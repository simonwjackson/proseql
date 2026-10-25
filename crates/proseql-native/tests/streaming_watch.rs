mod support;
use support::parity::RuntimeKind;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use proseql_engine::errors::{EngineError, OperationError};
use proseql_engine::query::pipeline::QueryInput;
use proseql_engine::query::SortOrder;
use proseql_engine::reactive::{ChangeOperation, WatchQueryConfig};
use proseql_native::{
    FullScanPolicy, LazyPartitionPolicy, NativeCollectionConfig, NativeRuntime,
    NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::fs::{DurabilityFaultInjector, DurabilityFaultPoint, FsStorageHost};
use proseql_storage::source_config::{
    DatabaseSourceConfig, PartitionKey, PartitionedSourceConfig, TimeBucket,
};
use serde_json::{json, Value};
use support::parity::{self, ParityFixture, COLLECTION, SOURCE};

type Watch = proseql_native::NativeWatch<proseql_engine::reactive::ValueSubscription>;

fn options(managed: bool) -> NativeSourceRuntimeOptions {
    NativeSourceRuntimeOptions {
        watch_debounce: managed.then_some(Duration::from_millis(10)),
        lazy_watch_interval: Duration::from_millis(30),
        lazy_partitions: IndexMap::from([(
            SOURCE.into(),
            LazyPartitionPolicy {
                max_loaded_partitions: 0,
                full_scan: FullScanPolicy::Allow,
            },
        )]),
        ..Default::default()
    }
}

fn config(root: &Path) -> NativeSourceRuntimeConfig {
    NativeSourceRuntimeConfig {
        collections: vec![NativeCollectionConfig::new(parity::descriptor())],
        sources: vec![DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
            id: SOURCE.into(),
            collection: COLLECTION.into(),
            root: root.to_string_lossy().into_owned(),
            format: "jsonl".into(),
            partition_by: PartitionKey::TimeBucket {
                field: "atUtc".into(),
                bucket: TimeBucket::Month,
            },
            prose: None,
        })],
    }
}

fn open(fixture: &ParityFixture, managed: bool) -> NativeRuntime {
    NativeRuntime::open_sources_with_options(fixture.config(), options(managed)).unwrap()
}

fn watch_config(month: &str) -> WatchQueryConfig {
    WatchQueryConfig {
        r#where: Some(json!({"atUtc":{"$startsWith": month}})),
        debounce_ms: Some(0),
        ..Default::default()
    }
}

fn wait(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !check() {
        assert!(Instant::now() < deadline, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn delivered(watch: &Watch, expected: &Value) {
    wait("watch delivery", || {
        watch.try_recv().is_ok_and(|value| value == *expected)
    });
}

fn write_rows(path: &Path, rows: &[Value]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let text = rows
        .iter()
        .map(|row| format!("{row}\n"))
        .collect::<String>();
    let staging = path.with_extension("pending");
    fs::write(&staging, text).unwrap();
    fs::rename(staging, path).unwrap();
}

fn assert_no_resident(runtime: &NativeRuntime) {
    let status = runtime.lazy_partition_status(SOURCE).unwrap().unwrap();
    assert!(
        status.loaded.is_empty(),
        "streaming watches must not retain covered rows"
    );
    assert!(status.pinned.is_empty());
    assert_eq!(
        runtime
            .read(|db| Ok(db.collection(COLLECTION).unwrap().len()))
            .unwrap(),
        0
    );
}

#[test]
fn initial_selected_watch_matches_resident_without_retaining_partitions() {
    let fixture = ParityFixture::new(720);
    fixture
        .assert_same(|runtime| {
            let mut config = watch_config("2025-01");
            config.select = Some(json!(["id"]));
            config.limit = Some(3);
            let watch = runtime.watch(COLLECTION, config)?;
            Ok(watch.recv().unwrap())
        })
        .unwrap();
    let runtime = open(&fixture, false);
    let watch = runtime.watch(COLLECTION, watch_config("2025-01")).unwrap();
    assert_eq!(watch.recv().unwrap().as_array().unwrap().len(), 124);
    assert_no_resident(&runtime);
}

#[test]
fn own_appends_update_watch_once_and_cleanup_is_silent() {
    let fixture = ParityFixture::new(720);
    let runtime = open(&fixture, true);
    let watch = runtime.watch(COLLECTION, watch_config("2025-01")).unwrap();
    let mut expected = watch.recv().unwrap();
    let changes = runtime.read(|db| Ok(db.subscribe_change_events())).unwrap();
    let created = parity::sample("2025-01", 31, 1439, "steps");
    runtime
        .mutate(|db| db.create(COLLECTION, created.clone()))
        .unwrap();
    expected.as_array_mut().unwrap().push(created);
    delivered(&watch, &expected);
    std::thread::sleep(Duration::from_millis(180));
    assert_eq!(
        changes.try_recv().unwrap().operation,
        ChangeOperation::Update // owned transaction publication, as under Resident
    );
    assert!(
        changes.try_recv().is_err(),
        "own append must not cause a poller reload"
    );
    assert!(watch.try_recv().is_err());
    assert_no_resident(&runtime);
}

#[test]
fn new_partition_discovered_during_create_and_identical_retry_are_not_rewritten() {
    for identical in [false, true] {
        let fixture = ParityFixture::new(720);
        let runtime = open(&fixture, false);
        let watch = runtime.watch(COLLECTION, watch_config("2025-06")).unwrap();
        assert_eq!(watch.recv().unwrap(), json!([]));
        let a = parity::sample("2025-06", 2, 0, "steps");
        let b = if identical {
            a.clone()
        } else {
            parity::sample("2025-06", 3, 0, "steps")
        };
        let path = fixture.partition_path("2025-06");
        write_rows(&path, std::slice::from_ref(&a));
        runtime
            .mutate(|db| db.create(COLLECTION, b.clone()))
            .unwrap();
        let expected = if identical { vec![a] } else { vec![a, b] };
        delivered(&watch, &json!(expected));
        let text = expected
            .iter()
            .map(|row| format!("{row}\n"))
            .collect::<String>();
        assert_eq!(fs::read_to_string(path).unwrap(), text);
        assert_no_resident(&runtime);
    }
}

#[test]
fn failed_create_rolls_back_without_a_watch_delivery_or_disk_write() {
    let fixture = ParityFixture::new(720);
    let runtime = open(&fixture, false);
    let watch = runtime.watch(COLLECTION, watch_config("2025-01")).unwrap();
    let initial = watch.recv().unwrap();
    let before = fs::read(fixture.partition_path("2025-01")).unwrap();
    let mut conflict = initial[0].clone();
    conflict["value"] = json!(99999);
    let new = parity::sample("2025-01", 31, 1439, "steps");
    let error = runtime
        .mutate(|db| db.create_many(COLLECTION, vec![new, conflict]))
        .unwrap_err();
    assert_eq!(error.tag(), "DuplicateKeyError");
    assert_eq!(fs::read(fixture.partition_path("2025-01")).unwrap(), before);
    assert!(watch.try_recv().is_err());
    assert_no_resident(&runtime);
}

#[test]
fn external_edit_invalid_edit_last_good_correction_and_removal() {
    let fixture = ParityFixture::new(720);
    let runtime = open(&fixture, true);
    let watch = runtime.watch(COLLECTION, watch_config("2025-01")).unwrap();
    let mut expected = watch.recv().unwrap();
    let changes = runtime.read(|db| Ok(db.subscribe_change_events())).unwrap();
    expected[0]["value"] = json!(9876);
    let path = fixture.partition_path("2025-01");
    write_rows(&path, expected.as_array().unwrap());
    delivered(&watch, &expected);
    wait("external reload change event", || {
        changes
            .try_recv()
            .is_ok_and(|event| event.operation == ChangeOperation::Reload)
    });
    fs::write(&path, "{invalid}\n").unwrap();
    wait("invalid edit error", || {
        runtime.last_reload_error().unwrap().is_some()
    });
    assert!(
        watch.try_recv().is_err(),
        "invalid bytes must not replace last-known-good result"
    );
    assert!(
        runtime.reload().is_err(),
        "explicit reload must return the typed error"
    );
    assert!(
        runtime.reload().is_err(),
        "unchanged invalid bytes must remain an error"
    );
    expected[0]["value"] = json!(1234);
    write_rows(&path, expected.as_array().unwrap());
    delivered(&watch, &expected);
    wait("reload recovery", || {
        runtime.last_reload_error().unwrap().is_none()
    });
    fs::remove_file(path).unwrap();
    delivered(&watch, &json!([]));
    assert_no_resident(&runtime);
}

#[test]
fn new_file_wrong_partition_then_corrected_and_uncovered_file_is_only_listed() {
    let fixture = ParityFixture::new(720);
    let runtime = open(&fixture, true);
    let watch = runtime.watch(COLLECTION, watch_config("2025-06")).unwrap();
    assert_eq!(watch.recv().unwrap(), json!([]));
    let row = parity::sample("2025-06", 2, 0, "steps");
    let path = fixture.partition_path("2025-06");
    write_rows(
        &path,
        &[row.clone(), parity::sample("2025-07", 2, 0, "steps")],
    );
    wait("wrong partition error", || {
        runtime
            .last_reload_error()
            .unwrap()
            .is_some_and(|e| e.to_string().contains("wrong partition"))
    });
    assert!(watch.try_recv().is_err());
    write_rows(&path, std::slice::from_ref(&row));
    delivered(&watch, &json!([row]));
    write_rows(
        &fixture.partition_path("2027-01"),
        &[parity::sample("2027-01", 2, 0, "steps")],
    );
    wait("uncovered file listing", || {
        runtime
            .lazy_partition_status(SOURCE)
            .unwrap()
            .unwrap()
            .partitions
            .iter()
            .any(|p| p.ends_with("2027-01.jsonl"))
    });
    assert!(watch.try_recv().is_err());
    assert_no_resident(&runtime);
}

#[test]
fn callback_initial_and_own_commit_can_reenter_runtime() {
    let fixture = ParityFixture::new(720);
    let runtime = open(&fixture, false);
    let reentrant = runtime.clone();
    let (sender, receiver) = mpsc::channel();
    let watch = runtime
        .watch_with_callback(
            COLLECTION,
            watch_config("2025-06"),
            Box::new(move |rows| {
                assert!(reentrant
                    .lazy_partition_status(SOURCE)
                    .unwrap()
                    .unwrap()
                    .loaded
                    .is_empty());
                sender.send(rows).unwrap();
            }),
        )
        .unwrap();
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
        json!([])
    );
    let row = parity::sample("2025-06", 2, 0, "steps");
    runtime
        .mutate(|db| db.create(COLLECTION, row.clone()))
        .unwrap();
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
        json!([row])
    );
    drop(watch);
    runtime
        .mutate(|db| db.create(COLLECTION, parity::sample("2025-06", 3, 0, "steps")))
        .unwrap();
    assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
}

#[test]
#[allow(deprecated)]
fn full_scan_error_watch_parity_including_empty_source() {
    use proseql_native::ExecutionModel;
    for empty in [false, true] {
        let fixture = ParityFixture::new(720);
        if empty {
            for file in fs::read_dir(fixture.root()).unwrap() {
                fs::remove_file(file.unwrap().path()).unwrap();
            }
        }
        let mut errors = Vec::new();
        for model in [ExecutionModel::Resident, ExecutionModel::Streaming] {
            let mut opts = options(false);
            opts.execution_model = model;
            opts.lazy_partitions.get_mut(SOURCE).unwrap().full_scan = FullScanPolicy::Error;
            let runtime = NativeRuntime::open_sources_with_options(fixture.config(), opts).unwrap();
            errors.push(
                runtime
                    .watch(COLLECTION, WatchQueryConfig::default())
                    .err()
                    .unwrap(),
            );
        }
        assert_eq!(errors[0], errors[1]);
    }
}

#[test]
fn natural_own_append_order_matches_reopened_resident_and_explicit_sort_matches_session() {
    let fixture = ParityFixture::new(720);
    let streaming_fixture = fixture.copy();
    let resident = fixture.open(RuntimeKind::Eager);
    let streaming = open(&streaming_fixture, false);
    let config = WatchQueryConfig {
        debounce_ms: Some(0),
        ..Default::default()
    };
    let a = resident.watch(COLLECTION, config.clone()).unwrap();
    let b = streaming.watch(COLLECTION, config).unwrap();
    assert_eq!(a.recv().unwrap(), b.recv().unwrap());
    let row = parity::sample("2025-01", 31, 1439, "steps");
    resident
        .mutate(|db| db.create(COLLECTION, row.clone()))
        .unwrap();
    streaming
        .mutate(|db| db.create(COLLECTION, row.clone()))
        .unwrap();
    let reopened = fixture.open(RuntimeKind::Eager);
    let expected = reopened
        .query(COLLECTION, QueryInput::default(), None)
        .unwrap();
    delivered(&b, &json!(expected));
    let sorted = WatchQueryConfig {
        sort: vec![("atUtc".into(), SortOrder::Desc)],
        debounce_ms: Some(0),
        ..Default::default()
    };
    assert_eq!(
        resident
            .watch(COLLECTION, sorted.clone())
            .unwrap()
            .recv()
            .unwrap(),
        streaming.watch(COLLECTION, sorted).unwrap().recv().unwrap()
    );
    assert_eq!(a.recv().unwrap().as_array().unwrap().last(), Some(&row));
}

#[test]
fn concurrent_edit_between_stage_and_commit_returns_source_changed_without_quarantine() {
    let fixture = ParityFixture::new(720);
    let runtime = open(&fixture, false);
    let path = fixture.partition_path("2025-01");
    let original = fs::read_to_string(&path).unwrap();
    let external = original.replacen("steps", "STEPS", 1); // same length, not in final 4 KiB
    let error = runtime
        .mutate(|db| {
            db.create(COLLECTION, parity::sample("2025-01", 31, 1439, "steps"))?;
            fs::write(&path, &external).unwrap();
            Ok(())
        })
        .unwrap_err();
    assert!(matches!(&error, EngineError::Operation(e) if e.reason == "source-changed"));
    assert_eq!(fs::read_to_string(&path).unwrap(), external);
    fs::write(&path, original).unwrap();
    runtime.reload().unwrap();
    runtime
        .mutate(|db| db.create(COLLECTION, parity::sample("2025-01", 31, 1439, "steps")))
        .unwrap();
    assert_no_resident(&runtime);
}

struct FailAt {
    point: DurabilityFaultPoint,
    encounter: std::sync::atomic::AtomicUsize,
    nth: usize,
}
impl DurabilityFaultInjector for FailAt {
    fn check(&self, point: DurabilityFaultPoint) -> Result<(), EngineError> {
        if point == self.point
            && self
                .encounter
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1
                == self.nth
        {
            return Err(EngineError::Operation(OperationError {
                operation: "append".into(),
                reason: "injected".into(),
                message: format!("injected at {point:?}"),
            }));
        }
        Ok(())
    }
}

#[test]
fn failed_append_rolls_back_watch_and_memory_and_quarantines_after_a_durable_prefix() {
    for point in [
        DurabilityFaultPoint::AppendWrite,
        DurabilityFaultPoint::AppendSync,
    ] {
        for nth in [1, 2] {
            let fixture = ParityFixture::new(720);
            let january = fixture.partition_path("2025-01");
            let february = fixture.partition_path("2025-02");
            let before_jan = fs::read(&january).unwrap();
            let before_feb = fs::read(&february).unwrap();
            let host = Arc::new(
                FsStorageHost::new_polling_with_fault_injector(
                    Duration::from_secs(2),
                    Arc::new(FailAt {
                        point,
                        encounter: Default::default(),
                        nth,
                    }),
                )
                .unwrap(),
            );
            let runtime =
                NativeRuntime::open_sources_with_host(fixture.config(), host, options(false))
                    .unwrap();
            let watch = runtime
                .watch(
                    COLLECTION,
                    WatchQueryConfig {
                        debounce_ms: Some(0),
                        ..Default::default()
                    },
                )
                .unwrap();
            let _ = watch.recv().unwrap();
            let jan = parity::sample("2025-01", 31, 1439, "steps");
            let feb = parity::sample("2025-02", 28, 1439, "steps");
            let error = runtime
                .mutate(|db| db.create_many(COLLECTION, vec![jan.clone(), feb]))
                .unwrap_err();
            assert_eq!(error.tag(), "StorageError");
            assert!(error.to_string().contains("completed paths"));
            assert!(runtime
                .query(COLLECTION, QueryInput::default(), None)
                .is_err());
            assert!(
                watch.try_recv().is_err(),
                "a failed commit must not publish candidate rows"
            );
            runtime.close().unwrap();
            assert_eq!(fs::read(&february).unwrap(), before_feb);
            let expected_jan = if nth == 1 {
                before_jan
            } else {
                [before_jan, format!("{jan}\n").into_bytes()].concat()
            };
            assert_eq!(fs::read(&january).unwrap(), expected_jan);
            let reopened = open(&fixture, false);
            assert_eq!(
                reopened
                    .find_by_id(COLLECTION, jan["id"].as_str().unwrap())
                    .unwrap()
                    .is_some(),
                nth == 2
            );
        }
    }
}

struct PauseAt {
    root: PathBuf,
    point: DurabilityFaultPoint,
}
impl DurabilityFaultInjector for PauseAt {
    fn check(&self, point: DurabilityFaultPoint) -> Result<(), EngineError> {
        if point == self.point {
            park(&self.root);
        }
        Ok(())
    }
}

fn park(root: &Path) {
    fs::write(root.join("ready"), "ready").unwrap();
    loop {
        std::thread::park();
    }
}

#[test]
#[ignore = "subprocess-only crash boundary"]
fn streaming_crash_child() {
    let dir = PathBuf::from(std::env::var("PROSEQL_STREAMING_CRASH_ROOT").unwrap());
    let boundary = std::env::var("PROSEQL_STREAMING_CRASH_BOUNDARY").unwrap();
    let root = dir.join(SOURCE);
    let host = if boundary == "after_commit" {
        FsStorageHost::new_polling(Duration::from_secs(2)).unwrap()
    } else {
        FsStorageHost::new_polling_with_fault_injector(
            Duration::from_secs(2),
            Arc::new(PauseAt {
                root: dir.clone(),
                point: if boundary == "write" {
                    DurabilityFaultPoint::AppendWrite
                } else {
                    DurabilityFaultPoint::AppendSync
                },
            }),
        )
        .unwrap()
    };
    let runtime =
        NativeRuntime::open_sources_with_host(config(&root), Arc::new(host), options(false))
            .unwrap();
    let record = parity::sample("2025-06", 2, 1, "steps");
    let reentrant = runtime.clone();
    let _watch = runtime
        .watch_with_callback(
            COLLECTION,
            watch_config("2025-06"),
            Box::new(move |rows| {
                if rows.as_array().is_some_and(|rows| rows.len() == 2) {
                    assert_no_resident(&reentrant); // proves append::after_commit ran before delivery
                    if boundary == "after_commit" {
                        park(&dir);
                    }
                }
            }),
        )
        .unwrap();
    runtime.mutate(|db| db.create(COLLECTION, record)).unwrap();
}

#[test]
fn crash_mid_append_before_sync_and_after_commit_preserve_documented_recovery() {
    for boundary in ["write", "sync", "after_commit"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SOURCE).join("2025-06.jsonl");
        let old = parity::sample("2025-06", 2, 0, "steps");
        write_rows(&path, std::slice::from_ref(&old));
        let before = fs::read(&path).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "streaming_crash_child",
                "--ignored",
                "--nocapture",
            ])
            .env("PROSEQL_STREAMING_CRASH_ROOT", dir.path())
            .env("PROSEQL_STREAMING_CRASH_BOUNDARY", boundary)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !dir.path().join("ready").exists() {
            assert!(
                child.try_wait().unwrap().is_none(),
                "child exited before {boundary}"
            );
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("child did not reach {boundary}");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        child.kill().unwrap();
        child.wait().unwrap();
        let bytes = fs::read(&path).unwrap();
        assert!(bytes.starts_with(&before));
        let runtime = NativeRuntime::open_sources_with_options(
            config(path.parent().unwrap()),
            options(false),
        )
        .unwrap();
        let rows = runtime
            .query(COLLECTION, QueryInput::default(), None)
            .unwrap();
        assert_eq!(rows.len(), if boundary == "write" { 1 } else { 2 });
        let retry = parity::sample("2025-06", 2, 1, "steps");
        runtime
            .mutate(|db| db.create(COLLECTION, retry.clone()))
            .unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!("{old}\n{retry}\n")
        );
        assert_no_resident(&runtime);
    }
}

#[test]
fn debounced_watch_coalesces_own_commits_and_unread_initial_is_latest() {
    let fixture = ParityFixture::new(720);
    let runtime = open(&fixture, false);
    let mut config = watch_config("2025-06");
    config.debounce_ms = Some(40);
    let watch = runtime.watch(COLLECTION, config).unwrap();
    let a = parity::sample("2025-06", 2, 0, "steps");
    let b = parity::sample("2025-06", 3, 0, "steps");
    runtime
        .mutate(|db| db.create(COLLECTION, a.clone()))
        .unwrap();
    runtime
        .mutate(|db| db.create(COLLECTION, b.clone()))
        .unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(watch.recv().unwrap(), json!([a, b]));
    assert!(watch.try_recv().is_err());
    assert_no_resident(&runtime);
}

#[test]
fn mutation_id_scan_discovers_a_corrected_watched_partition_without_writing_it() {
    let fixture = ParityFixture::new(720);
    let runtime = open(&fixture, false);
    let watch = runtime.watch(COLLECTION, watch_config("2025-06")).unwrap();
    assert_eq!(watch.recv().unwrap(), json!([]));
    let a = parity::sample("2025-06", 2, 0, "steps");
    let path = fixture.partition_path("2025-06");
    write_rows(
        &path,
        &[a.clone(), parity::sample("2025-07", 2, 0, "steps")],
    );
    assert!(runtime.reload().is_err());
    write_rows(&path, std::slice::from_ref(&a));
    let before = fs::read(&path).unwrap();
    runtime
        .mutate(|db| {
            assert_eq!(
                db.find_by_id(COLLECTION, a["id"].as_str().unwrap())?,
                Some(a.clone())
            );
            db.create(COLLECTION, parity::sample("2025-01", 31, 1439, "steps"))
        })
        .unwrap();
    delivered(&watch, &json!([a]));
    assert_eq!(fs::read(path).unwrap(), before);
    assert_no_resident(&runtime);
}

#[test]
fn dropping_last_watch_releases_failed_file_baseline_before_explicit_reload() {
    let fixture = ParityFixture::new(720);
    let runtime = open(&fixture, false);
    let a = runtime.watch(COLLECTION, watch_config("2025-06")).unwrap();
    let b = runtime.watch(COLLECTION, watch_config("2025-06")).unwrap();
    assert_eq!(a.recv().unwrap(), json!([]));
    assert_eq!(b.recv().unwrap(), json!([]));
    fs::write(fixture.partition_path("2025-06"), "{bad}\n").unwrap();
    assert!(runtime.reload().is_err());
    drop(a);
    assert!(runtime.reload().is_err());
    drop(b);
    runtime.reload().unwrap(); // no watch reads or validates those bytes now
    assert!(runtime.last_reload_error().unwrap().is_none());
}

#[test]
fn newly_created_target_conflicts_if_another_writer_creates_it_before_commit() {
    let fixture = ParityFixture::new(720);
    let runtime = open(&fixture, false);
    let path = fixture.partition_path("2025-06");
    let external = parity::sample("2025-06", 2, 0, "steps");
    let error = runtime
        .mutate(|db| {
            db.create(COLLECTION, parity::sample("2025-06", 3, 0, "steps"))?;
            write_rows(&path, std::slice::from_ref(&external));
            Ok(())
        })
        .unwrap_err();
    assert!(matches!(error, EngineError::Operation(e) if e.reason == "source-changed"));
    assert_eq!(fs::read_to_string(path).unwrap(), format!("{external}\n"));
    runtime.reload().unwrap();
    assert_no_resident(&runtime);
}

#[test]
fn conflicting_create_in_a_new_watched_partition_still_publishes_external_rows() {
    let fixture = ParityFixture::new(720);
    let runtime = open(&fixture, false);
    let watch = runtime.watch(COLLECTION, watch_config("2025-06")).unwrap();
    assert_eq!(watch.recv().unwrap(), json!([]));
    let a = parity::sample("2025-06", 2, 0, "steps");
    let path = fixture.partition_path("2025-06");
    write_rows(&path, std::slice::from_ref(&a));
    let before = fs::read(&path).unwrap();
    let mut conflicting = a.clone();
    conflicting["value"] = json!(99999);
    let error = runtime
        .mutate(|db| db.create(COLLECTION, conflicting))
        .unwrap_err();
    assert_eq!(error.tag(), "DuplicateKeyError");
    delivered(&watch, &json!([a]));
    assert_eq!(fs::read(path).unwrap(), before);
    assert_no_resident(&runtime);
}
