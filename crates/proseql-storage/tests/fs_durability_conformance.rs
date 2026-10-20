#![cfg(not(target_arch = "wasm32"))]

use std::sync::Arc;
use std::time::Duration;

use proseql_engine::errors::{EngineError, StorageError, StorageOperation};
use proseql_storage::fs::{DurabilityFaultInjector, DurabilityFaultPoint, FsStorageHost};
use proseql_storage::host::StorageHost;
use proseql_storage::persistence::DurableStorageHost;

struct FailAt(DurabilityFaultPoint);

struct FailDirectorySyncAnd(DurabilityFaultPoint);

impl DurabilityFaultInjector for FailDirectorySyncAnd {
    fn check(&self, point: DurabilityFaultPoint) -> Result<(), EngineError> {
        if point == DurabilityFaultPoint::DirectorySync || point == self.0 {
            Err(EngineError::Storage(Box::new(StorageError {
                path: "fault-injection".into(),
                operation: StorageOperation::Write,
                message: format!("injected {point:?} failure"),
                cause: None,
            })))
        } else {
            Ok(())
        }
    }
}

impl DurabilityFaultInjector for FailAt {
    fn check(&self, point: DurabilityFaultPoint) -> Result<(), EngineError> {
        if point == self.0 {
            Err(EngineError::Storage(Box::new(StorageError {
                path: "fault-injection".into(),
                operation: StorageOperation::Write,
                message: format!("injected {point:?} failure"),
                cause: None,
            })))
        } else {
            Ok(())
        }
    }
}

#[test]
fn every_persistence_boundary_failure_retains_prior_file() {
    for point in [
        DurabilityFaultPoint::StageWrite,
        DurabilityFaultPoint::FileSync,
        DurabilityFaultPoint::PendingMarkerWrite,
        DurabilityFaultPoint::PendingMarkerSync,
        DurabilityFaultPoint::PendingMarkerDirectorySync,
        DurabilityFaultPoint::AtomicReplace,
        DurabilityFaultPoint::DirectorySync,
        DurabilityFaultPoint::CommitMarkerWrite,
        DurabilityFaultPoint::CommitMarkerSync,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        std::fs::write(&path, "last-known-good").unwrap();
        let host = FsStorageHost::new_polling_with_fault_injector(
            Duration::from_millis(10),
            Arc::new(FailAt(point)),
        )
        .unwrap();

        assert!(host
            .replace_durable(path.to_str().unwrap(), "candidate")
            .is_err());
        assert_eq!(
            host.read(path.to_str().unwrap()).unwrap(),
            "last-known-good"
        );
        let residue = std::fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(residue, vec!["state.json"], "residue after {point:?}");
    }
}

#[test]
fn durable_replace_installs_complete_content_and_cleans_staging_files() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.json");
    std::fs::write(&path, "old").unwrap();
    let host = FsStorageHost::new_polling(Duration::from_millis(10)).unwrap();

    host.replace_durable(path.to_str().unwrap(), "new-complete-state")
        .unwrap();

    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "new-complete-state"
    );
    let names = std::fs::read_dir(temp.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["state.json"]);
}

#[test]
fn durable_replace_recovers_an_interrupted_backup_before_next_commit() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.json");
    let backup = temp.path().join(".state.json.proseql-backup");
    std::fs::write(&path, "uncommitted-candidate").unwrap();
    std::fs::write(&backup, "last-known-good").unwrap();
    let host = FsStorageHost::new_polling(Duration::from_millis(10)).unwrap();

    assert_eq!(
        host.read(path.to_str().unwrap()).unwrap(),
        "last-known-good"
    );
    assert!(!backup.exists());

    host.replace_durable(path.to_str().unwrap(), "next-state")
        .unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "next-state");
}

#[test]
fn durable_commit_marker_keeps_acknowledged_candidate_during_cleanup_recovery() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.json");
    let backup = temp.path().join(".state.json.proseql-backup");
    let committed = temp.path().join(".state.json.proseql-committed");
    std::fs::write(&path, "acknowledged-candidate").unwrap();
    std::fs::write(&backup, "prior-state").unwrap();
    std::fs::write(&committed, b"C").unwrap();
    let host = FsStorageHost::new_polling(Duration::from_millis(10)).unwrap();

    assert_eq!(
        host.read(path.to_str().unwrap()).unwrap(),
        "acknowledged-candidate"
    );
    assert!(!backup.exists());
    assert!(!committed.exists());
}

#[test]
fn pending_or_malformed_marker_recovers_prior_state() {
    for marker in [b"P".as_slice(), b"?".as_slice(), b"broken".as_slice()] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        let backup = temp.path().join(".state.json.proseql-backup");
        let committed = temp.path().join(".state.json.proseql-committed");
        std::fs::write(&path, "unacknowledged-candidate").unwrap();
        std::fs::write(&backup, "prior-state").unwrap();
        std::fs::write(&committed, marker).unwrap();
        let host = FsStorageHost::new_polling(Duration::from_millis(10)).unwrap();

        assert_eq!(host.read(path.to_str().unwrap()).unwrap(), "prior-state");
        assert!(!backup.exists());
        assert!(!committed.exists());
    }
}

#[test]
fn pending_first_write_removes_unacknowledged_candidate() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.json");
    let committed = temp.path().join(".state.json.proseql-committed");
    std::fs::write(&path, "unacknowledged-first-write").unwrap();
    std::fs::write(&committed, b"P").unwrap();
    let host = FsStorageHost::new_polling(Duration::from_millis(10)).unwrap();

    assert!(!host.exists(path.to_str().unwrap()).unwrap());
    assert!(!committed.exists());
}

#[test]
fn cleanup_failure_returns_success_and_recovery_keeps_committed_candidate() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.json");
    std::fs::write(&path, "old").unwrap();
    let host = FsStorageHost::new_polling_with_fault_injector(
        Duration::from_millis(10),
        Arc::new(FailAt(DurabilityFaultPoint::Cleanup)),
    )
    .unwrap();

    host.replace_durable(path.to_str().unwrap(), "new").unwrap();
    let backup = temp.path().join(".state.json.proseql-backup");
    let committed = temp.path().join(".state.json.proseql-committed");
    assert!(backup.exists());
    assert!(committed.exists());

    let recovering = FsStorageHost::new_polling(Duration::from_millis(10)).unwrap();
    assert_eq!(recovering.read(path.to_str().unwrap()).unwrap(), "new");
    assert!(!backup.exists());
    assert!(!committed.exists());
}

#[test]
fn failed_rollback_preserves_backup_for_required_next_read_recovery() {
    for point in [
        DurabilityFaultPoint::RollbackReplace,
        DurabilityFaultPoint::RollbackDirectorySync,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        std::fs::write(&path, "last-known-good").unwrap();
        let host = FsStorageHost::new_polling_with_fault_injector(
            Duration::from_millis(10),
            Arc::new(FailDirectorySyncAnd(point)),
        )
        .unwrap();

        assert!(host
            .replace_durable(path.to_str().unwrap(), "candidate")
            .is_err());
        let backup = temp.path().join(".state.json.proseql-backup");
        assert!(backup.exists(), "LKG backup must survive failed rollback");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "last-known-good");

        let recovering = FsStorageHost::new_polling(Duration::from_millis(10)).unwrap();
        assert_eq!(
            recovering.read(path.to_str().unwrap()).unwrap(),
            "last-known-good"
        );
        assert!(!backup.exists());
    }
}

#[test]
fn durable_append_truncates_to_the_kept_length_and_creates_missing_files() {
    let temp = tempfile::tempdir().unwrap();
    let host = FsStorageHost::new_polling(Duration::from_secs(2)).unwrap();
    let path = temp.path().join("nested/log.jsonl");
    let path = path.to_str().unwrap();

    host.append_durable(path, 0, "{\"a\":1}\n").unwrap();
    std::fs::write(path, "{\"a\":1}\n{\"b\"").unwrap();
    host.append_durable(path, 8, "{\"c\":3}\n").unwrap();
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "{\"a\":1}\n{\"c\":3}\n"
    );

    let tail = host.read_tail(path, 4).unwrap().unwrap();
    assert_eq!(tail.len, 16);
    assert_eq!(tail.tail, b":3}\n");
    assert!(host
        .read_tail(temp.path().join("missing.jsonl").to_str().unwrap(), 4)
        .unwrap()
        .is_none());
    assert!(host.append_durable(path, 99, "x\n").is_err());
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "{\"a\":1}\n{\"c\":3}\n"
    );
}

#[test]
fn failed_durable_append_restores_the_kept_bytes() {
    for point in [
        DurabilityFaultPoint::AppendWrite,
        DurabilityFaultPoint::AppendSync,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let existing = temp.path().join("log.jsonl");
        std::fs::write(&existing, "{\"a\":1}\n").unwrap();
        let fresh = temp.path().join("fresh.jsonl");
        let host = FsStorageHost::new_polling_with_fault_injector(
            Duration::from_secs(2),
            Arc::new(FailAt(point)),
        )
        .unwrap();
        assert!(host
            .append_durable(existing.to_str().unwrap(), 8, "{\"b\":2}\n")
            .is_err());
        assert_eq!(std::fs::read_to_string(&existing).unwrap(), "{\"a\":1}\n");
        assert!(host
            .append_durable(fresh.to_str().unwrap(), 0, "{\"b\":2}\n")
            .is_err());
        assert!(!fresh.exists(), "{point:?}");
    }
}

/// A host without its own append uses the durable full-replace default.
struct ReplaceOnly(FsStorageHost);

impl DurableStorageHost for ReplaceOnly {
    fn replace_durable(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.0.replace_durable(path, data)
    }
}

impl StorageHost for ReplaceOnly {
    fn read(&self, path: &str) -> Result<String, EngineError> {
        self.0.read(path)
    }
    fn write(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.0.write(path, data)
    }
    fn append(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.0.append(path, data)
    }
    fn exists(&self, path: &str) -> Result<bool, EngineError> {
        self.0.exists(path)
    }
    fn remove(&self, path: &str) -> Result<(), EngineError> {
        self.0.remove(path)
    }
    fn ensure_dir(&self, path: &str) -> Result<(), EngineError> {
        self.0.ensure_dir(path)
    }
    fn list_directory(&self, path: &str) -> Result<Vec<String>, EngineError> {
        self.0.list_directory(path)
    }
    fn list_recursive(&self, path: &str) -> Result<Vec<String>, EngineError> {
        self.0.list_recursive(path)
    }
    fn watch(
        &self,
        path: &str,
        on_change: Box<dyn Fn(proseql_storage::host::StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn proseql_storage::host::WatchHandle>, EngineError> {
        self.0.watch(path, on_change)
    }
    fn watch_dir(
        &self,
        path: &str,
        on_change: Box<dyn Fn(proseql_storage::host::StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn proseql_storage::host::WatchHandle>, EngineError> {
        self.0.watch_dir(path, on_change)
    }
}

#[test]
fn default_durable_append_matches_the_filesystem_append() {
    let temp = tempfile::tempdir().unwrap();
    let host = ReplaceOnly(FsStorageHost::new_polling(Duration::from_secs(2)).unwrap());
    let path = temp.path().join("log.jsonl");
    let path = path.to_str().unwrap();
    host.append_durable(path, 0, "{\"a\":1}\n").unwrap();
    std::fs::write(path, "{\"a\":1}\n{\"b\"").unwrap();
    host.append_durable(path, 8, "{\"c\":3}\n").unwrap();
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "{\"a\":1}\n{\"c\":3}\n"
    );
    let tail = host.read_tail(path, 4).unwrap().unwrap();
    assert_eq!((tail.len, tail.tail), (16, b":3}\n".to_vec()));
}
