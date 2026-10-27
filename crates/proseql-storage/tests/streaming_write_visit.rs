use proseql_engine::errors::{EngineError, OperationError};
use proseql_storage::{fs::FsStorageHost, host::StorageHost, memory::MemoryStorageHost};
use std::time::Duration;

fn check(host: &dyn StorageHost, path: &str) {
    for len in [0, 1, 65535, 65536, 65537, 3 * 65536 + 17] {
        let content = "x".repeat(len);
        host.write(path, &content).unwrap();
        let mut bytes = Vec::new();
        host.visit_bytes(path, &mut |chunk| {
            assert!(chunk.len() <= 65536);
            bytes.extend_from_slice(chunk);
            Ok(())
        })
        .unwrap();
        assert_eq!(bytes, host.read_bytes(path).unwrap());
    }
    let expected = EngineError::Operation(OperationError {
        operation: "visit".into(),
        reason: "stop".into(),
        message: "visitor failed".into(),
    });
    let mut calls = 0;
    let actual = host
        .visit_bytes(path, &mut |_| {
            calls += 1;
            Err(expected.clone())
        })
        .unwrap_err();
    assert_eq!(calls, 1);
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
    host.remove(path).unwrap();
    let expected = host.read_bytes(path).unwrap_err();
    let actual = host
        .visit_bytes(path, &mut |_| panic!("missing file has no chunks"))
        .unwrap_err();
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
}

#[test]
fn filesystem_visits_match_bytes_and_preserve_errors() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rows.jsonl");
    let host = FsStorageHost::new_polling(Duration::from_secs(3600)).unwrap();
    check(&host, path.to_str().unwrap());
}

#[test]
fn default_memory_visits_match_bytes_and_preserve_errors() {
    check(&MemoryStorageHost::default(), "rows.jsonl");
}
