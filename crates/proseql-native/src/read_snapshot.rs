//! Capture the exact bytes decoded during one load. A later disk read must not
//! replace the conflict baseline while the database still contains older data.
use indexmap::IndexMap;
use proseql_engine::errors::EngineError;
use proseql_storage::host::{StorageEvent, StorageHost, WatchHandle};
use std::sync::Mutex;

pub(crate) struct ReadSnapshot<'a> {
    host: &'a dyn StorageHost,
    /// Raw bytes of every file read, so text and byte reads of one file see
    /// the same snapshot.
    contents: Mutex<IndexMap<String, Vec<u8>>>,
}

impl<'a> ReadSnapshot<'a> {
    pub fn new(host: &'a dyn StorageHost) -> Self {
        Self {
            host,
            contents: Mutex::new(IndexMap::new()),
        }
    }
}

fn write_error() -> EngineError {
    crate::operation_error("load-write", "Source loads cannot write")
}

impl StorageHost for ReadSnapshot<'_> {
    fn read(&self, path: &str) -> Result<String, EngineError> {
        let mut contents = self
            .contents
            .lock()
            .map_err(|_| crate::operation_error("poisoned", "Read snapshot lock is poisoned"))?;
        if let Some(content) = contents.get(path) {
            return String::from_utf8(content.clone()).map_err(|error| {
                EngineError::Storage(Box::new(proseql_engine::errors::StorageError {
                    path: path.to_owned(),
                    operation: proseql_engine::errors::StorageOperation::Read,
                    message: format!("Failed to read '{path}': {error}"),
                    cause: None,
                }))
            });
        }
        // Text reads keep the host's own strict decoding and errors.
        let content = self.host.read(path)?;
        contents.insert(path.into(), content.clone().into_bytes());
        Ok(content)
    }
    fn read_bytes(&self, path: &str) -> Result<Vec<u8>, EngineError> {
        let mut contents = self
            .contents
            .lock()
            .map_err(|_| crate::operation_error("poisoned", "Read snapshot lock is poisoned"))?;
        if let Some(content) = contents.get(path) {
            return Ok(content.clone());
        }
        let content = self.host.read_bytes(path)?;
        contents.insert(path.into(), content.clone());
        Ok(content)
    }
    fn exists(&self, path: &str) -> Result<bool, EngineError> {
        self.host.exists(path)
    }
    fn list_directory(&self, path: &str) -> Result<Vec<String>, EngineError> {
        self.host.list_directory(path)
    }
    fn list_recursive(&self, path: &str) -> Result<Vec<String>, EngineError> {
        self.host.list_recursive(path)
    }
    fn write(&self, _: &str, _: &str) -> Result<(), EngineError> {
        Err(write_error())
    }
    fn append(&self, _: &str, _: &str) -> Result<(), EngineError> {
        Err(write_error())
    }
    fn remove(&self, _: &str) -> Result<(), EngineError> {
        Err(write_error())
    }
    fn ensure_dir(&self, _: &str) -> Result<(), EngineError> {
        Err(write_error())
    }
    fn watch(
        &self,
        _: &str,
        _: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        Err(write_error())
    }
    fn watch_dir(
        &self,
        _: &str,
        _: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        Err(write_error())
    }
}
