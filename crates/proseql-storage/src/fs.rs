#![cfg(not(target_arch = "wasm32"))]

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Config, EventKind, PollWatcher, RecursiveMode, Watcher};
use proseql_engine::errors::{EngineError, StorageOperation};
use walkdir::WalkDir;

use crate::host::FileStat;
use crate::host::{storage_error, StorageEvent, StorageEventKind, StorageHost, WatchHandle};
use crate::path::normalize_path;
use crate::persistence::{AppendIdentity, DurableStorageHost};

static STAGING_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const RECOVERY_BUFFER_BYTES: usize = 64 * 1024;

// Fill a block before comparing it: regular reads can return different short
// lengths for identical files, and interruptions must not change recovery.
fn read_recovery_block(file: &mut std::fs::File, bytes: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < bytes.len() {
        match file.read(&mut bytes[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(filled)
}

fn recovery_files_equal(left: &Path, right: &Path) -> std::io::Result<bool> {
    let mut left = std::fs::File::open(left)?;
    let mut right = std::fs::File::open(right)?;
    let mut left_bytes = [0; RECOVERY_BUFFER_BYTES];
    let mut right_bytes = [0; RECOVERY_BUFFER_BYTES];
    loop {
        let left_len = read_recovery_block(&mut left, &mut left_bytes)?;
        let right_len = read_recovery_block(&mut right, &mut right_bytes)?;
        if left_len != right_len || left_bytes[..left_len] != right_bytes[..right_len] {
            return Ok(false);
        }
        if left_len == 0 {
            return Ok(true);
        }
    }
}

fn recovery_marker_committed(path: &Path) -> std::io::Result<bool> {
    let mut file = std::fs::File::open(path)?;
    let mut bytes = [0; RECOVERY_BUFFER_BYTES];
    let mut seen = false;
    let mut committed = false;
    loop {
        let len = read_recovery_block(&mut file, &mut bytes)?;
        if len == 0 {
            return Ok(committed);
        }
        committed = !seen && len == 1 && bytes[0] == b'C';
        seen = true;
        // Drain malformed markers too: preserve read failures, but never
        // allocate their entire contents just to classify them as PENDING.
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurabilityFaultPoint {
    /// Before unlink: failure leaves the file intact.
    RemoveUnlink,
    /// After unlink, before syncing the parent: failure requires reopen.
    RemoveDirectorySync,
    StageWrite,
    FileSync,
    PendingMarkerWrite,
    PendingMarkerSync,
    PendingMarkerDirectorySync,
    AtomicReplace,
    DirectorySync,
    CommitMarkerWrite,
    CommitMarkerSync,
    Cleanup,
    RollbackReplace,
    RollbackDirectorySync,
    /// Durable append: checked after the first half of the data is written and
    /// before the rest, so a crash here leaves a torn final line.
    AppendWrite,
    /// Durable append: checked after all data is written, before the file sync.
    AppendSync,
    /// Disposable index temp file is complete, but not yet renamed.
    IndexRename,
}

/// Optional fault seam used by native durability conformance suites.
pub trait DurabilityFaultInjector: Send + Sync {
    fn check(&self, point: DurabilityFaultPoint) -> Result<(), EngineError>;
}

#[derive(Clone)]
pub struct FsStorageHost {
    poll_interval: Duration,
    durability_faults: Option<Arc<dyn DurabilityFaultInjector>>,
}

pub struct FsWatchHandle {
    watcher: Arc<Mutex<Option<PollWatcher>>>,
    watched_path: PathBuf,
}

impl WatchHandle for FsWatchHandle {
    fn stop(&self) -> Result<(), EngineError> {
        let mut watcher = self.watcher.lock().map_err(|_| {
            storage_error(
                self.watched_path.to_string_lossy(),
                StorageOperation::Watch,
                "Poisoned fs watcher",
            )
        })?;
        if let Some(inner) = watcher.as_mut() {
            let _ = inner.unwatch(&self.watched_path);
        }
        watcher.take();
        Ok(())
    }
}

impl FsStorageHost {
    pub fn new_polling(poll_interval: Duration) -> Result<Self, EngineError> {
        Ok(Self {
            poll_interval,
            durability_faults: None,
        })
    }

    pub fn new_polling_with_fault_injector(
        poll_interval: Duration,
        faults: Arc<dyn DurabilityFaultInjector>,
    ) -> Result<Self, EngineError> {
        Ok(Self {
            poll_interval,
            durability_faults: Some(faults),
        })
    }

    fn check_durability_fault(&self, point: DurabilityFaultPoint) -> Result<(), EngineError> {
        match &self.durability_faults {
            Some(faults) => faults.check(point),
            None => Ok(()),
        }
    }

    fn durable_artifacts(path: &str) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), EngineError> {
        let destination = PathBuf::from(path);
        let parent = destination
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();
        let filename = destination
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned)
            .ok_or_else(|| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    "Invalid destination filename",
                )
            })?;
        Ok((
            destination,
            parent.clone(),
            parent.join(format!(".{filename}.proseql-backup")),
            parent.join(format!(".{filename}.proseql-committed")),
        ))
    }

    fn sync_directory(path: &str, parent: &Path) -> Result<(), EngineError> {
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    format!("Failed to sync containing directory for '{path}': {error}"),
                )
            })
    }

    /// Recover a prior durable replace before reading or starting another one.
    pub fn recover_durable_path(&self, path: &str) -> Result<(), EngineError> {
        let (destination, parent, backup, committed) = Self::durable_artifacts(path)?;
        if committed.exists() {
            let marker_committed = recovery_marker_committed(&committed).map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Read,
                    format!("Failed to read durable commit marker: {error}"),
                )
            })?;
            if marker_committed {
                // COMMITTED is written into an already-durable marker inode only
                // after the candidate and containing directory are durable.
                if backup.exists() {
                    std::fs::remove_file(&backup).map_err(|error| {
                        storage_error(
                            path,
                            StorageOperation::Write,
                            format!("Failed to clean committed durable backup: {error}"),
                        )
                    })?;
                    Self::sync_directory(path, &parent)?;
                }
                std::fs::remove_file(&committed).map_err(|error| {
                    storage_error(
                        path,
                        StorageOperation::Write,
                        format!("Failed to clean durable commit marker: {error}"),
                    )
                })?;
                return Self::sync_directory(path, &parent);
            }

            // PENDING or malformed means no successful commit was acknowledged.
            if backup.exists() {
                // A failed comparison still restores the backup, as before.
                let already_restored = recovery_files_equal(&destination, &backup).unwrap_or(false);
                if already_restored {
                    std::fs::remove_file(&backup).map_err(|error| {
                        storage_error(
                            path,
                            StorageOperation::Write,
                            format!("Failed to clean restored durable backup: {error}"),
                        )
                    })?;
                } else {
                    std::fs::rename(&backup, &destination).map_err(|error| {
                        storage_error(
                            path,
                            StorageOperation::Write,
                            format!("Failed to restore pending durable backup: {error}"),
                        )
                    })?;
                }
            } else if destination.exists() {
                std::fs::remove_file(&destination).map_err(|error| {
                    storage_error(
                        path,
                        StorageOperation::Write,
                        format!("Failed to remove pending first-write candidate: {error}"),
                    )
                })?;
            }
            Self::sync_directory(path, &parent)?;
            std::fs::remove_file(&committed).map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    format!("Failed to clean pending durable marker: {error}"),
                )
            })?;
            return Self::sync_directory(path, &parent);
        }
        if !backup.exists() {
            return Ok(());
        }
        let unchanged_destination =
            destination.exists() && recovery_files_equal(&destination, &backup).unwrap_or(false);
        if unchanged_destination {
            std::fs::remove_file(&backup).map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    format!("Failed to clean unchanged durable backup: {error}"),
                )
            })?;
        } else {
            std::fs::rename(&backup, &destination).map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    format!("Failed to restore durable backup: {error}"),
                )
            })?;
        }
        Self::sync_directory(path, &parent)
    }

    fn ensure_parent(path: &str) -> Result<(), EngineError> {
        let path_buf = PathBuf::from(path);
        let dir = if path_buf.extension().is_some() {
            path_buf.parent().map(Path::to_path_buf)
        } else {
            Some(path_buf)
        };
        if let Some(dir) = dir {
            std::fs::create_dir_all(&dir).map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    format!("Failed to create directory for '{path}': {error}"),
                )
            })?;
        }
        Ok(())
    }

    fn map_event_kind(kind: &EventKind) -> StorageEventKind {
        match kind {
            EventKind::Create(_) => StorageEventKind::Add,
            EventKind::Remove(_) => StorageEventKind::Remove,
            _ => StorageEventKind::Change,
        }
    }

    fn new_watch<F>(
        &self,
        watched_path: PathBuf,
        recursive_mode: RecursiveMode,
        on_change: F,
    ) -> Result<Box<dyn WatchHandle>, EngineError>
    where
        F: Fn(&notify::Event, StorageEvent) + Send + Sync + 'static,
    {
        let callback = Arc::new(on_change);
        let callback_for_watcher = Arc::clone(&callback);
        let watch_root = watched_path.clone();
        let watch_root_for_handler = watch_root.clone();
        let mut watcher = PollWatcher::new(
            move |result: notify::Result<notify::Event>| {
                let Ok(event) = result else {
                    return;
                };
                if event
                    .paths
                    .iter()
                    .any(|path| crate::index::persist::hidden(&path.to_string_lossy()))
                {
                    return;
                }
                let kind = Self::map_event_kind(&event.kind);
                let changed = event
                    .paths
                    .iter()
                    .rev()
                    .find(|path| path.file_name().and_then(|name| name.to_str()).is_some());
                let path = changed.map(|path| path.to_string_lossy().into_owned());
                let filename = changed
                    .and_then(|path| path.file_name())
                    .and_then(|name| name.to_str())
                    .map(str::to_owned)
                    .or_else(|| {
                        watch_root_for_handler
                            .file_name()
                            .and_then(|name| name.to_str())
                            .map(str::to_owned)
                    });
                callback_for_watcher(
                    &event,
                    StorageEvent {
                        filename,
                        kind,
                        path,
                    },
                );
            },
            // notify 6 compares modification times at second precision. Content
            // comparison also detects replacements within the same second.
            Config::default()
                .with_poll_interval(self.poll_interval)
                .with_compare_contents(true),
        )
        .map_err(|error| {
            storage_error(
                watch_root.to_string_lossy(),
                StorageOperation::Watch,
                format!("Failed to create watcher: {error}"),
            )
        })?;
        watcher
            .watch(&watch_root, recursive_mode)
            .map_err(|error| {
                storage_error(
                    watch_root.to_string_lossy(),
                    StorageOperation::Watch,
                    format!("Failed to watch '{}': {error}", watch_root.display()),
                )
            })?;
        Ok(Box::new(FsWatchHandle {
            watcher: Arc::new(Mutex::new(Some(watcher))),
            watched_path: watch_root,
        }))
    }
}

impl FsStorageHost {
    fn append_file(
        &self,
        path: &str,
        keep_len: u64,
        data: &str,
        prove: bool,
    ) -> Result<Option<AppendIdentity>, EngineError> {
        // Preserve ensure_parent's existing extensionless-path behaviour.
        if Path::new(path).extension().is_none() {
            Self::ensure_parent(path)?;
        }
        self.recover_durable_path(path)?;
        let destination = PathBuf::from(path);
        let parent = destination
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();
        let created = !destination.exists();
        let write_error = |message: String| storage_error(path, StorageOperation::Write, message);
        let open = || {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&destination)
        };
        // Existing append targets already have a parent. Avoid one mkdir
        // syscall per touched shard; still create missing parents on demand.
        let opened = match open() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Self::ensure_parent(path)?;
                open()
            }
            result => result,
        };
        let mut file = opened
            .map_err(|error| write_error(format!("Failed to open '{path}' for append: {error}")))?;
        let before = file_stat(
            &file
                .metadata()
                .map_err(|error| write_error(format!("Failed to stat '{path}': {error}")))?,
        );
        let len = before.len;
        if keep_len > len {
            return Err(write_error(format!(
                "Cannot append to '{path}': kept length {keep_len} exceeds file length {len}"
            )));
        }
        let result = (|| -> Result<(), EngineError> {
            if keep_len < len {
                file.set_len(keep_len).map_err(|error| {
                    write_error(format!(
                        "Failed to truncate '{path}' before append: {error}"
                    ))
                })?;
            }
            file.seek(SeekFrom::Start(keep_len))
                .map_err(|error| write_error(format!("Failed to seek '{path}': {error}")))?;
            let bytes = data.as_bytes();
            let (first, rest) = bytes.split_at(bytes.len() / 2);
            file.write_all(first)
                .map_err(|error| write_error(format!("Failed to append '{path}': {error}")))?;
            self.check_durability_fault(DurabilityFaultPoint::AppendWrite)?;
            file.write_all(rest)
                .map_err(|error| write_error(format!("Failed to append '{path}': {error}")))?;
            self.check_durability_fault(DurabilityFaultPoint::AppendSync)?;
            file.sync_data()
                .map_err(|error| write_error(format!("Failed to sync '{path}': {error}")))?;
            if created {
                Self::sync_directory(path, &parent)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            // Best effort: drop the partial append. A crash before this point
            // leaves a torn final line, which the append-only loader ignores.
            if created && keep_len == 0 {
                drop(file);
                let _ = std::fs::remove_file(&destination);
                let _ = Self::sync_directory(path, &parent);
            } else if file.set_len(keep_len).is_ok() {
                let _ = file.sync_data();
            }
            return Err(error);
        }
        // Read-back is disposable metadata work, outside the durable commit.
        // Never quarantine an already successful append if this check fails.
        Ok(if prove {
            self.append_identity(&mut file, before, keep_len, data)
                .ok()
                .flatten()
        } else {
            None
        })
    }

    fn append_identity(
        &self,
        file: &mut std::fs::File,
        before: FileStat,
        keep_len: u64,
        data: &str,
    ) -> std::io::Result<Option<AppendIdentity>> {
        use std::hash::Hasher;
        let _proof = crate::diagnostics::span("streaming_append_prefix_proof");
        let after = file_stat(&file.metadata()?);
        if after.change_id.is_none() || after.len != keep_len + data.len() as u64 {
            return Ok(None);
        }
        file.seek(SeekFrom::Start(0))?;
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        let mut buffer = [0; 64 * 1024];
        let mut remaining = keep_len;
        while remaining > 0 {
            let count = remaining.min(buffer.len() as u64) as usize;
            file.read_exact(&mut buffer[..count])?;
            hash.write(&buffer[..count]);
            remaining -= count as u64;
        }
        // A concurrent editor can also change our suffix before the read-back.
        // Identity pairs alone cannot distinguish that from our own write.
        for expected in data.as_bytes().chunks(buffer.len()) {
            file.read_exact(&mut buffer[..expected.len()])?;
            if &buffer[..expected.len()] != expected {
                return Ok(None);
            }
        }
        if file_stat(&file.metadata()?) != after {
            return Ok(None);
        }
        Ok(Some(AppendIdentity {
            before,
            after,
            preserved_prefix_hash: hash.finish(),
        }))
    }
}

impl DurableStorageHost for FsStorageHost {
    fn preflight_remove_durable(&self, _path: &str) -> Result<(), EngineError> {
        Ok(())
    }

    fn remove_durable(&self, path: &str) -> Result<(), EngineError> {
        self.recover_durable_path(path)?;
        self.check_durability_fault(DurabilityFaultPoint::RemoveUnlink)?;
        std::fs::remove_file(path).map_err(|error| {
            storage_error(
                path,
                StorageOperation::Delete,
                format!("Failed to unlink '{path}': {error}"),
            )
        })?;
        self.check_durability_fault(DurabilityFaultPoint::RemoveDirectorySync)?;
        let parent = Path::new(path)
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        Self::sync_directory(path, parent)
    }

    fn append_durable(&self, path: &str, keep_len: u64, data: &str) -> Result<(), EngineError> {
        self.append_file(path, keep_len, data, false).map(|_| ())
    }

    fn append_durable_with_identity(
        &self,
        path: &str,
        keep_len: u64,
        data: &str,
    ) -> Result<Option<AppendIdentity>, EngineError> {
        self.append_file(path, keep_len, data, true)
    }

    fn read_tail(
        &self,
        path: &str,
        max_tail: usize,
    ) -> Result<Option<crate::persistence::FileTail>, EngineError> {
        self.recover_durable_path(path)?;
        let read_error = |message: String| storage_error(path, StorageOperation::Read, message);
        let mut file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(read_error(format!("Failed to open '{path}': {error}"))),
        };
        let len = file
            .metadata()
            .map_err(|error| read_error(format!("Failed to stat '{path}': {error}")))?
            .len();
        let tail_len = len.min(max_tail as u64);
        file.seek(SeekFrom::Start(len - tail_len))
            .map_err(|error| read_error(format!("Failed to seek '{path}': {error}")))?;
        let mut tail = vec![0; tail_len as usize];
        std::io::Read::read_exact(&mut file, &mut tail)
            .map_err(|error| read_error(format!("Failed to read '{path}': {error}")))?;
        Ok(Some(crate::persistence::FileTail { len, tail }))
    }

    fn replace_durable(&self, path: &str, data: &str) -> Result<(), EngineError> {
        Self::ensure_parent(path)?;
        self.recover_durable_path(path)?;
        let (destination, parent, backup, committed) = Self::durable_artifacts(path)?;
        let filename = destination
            .file_name()
            .and_then(|name| name.to_str())
            .expect("durable_artifacts validated filename");
        let sequence = STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let staging = parent.join(format!(
            ".{filename}.proseql-stage-{}-{sequence}",
            std::process::id()
        ));
        let sync_parent = || Self::sync_directory(path, &parent);
        let mut installed_candidate = false;
        let mut commit_durable = false;

        let result = (|| -> Result<(), EngineError> {
            self.check_durability_fault(DurabilityFaultPoint::StageWrite)?;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging)
                .map_err(|error| {
                    storage_error(
                        path,
                        StorageOperation::Write,
                        format!("Failed to create staging file: {error}"),
                    )
                })?;
            file.write_all(data.as_bytes()).map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    format!("Failed to write staging file: {error}"),
                )
            })?;
            self.check_durability_fault(DurabilityFaultPoint::FileSync)?;
            file.sync_all().map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    format!("Failed to sync staging file: {error}"),
                )
            })?;
            drop(file);

            // Preserve the old inode before making the transaction marker
            // durable. Therefore PENDING without a backup can only represent a
            // first write and recovery may safely remove its candidate.
            if destination.exists() {
                std::fs::hard_link(&destination, &backup).map_err(|error| {
                    storage_error(
                        path,
                        StorageOperation::Write,
                        format!("Failed to preserve prior durable file: {error}"),
                    )
                })?;
                sync_parent()?;
            }

            let mut marker = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(&committed)
                .map_err(|error| {
                    storage_error(
                        path,
                        StorageOperation::Write,
                        format!("Failed to create pending durable marker: {error}"),
                    )
                })?;
            self.check_durability_fault(DurabilityFaultPoint::PendingMarkerWrite)?;
            marker.write_all(b"P").map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    format!("Failed to write pending durable marker: {error}"),
                )
            })?;
            self.check_durability_fault(DurabilityFaultPoint::PendingMarkerSync)?;
            marker.sync_all().map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    format!("Failed to sync pending durable marker: {error}"),
                )
            })?;
            self.check_durability_fault(DurabilityFaultPoint::PendingMarkerDirectorySync)?;
            sync_parent()?;

            self.check_durability_fault(DurabilityFaultPoint::AtomicReplace)?;
            std::fs::rename(&staging, &destination).map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    format!("Failed to atomically replace destination: {error}"),
                )
            })?;
            installed_candidate = true;
            self.check_durability_fault(DurabilityFaultPoint::DirectorySync)?;
            sync_parent()?;

            // The marker inode and directory entry are already durable. Only
            // its one-byte state changes at the acknowledgement boundary.
            self.check_durability_fault(DurabilityFaultPoint::CommitMarkerWrite)?;
            marker.seek(SeekFrom::Start(0)).map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    format!("Failed to seek durable commit marker: {error}"),
                )
            })?;
            marker.write_all(b"C").map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    format!("Failed to mark durable commit complete: {error}"),
                )
            })?;
            marker.set_len(1).map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    format!("Failed to truncate durable commit marker: {error}"),
                )
            })?;
            self.check_durability_fault(DurabilityFaultPoint::CommitMarkerSync)?;
            marker.sync_all().map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    format!("Failed to sync committed durable marker: {error}"),
                )
            })?;
            commit_durable = true;
            drop(marker);

            // Cleanup is outside the commit boundary. A COMMITTED marker makes
            // every partial cleanup state safe for recovery and retry.
            if self
                .check_durability_fault(DurabilityFaultPoint::Cleanup)
                .is_ok()
            {
                let backup_clean = !backup.exists()
                    || (std::fs::remove_file(&backup).is_ok() && sync_parent().is_ok());
                if backup_clean {
                    let _ = std::fs::remove_file(&committed);
                    let _ = sync_parent();
                }
            }
            Ok(())
        })();

        if result.is_err() {
            let _ = std::fs::remove_file(&staging);
            if !commit_durable {
                // Commit-marker sync can fail after C reached the page cache.
                // Put the still-unacknowledged transaction back into PENDING
                // before restoring the prior state.
                if committed.exists() {
                    if let Ok(mut marker) = std::fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(&committed)
                    {
                        let _ = marker.seek(SeekFrom::Start(0));
                        let _ = marker.write_all(b"P");
                        let _ = marker.set_len(1);
                        let _ = marker.sync_all();
                    }
                }

                if backup.exists() {
                    if !installed_candidate {
                        let _ = std::fs::remove_file(&backup);
                        let _ = sync_parent();
                        let _ = std::fs::remove_file(&committed);
                        let _ = sync_parent();
                    } else if self
                        .check_durability_fault(DurabilityFaultPoint::RollbackReplace)
                        .is_ok()
                    {
                        let rollback = parent.join(format!(
                            ".{filename}.proseql-rollback-{}-{sequence}",
                            std::process::id()
                        ));
                        let restored = std::fs::hard_link(&backup, &rollback)
                            .and_then(|()| std::fs::rename(&rollback, &destination));
                        if restored.is_ok()
                            && self
                                .check_durability_fault(DurabilityFaultPoint::RollbackDirectorySync)
                                .and_then(|()| sync_parent())
                                .is_ok()
                        {
                            let _ = std::fs::remove_file(&backup);
                            let _ = sync_parent();
                            let _ = std::fs::remove_file(&committed);
                            let _ = sync_parent();
                        } else {
                            let _ = std::fs::remove_file(&rollback);
                        }
                    }
                } else if installed_candidate {
                    let _ = std::fs::remove_file(&destination);
                    let _ = sync_parent();
                    let _ = std::fs::remove_file(&committed);
                    let _ = sync_parent();
                } else if committed.exists() {
                    let _ = std::fs::remove_file(&committed);
                    let _ = sync_parent();
                }
            }
        }
        result
    }
}

impl StorageHost for FsStorageHost {
    fn supports_indexes(&self) -> bool {
        true
    }
    fn read_index(&self, path: &str) -> Option<Vec<u8>> {
        let mut file = std::fs::File::open(path).ok()?;
        // A damaged or hostile sidecar must not allocate without a bound.
        let len = file.metadata().ok()?.len();
        if len > 64 * 1024 * 1024 {
            return None;
        }
        let mut bytes = Vec::with_capacity(len as usize);
        std::io::Read::by_ref(&mut file)
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        (bytes.len() <= 64 * 1024 * 1024).then_some(bytes)
    }
    fn write_index_atomic(&self, path: &str, data: &[u8]) {
        use std::io::Write;
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let temp = format!(
            "{path}.{}.{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        // No fsync: losing derived data is harmless. Rename publishes only a
        // complete file. Checksum/generation checks reject power-loss damage.
        let result = (|| -> std::io::Result<()> {
            if let Some(parent) = Path::new(path).parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            file.write_all(data)?;
            drop(file);
            self.check_durability_fault(DurabilityFaultPoint::IndexRename)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            std::fs::rename(&temp, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
    }

    fn read(&self, path: &str) -> Result<String, EngineError> {
        let _phase = crate::diagnostics::span("filesystem_read_text_including_recovery");
        self.recover_durable_path(path)?;
        std::fs::read_to_string(path).map_err(|error| {
            storage_error(
                path,
                StorageOperation::Read,
                format!("Failed to read '{path}': {error}"),
            )
        })
    }

    fn read_bytes(&self, path: &str) -> Result<Vec<u8>, EngineError> {
        let _phase = crate::diagnostics::span("filesystem_read_bytes_including_recovery");
        self.recover_durable_path(path)?;
        std::fs::read(path).map_err(|error| {
            storage_error(
                path,
                StorageOperation::Read,
                format!("Failed to read '{path}': {error}"),
            )
        })
    }

    fn visit_bytes(
        &self,
        path: &str,
        visitor: &mut dyn FnMut(&[u8]) -> Result<(), EngineError>,
    ) -> Result<(), EngineError> {
        self.recover_durable_path(path)?;
        let read_error = |error| {
            storage_error(
                path,
                StorageOperation::Read,
                format!("Failed to read '{path}': {error}"),
            )
        };
        let mut file = std::fs::File::open(path).map_err(read_error)?;
        let mut buffer = [0; 64 * 1024];
        loop {
            let count = match file.read(&mut buffer) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                result => result.map_err(read_error)?,
            };
            if count == 0 {
                return Ok(());
            }
            visitor(&buffer[..count])?;
        }
    }

    fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, EngineError> {
        self.recover_durable_path(path)?;
        let result = (|| -> std::io::Result<Vec<u8>> {
            let mut file = std::fs::File::open(path)?;
            if len == 0 {
                return Ok(Vec::new());
            }
            // Indexed callers already supply a checked end offset. Do not
            // fstat the descriptor again for every 64 KiB chunk. Still bound
            // initial allocation for callers requesting more than the file.
            if offset > i64::MAX as u64 {
                return Ok(Vec::new());
            }
            file.seek(SeekFrom::Start(offset))?;
            if len > 64 * 1024 {
                let mut bytes = Vec::with_capacity(64 * 1024);
                file.take(len as u64).read_to_end(&mut bytes)?;
                return Ok(bytes);
            }
            let capacity = len;
            let mut bytes = vec![0; capacity];
            let mut read = 0;
            while read < capacity {
                match file.read(&mut bytes[read..]) {
                    Ok(0) => break,
                    Ok(count) => read += count,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                }
            }
            bytes.truncate(read);
            Ok(bytes)
        })();
        result.map_err(|error| {
            storage_error(
                path,
                StorageOperation::Read,
                format!("Failed to read '{path}': {error}"),
            )
        })
    }

    fn stat(&self, path: &str) -> Result<Option<crate::host::FileStat>, EngineError> {
        self.recover_durable_path(path)?;
        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(storage_error(
                    path,
                    StorageOperation::Read,
                    format!("Failed to stat '{path}': {error}"),
                ))
            }
        };
        Ok(Some(file_stat(&metadata)))
    }

    fn write(&self, path: &str, data: &str) -> Result<(), EngineError> {
        Self::ensure_parent(path)?;
        std::fs::write(path, data).map_err(|error| {
            storage_error(
                path,
                StorageOperation::Write,
                format!("Failed to write '{path}': {error}"),
            )
        })
    }

    fn append(&self, path: &str, data: &str) -> Result<(), EngineError> {
        Self::ensure_parent(path)?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Write,
                    format!("Failed to open '{path}' for append: {error}"),
                )
            })?;
        file.write_all(data.as_bytes()).map_err(|error| {
            storage_error(
                path,
                StorageOperation::Write,
                format!("Failed to append '{path}': {error}"),
            )
        })
    }

    fn exists(&self, path: &str) -> Result<bool, EngineError> {
        self.recover_durable_path(path)?;
        Ok(Path::new(path).exists())
    }

    fn remove(&self, path: &str) -> Result<(), EngineError> {
        std::fs::remove_file(path).map_err(|error| {
            storage_error(
                path,
                StorageOperation::Delete,
                format!("Failed to delete '{path}': {error}"),
            )
        })
    }

    fn ensure_dir(&self, path: &str) -> Result<(), EngineError> {
        Self::ensure_parent(path)
    }

    fn is_directory(&self, path: &str) -> Result<bool, EngineError> {
        match std::fs::metadata(path) {
            Ok(metadata) => Ok(metadata.is_dir()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(storage_error(
                path,
                StorageOperation::List,
                error.to_string(),
            )),
        }
    }
    fn list_directory(&self, dir_path: &str) -> Result<Vec<String>, EngineError> {
        let mut entries = std::fs::read_dir(dir_path)
            .map_err(|error| {
                storage_error(
                    dir_path,
                    StorageOperation::List,
                    format!("Failed to list '{dir_path}': {error}"),
                )
            })?
            .map(|entry| {
                entry
                    .map(|item| normalize_path(&item.path().to_string_lossy()))
                    .map_err(|error| {
                        storage_error(
                            dir_path,
                            StorageOperation::List,
                            format!("Failed to read directory entry: {error}"),
                        )
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        entries.retain(|path| !crate::index::persist::hidden(path));
        entries.sort();
        Ok(entries)
    }

    fn list_directory_with_stat(
        &self,
        dir_path: &str,
    ) -> Result<Vec<(String, crate::host::FileStat)>, EngineError> {
        list_directory_observations(dir_path, &mut |path| self.recover_durable_path(path))
    }

    fn list_recursive(&self, root_path: &str) -> Result<Vec<String>, EngineError> {
        let mut entries = WalkDir::new(root_path)
            .into_iter()
            .filter_entry(|entry| entry.file_name() != crate::index::persist::DIRECTORY)
            .filter_map(|entry| match entry {
                Ok(entry) if entry.file_type().is_file() => {
                    Some(Ok(normalize_path(&entry.path().to_string_lossy())))
                }
                Ok(_) => None,
                Err(error) => Some(Err(storage_error(
                    root_path,
                    StorageOperation::List,
                    format!("Failed to walk '{root_path}': {error}"),
                ))),
            })
            .collect::<Result<Vec<_>, _>>()?;
        entries.retain(|path| !crate::index::persist::hidden(path));
        entries.sort();
        Ok(entries)
    }

    fn watch(
        &self,
        path: &str,
        on_change: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        let watched_path = PathBuf::from(path);
        let filter = normalize_path(path);
        let filter_parent = Path::new(&filter)
            .parent()
            .map(|path| normalize_path(&path.to_string_lossy()))
            .unwrap_or_default();
        let filter_filename = Path::new(&filter)
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned);
        self.new_watch(
            watched_path
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| watched_path.clone()),
            RecursiveMode::NonRecursive,
            move |event, storage_event| {
                let path_matches = event.paths.iter().any(|candidate| {
                    let normalized = normalize_path(&candidate.to_string_lossy());
                    normalized == filter || normalized == filter_parent
                });
                let filename_matches = filter_filename
                    .as_ref()
                    .zip(storage_event.filename.as_ref())
                    .map(|(expected, actual)| expected == actual)
                    .unwrap_or(false);
                if path_matches && filename_matches {
                    on_change(storage_event);
                }
            },
        )
    }

    fn watch_dir(
        &self,
        path: &str,
        on_change: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        self.new_watch(
            PathBuf::from(path),
            RecursiveMode::Recursive,
            move |_event, storage_event| {
                on_change(storage_event);
            },
        )
    }
}

fn file_stat(metadata: &std::fs::Metadata) -> FileStat {
    #[cfg(unix)]
    let change_id = {
        use std::hash::{Hash, Hasher};
        use std::os::unix::fs::MetadataExt;
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        (
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec(),
        )
            .hash(&mut hash);
        Some(hash.finish())
    };
    #[cfg(not(unix))]
    let change_id = None;
    FileStat {
        len: metadata.len(),
        modified_ns: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos()),
        change_id,
    }
}

// Sibling artifacts make recovery discoverable without probing two nonexistent
// paths for every ordinary entry. Finish recovery before taking any metadata.
fn list_directory_observations(
    dir_path: &str,
    recover: &mut dyn FnMut(&str) -> Result<(), EngineError>,
) -> Result<Vec<(String, FileStat)>, EngineError> {
    let error = |error: std::io::Error| {
        storage_error(
            dir_path,
            StorageOperation::List,
            format!("Failed to list '{dir_path}' with metadata: {error}"),
        )
    };
    let listed = std::fs::read_dir(dir_path)
        .map_err(error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error)?;
    let mut recovery = std::collections::BTreeSet::new();
    for entry in &listed {
        let name = entry.file_name();
        let Some(name) = name.to_str().and_then(|name| name.strip_prefix('.')) else {
            continue;
        };
        if let Some(name) = name
            .strip_suffix(".proseql-backup")
            .or_else(|| name.strip_suffix(".proseql-committed"))
        {
            recovery.insert(normalize_path(
                &Path::new(dir_path).join(name).to_string_lossy(),
            ));
        }
    }
    for path in &recovery {
        recover(path)?;
    }
    let mut entries = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for entry in listed {
        let path = normalize_path(&entry.path().to_string_lossy());
        if crate::index::persist::hidden(&path) {
            continue;
        }
        let metadata = if recovery.contains(&path) {
            // Recovery can replace this inode or remove a pending first write.
            std::fs::metadata(entry.path())
        } else {
            match entry.metadata() {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    std::fs::metadata(entry.path())
                }
                result => result,
            }
        };
        match metadata {
            Ok(metadata) => {
                seen.insert(path.clone());
                entries.push((path, file_stat(&metadata)));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(cause) => return Err(error(cause)),
        }
    }
    // A backup can restore a destination that was absent during read_dir.
    for path in recovery.difference(&seen) {
        match std::fs::metadata(path) {
            Ok(metadata) => entries.push((path.clone(), file_stat(&metadata))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(cause) => return Err(error(cause)),
        }
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(entries)
}

#[cfg(test)]
mod listing_tests {
    use super::*;
    #[test]
    fn normal_listing_never_calls_recovery() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.jsonl"), "text").unwrap();
        let entries = list_directory_observations(dir.path().to_str().unwrap(), &mut |_| {
            panic!("ordinary entry recovered")
        })
        .unwrap();
        assert_eq!(entries.len(), 1);
    }
}
