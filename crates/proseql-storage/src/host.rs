use proseql_engine::errors::{EngineError, StorageError, StorageOperation};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageEventKind {
    Add,
    Change,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageEvent {
    pub filename: Option<String>,
    pub kind: StorageEventKind,
}

pub trait WatchHandle: Send + Sync {
    fn stop(&self) -> Result<(), EngineError>;
}

pub trait StorageHost: Send + Sync {
    fn read(&self, path: &str) -> Result<String, EngineError>;
    fn write(&self, path: &str, data: &str) -> Result<(), EngineError>;
    fn append(&self, path: &str, data: &str) -> Result<(), EngineError>;
    fn exists(&self, path: &str) -> Result<bool, EngineError>;
    fn remove(&self, path: &str) -> Result<(), EngineError>;
    fn ensure_dir(&self, path: &str) -> Result<(), EngineError>;
    fn list_directory(&self, dir_path: &str) -> Result<Vec<String>, EngineError>;
    fn list_recursive(&self, root_path: &str) -> Result<Vec<String>, EngineError>;
    fn watch(
        &self,
        path: &str,
        on_change: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError>;
    fn watch_dir(
        &self,
        path: &str,
        on_change: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError>;
}

pub(crate) fn storage_error(
    path: impl Into<String>,
    operation: StorageOperation,
    message: impl Into<String>,
) -> EngineError {
    EngineError::Storage(Box::new(StorageError {
        path: path.into(),
        operation,
        message: message.into(),
        cause: None,
    }))
}
