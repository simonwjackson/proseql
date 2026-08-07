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
