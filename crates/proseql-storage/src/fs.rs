#![cfg(not(target_arch = "wasm32"))]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Config, EventKind, PollWatcher, RecursiveMode, Watcher};
use proseql_engine::errors::{EngineError, StorageOperation};
use walkdir::WalkDir;

use crate::host::{storage_error, StorageEvent, StorageEventKind, StorageHost, WatchHandle};
use crate::path::normalize_path;

#[derive(Clone)]
pub struct FsStorageHost {
    poll_interval: Duration,
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
        Ok(Self { poll_interval })
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
                    .first()
                    .and_then(|path| path.file_name())
                    .and_then(|name| name.to_str())
                    .map(str::to_owned)
                    .or_else(|| {
                        watch_root_for_handler
                            .file_name()
                            .and_then(|name| name.to_str())
                            .map(str::to_owned)
                    });
                callback_for_watcher(&event, StorageEvent { filename, kind });
            },
            Config::default().with_poll_interval(self.poll_interval),
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

impl StorageHost for FsStorageHost {
    fn read(&self, path: &str) -> Result<String, EngineError> {
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
        use std::io::Write;
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
