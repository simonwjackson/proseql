//! Streaming creates use the real global locator and the ordinary durable
//! source commit path. No existing partition enters the engine collection.
mod support;
use support::parity::RuntimeKind;

use proseql_engine::errors::{EngineError, OperationError};
use proseql_engine::query::pipeline::QueryInput;
use proseql_engine::reactive::WatchQueryConfig;
use proseql_native::NativeRuntime;
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
    let runtime = fixture.open(RuntimeKind::Lazy);
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
    let runtime = fixture.open(RuntimeKind::Lazy);
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
    let runtime = fixture.open(RuntimeKind::Lazy);
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
    let runtime = fixture.open(RuntimeKind::Lazy);
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
fn a_watch_sees_the_create_but_not_the_silent_engine_removal() {
    let fixture = ParityFixture::new(1440);
    let runtime = fixture.open(RuntimeKind::Lazy);
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
    let runtime = fixture.open(RuntimeKind::Lazy);
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
            fixture.options(RuntimeKind::Lazy),
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
        let reopened = fixture.open(RuntimeKind::Lazy);
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
    let runtime =
        NativeRuntime::open_sources_with_host(config, host, fixture.options(RuntimeKind::Lazy))
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
    let runtime = fixture.open(RuntimeKind::Lazy);
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

struct CountingIds(Arc<std::sync::atomic::AtomicUsize>);
impl proseql_engine::id_gen::IdGenerator for CountingIds {
    fn generate(&mut self) -> String {
        use std::sync::atomic::Ordering;
        format!("counted-{}", self.0.fetch_add(1, Ordering::SeqCst) + 1)
    }
}

fn counted_runtime(
    fixture: &ParityFixture,
    model: RuntimeKind,
) -> (NativeRuntime, Arc<std::sync::atomic::AtomicUsize>) {
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut config = fixture.config();
    config.collections[0].descriptor.id_generator = Some("counted".into());
    let mut options = fixture.options(model);
    let shared = Arc::clone(&count);
    options.callbacks.register_id_generator(
        "counted",
        Box::new(move || Box::new(CountingIds(Arc::clone(&shared)))),
    );
    (
        NativeRuntime::open_sources_with_options(config, options).unwrap(),
        count,
    )
}

#[test]
fn generated_ids_are_globally_checked_before_insertion_even_when_errors_are_caught() {
    let fixture = ParityFixture::new(1440);
    let mut existing = sample("2025-01", 1, 0, "steps");
    existing["id"] = json!("counted-1");
    fs::write(fixture.partition_path("2025-01"), format!("{existing}\n")).unwrap();
    let (runtime, _) = counted_runtime(&fixture, RuntimeKind::Lazy);
    let mut input = sample("2025-03", 1, 1, "steps");
    input.as_object_mut().unwrap().shift_remove("id");
    runtime
        .mutate(|db| {
            assert_eq!(
                db.create(COLLECTION, input.clone()).unwrap_err().tag(),
                "DuplicateKeyError"
            );
            let created = db.create(COLLECTION, input.clone())?;
            assert_eq!(created["id"], "counted-2");
            Ok(())
        })
        .unwrap();
    empty_engine(&runtime);
    let text = fs::read_to_string(fixture.partition_path("2025-03")).unwrap();
    assert!(!text.contains("counted-1"));
    assert!(text.contains("counted-2"));
}

#[test]
fn successful_generated_batches_and_all_provided_batches_keep_generator_semantics() {
    use std::sync::atomic::Ordering;
    let fixture = ParityFixture::new(1440);
    let mut answers = Vec::new();
    for model in [RuntimeKind::Eager, RuntimeKind::Lazy] {
        let copy = fixture.copy();
        let (runtime, count) = counted_runtime(&copy, model);
        let provided = sample("2025-01", 1, 1, "steps");
        let first = runtime
            .mutate(|db| db.create_many(COLLECTION, vec![provided.clone()]))
            .unwrap()
            .created;
        assert_eq!(first, vec![provided]);
        assert_eq!(count.load(Ordering::SeqCst), 0);
        let mut invalid = sample("2025-01", 1, 2, "steps");
        invalid["value"] = Value::Null;
        assert_eq!(
            runtime
                .mutate(|db| db.create_many(COLLECTION, vec![invalid]))
                .unwrap_err()
                .tag(),
            "ValidationError"
        );
        assert_eq!(count.load(Ordering::SeqCst), 0);
        let generated = [3, 4]
            .into_iter()
            .map(|minute| {
                let mut row = sample("2025-01", 1, minute, "steps");
                row.as_object_mut().unwrap().shift_remove("id");
                row
            })
            .collect();
        let second = runtime
            .mutate(|db| db.create_many(COLLECTION, generated))
            .unwrap()
            .created;
        assert_eq!(count.load(Ordering::SeqCst), 2);
        answers.push(second);
    }
    assert_eq!(answers[0], answers[1]);
}

#[test]
fn failed_generated_batches_deliberately_resolve_all_ids_under_streaming() {
    use std::sync::atomic::Ordering;
    for (model, expected) in [(RuntimeKind::Eager, 2), (RuntimeKind::Lazy, 3)] {
        let fixture = ParityFixture::new(1440);
        let before = fs::read(fixture.partition_path("2025-01")).unwrap();
        let (runtime, count) = counted_runtime(&fixture, model);
        let rows = [1, 2, 3]
            .into_iter()
            .map(|minute| {
                let mut row = sample("2025-01", 1, minute, "steps");
                row.as_object_mut().unwrap().shift_remove("id");
                if minute == 2 {
                    row["value"] = Value::Null;
                }
                row
            })
            .collect();
        assert_eq!(
            runtime
                .mutate(|db| db.create_many(COLLECTION, rows))
                .unwrap_err()
                .tag(),
            "ValidationError"
        );
        assert_eq!(count.load(Ordering::SeqCst), expected);
        assert_eq!(fs::read(fixture.partition_path("2025-01")).unwrap(), before);
        if model == RuntimeKind::Lazy {
            empty_engine(&runtime);
        }
    }
}

struct FailSecondSync(std::sync::atomic::AtomicUsize);
impl DurabilityFaultInjector for FailSecondSync {
    fn check(&self, point: DurabilityFaultPoint) -> Result<(), EngineError> {
        if point == DurabilityFaultPoint::AppendSync
            && self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1
        {
            return Err(EngineError::Operation(OperationError {
                operation: "append".into(),
                reason: "injected-failure".into(),
                message: "second sync failed".into(),
            }));
        }
        Ok(())
    }
}

#[test]
fn failure_between_files_keeps_the_durable_prefix_and_quarantines_the_runtime() {
    let fixture = ParityFixture::new(1440);
    let host = Arc::new(
        FsStorageHost::new_polling_with_fault_injector(
            Duration::from_secs(2),
            Arc::new(FailSecondSync(std::sync::atomic::AtomicUsize::new(0))),
        )
        .unwrap(),
    );
    let runtime = NativeRuntime::open_sources_with_host(
        fixture.config(),
        host,
        fixture.options(RuntimeKind::Lazy),
    )
    .unwrap();
    let first = sample("2025-01", 1, 1, "steps");
    let second = sample("2025-02", 1, 1, "steps");
    let error = runtime
        .mutate(|db| db.create_many(COLLECTION, vec![second.clone(), first.clone()]))
        .unwrap_err();
    assert_eq!(error.tag(), "StorageError");
    assert!(error.to_string().contains("completed paths"));
    assert!(runtime.read(|_| Ok(())).is_err());
    runtime.close().unwrap();
    let reopened = fixture.open(RuntimeKind::Lazy);
    assert_eq!(
        reopened
            .find_by_id(COLLECTION, first["id"].as_str().unwrap())
            .unwrap(),
        Some(first)
    );
    assert_eq!(
        reopened
            .find_by_id(COLLECTION, second["id"].as_str().unwrap())
            .unwrap(),
        None
    );
}

#[test]
fn locator_build_rejects_existing_cross_partition_duplicates_but_an_empty_batch_is_a_noop() {
    let fixture = ParityFixture::new(1440);
    let existing = sample("2025-01", 1, 0, "steps");
    let mut duplicate = sample("2025-02", 1, 0, "steps");
    duplicate["id"] = existing["id"].clone();
    fs::write(fixture.partition_path("2025-02"), format!("{duplicate}\n")).unwrap();
    let runtime = fixture.open(RuntimeKind::Lazy);
    assert!(runtime
        .mutate(|db| db.create_many(COLLECTION, vec![]))
        .unwrap()
        .created
        .is_empty());
    let error = runtime
        .mutate(|db| db.create(COLLECTION, sample("2025-03", 1, 1, "steps")))
        .unwrap_err();
    assert_eq!(error.tag(), "SourceConfigError");
    assert!(error.to_string().contains("Duplicate partition record"));
    empty_engine(&runtime);
}

#[test]
fn invalid_unrelated_payload_does_not_block_a_new_id_but_scanning_reads_still_fail() {
    let fixture = ParityFixture::new(1440);
    let mut invalid = sample("2025-01", 1, 0, "steps");
    invalid["value"] = json!("invalid persisted value");
    fs::write(fixture.partition_path("2025-01"), format!("{invalid}\n")).unwrap();
    let resident_copy = fixture.copy();
    let resident_error = resident_copy.try_open(RuntimeKind::Eager).err().unwrap();
    assert_eq!(resident_error.tag(), "ValidationError");
    let streaming = fixture.open(RuntimeKind::Lazy);
    let new = sample("2025-01", 1, 1, "steps");
    streaming
        .mutate(|db| db.create(COLLECTION, new.clone()))
        .unwrap();
    empty_engine(&streaming);
    let input = QueryInput {
        r#where: Some(json!({"atUtc": {"$startsWith": "2025-01"}})),
        ..Default::default()
    };
    let streaming_error = streaming.query(COLLECTION, input, None).unwrap_err();
    assert_eq!(streaming_error, resident_error);
    // A matching locator candidate is never exempt from full validation.
    assert_eq!(
        streaming
            .mutate(|db| db.create(COLLECTION, sample("2025-01", 1, 0, "steps")))
            .unwrap_err()
            .tag(),
        "ValidationError"
    );
    empty_engine(&streaming);
}

/// A real codec override that delegates JSONL decoding. It deliberately keeps
/// the custom whole-file decode contract (no decode_append_jsonl override).
struct DelegatingJsonl(Arc<std::sync::atomic::AtomicUsize>);
impl proseql_formats::FormatCodec for DelegatingJsonl {
    fn name(&self) -> &str {
        "delegating-jsonl"
    }
    fn extensions(&self) -> &[&str] {
        &["jsonl", "ndjson"]
    }
    fn encode(
        &self,
        data: &Value,
        options: Option<proseql_formats::FormatOptions>,
    ) -> Result<String, String> {
        proseql_formats::codecs::jsonl_codec().encode(data, options)
    }
    fn decode(&self, raw: &str) -> Result<Value, String> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        proseql_formats::codecs::jsonl_codec().decode(raw)
    }
}

#[test]
fn custom_codec_verifies_duplicate_ids_and_ignore_identical_recreates() {
    use proseql_engine::descriptor::DuplicateIdPolicy;
    for policy in [DuplicateIdPolicy::Error, DuplicateIdPolicy::IgnoreIdentical] {
        let fixture = ParityFixture::new(1440);
        let before_january = fs::read(fixture.partition_path("2025-01")).unwrap();
        let before_march = fs::read(fixture.partition_path("2025-03")).unwrap();
        let decoded = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut config = fixture.config();
        config.collections[0].descriptor.duplicate_ids = policy;
        let mut options = fixture.options(RuntimeKind::Lazy);
        options
            .formats
            .register(Box::new(DelegatingJsonl(Arc::clone(&decoded))));
        let runtime = NativeRuntime::open_sources_with_options(config, options).unwrap();
        let stored = sample("2025-01", 1, 0, "steps");
        let mut different = sample("2025-03", 1, 1, "steps");
        different["id"] = stored["id"].clone();
        assert_eq!(
            runtime
                .mutate(|db| db.create(COLLECTION, different))
                .unwrap_err()
                .tag(),
            "DuplicateKeyError"
        );
        empty_engine(&runtime);
        let recreated = runtime.mutate(|db| db.create(COLLECTION, stored.clone()));
        if policy == DuplicateIdPolicy::IgnoreIdentical {
            assert_eq!(recreated.unwrap(), stored);
        } else {
            assert_eq!(recreated.unwrap_err().tag(), "DuplicateKeyError");
        }
        empty_engine(&runtime);
        // Opaque-codec candidates for different IDs can share the same
        // (path, UNKNOWN_OFFSET). Verification must retain the requested ID.
        let other = sample("2025-01", 1, 0, "heartRate");
        let batch =
            runtime.mutate(|db| db.create_many(COLLECTION, vec![stored.clone(), other.clone()]));
        if policy == DuplicateIdPolicy::IgnoreIdentical {
            assert_eq!(batch.unwrap().created, vec![stored, other]);
        } else {
            assert_eq!(batch.unwrap_err().tag(), "DuplicateKeyError");
        }
        empty_engine(&runtime);
        assert!(decoded.load(std::sync::atomic::Ordering::SeqCst) > 0);
        assert_eq!(
            fs::read(fixture.partition_path("2025-01")).unwrap(),
            before_january
        );
        assert_eq!(
            fs::read(fixture.partition_path("2025-03")).unwrap(),
            before_march
        );
        // An own append invalidates opaque membership; the next create must
        // rebuild through the codec, rather than trust physical row offsets.
        let fresh = sample("2025-03", 1, 1, "steps");
        runtime
            .mutate(|db| db.create(COLLECTION, fresh.clone()))
            .unwrap();
        let after_append = fs::read(fixture.partition_path("2025-03")).unwrap();
        let recreated = runtime.mutate(|db| db.create(COLLECTION, fresh.clone()));
        if policy == DuplicateIdPolicy::IgnoreIdentical {
            assert_eq!(recreated.unwrap(), fresh);
        } else {
            assert_eq!(recreated.unwrap_err().tag(), "DuplicateKeyError");
        }
        empty_engine(&runtime);
        assert_eq!(
            fs::read(fixture.partition_path("2025-03")).unwrap(),
            after_append
        );
    }
}
