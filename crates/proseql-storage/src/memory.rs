use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use proseql_engine::errors::{EngineError, StorageOperation};

use crate::host::{storage_error, StorageEvent, StorageEventKind, StorageHost, WatchHandle};
use crate::path::{join_path, normalize_path};

/// In-process storage with permanent virtual directory roots: `.` for relative
/// paths and `/` for absolute paths. Root listings and watches stay in their
/// namespace; other directories exist only while they contain files.
#[derive(Clone)]
pub struct MemoryStorageHost {
    inner: Arc<Inner>,
}

struct Inner {
    files: Mutex<HashMap<String, String>>,
    watchers: Mutex<HashMap<usize, WatchRegistration>>,
    next_watch_id: AtomicUsize,
}

struct WatchRegistration {
    target: WatchTarget,
    callback: Arc<dyn Fn(StorageEvent) + Send + Sync>,
    active: Arc<AtomicBool>,
}

#[derive(Clone)]
enum WatchTarget {
    Path(String),
    Dir(String),
}

struct MemoryWatchHandle {
    inner: Arc<Inner>,
    id: usize,
    stopped: AtomicBool,
}

impl MemoryWatchHandle {
    fn unregister(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut watchers) = self.inner.watchers.lock() {
            watchers.remove(&self.id);
        }
    }
}

impl WatchHandle for MemoryWatchHandle {
    fn stop(&self) -> Result<(), EngineError> {
        self.unregister();
        Ok(())
    }
}

impl Drop for MemoryWatchHandle {
    fn drop(&mut self) {
        self.unregister();
    }
}

impl Default for MemoryStorageHost {
    fn default() -> Self {
        Self {
            inner: Arc::new(Inner {
                files: Mutex::new(HashMap::new()),
                watchers: Mutex::new(HashMap::new()),
                next_watch_id: AtomicUsize::new(1),
            }),
        }
    }
}

impl MemoryStorageHost {
    fn is_virtual_root(path: &str) -> bool {
        matches!(path, "." | "/")
    }

    fn relative_entry<'a>(root: &str, path: &'a str) -> Option<&'a str> {
        match root {
            "." if !path.starts_with('/') && path != "." => Some(path),
            "/" => path
                .strip_prefix('/')
                .filter(|relative| !relative.is_empty()),
            _ => path
                .strip_prefix(root)
                .and_then(|relative| relative.strip_prefix('/')),
        }
    }

    fn require_file_path(path: &str, operation: StorageOperation) -> Result<(), EngineError> {
        if Self::is_virtual_root(path) {
            return Err(storage_error(
                path,
                operation,
                "Virtual roots are directories, not files",
            ));
        }
        Ok(())
    }

    fn basename(path: &str) -> Option<String> {
        normalize_path(path)
            .rsplit('/')
            .next()
            .map(str::to_owned)
            .filter(|name| !name.is_empty())
    }

    fn emit(&self, path: &str, kind: StorageEventKind) {
        let normalized = normalize_path(path);
        let registrations = match self.inner.watchers.lock() {
            Ok(watchers) => watchers
                .values()
                .map(|registration| {
                    (
                        registration.target.clone(),
                        Arc::clone(&registration.callback),
                        Arc::clone(&registration.active),
                    )
                })
                .collect::<Vec<_>>(),
            Err(_) => return,
        };

        let filename = Self::basename(&normalized);
        for (target, callback, active) in registrations {
            if !active.load(Ordering::SeqCst) {
                continue;
            }
            let matches = match target {
                WatchTarget::Path(target) => target == normalized,
                WatchTarget::Dir(target) => {
                    normalized == target || Self::relative_entry(&target, &normalized).is_some()
                }
            };
            if matches {
                callback(StorageEvent {
                    filename: filename.clone(),
                    kind,
                    path: Some(normalized.clone()),
                });
            }
        }
    }

    fn insert_watch(
        &self,
        target: WatchTarget,
        on_change: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        let id = self.inner.next_watch_id.fetch_add(1, Ordering::SeqCst);
        let active = Arc::new(AtomicBool::new(true));
        let registration = WatchRegistration {
            target,
            callback: Arc::from(on_change),
            active: Arc::clone(&active),
        };
        self.inner
            .watchers
            .lock()
            .map_err(|_| {
                storage_error(
                    "(memory)",
                    StorageOperation::Watch,
                    "Poisoned memory watcher registry",
                )
            })?
            .insert(id, registration);
        Ok(Box::new(MemoryWatchHandle {
            inner: Arc::clone(&self.inner),
            id,
            stopped: AtomicBool::new(false),
        }))
    }
}

impl crate::persistence::DurableStorageHost for MemoryStorageHost {
    fn preflight_remove_durable(&self, _path: &str) -> Result<(), EngineError> {
        Ok(())
    }
    fn remove_durable(&self, path: &str) -> Result<(), EngineError> {
        self.remove(path)
    }

    fn replace_durable(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.write(path, data)
    }
}

impl StorageHost for MemoryStorageHost {
    fn read(&self, path: &str) -> Result<String, EngineError> {
        let path = normalize_path(path);
        self.inner
            .files
            .lock()
            .map_err(|_| storage_error(&path, StorageOperation::Read, "Poisoned memory storage"))?
            .get(&path)
            .cloned()
            .ok_or_else(|| {
                storage_error(
                    &path,
                    StorageOperation::Read,
                    format!("File not found: '{path}'"),
                )
            })
    }

    fn write(&self, path: &str, data: &str) -> Result<(), EngineError> {
        let path = normalize_path(path);
        Self::require_file_path(&path, StorageOperation::Write)?;
        let kind = {
            let mut files = self.inner.files.lock().map_err(|_| {
                storage_error(&path, StorageOperation::Write, "Poisoned memory storage")
            })?;
            let kind = if files.contains_key(&path) {
                StorageEventKind::Change
            } else {
                StorageEventKind::Add
            };
            files.insert(path.clone(), data.to_owned());
            kind
        };
        self.emit(&path, kind);
        Ok(())
    }

    fn append(&self, path: &str, data: &str) -> Result<(), EngineError> {
        let path = normalize_path(path);
        Self::require_file_path(&path, StorageOperation::Write)?;
        let kind = {
            let mut files = self.inner.files.lock().map_err(|_| {
                storage_error(&path, StorageOperation::Write, "Poisoned memory storage")
            })?;
            if let Some(existing) = files.get_mut(&path) {
                existing.push_str(data);
                StorageEventKind::Change
            } else {
                files.insert(path.clone(), data.to_owned());
                StorageEventKind::Add
            }
        };
        self.emit(&path, kind);
        Ok(())
    }

    fn exists(&self, path: &str) -> Result<bool, EngineError> {
        let path = normalize_path(path);
        if Self::is_virtual_root(&path) {
            return Ok(true);
        }
        let files =
            self.inner.files.lock().map_err(|_| {
                storage_error(&path, StorageOperation::Read, "Poisoned memory storage")
            })?;
        Ok(files.contains_key(&path)
            || files
                .keys()
                .any(|key| Self::relative_entry(&path, key).is_some()))
    }

    fn remove(&self, path: &str) -> Result<(), EngineError> {
        let path = normalize_path(path);
        Self::require_file_path(&path, StorageOperation::Delete)?;
        let removed = self
            .inner
            .files
            .lock()
            .map_err(|_| storage_error(&path, StorageOperation::Delete, "Poisoned memory storage"))?
            .remove(&path);
        if removed.is_none() {
            return Err(storage_error(
                &path,
                StorageOperation::Delete,
                format!("File not found: '{path}'"),
            ));
        }
        self.emit(&path, StorageEventKind::Remove);
        Ok(())
    }

    fn ensure_dir(&self, _path: &str) -> Result<(), EngineError> {
        Ok(())
    }

    fn is_directory(&self, path: &str) -> Result<bool, EngineError> {
        let normalized = normalize_path(path);
        if Self::is_virtual_root(&normalized) {
            return Ok(true);
        }
        let files =
            self.inner.files.lock().map_err(|_| {
                storage_error(path, StorageOperation::List, "Poisoned memory storage")
            })?;
        Ok(files
            .keys()
            .any(|key| Self::relative_entry(&normalized, key).is_some()))
    }
    fn list_directory(&self, dir_path: &str) -> Result<Vec<String>, EngineError> {
        let dir_path = normalize_path(dir_path);
        let files = self.inner.files.lock().map_err(|_| {
            storage_error(&dir_path, StorageOperation::List, "Poisoned memory storage")
        })?;
        let mut entries = BTreeSet::new();
        for path in files.keys() {
            let Some(rest) = Self::relative_entry(&dir_path, path) else {
                continue;
            };
            if rest.is_empty() {
                continue;
            }
            if let Some((first, _)) = rest.split_once('/') {
                entries.insert(join_path(&dir_path, first));
            } else {
                entries.insert(path.clone());
            }
        }
        Ok(entries.into_iter().collect())
    }

    fn list_recursive(&self, root_path: &str) -> Result<Vec<String>, EngineError> {
        let root_path = normalize_path(root_path);
        let files = self.inner.files.lock().map_err(|_| {
            storage_error(
                &root_path,
                StorageOperation::List,
                "Poisoned memory storage",
            )
        })?;
        let mut entries = files
            .keys()
            .filter(|path| *path == &root_path || Self::relative_entry(&root_path, path).is_some())
            .cloned()
            .collect::<Vec<_>>();
        entries.sort();
        Ok(entries)
    }

    fn watch(
        &self,
        path: &str,
        on_change: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        self.insert_watch(WatchTarget::Path(normalize_path(path)), on_change)
    }

    fn watch_dir(
        &self,
        path: &str,
        on_change: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        self.insert_watch(WatchTarget::Dir(normalize_path(path)), on_change)
    }
}
