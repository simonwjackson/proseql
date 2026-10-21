//! Native append-only JSONL conformance (contract sections 2 and 3).
//!
//! Real files in temporary directories, the public runtime API and the
//! filesystem durability fault interface. All data is synthetic.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use indexmap::IndexMap;
use proseql_engine::descriptor::{
    CollectionDescriptor, DuplicateIdPolicy, IdStrategy, SchemaNode, StructField, ValidationMode,
};
use proseql_engine::errors::EngineError;
use proseql_formats::FormatRegistry;
use proseql_native::{
    NativeCollectionConfig, NativeRuntime, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::collection_file::encode_collection_file;
use proseql_storage::fs::{DurabilityFaultInjector, DurabilityFaultPoint, FsStorageHost};
use proseql_storage::host::{StorageEvent, StorageHost, WatchHandle};
use proseql_storage::persistence::{CollectionStorageConfig, DurableStorageHost, FileTail};
use proseql_storage::source_config::{
    CollectionFileSourceConfig, DatabaseSourceConfig, NormalizedCollectionFileSourceConfig,
    PartitionKey, PartitionedSourceConfig,
};
use serde_json::{json, Value};

// ── Configuration ────────────────────────────────────────────────────────────

fn schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: [
            ("id", SchemaNode::Str),
            ("timestamp", SchemaNode::Str),
            ("bpm", SchemaNode::Num),
            ("source", SchemaNode::Str),
            ("month", SchemaNode::Str),
        ]
        .into_iter()
        .map(|(name, schema)| StructField {
            name: name.into(),
            schema,
        })
        .collect(),
    }
}

fn descriptor(name: &str, append_only: bool) -> CollectionDescriptor {
    CollectionDescriptor {
        name: name.into(),
        schema: schema(),
        id_strategy: IdStrategy::Provided,
        relationships: vec![],
        indexes: vec![],
        ordered_indexes: vec![],
        unique_fields: vec![],
        before_create_hooks: vec![],
        after_create_hooks: vec![],
        before_update_hooks: vec![],
        after_update_hooks: vec![],
        before_delete_hooks: vec![],
        after_delete_hooks: vec![],
        on_change_hooks: vec![],
        computed_fields: vec![],
        search_index: vec![],
        id_generator: None,
        version: None,
        migrations: vec![],
        append_only,
        duplicate_ids: DuplicateIdPolicy::IgnoreIdentical,
        validation_mode: ValidationMode::Strict,
    }
}

fn root(dir: &Path) -> PathBuf {
    dir.join("heartrate")
}

fn partition(dir: &Path, month: &str) -> PathBuf {
    root(dir).join(format!("{month}.jsonl"))
}

fn partitioned_source(dir: &Path) -> PartitionedSourceConfig {
    PartitionedSourceConfig {
        id: "heartrate".into(),
        collection: "heartrate".into(),
        root: root(dir).to_string_lossy().into_owned(),
        format: "jsonl".into(),
        partition_by: PartitionKey::Field {
            field: "month".into(),
        },
        prose: None,
    }
}

/// One append-only partitioned collection and one rewritable collection file.
fn config(dir: &Path) -> NativeSourceRuntimeConfig {
    NativeSourceRuntimeConfig {
        collections: vec![
            NativeCollectionConfig::new(descriptor("heartrate", true)),
            NativeCollectionConfig::new(descriptor("notes", false)),
        ],
        sources: vec![
            DatabaseSourceConfig::Partitioned(partitioned_source(dir)),
            DatabaseSourceConfig::CollectionFile(CollectionFileSourceConfig {
                id: "notes".into(),
                collection: "notes".into(),
                path: dir.join("notes.jsonl").to_string_lossy().into_owned(),
                format: None,
                prose: None,
            }),
        ],
    }
}

fn options() -> NativeSourceRuntimeOptions {
    NativeSourceRuntimeOptions {
        watch_debounce: None,
        ..Default::default()
    }
}

fn open(dir: &Path) -> NativeRuntime {
    NativeRuntime::open_sources_with_options(config(dir), options()).unwrap()
}

fn open_with_host(dir: &Path, host: Arc<dyn DurableStorageHost>) -> NativeRuntime {
    NativeRuntime::open_sources_with_host(config(dir), host, options()).unwrap()
}

fn sample(month: &str, minute: u32, bpm: u32) -> Value {
    let timestamp = format!("{month}-15T08:{minute:02}:00.000Z");
    json!({
        "id": format!("heartrate:{timestamp}"),
        "timestamp": timestamp,
        "bpm": bpm,
        "source": "live",
        "month": month,
    })
}

fn line(record: &Value) -> String {
    serde_json::to_string(record).unwrap()
}

/// Write a partition the way the rewrite encoder does: no trailing newline.
fn seed(dir: &Path, month: &str, records: &[Value]) -> String {
    fs::create_dir_all(root(dir)).unwrap();
    let content = records.iter().map(line).collect::<Vec<_>>().join("\n");
    fs::write(partition(dir, month), &content).unwrap();
    content
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

/// What a full rewrite of `records` would produce for one partition.
fn rewrite(dir: &Path, month: &str, records: &[Value]) -> String {
    let source = NormalizedCollectionFileSourceConfig {
        id: "heartrate".into(),
        collection: "heartrate".into(),
        path: partition(dir, month).to_string_lossy().into_owned(),
        format: "jsonl".into(),
        prose: None,
    };
    let collection = CollectionStorageConfig {
        name: "heartrate".into(),
        schema: schema(),
        id_strategy: IdStrategy::Provided,
        version: None,
        migrations: vec![],
    };
    let records = records
        .iter()
        .map(|record| (record["id"].as_str().unwrap().to_owned(), record.clone()))
        .collect::<IndexMap<_, _>>();
    encode_collection_file(
        &FormatRegistry::with_builtins(),
        &source,
        &collection,
        &records,
    )
    .unwrap()
}

// ── Counting host: a real filesystem host that records its I/O ──────────────

#[derive(Default)]
struct Io {
    reads: HashMap<String, usize>,
    appended: Vec<(String, u64, String)>,
    replaced: Vec<String>,
}

struct CountingHost {
    fs: FsStorageHost,
    io: Arc<Mutex<Io>>,
}

impl CountingHost {
    fn new(poll: Duration) -> (Arc<Self>, Arc<Mutex<Io>>) {
        let io = Arc::new(Mutex::new(Io::default()));
        (
            Arc::new(Self {
                fs: FsStorageHost::new_polling(poll).unwrap(),
                io: Arc::clone(&io),
            }),
            io,
        )
    }
}

impl DurableStorageHost for CountingHost {
    fn replace_durable(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.io.lock().unwrap().replaced.push(path.into());
        self.fs.replace_durable(path, data)
    }
    fn append_durable(&self, path: &str, keep_len: u64, data: &str) -> Result<(), EngineError> {
        self.io
            .lock()
            .unwrap()
            .appended
            .push((path.into(), keep_len, data.into()));
        self.fs.append_durable(path, keep_len, data)
    }
    fn read_tail(&self, path: &str, max_tail: usize) -> Result<Option<FileTail>, EngineError> {
        self.fs.read_tail(path, max_tail)
    }
}

impl StorageHost for CountingHost {
    fn read(&self, path: &str) -> Result<String, EngineError> {
        *self
            .io
            .lock()
            .unwrap()
            .reads
            .entry(path.into())
            .or_default() += 1;
        self.fs.read(path)
    }
    fn write(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.fs.write(path, data)
    }
    fn append(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.fs.append(path, data)
    }
    fn exists(&self, path: &str) -> Result<bool, EngineError> {
        self.fs.exists(path)
    }
    fn remove(&self, path: &str) -> Result<(), EngineError> {
        self.fs.remove(path)
    }
    fn ensure_dir(&self, path: &str) -> Result<(), EngineError> {
        self.fs.ensure_dir(path)
    }
    fn list_directory(&self, path: &str) -> Result<Vec<String>, EngineError> {
        self.fs.list_directory(path)
    }
    fn list_recursive(&self, path: &str) -> Result<Vec<String>, EngineError> {
        self.fs.list_recursive(path)
    }
    fn watch(
        &self,
        path: &str,
        on_change: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        self.fs.watch(path, on_change)
    }
    fn watch_dir(
        &self,
        path: &str,
        on_change: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        self.fs.watch_dir(path, on_change)
    }
}

// ── Append without rewrite ───────────────────────────────────────────────────

#[test]
fn appends_complete_lines_without_rewriting_the_partition() {
    let dir = tempfile::tempdir().unwrap();
    let existing = [sample("2026-04", 0, 70), sample("2026-04", 1, 71)];
    let before = seed(dir.path(), "2026-04", &existing);
    let other = seed(dir.path(), "2026-03", &[sample("2026-03", 0, 60)]);
    let (host, io) = CountingHost::new(Duration::from_secs(2));
    let runtime = open_with_host(dir.path(), host);

    let first = sample("2026-04", 2, 80);
    let second = sample("2026-04", 3, 81);
    let created = runtime
        .mutate(|db| db.create("heartrate", first.clone()))
        .unwrap();
    assert_eq!(created, first);
    runtime
        .mutate(|db| db.create("heartrate", second.clone()))
        .unwrap();

    // The rewritten file had no final newline, so the first append adds it.
    let after = read(&partition(dir.path(), "2026-04"));
    assert_eq!(
        after,
        format!("{before}\n{}\n{}\n", line(&first), line(&second))
    );
    let io = io.lock().unwrap();
    assert!(io.replaced.is_empty(), "no file was rewritten");
    assert_eq!(io.appended.len(), 2);
    assert_eq!(io.appended[0].1, before.len() as u64);
    assert_eq!(io.appended[0].2, format!("\n{}\n", line(&first)));
    // Bytes written for a later append equal the line plus its newline.
    assert_eq!(io.appended[1].2, format!("{}\n", line(&second)));
    drop(io);
    assert_eq!(read(&partition(dir.path(), "2026-03")), other);

    // A later full rewrite of the same records produces the same lines.
    let all = [&existing[..], &[first, second]].concat();
    assert_eq!(after, format!("{}\n", rewrite(dir.path(), "2026-04", &all)));

    runtime.close().unwrap();
    let reopened = open(dir.path());
    assert!(reopened
        .find_by_id("heartrate", "heartrate:2026-04-15T08:03:00.000Z")
        .unwrap()
        .is_some());
    assert!(reopened.torn_line_diagnostics().unwrap().is_empty());
}

#[test]
fn a_batch_appends_one_write_per_partition_and_creates_new_files() {
    let dir = tempfile::tempdir().unwrap();
    let (host, io) = CountingHost::new(Duration::from_secs(2));
    let runtime = open_with_host(dir.path(), host);
    let records = vec![
        sample("2026-05", 0, 70),
        sample("2026-06", 0, 71),
        sample("2026-05", 1, 72),
    ];
    let result = runtime
        .mutate(|db| db.create_many("heartrate", records.clone()))
        .unwrap();
    assert_eq!(result.created, records);
    assert_eq!(
        read(&partition(dir.path(), "2026-05")),
        format!("{}\n{}\n", line(&records[0]), line(&records[2]))
    );
    assert_eq!(
        read(&partition(dir.path(), "2026-06")),
        format!("{}\n", line(&records[1]))
    );
    let paths = io
        .lock()
        .unwrap()
        .appended
        .iter()
        .map(|(path, keep, _)| (path.clone(), *keep))
        .collect::<Vec<_>>();
    let expected = ["2026-05", "2026-06"].map(|month| {
        (
            partition(dir.path(), month).to_string_lossy().into_owned(),
            0,
        )
    });
    assert_eq!(paths, expected);
}

#[test]
fn a_mixed_transaction_appends_and_rewrites_other_collections() {
    let dir = tempfile::tempdir().unwrap();
    let before = seed(dir.path(), "2026-04", &[sample("2026-04", 0, 70)]);
    let runtime = open(dir.path());
    let appended = sample("2026-04", 1, 75);
    runtime
        .mutate(|db| {
            db.create("heartrate", appended.clone())?;
            db.create("notes", sample("2026-04", 9, 1))
        })
        .unwrap();
    assert_eq!(
        read(&partition(dir.path(), "2026-04")),
        format!("{before}\n{}\n", line(&appended))
    );
    assert_eq!(
        read(&dir.path().join("notes.jsonl")),
        line(&sample("2026-04", 9, 1))
    );
    runtime
        .mutate(|db| {
            db.update(
                "notes",
                "heartrate:2026-04-15T08:09:00.000Z",
                json!({"bpm": 2}),
            )
        })
        .unwrap();
    assert_eq!(
        read(&partition(dir.path(), "2026-04")),
        format!("{before}\n{}\n", line(&appended))
    );
}

#[test]
fn append_only_collection_files_append_too() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(dir.path());
    cfg.collections[1].descriptor.append_only = true;
    let path = dir.path().join("notes.jsonl");
    fs::write(&path, format!("{}\n", line(&sample("2026-01", 0, 1)))).unwrap();
    let runtime = NativeRuntime::open_sources_with_options(cfg, options()).unwrap();
    runtime
        .mutate(|db| db.create("notes", sample("2026-01", 1, 2)))
        .unwrap();
    assert_eq!(
        read(&path),
        format!(
            "{}\n{}\n",
            line(&sample("2026-01", 0, 1)),
            line(&sample("2026-01", 1, 2))
        )
    );
}

// ── duplicate_ids and refusals ───────────────────────────────────────────────

#[test]
fn identical_re_append_is_a_no_op_and_a_conflict_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let record = sample("2026-04", 0, 70);
    let before = seed(dir.path(), "2026-04", std::slice::from_ref(&record));
    let (host, io) = CountingHost::new(Duration::from_secs(2));
    let runtime = open_with_host(dir.path(), host);

    let again = runtime
        .mutate(|db| db.create("heartrate", record.clone()))
        .unwrap();
    assert_eq!(again, record);
    let batch = runtime
        .mutate(|db| db.create_many("heartrate", vec![record.clone(), record.clone()]))
        .unwrap();
    assert_eq!(batch.created, vec![record.clone(), record.clone()]);
    assert!(io.lock().unwrap().appended.is_empty());

    let mut changed = record.clone();
    changed["bpm"] = json!(99);
    let error = runtime
        .mutate(|db| db.create("heartrate", changed.clone()))
        .unwrap_err();
    assert_eq!(error.tag(), "DuplicateKeyError");

    let fresh = sample("2026-04", 1, 71);
    let error = runtime
        .mutate(|db| db.create_many("heartrate", vec![fresh.clone(), changed.clone()]))
        .unwrap_err();
    assert_eq!(error.tag(), "DuplicateKeyError");
    assert!(runtime
        .find_by_id("heartrate", fresh["id"].as_str().unwrap())
        .unwrap()
        .is_none());
    assert!(io.lock().unwrap().appended.is_empty());
    assert_eq!(read(&partition(dir.path(), "2026-04")), before);
}

#[test]
fn update_and_delete_are_refused_with_the_append_only_error() {
    let dir = tempfile::tempdir().unwrap();
    let record = sample("2026-04", 0, 70);
    let before = seed(dir.path(), "2026-04", std::slice::from_ref(&record));
    let runtime = open(dir.path());
    let id = record["id"].as_str().unwrap();
    for error in [
        runtime
            .mutate(|db| db.update("heartrate", id, json!({"bpm": 1})))
            .unwrap_err(),
        runtime.mutate(|db| db.delete("heartrate", id)).unwrap_err(),
    ] {
        let EngineError::Operation(operation) = error else {
            panic!("expected OperationError, got {error:?}");
        };
        assert_eq!(operation.reason, "append-only");
    }
    assert_eq!(read(&partition(dir.path(), "2026-04")), before);
    assert_eq!(runtime.find_by_id("heartrate", id).unwrap(), Some(record));
}

#[test]
fn an_external_edit_since_load_is_rejected_before_appending() {
    let dir = tempfile::tempdir().unwrap();
    let before = seed(dir.path(), "2026-04", &[sample("2026-04", 0, 70)]);
    let runtime = open(dir.path());
    let external = format!("{before}\n{}\n", line(&sample("2026-04", 5, 90)));
    fs::write(partition(dir.path(), "2026-04"), &external).unwrap();
    let error = runtime
        .mutate(|db| db.create("heartrate", sample("2026-04", 1, 71)))
        .unwrap_err();
    assert!(error.to_string().contains("changed since load"), "{error}");
    assert_eq!(read(&partition(dir.path(), "2026-04")), external);
    runtime.reload().unwrap();
    runtime
        .mutate(|db| db.create("heartrate", sample("2026-04", 1, 71)))
        .unwrap();
    assert_eq!(
        read(&partition(dir.path(), "2026-04")),
        format!("{external}{}\n", line(&sample("2026-04", 1, 71)))
    );
}

// ── Failure and crash rules ──────────────────────────────────────────────────

struct FailAt(DurabilityFaultPoint);

impl DurabilityFaultInjector for FailAt {
    fn check(&self, point: DurabilityFaultPoint) -> Result<(), EngineError> {
        if point == self.0 {
            return Err(EngineError::Operation(
                proseql_engine::errors::OperationError {
                    operation: "append".into(),
                    reason: "injected-failure".into(),
                    message: format!("injected failure at {point:?}"),
                },
            ));
        }
        Ok(())
    }
}

#[test]
fn a_failed_append_returns_storage_error_rolls_back_and_quarantines() {
    for point in [
        DurabilityFaultPoint::AppendWrite,
        DurabilityFaultPoint::AppendSync,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let before = seed(dir.path(), "2026-04", &[sample("2026-04", 0, 70)]);
        let host = Arc::new(
            FsStorageHost::new_polling_with_fault_injector(
                Duration::from_secs(2),
                Arc::new(FailAt(point)),
            )
            .unwrap(),
        );
        let runtime = open_with_host(dir.path(), host);
        let record = sample("2026-04", 1, 71);
        let error = runtime
            .mutate(|db| db.create("heartrate", record.clone()))
            .unwrap_err();
        assert_eq!(error.tag(), "StorageError", "{point:?}: {error}");
        assert!(error.to_string().contains("completed paths"), "{error}");
        // Quarantined: no read can observe memory ahead of disk.
        assert!(runtime
            .find_by_id("heartrate", record["id"].as_str().unwrap())
            .is_err());
        runtime.close().unwrap();
        // The host removed the partial line.
        assert_eq!(read(&partition(dir.path(), "2026-04")), before, "{point:?}");
        let reopened = open(dir.path());
        assert!(reopened
            .find_by_id("heartrate", record["id"].as_str().unwrap())
            .unwrap()
            .is_none());
        reopened
            .mutate(|db| db.create("heartrate", record.clone()))
            .unwrap();
    }
}

struct PauseAt {
    ready: PathBuf,
    point: DurabilityFaultPoint,
}

impl DurabilityFaultInjector for PauseAt {
    fn check(&self, point: DurabilityFaultPoint) -> Result<(), EngineError> {
        if point == self.point {
            fs::write(&self.ready, "ready").unwrap();
            loop {
                std::thread::park();
            }
        }
        Ok(())
    }
}

#[test]
#[ignore = "subprocess-only crash boundary"]
fn append_crash_child() {
    let dir = PathBuf::from(std::env::var("PROSEQL_APPEND_CRASH_ROOT").unwrap());
    let host = Arc::new(
        FsStorageHost::new_polling_with_fault_injector(
            Duration::from_secs(2),
            Arc::new(PauseAt {
                ready: dir.join("ready"),
                point: DurabilityFaultPoint::AppendWrite,
            }),
        )
        .unwrap(),
    );
    let runtime = open_with_host(&dir, host);
    runtime
        .mutate(|db| db.create("heartrate", sample("2026-04", 1, 71)))
        .unwrap();
}

/// Kill a child process halfway through writing an append.
fn crash_mid_append(dir: &Path) {
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "append_crash_child", "--ignored", "--nocapture"])
        .env("PROSEQL_APPEND_CRASH_ROOT", dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !dir.join("ready").exists() {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("child exited before the append boundary: {status}");
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("child did not reach the append boundary");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    child.kill().unwrap();
    child.wait().unwrap();
    fs::remove_file(dir.join("ready")).unwrap();
}

#[test]
fn a_crash_mid_append_leaves_a_torn_line_that_reopen_ignores_and_the_next_append_removes() {
    let dir = tempfile::tempdir().unwrap();
    let existing = sample("2026-04", 0, 70);
    let before = format!("{}\n", line(&existing));
    fs::create_dir_all(root(dir.path())).unwrap();
    fs::write(partition(dir.path(), "2026-04"), &before).unwrap();

    crash_mid_append(dir.path());
    let torn = read(&partition(dir.path(), "2026-04"));
    assert!(
        torn.starts_with(&before) && torn.len() > before.len(),
        "{torn}"
    );
    assert!(!torn.ends_with('\n'), "the crash left a torn final line");

    let runtime = open(dir.path());
    let diagnostics = runtime.torn_line_diagnostics().unwrap();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].line, 2);
    assert_eq!(diagnostics[0].bytes, torn.len() - before.len());
    assert!(runtime
        .find_by_id("heartrate", "heartrate:2026-04-15T08:01:00.000Z")
        .unwrap()
        .is_none());
    assert!(runtime
        .find_by_id("heartrate", existing["id"].as_str().unwrap())
        .unwrap()
        .is_some());

    let retried = sample("2026-04", 1, 71);
    runtime
        .mutate(|db| db.create("heartrate", retried.clone()))
        .unwrap();
    assert_eq!(
        read(&partition(dir.path(), "2026-04")),
        format!("{before}{}\n", line(&retried))
    );
    assert!(runtime.torn_line_diagnostics().unwrap().is_empty());
    runtime.close().unwrap();
    let reopened = open(dir.path());
    assert!(reopened.torn_line_diagnostics().unwrap().is_empty());
    assert!(reopened
        .find_by_id("heartrate", retried["id"].as_str().unwrap())
        .unwrap()
        .is_some());
}

#[test]
fn a_torn_final_line_that_stops_inside_a_utf8_sequence_is_ignored_with_a_diagnostic() {
    let dir = tempfile::tempdir().unwrap();
    let existing = sample("2026-04", 0, 70);
    let before = format!("{}\n", line(&existing));
    fs::create_dir_all(root(dir.path())).unwrap();
    // An interrupted append of `"source":"café"` that stopped after the
    // first byte of `é` (0xC3 0xA9).
    let mut torn = before.clone().into_bytes();
    torn.extend_from_slice(b"{\"id\":\"heartrate:x\",\"source\":\"caf\xC3");
    fs::write(partition(dir.path(), "2026-04"), &torn).unwrap();

    let runtime = open(dir.path());
    let diagnostics = runtime.torn_line_diagnostics().unwrap();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].line, 2);
    assert_eq!(diagnostics[0].bytes, torn.len() - before.len());
    assert!(runtime
        .find_by_id("heartrate", existing["id"].as_str().unwrap())
        .unwrap()
        .is_some());
    let next = sample("2026-04", 1, 71);
    runtime
        .mutate(|db| db.create("heartrate", next.clone()))
        .unwrap();
    assert_eq!(
        read(&partition(dir.path(), "2026-04")),
        format!("{before}{}\n", line(&next))
    );
    assert!(runtime.torn_line_diagnostics().unwrap().is_empty());

    // Invalid UTF-8 on an earlier, complete line stays a strict error.
    let strict = tempfile::tempdir().unwrap();
    fs::create_dir_all(root(strict.path())).unwrap();
    let mut content = b"{\"id\":\"heartrate:y\",\"source\":\"caf\xC3\"}\n".to_vec();
    content.extend_from_slice(before.as_bytes());
    content.extend_from_slice(b"{\"id\"");
    fs::write(partition(strict.path(), "2026-04"), content).unwrap();
    let error = NativeRuntime::open_sources_with_options(config(strict.path()), options())
        .err()
        .expect("strict error");
    assert!(matches!(error, EngineError::Storage(_)), "{error:?}");
}

#[test]
fn an_unterminated_parseable_final_line_is_a_record() {
    let dir = tempfile::tempdir().unwrap();
    let last = sample("2026-04", 1, 71);
    let before = format!("{}\n{}", line(&sample("2026-04", 0, 70)), line(&last));
    fs::create_dir_all(root(dir.path())).unwrap();
    fs::write(partition(dir.path(), "2026-04"), &before).unwrap();
    let runtime = open(dir.path());
    assert!(runtime.torn_line_diagnostics().unwrap().is_empty());
    assert_eq!(
        runtime
            .find_by_id("heartrate", last["id"].as_str().unwrap())
            .unwrap(),
        Some(last)
    );
    let next = sample("2026-04", 2, 72);
    runtime
        .mutate(|db| db.create("heartrate", next.clone()))
        .unwrap();
    assert_eq!(
        read(&partition(dir.path(), "2026-04")),
        format!("{before}\n{}\n", line(&next))
    );
}

#[test]
fn other_malformed_lines_are_still_errors() {
    for content in [
        // A malformed line that is not the final line.
        "{\"id\":\"x\"\n{\"id\":\"heartrate:a\",\"timestamp\":\"t\",\"bpm\":1,\"source\":\"s\",\"month\":\"2026-04\"}\n".to_owned(),
        // A malformed final line that has its newline: not an interrupted append.
        "{\"id\":\"heartrate:a\",\"timestamp\":\"t\",\"bpm\":1,\"source\":\"s\",\"month\":\"2026-04\"}\n{\"id\"\n".to_owned(),
    ] {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(root(dir.path())).unwrap();
        fs::write(partition(dir.path(), "2026-04"), content).unwrap();
        let error = NativeRuntime::open_sources_with_options(config(dir.path()), options())
            .err()
            .expect("strict codec error");
        assert!(error.to_string().contains("JSONL parse error"), "{error}");
    }
}

#[test]
fn a_torn_line_in_a_rewritable_collection_is_still_an_error() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("notes.jsonl"),
        format!("{}\n{{\"id\"", line(&sample("2026-04", 0, 1))),
    )
    .unwrap();
    assert!(NativeRuntime::open_sources_with_options(config(dir.path()), options()).is_err());
}

// ── Watcher ──────────────────────────────────────────────────────────────────

fn wait_until(mut predicate: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !predicate() {
        assert!(std::time::Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn the_managed_watcher_does_not_reload_after_the_runtimes_own_append() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path(), "2026-04", &[sample("2026-04", 0, 70)]);
    let other = seed(dir.path(), "2026-03", &[sample("2026-03", 0, 60)]);
    let other_path = partition(dir.path(), "2026-03")
        .to_string_lossy()
        .into_owned();
    let (host, io) = CountingHost::new(Duration::from_millis(20));
    let runtime = NativeRuntime::open_sources_with_host(
        config(dir.path()),
        host,
        NativeSourceRuntimeOptions {
            watch_debounce: Some(Duration::from_millis(10)),
            ..Default::default()
        },
    )
    .unwrap();
    let reads_of_other = || {
        io.lock()
            .unwrap()
            .reads
            .get(&other_path)
            .copied()
            .unwrap_or(0)
    };
    let baseline = reads_of_other();

    for minute in 1..=3 {
        runtime
            .mutate(|db| db.create("heartrate", sample("2026-04", minute, 70 + minute)))
            .unwrap();
    }
    // Several poll intervals pass; a reload would read every partition again.
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(reads_of_other(), baseline, "own appends must not reload");
    assert!(runtime.last_reload_error().unwrap().is_none());

    // An external change is still picked up, and appends continue after it.
    let external = sample("2026-03", 1, 61);
    fs::write(
        partition(dir.path(), "2026-03"),
        format!("{other}\n{}\n", line(&external)),
    )
    .unwrap();
    wait_until(|| {
        runtime
            .find_by_id("heartrate", external["id"].as_str().unwrap())
            .unwrap()
            .is_some()
    });
    assert!(reads_of_other() > baseline);
    runtime
        .mutate(|db| db.create("heartrate", sample("2026-04", 4, 74)))
        .unwrap();
    runtime.close().unwrap();
}
