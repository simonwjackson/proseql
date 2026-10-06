//! Capture the exact bytes decoded during one load. A later disk read must not
//! replace the conflict baseline while the database still contains older data.
use indexmap::IndexMap;
use proseql_engine::errors::EngineError;
use proseql_storage::host::{StorageEvent, StorageHost, WatchHandle};
use std::sync::Mutex;

pub(crate) struct ReadSnapshot<'a> {
    host: &'a dyn StorageHost,
    contents: Mutex<IndexMap<String, String>>,
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
            return Ok(content.clone());
        }
        let content = self.host.read(path)?;
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
