//! Streaming creates use the real global locator and the ordinary durable
//! source commit path. No existing partition enters the engine collection.
mod support;

use proseql_engine::errors::{EngineError, OperationError};
use proseql_engine::query::pipeline::QueryInput;
use proseql_engine::reactive::WatchQueryConfig;
use proseql_native::{ExecutionModel, NativeRuntime};
use proseql_storage::fs::{DurabilityFaultInjector, DurabilityFaultPoint, FsStorageHost};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::parity::{sample, ParityFixture, COLLECTION, SOURCE};

fn empty_engine(runtime: &NativeRuntime) {
    assert_eq!(
        runtime
            .read(|db| Ok(db.collection(COLLECTION).unwrap().len()))
            .unwrap(),
        0
    );
    assert!(runtime
        .lazy_partition_status(SOURCE)
        .unwrap()
        .unwrap()
        .loaded
        .is_empty());
}

#[test]
fn new_rows_append_without_loading_any_partition_and_are_visible_after_commit() {
    let fixture = ParityFixture::new(1440);
    let runtime = fixture.open(ExecutionModel::Streaming);
    let rows = vec![
        sample("2025-01", 1, 1, "steps"),
        sample("2025-04", 1, 1, "heartRate"),
    ];
    let result = runtime
        .mutate(|db| db.create_many(COLLECTION, rows.clone()))
        .unwrap();
    assert_eq!(result.created, rows);
    empty_engine(&runtime);
    for row in &rows {
        assert_eq!(
            runtime
                .find_by_id(COLLECTION, row["id"].as_str().unwrap())
                .unwrap(),
            Some(row.clone())
        );
        assert_eq!(
            runtime
                .query(
                    COLLECTION,
                    QueryInput {
                        r#where: Some(json!({"id": row["id"]})),
                        ..Default::default()
                    },
                    None
                )
                .unwrap(),
            vec![row.clone()]
        );
    }
}

#[test]
fn differential_creates_identical_recreates_and_validation_rollback() {
    let fixture = ParityFixture::new(1440);
    fixture
        .assert_same(|runtime| {
            let new = sample("2025-01", 1, 1, "steps");
            let created = runtime.mutate(|db| db.create(COLLECTION, new.clone()))?;
            assert_eq!(
                runtime.mutate(|db| db.create(COLLECTION, new.clone()))?,
                created
            );
            let mut invalid = sample("2025-02", 1, 1, "steps");
            invalid["value"] = json!("invalid");
            let error = runtime
                .mutate(|db| {
                    db.create_many(COLLECTION, vec![sample("2025-03", 1, 1, "steps"), invalid])
                })
                .unwrap_err();
            Ok((created, error))
        })
        .unwrap();
}

#[test]
fn duplicate_in_an_unloaded_other_partition_is_rejected_and_catching_it_cannot_publish_it() {
    let fixture = ParityFixture::new(1440);
    let runtime = fixture.open(ExecutionModel::Streaming);
    let before = fs::read(fixture.partition_path("2025-03")).unwrap();
    let mut duplicate = sample("2025-03", 1, 1, "steps");
    duplicate["id"] = sample("2025-01", 1, 0, "steps")["id"].clone();
    runtime
        .mutate(|db| {
            let error = db.create(COLLECTION, duplicate.clone()).unwrap_err();
            assert_eq!(error.tag(), "DuplicateKeyError");
            Ok(())
        })
        .unwrap();
    empty_engine(&runtime);
    assert_eq!(fs::read(fixture.partition_path("2025-03")).unwrap(), before);
}

#[test]
fn identical_recreate_compares_the_validated_stored_record_and_does_not_write() {
    let fixture = ParityFixture::new(1440);
    let mut existing = sample("2025-01", 1, 0, "steps");
    existing["notInSchema"] = json!("stripped on load");
    fs::write(fixture.partition_path("2025-01"), format!("{existing}\n")).unwrap();
    let before = fs::read(fixture.partition_path("2025-01")).unwrap();
    let runtime = fixture.open(ExecutionModel::Streaming);
    let expected = sample("2025-01", 1, 0, "steps");
    let actual = runtime
        .mutate(|db| db.create(COLLECTION, expected.clone()))
        .unwrap();
    assert_eq!(actual, expected);
    assert_eq!(fs::read(fixture.partition_path("2025-01")).unwrap(), before);
    empty_engine(&runtime);
    let mut different = expected;
    different["value"] = json!(-1);
    assert_eq!(
        runtime
            .mutate(|db| db.create(COLLECTION, different))
            .unwrap_err()
            .tag(),
        "DuplicateKeyError"
    );
    empty_engine(&runtime);
}

#[test]
fn rejected_batch_unloads_candidates_and_leaves_engine_and_disk_empty_of_new_rows() {
    let fixture = ParityFixture::new(1440);
    let runtime = fixture.open(ExecutionModel::Streaming);
    let before = fs::read(fixture.partition_path("2025-01")).unwrap();
    let mut invalid = sample("2025-02", 1, 1, "steps");
    invalid["value"] = Value::Null;
    runtime
        .mutate(|db| {
            assert_eq!(
                db.create_many(
                    COLLECTION,
                    vec![
                        sample("2025-01", 1, 0, "steps"),
                        sample("2025-01", 1, 1, "steps"),
                        invalid
                    ]
                )
                .unwrap_err()
                .tag(),
                "ValidationError"
            );
            Ok(())
        })
        .unwrap();
    empty_engine(&runtime);
    assert_eq!(fs::read(fixture.partition_path("2025-01")).unwrap(), before);
    assert!(runtime
        .find_by_id(
            COLLECTION,
            sample("2025-01", 1, 1, "steps")["id"].as_str().unwrap()
        )
        .unwrap()
        .is_none());
}

#[test]
#[ignore = "needs mutate's streaming watch; un-ignored at integration"]
fn a_watch_sees_the_create_but_not_the_silent_engine_removal() {
    let fixture = ParityFixture::new(1440);
    let runtime = fixture.open(ExecutionModel::Streaming);
    let watch = runtime
        .watch(
            COLLECTION,
            WatchQueryConfig {
                r#where: Some(json!({"atUtc": {"$startsWith": "2025-04"}})),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(watch.try_recv().unwrap(), json!([]));
    let row = sample("2025-04", 1, 0, "steps");
    runtime
        .mutate(|db| db.create(COLLECTION, row.clone()))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(value) = watch.try_recv() {
            assert_eq!(value, json!([row]));
            break;
        }
        assert!(Instant::now() < deadline, "watch did not see create");
        std::thread::sleep(Duration::from_millis(10));
    }
    empty_engine(&runtime);
    std::thread::sleep(Duration::from_millis(50));
    assert!(watch.try_recv().is_err());
}

#[test]
fn an_external_append_between_staging_and_commit_rejects_and_rolls_back() {
    let fixture = ParityFixture::new(1440);
    let runtime = fixture.open(ExecutionModel::Streaming);
    let ours = sample("2025-01", 1, 1, "steps");
    let error = runtime
        .mutate(|db| {
            db.create(COLLECTION, ours.clone())?;
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .append(true)
                .open(fixture.partition_path("2025-01"))
                .unwrap();
            writeln!(file, "{}", sample("2025-01", 1, 2, "steps")).unwrap();
            Ok(())
        })
        .unwrap_err();
    assert!(matches!(error, EngineError::Operation(ref error) if error.reason == "source-changed"));
    empty_engine(&runtime);
    assert!(!fs::read_to_string(fixture.partition_path("2025-01"))
        .unwrap()
        .contains(ours["id"].as_str().unwrap()));
}

struct FailAt(DurabilityFaultPoint);
impl DurabilityFaultInjector for FailAt {
    fn check(&self, point: DurabilityFaultPoint) -> Result<(), EngineError> {
        if point == self.0 {
            return Err(EngineError::Operation(OperationError {
                operation: "append".into(),
                reason: "injected-failure".into(),
                message: format!("injected {point:?}"),
            }));
        }
        Ok(())
    }
}

#[test]
fn append_write_and_sync_faults_roll_back_and_quarantine_without_weakening_durability() {
    for point in [
        DurabilityFaultPoint::AppendWrite,
        DurabilityFaultPoint::AppendSync,
    ] {
        let fixture = ParityFixture::new(1440);
        let before = fs::read(fixture.partition_path("2025-01")).unwrap();
        let host = Arc::new(
            FsStorageHost::new_polling_with_fault_injector(
                Duration::from_secs(2),
                Arc::new(FailAt(point)),
            )
            .unwrap(),
        );
        let runtime = NativeRuntime::open_sources_with_host(
            fixture.config(),
            host,
            fixture.options(ExecutionModel::Streaming),
        )
        .unwrap();
        let row = sample("2025-01", 1, 1, "steps");
        let error = runtime
            .mutate(|db| db.create(COLLECTION, row.clone()))
            .unwrap_err();
        assert_eq!(error.tag(), "StorageError", "{error}");
        assert!(error.to_string().contains("completed paths"));
        assert!(runtime
            .find_by_id(COLLECTION, row["id"].as_str().unwrap())
            .is_err());
        runtime.close().unwrap();
        assert_eq!(fs::read(fixture.partition_path("2025-01")).unwrap(), before);
        let reopened = fixture.open(ExecutionModel::Streaming);
        assert_eq!(
            reopened
                .find_by_id(COLLECTION, row["id"].as_str().unwrap())
                .unwrap(),
            None
        );
    }
}

struct PauseAt(PathBuf);
impl DurabilityFaultInjector for PauseAt {
    fn check(&self, point: DurabilityFaultPoint) -> Result<(), EngineError> {
        if point == DurabilityFaultPoint::AppendWrite {
            fs::write(&self.0, "ready").unwrap();
            loop {
                std::thread::park();
            }
        }
        Ok(())
    }
}

#[test]
#[ignore = "subprocess-only crash boundary"]
fn streaming_append_crash_child() {
    let root = PathBuf::from(std::env::var("PROSEQL_STREAMING_APPEND_CRASH_ROOT").unwrap());
    let fixture = ParityFixture::new(1440);
    let mut config = fixture.config();
    if let proseql_storage::source_config::DatabaseSourceConfig::Partitioned(source) =
        &mut config.sources[0]
    {
        source.root = root.to_string_lossy().into_owned();
    }
    let host = Arc::new(
        FsStorageHost::new_polling_with_fault_injector(
            Duration::from_secs(2),
            Arc::new(PauseAt(root.join("ready"))),
        )
        .unwrap(),
    );
    let runtime = NativeRuntime::open_sources_with_host(
        config,
        host,
        fixture.options(ExecutionModel::Streaming),
    )
    .unwrap();
    runtime
        .mutate(|db| db.create(COLLECTION, sample("2025-01", 1, 1, "steps")))
        .unwrap();
}

#[test]
fn killed_mid_append_keeps_a_torn_suffix_and_next_append_truncates_it() {
    let fixture = ParityFixture::new(1440);
    let before = fs::read(fixture.partition_path("2025-01")).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "streaming_append_crash_child", "--ignored"])
        .env("PROSEQL_STREAMING_APPEND_CRASH_ROOT", fixture.root())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !fixture.root().join("ready").exists() {
        assert!(
            child.try_wait().unwrap().is_none(),
            "child exited before append boundary"
        );
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("child did not reach append boundary");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    child.kill().unwrap();
    child.wait().unwrap();
    let torn = fs::read(fixture.partition_path("2025-01")).unwrap();
    assert!(torn.starts_with(&before) && torn.len() > before.len());
    assert!(!torn.ends_with(b"\n"));
    let runtime = fixture.open(ExecutionModel::Streaming);
    let row = sample("2025-01", 1, 1, "steps");
    runtime
        .mutate(|db| db.create(COLLECTION, row.clone()))
        .unwrap();
    let mut expected = before;
    expected.extend_from_slice(format!("{row}\n").as_bytes());
    assert_eq!(
        fs::read(fixture.partition_path("2025-01")).unwrap(),
        expected
    );
    empty_engine(&runtime);
}
