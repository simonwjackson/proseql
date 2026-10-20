#![cfg(not(target_arch = "wasm32"))]

use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Config, EventKind, PollWatcher, RecursiveMode, Watcher};
use proseql_engine::errors::{EngineError, StorageOperation};
use walkdir::WalkDir;

use crate::host::{storage_error, StorageEvent, StorageEventKind, StorageHost, WatchHandle};
use crate::path::normalize_path;
use crate::persistence::DurableStorageHost;

static STAGING_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurabilityFaultPoint {
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
            let marker = std::fs::read(&committed).map_err(|error| {
                storage_error(
                    path,
                    StorageOperation::Read,
                    format!("Failed to read durable commit marker: {error}"),
                )
            })?;
            if marker == b"C" {
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
                let already_restored = match (std::fs::read(&destination), std::fs::read(&backup)) {
                    (Ok(destination_bytes), Ok(backup_bytes)) => destination_bytes == backup_bytes,
                    _ => false,
                };
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
        let unchanged_destination = if destination.exists() {
            match (std::fs::read(&destination), std::fs::read(&backup)) {
                (Ok(destination_bytes), Ok(backup_bytes)) => destination_bytes == backup_bytes,
                _ => false,
            }
        } else {
            false
        };
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
                let kind = Self::map_event_kind(&event.kind);
                let filename = event
                    .paths
                    .iter()
                    .rev()
                    .find_map(|path| {
                        path.file_name()
                            .and_then(|name| name.to_str())
                            .map(str::to_owned)
                    })
                    .or_else(|| {
                        watch_root_for_handler
                            .file_name()
                            .and_then(|name| name.to_str())
                            .map(str::to_owned)
                    });
                callback_for_watcher(&event, StorageEvent { filename, kind });
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

impl DurableStorageHost for FsStorageHost {
    fn append_durable(&self, path: &str, keep_len: u64, data: &str) -> Result<(), EngineError> {
        Self::ensure_parent(path)?;
        self.recover_durable_path(path)?;
        let destination = PathBuf::from(path);
        let parent = destination
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();
        let created = !destination.exists();
        let write_error = |message: String| storage_error(path, StorageOperation::Write, message);
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&destination)
            .map_err(|error| write_error(format!("Failed to open '{path}' for append: {error}")))?;
        let len = file
            .metadata()
            .map_err(|error| write_error(format!("Failed to stat '{path}': {error}")))?
            .len();
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
        if result.is_err() {
            // Best effort: drop the partial append. A crash before this point
            // leaves a torn final line, which the append-only loader ignores.
            if created && keep_len == 0 {
                drop(file);
                let _ = std::fs::remove_file(&destination);
                let _ = Self::sync_directory(path, &parent);
            } else if file.set_len(keep_len).is_ok() {
                let _ = file.sync_data();
            }
        }
        result
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
    fn read(&self, path: &str) -> Result<String, EngineError> {
        self.recover_durable_path(path)?;
        std::fs::read_to_string(path).map_err(|error| {
            storage_error(
                path,
                StorageOperation::Read,
                format!("Failed to read '{path}': {error}"),
            )
        })
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
        entries.sort();
        Ok(entries)
    }

    fn list_recursive(&self, root_path: &str) -> Result<Vec<String>, EngineError> {
        let mut entries = WalkDir::new(root_path)
            .into_iter()
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
