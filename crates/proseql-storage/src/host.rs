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
    /// The changed path as the host reports it, when known. Lets a runtime
    /// tell its own writes apart from a same-named file elsewhere under a
    /// watched directory.
    pub path: Option<String>,
}

pub trait WatchHandle: Send + Sync {
    fn stop(&self) -> Result<(), EngineError>;
}

/// Synchronous platform I/O boundary for the Rust engine's storage layer.
///
/// Paths are host-owned identifiers. Use one consistent representation for
/// reads, listings and events; listings contain complete file paths, not bare
/// names. `list_directory` lists immediate files and `list_recursive` lists all
/// descendant files. Neither includes directories. `ensure_dir` receives a
/// *file* path and prepares its parent directory; key/value hosts may do nothing.
/// Missing reads fail, `exists` reports absence, and I/O failures use
/// `EngineError::Storage` with the original path and operation.
///
/// Watch callbacks report additions, changes and removals, including atomic
/// replacement. They must not run while holding a host lock needed by reads or
/// writes. The returned handle releases the subscription when stopped. Supply
/// `StorageEvent::path` when possible to distinguish equal filenames in different
/// directories. Consumers must tolerate coalesced notifications and reload.
///
/// `write` and `append` alone promise no crash durability. Native runtime hosts
/// also implement [`crate::persistence::DurableStorageHost`]. A successful
/// durable replacement must be recoverable after interruption; never silently
/// substitute an ordinary write. See `docs/native-sources.md` for ownership,
/// synchronization, watch lifecycle and crash rules.
/// File metadata for change detection. `modified_ns` is the modification time
/// in nanoseconds since the Unix epoch. `change_id` is a host-specific identity
/// that changes when the file is replaced (for example device, inode and
/// ctime combined); `None` when the host has none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStat {
    pub len: u64,
    pub modified_ns: Option<u128>,
    pub change_id: Option<u64>,
}

pub trait StorageHost: Send + Sync {
    fn read(&self, path: &str) -> Result<String, EngineError>;
    /// Read a file's raw bytes. Append-only JSONL loading uses it so that an
    /// interrupted final line that ends inside a UTF-8 sequence can still be
    /// classified as torn. The default reads text; hosts that can hold
    /// non-UTF-8 bytes should override it.
    fn read_bytes(&self, path: &str) -> Result<Vec<u8>, EngineError> {
        self.read(path).map(String::into_bytes)
    }
    /// Read at most `len` bytes starting at byte `offset`. A short result
    /// means end of file. Query-while-scanning readers use it to keep memory
    /// bounded. The default reads the whole file and slices it, which is
    /// correct but unbounded; hosts that can seek should override it
    /// (`FsStorageHost` does; owner `formats`).
    fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, EngineError> {
        let bytes = self.read_bytes(path)?;
        let start = usize::try_from(offset)
            .unwrap_or(usize::MAX)
            .min(bytes.len());
        let end = start.saturating_add(len).min(bytes.len());
        Ok(bytes[start..end].to_vec())
    }
    /// Cheap file metadata for change detection, or `None` when the file is
    /// missing. The default derives the length from a full read and reports
    /// no stamp, so callers fall back to content hashes. `FsStorageHost`
    /// overrides it (owner `formats`).
    fn stat(&self, path: &str) -> Result<Option<FileStat>, EngineError> {
        if !self.exists(path)? {
            return Ok(None);
        }
        Ok(Some(FileStat {
            len: self.read_bytes(path)?.len() as u64,
            modified_ns: None,
            change_id: None,
        }))
    }
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
