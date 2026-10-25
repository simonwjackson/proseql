//! Lazy partition conformance through the public native API, on real files in
//! temporary directories. Every lazy result is compared with an eager runtime
//! opened on the same files. Synthetic data only.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use proseql_engine::descriptor::{
    CollectionDescriptor, DuplicateIdPolicy, IdStrategy, IndexDescriptor, RelationshipDescriptor,
    RelationshipKind, SchemaNode, StructField, UniqueConstraintDescriptor, ValidationMode,
};
use proseql_engine::errors::EngineError;
use proseql_engine::query::aggregate::{compute_aggregates, compute_grouped_aggregates};
use proseql_engine::query::indexes::IndexUsed;
use proseql_engine::query::pipeline::QueryInput;
use proseql_engine::query::{AggregateConfig, SortOrder};
use proseql_engine::reactive::WatchQueryConfig;
use proseql_native::{
    FullScanPolicy, LazyPartitionPolicy, NativeCollectionConfig, NativeRuntime,
    NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::fs::FsStorageHost;
use proseql_storage::host::{StorageEvent, StorageHost, WatchHandle};
use proseql_storage::persistence::{DurableStorageHost, FileTail};
use proseql_storage::source_config::{
    CollectionFileSourceConfig, DatabaseSourceConfig, PartitionKey, PartitionedSourceConfig,
    TimeBucket,
};
use serde_json::{json, Value};

const SOURCE: &str = "heartrate";
const MONTHS: [(&str, u32); 6] = [
    ("2025-11", 30),
    ("2025-12", 31),
    ("2026-01", 31),
    ("2026-02", 28),
    ("2026-03", 31),
    ("2026-04", 30),
];

// ── Configuration ────────────────────────────────────────────────────────────

fn descriptor(name: &str) -> CollectionDescriptor {
    CollectionDescriptor {
        name: name.into(),
        schema: SchemaNode::Struct {
            fields: [
                ("id", SchemaNode::Str),
                ("timestamp", SchemaNode::Str),
                ("bpm", SchemaNode::Num),
                ("source", SchemaNode::Str),
            ]
            .into_iter()
            .map(|(name, schema)| StructField {
                name: name.into(),
                schema,
            })
            .collect(),
        },
        id_strategy: IdStrategy::Provided,
        relationships: vec![],
        indexes: vec![IndexDescriptor::Single("source".into())],
        ordered_indexes: vec!["timestamp".into()],
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
        append_only: true,
        duplicate_ids: DuplicateIdPolicy::IgnoreIdentical,
        validation_mode: ValidationMode::Strict,
    }
}

fn root(dir: &Path) -> PathBuf {
    dir.join("heartrate")
}

fn partitioned(dir: &Path, format: &str) -> DatabaseSourceConfig {
    DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
        id: SOURCE.into(),
        collection: "heartrate".into(),
        root: root(dir).to_string_lossy().into_owned(),
        format: format.into(),
        partition_by: PartitionKey::TimeBucket {
            field: "timestamp".into(),
            bucket: TimeBucket::Month,
        },
        prose: None,
    })
}

fn config(dir: &Path) -> NativeSourceRuntimeConfig {
    NativeSourceRuntimeConfig {
        collections: vec![NativeCollectionConfig::new(descriptor("heartrate"))],
        sources: vec![partitioned(dir, "jsonl")],
    }
}

fn policy(max_loaded_partitions: usize, full_scan: FullScanPolicy) -> LazyPartitionPolicy {
    LazyPartitionPolicy {
        max_loaded_partitions,
        full_scan,
    }
}

fn lazy_options(policy: LazyPartitionPolicy) -> NativeSourceRuntimeOptions {
    NativeSourceRuntimeOptions {
        watch_debounce: None,
        lazy_partitions: IndexMap::from([(SOURCE.to_owned(), policy)]),
        ..Default::default()
    }
}

fn open_lazy(dir: &Path, policy: LazyPartitionPolicy) -> NativeRuntime {
    NativeRuntime::open_sources_with_options(config(dir), lazy_options(policy)).unwrap()
}

fn open_eager(dir: &Path) -> NativeRuntime {
    NativeRuntime::open_sources_with_options(
        config(dir),
        NativeSourceRuntimeOptions {
            watch_debounce: None,
            ..Default::default()
        },
    )
    .unwrap()
}

#[test]
fn zero_cache_bounded_reads_release_rows_and_reread_durable_data() {
    let dir = tempfile::tempdir().unwrap();
    let expected = seed(dir.path());
    let runtime = open_lazy(dir.path(), policy(0, FullScanPolicy::Allow));
    for _ in 0..2 {
        let actual = runtime
            .query_bounded(SOURCE, QueryInput::default())
            .unwrap();
        assert_eq!(actual, expected);
        drop(actual);
        assert!(loaded(&runtime).is_empty());
        assert_eq!(
            runtime
                .read(|db| Ok(db.collection(SOURCE).unwrap().len()))
                .unwrap(),
            0
        );
    }
    runtime.close().unwrap();
}

// ── Synthetic data ───────────────────────────────────────────────────────────

fn sample(timestamp: &str, n: usize) -> Value {
    let sources = ["awake", "rest", "live", "workout"];
    json!({
        "id": format!("heartrate:{timestamp}"),
        "timestamp": timestamp,
        "bpm": 50 + (n * 7) % 90,
        "source": sources[n % sources.len()],
    })
}

/// Timestamps at the edges of each month and inside it, in time order.
fn month_timestamps(month: &str, days: u32) -> Vec<String> {
    vec![
        format!("{month}-01T00:00:00.000Z"),
        format!("{month}-01T00:00:00.0000Z"),
        format!("{month}-01T00:00:00Z"),
        format!("{month}-01T00:00:00.001Z"),
        format!("{month}-10T05:00:00.000Z"),
        format!("{month}-10T05:30:00.000Z"),
        format!("{month}-10T05:59:59.999Z"),
        format!("{month}-10T06:00:00.000Z"),
        format!("{month}-15T12:34:56.789Z"),
        format!("{month}-{days}T23:59:59.999Z"),
        format!("{month}-{days}T23:59:59Z"),
    ]
}

fn write_partition(dir: &Path, month: &str, records: &[Value]) -> PathBuf {
    fs::create_dir_all(root(dir)).unwrap();
    let path = root(dir).join(format!("{month}.jsonl"));
    let lines = records
        .iter()
        .map(|record| serde_json::to_string(record).unwrap())
        .collect::<Vec<_>>();
    // Write and rename, so a polling watcher never reads half a file.
    let staged = root(dir).join(format!(".{month}.jsonl.tmp"));
    fs::write(&staged, lines.join("\n")).unwrap();
    fs::rename(&staged, &path).unwrap();
    path
}

/// Six monthly partitions of 11 records; returns every record in path order.
fn seed(dir: &Path) -> Vec<Value> {
    let mut all = Vec::new();
    let mut n = 0;
    for (month, days) in MONTHS {
        let records = month_timestamps(month, days)
            .iter()
            .map(|timestamp| {
                n += 1;
                sample(timestamp, n)
            })
            .collect::<Vec<_>>();
        write_partition(dir, month, &records);
        all.extend(records);
    }
    all
}

fn lazy_query(runtime: &NativeRuntime, input: QueryInput) -> Vec<Value> {
    runtime.query("heartrate", input, None).unwrap()
}

fn eager_query(runtime: &NativeRuntime, input: QueryInput) -> Vec<Value> {
    runtime
        .read(|db| db.query("heartrate", input, None))
        .unwrap()
}

fn filtered(filter: Value) -> QueryInput {
    QueryInput {
        r#where: Some(filter),
        ..QueryInput::default()
    }
}

fn month(prefix: &str) -> QueryInput {
    QueryInput {
        r#where: Some(json!({"timestamp": {"$startsWith": prefix}})),
        sort: vec![("timestamp".to_owned(), SortOrder::Asc)],
        ..QueryInput::default()
    }
}

fn loaded(runtime: &NativeRuntime) -> Vec<String> {
    runtime
        .lazy_partition_status(SOURCE)
        .unwrap()
        .unwrap()
        .loaded
        .iter()
        .map(|path| {
            Path::new(path)
                .file_stem()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect()
}

fn operation_reason(error: &EngineError) -> &str {
    match error {
        EngineError::Operation(operation) => &operation.reason,
        other => panic!("expected OperationError, got {other:?}"),
    }
}

fn source_config_message(error: &EngineError) -> &str {
    match error {
        EngineError::SourceConfig(config) => &config.message,
        other => panic!("expected SourceConfigError, got {other:?}"),
    }
}

fn wait_until(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("timed out waiting for {what}");
}

fn resident_len(runtime: &NativeRuntime) -> usize {
    runtime
        .read(|db| Ok(db.collection("heartrate").unwrap().len()))
        .unwrap()
}

// ── Counting host ────────────────────────────────────────────────────────────

type Reads = Arc<Mutex<HashMap<String, usize>>>;

struct CountingHost {
    fs: FsStorageHost,
    reads: Reads,
}

impl CountingHost {
    fn new() -> (Arc<Self>, Reads) {
        let reads = Arc::new(Mutex::new(HashMap::new()));
        (
            Arc::new(Self {
                fs: FsStorageHost::new_polling(Duration::from_secs(2)).unwrap(),
                reads: Arc::clone(&reads),
            }),
            reads,
        )
    }
}

impl DurableStorageHost for CountingHost {
    fn replace_durable(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.fs.replace_durable(path, data)
    }
    fn append_durable(&self, path: &str, keep_len: u64, data: &str) -> Result<(), EngineError> {
        self.fs.append_durable(path, keep_len, data)
    }
    fn read_tail(&self, path: &str, max_tail: usize) -> Result<Option<FileTail>, EngineError> {
        self.fs.read_tail(path, max_tail)
    }
}

impl StorageHost for CountingHost {
    fn read(&self, path: &str) -> Result<String, EngineError> {
        *self.reads.lock().unwrap().entry(path.into()).or_default() += 1;
        self.fs.read(path)
    }
    fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, EngineError> {
        *self.reads.lock().unwrap().entry(path.into()).or_default() += 1;
        self.fs.read_range(path, offset, len)
    }
    fn stat(&self, path: &str) -> Result<Option<proseql_storage::host::FileStat>, EngineError> {
        self.fs.stat(path)
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

// ── Open ─────────────────────────────────────────────────────────────────────

#[test]
fn open_lists_partition_names_and_reads_no_file() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let (host, reads) = CountingHost::new();
    let runtime = NativeRuntime::open_sources_with_host(
        config(dir.path()),
        host,
        lazy_options(policy(2, FullScanPolicy::Allow)),
    )
    .unwrap();
    assert!(reads.lock().unwrap().is_empty(), "open read a partition");
    let status = runtime.lazy_partition_status(SOURCE).unwrap().unwrap();
    assert_eq!(status.partitions.len(), MONTHS.len());
    assert!(status.loaded.is_empty());
    assert_eq!(resident_len(&runtime), 0);

    let (rows, stats) = runtime
        .query_with_stats(
            "heartrate",
            filtered(json!({"timestamp": {"$gte": "2026-01-10T05:00:00.000Z", "$lt": "2026-01-10T06:00:00.000Z"}})),
            None,
        )
        .unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(stats.partitions_loaded, 1);
    assert_eq!(stats.partitions_read, 1);
    assert_eq!(stats.index_used, IndexUsed::Ordered);
    assert_eq!(stats.candidate_rows, 3);
    let read_paths = reads.lock().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(read_paths.len(), 1);
    assert!(read_paths[0].ends_with("2026-01.jsonl"));
}

#[test]
fn eager_runtimes_report_partition_stats() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let eager = open_eager(dir.path());
    assert!(eager.lazy_partition_status(SOURCE).unwrap().is_none());
    let (rows, stats) = eager
        .query_with_stats(
            "heartrate",
            filtered(json!({"timestamp": {"$gte": "2026-01-10T05:00:00.000Z", "$lt": "2026-01-10T06:00:00.000Z"}})),
            None,
        )
        .unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(stats.partitions_loaded, MONTHS.len());
    assert_eq!(stats.partitions_read, 0);
    assert_eq!(stats.index_used, IndexUsed::Ordered);
}

// ── Filtered queries ─────────────────────────────────────────────────────────

#[test]
fn filtered_queries_match_eager_with_sorts_and_pages() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let eager = open_eager(dir.path());
    let lazy = open_lazy(dir.path(), policy(2, FullScanPolicy::Error));
    let cases = [
        (
            json!({"timestamp": {"$gte": "2026-01-10T05:00:00.000Z", "$lt": "2026-01-10T06:00:00.000Z"}}),
            1,
        ),
        // `2026-03-01T00:00:00.0000Z` sorts before the upper bound: March is touched.
        (
            json!({"timestamp": {"$gte": "2026-02-01T00:00:00.000Z", "$lt": "2026-03-01T00:00:00.000Z"}}),
            2,
        ),
        (
            json!({"timestamp": {"$gte": "2026-02-01T00:00:00.000Z", "$lt": "2026-03-01T00:00:00"}}),
            1,
        ),
        (json!({"timestamp": {"$gt": "2026-02-28T23:59:59.999Z"}}), 3),
        (json!({"timestamp": {"$lte": "2025-12-01T00:00:00Z"}}), 2),
        (json!({"timestamp": "2026-04-30T23:59:59Z"}), 1),
        (
            json!({"timestamp": {"$in": ["2025-11-01T00:00:00Z", "2026-03-15T12:34:56.789Z", "2027-01-01T00:00:00Z"]}}),
            2,
        ),
        (json!({"timestamp": {"$startsWith": "2026-03-1"}}), 1),
        (
            json!({"$or": [{"timestamp": {"$lt": "2025-11-02"}}, {"timestamp": {"$gte": "2026-04-30"}}]}),
            2,
        ),
        (
            json!({"$and": [{"timestamp": {"$gte": "2025-12"}}, {"timestamp": {"$lt": "2026-01-01T00:00:00"}}, {"source": "rest"}]}),
            1,
        ),
        (json!({"timestamp": {"$gte": "2026-05"}}), 0),
    ];
    let sorts = [
        vec![],
        vec![("timestamp".to_owned(), SortOrder::Asc)],
        vec![("timestamp".to_owned(), SortOrder::Desc)],
        vec![
            ("bpm".to_owned(), SortOrder::Desc),
            ("timestamp".to_owned(), SortOrder::Asc),
        ],
    ];
    for (filter, partitions) in cases {
        for sort in &sorts {
            for (offset, limit) in [(None, None), (Some(1), Some(3))] {
                let input = QueryInput {
                    r#where: Some(filter.clone()),
                    sort: sort.clone(),
                    offset,
                    limit,
                    ..QueryInput::default()
                };
                let (rows, stats) = lazy
                    .query_with_stats("heartrate", input.clone(), None)
                    .unwrap();
                assert_eq!(rows, eager_query(&eager, input), "{filter} {sort:?}");
                assert_eq!(stats.partitions_loaded, partitions, "{filter}");
                assert!(stats.partitions_resident <= 2, "{filter}");
                assert!(stats.partitions_resident >= partitions.min(2), "{filter}");
            }
        }
    }
}

#[test]
fn pruning_never_skips_a_matching_partition() {
    let dir = tempfile::tempdir().unwrap();
    let all = seed(dir.path());
    let eager = open_eager(dir.path());
    let lazy = open_lazy(dir.path(), policy(1, FullScanPolicy::Allow));
    let mut bounds = all
        .iter()
        .map(|record| record["timestamp"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    bounds.extend(
        [
            "",
            "2025",
            "2026",
            "2027",
            "2026-01",
            "2026-02-",
            "2026-02-01T00:00:00",
            "2026-03-01T00:00:00.",
            "2026-03-31T23:59:59.9999Z",
            "2026-03-31T23:59:59.9990Z",
            "2026-02-29T00:00:00Z",
            "2026-04-01T00:00:00+00:00",
        ]
        .map(str::to_owned),
    );
    let mut checked = 0;
    for bound in &bounds {
        for op in ["$gt", "$gte", "$lt", "$lte", "$eq", "$startsWith"] {
            let input = QueryInput {
                r#where: Some(json!({"timestamp": {op: bound}})),
                sort: vec![("timestamp".to_owned(), SortOrder::Asc)],
                ..QueryInput::default()
            };
            assert_eq!(
                lazy_query(&lazy, input.clone()),
                eager_query(&eager, input),
                "{op} {bound}"
            );
            checked += 1;
        }
        let input = filtered(json!({"timestamp": {"$in": [bound, "2026-02-10T05:30:00.000Z"]}}));
        assert_eq!(lazy_query(&lazy, input.clone()), eager_query(&eager, input));
    }
    // Between-style pairs around every month edge.
    for low in bounds.iter().step_by(3) {
        for high in bounds.iter().step_by(4) {
            for (low_op, high_op) in [("$gte", "$lt"), ("$gt", "$lte")] {
                let input = filtered(json!({"timestamp": {low_op: low, high_op: high}}));
                assert_eq!(
                    lazy_query(&lazy, input.clone()),
                    eager_query(&eager, input),
                    "{low_op} {low} {high_op} {high}"
                );
                checked += 1;
            }
        }
    }
    assert!(checked > 500, "{checked}");
    assert!(loaded(&lazy).len() <= 1);
}

// ── Unfiltered queries and aggregates ────────────────────────────────────────

#[test]
fn unfiltered_queries_and_aggregates_match_eager_then_return_to_the_bound() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let eager = open_eager(dir.path());
    let lazy = open_lazy(dir.path(), policy(2, FullScanPolicy::Allow));
    for input in [
        QueryInput::default(),
        QueryInput {
            sort: vec![("timestamp".to_owned(), SortOrder::Desc)],
            limit: Some(5),
            ..QueryInput::default()
        },
        filtered(json!({"source": "rest"})),
        filtered(json!({"bpm": {"$gte": 100}})),
    ] {
        let (rows, stats) = lazy
            .query_with_stats("heartrate", input.clone(), None)
            .unwrap();
        assert_eq!(rows, eager_query(&eager, input));
        assert_eq!(stats.partitions_loaded, MONTHS.len());
        assert_eq!(stats.partitions_resident, 2);
        assert_eq!(loaded(&lazy).len(), 2);
    }
    let config = AggregateConfig {
        count: true,
        sum: vec!["bpm".into()],
        avg: vec!["bpm".into()],
        min: vec!["bpm".into(), "timestamp".into()],
        max: vec!["bpm".into(), "timestamp".into()],
    };
    for filter in [
        None,
        Some(json!({"timestamp": {"$gte": "2026-01-15", "$lt": "2026-03-10T05:30:00.000Z"}})),
    ] {
        let expected_rows = eager_query(
            &eager,
            QueryInput {
                r#where: filter.clone(),
                ..QueryInput::default()
            },
        );
        assert_eq!(
            lazy.aggregate("heartrate", filter.clone(), &config)
                .unwrap(),
            compute_aggregates(&expected_rows, &config)
        );
        let group_by = ["source".to_owned()];
        assert_eq!(
            lazy.aggregate_grouped("heartrate", filter.clone(), &group_by, &config)
                .unwrap(),
            compute_grouped_aggregates(&expected_rows, &group_by, &config)
        );
    }
    assert_eq!(loaded(&lazy).len(), 2);
}

#[test]
fn full_scan_error_fails_with_a_typed_error_and_loads_nothing() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let lazy = open_lazy(dir.path(), policy(3, FullScanPolicy::Error));
    for input in [
        QueryInput::default(),
        filtered(json!({"bpm": 60})),
        filtered(json!({"timestamp": {"$ne": "2026-01-01T00:00:00Z"}})),
        filtered(json!({"$or": [{"timestamp": "2026-01-01T00:00:00Z"}, {"source": "rest"}]})),
    ] {
        let error = lazy.query("heartrate", input, None).unwrap_err();
        assert_eq!(operation_reason(&error), "lazy-full-scan");
        assert!(loaded(&lazy).is_empty());
    }
    let error = lazy
        .aggregate("heartrate", None, &AggregateConfig::count())
        .unwrap_err();
    assert_eq!(operation_reason(&error), "lazy-full-scan");
    let id = "heartrate:2026-01-15T12:34:56.789Z";
    let error = lazy.find_by_id("heartrate", id).unwrap_err();
    assert_eq!(operation_reason(&error), "lazy-full-scan");
    assert!(loaded(&lazy).is_empty());
    // An ID found among the loaded partitions needs no scan.
    lazy_query(&lazy, month("2026-01"));
    let found = lazy.find_by_id("heartrate", id).unwrap().unwrap();
    assert_eq!(found["timestamp"], "2026-01-15T12:34:56.789Z");
}

#[test]
fn find_by_id_loads_everything_under_allow_and_returns_to_the_bound() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let lazy = open_lazy(dir.path(), policy(1, FullScanPolicy::Allow));
    let found = lazy
        .find_by_id("heartrate", "heartrate:2026-02-28T23:59:59Z")
        .unwrap()
        .unwrap();
    assert_eq!(found["timestamp"], "2026-02-28T23:59:59Z");
    assert!(lazy
        .find_by_id("heartrate", "heartrate:none")
        .unwrap()
        .is_none());
    assert_eq!(loaded(&lazy).len(), 1);
}

// ── Eviction and pinning ─────────────────────────────────────────────────────

#[test]
fn eviction_drops_the_least_recently_used_partition_and_reloads_it_identically() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let eager = open_eager(dir.path());
    let lazy = open_lazy(dir.path(), policy(2, FullScanPolicy::Error));
    let first = lazy_query(&lazy, month("2026-01"));
    lazy_query(&lazy, month("2026-02"));
    assert_eq!(loaded(&lazy), ["2026-01", "2026-02"]);
    // 2026-01 is used again, so 2026-02 is the least recently used.
    lazy_query(&lazy, month("2026-01"));
    lazy_query(&lazy, month("2026-03"));
    assert_eq!(loaded(&lazy), ["2026-01", "2026-03"]);
    lazy_query(&lazy, month("2026-04"));
    assert_eq!(loaded(&lazy), ["2026-03", "2026-04"]);
    // Evicted records and their index postings are gone.
    assert_eq!(resident_len(&lazy), 22);
    let (again, stats) = lazy
        .query_with_stats("heartrate", month("2026-01"), None)
        .unwrap();
    assert_eq!(stats.partitions_read, 1);
    assert_eq!(again, first);
    assert_eq!(again, eager_query(&eager, month("2026-01")));
    // Ordered and equality indexes after eviction and reload.
    let input = filtered(json!({"timestamp": {"$gte": "2026-01-10", "$lt": "2026-01-11"}}));
    let (rows, stats) = lazy
        .query_with_stats("heartrate", input.clone(), None)
        .unwrap();
    assert_eq!(rows, eager_query(&eager, input));
    assert_eq!(stats.index_used, IndexUsed::Ordered);
    assert_eq!(stats.candidate_rows, 4);
    let input = filtered(json!({"source": "live", "timestamp": {"$startsWith": "2026-01"}}));
    let (rows, stats) = lazy
        .query_with_stats("heartrate", input.clone(), None)
        .unwrap();
    assert_eq!(rows, eager_query(&eager, input));
    assert_ne!(stats.index_used, IndexUsed::None);
    assert!(stats.candidate_rows < resident_len(&lazy));
}

#[test]
fn watches_pin_the_partitions_their_filter_touches() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let lazy = open_lazy(dir.path(), policy(1, FullScanPolicy::Error));
    let watch = lazy
        .watch(
            "heartrate",
            WatchQueryConfig {
                r#where: Some(json!({"timestamp": {"$gte": "2026-01-10T00:00:00Z", "$lt": "2026-01-11T00:00:00Z"}})),
                sort: vec![("timestamp".to_owned(), SortOrder::Asc)],
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    let initial = watch.recv().unwrap();
    assert_eq!(initial.as_array().unwrap().len(), 4);
    for prefix in ["2026-02", "2026-03", "2026-04"] {
        lazy_query(&lazy, month(prefix));
        let resident = loaded(&lazy);
        assert!(resident.contains(&"2026-01".to_owned()), "{resident:?}");
        assert_eq!(resident.len(), 2, "{resident:?}");
    }
    let status = lazy.lazy_partition_status(SOURCE).unwrap().unwrap();
    assert_eq!(status.pinned.len(), 1);
    assert!(status.pinned[0].ends_with("2026-01.jsonl"));
    // An append into the pinned partition reaches the watch.
    lazy.mutate(|db| db.create("heartrate", sample("2026-01-10T07:00:00.000Z", 1)))
        .unwrap();
    wait_until("the watch update", || {
        watch
            .try_recv()
            .is_ok_and(|value| value.as_array().is_some_and(|rows| rows.len() == 5))
    });
    drop(watch);
    lazy_query(&lazy, month("2026-02"));
    assert_eq!(loaded(&lazy), ["2026-02"]);
    assert!(lazy
        .lazy_partition_status(SOURCE)
        .unwrap()
        .unwrap()
        .pinned
        .is_empty());
    // A watch that cannot prune is a full scan.
    let error = lazy
        .watch("heartrate", WatchQueryConfig::default())
        .err()
        .unwrap();
    assert_eq!(operation_reason(&error), "lazy-full-scan");
}

// ── Appends ──────────────────────────────────────────────────────────────────

#[test]
fn appends_into_unloaded_evicted_and_new_partitions() {
    let dir = tempfile::tempdir().unwrap();
    let all = seed(dir.path());
    let january = root(dir.path()).join("2026-01.jsonl");
    let before = fs::read(&january).unwrap();
    let (host, reads) = CountingHost::new();
    let lazy = NativeRuntime::open_sources_with_host(
        config(dir.path()),
        host,
        lazy_options(policy(1, FullScanPolicy::Error)),
    )
    .unwrap();

    // Unloaded partition: the target loads for the ID check, then one line is appended.
    let first = sample("2026-01-20T08:00:00.000Z", 100);
    assert_eq!(
        lazy.mutate(|db| db.create("heartrate", first.clone()))
            .unwrap(),
        first
    );
    assert_eq!(loaded(&lazy), ["2026-01"]);
    assert_eq!(reads.lock().unwrap().len(), 1);
    let after = fs::read(&january).unwrap();
    assert!(after.starts_with(&before));
    assert_eq!(
        &after[before.len()..],
        format!("\n{}\n", serde_json::to_string(&first).unwrap()).as_bytes()
    );

    // Identical re-create writes nothing; a conflicting payload is refused.
    lazy.mutate(|db| db.create("heartrate", first.clone()))
        .unwrap();
    assert_eq!(fs::read(&january).unwrap(), after);
    let mut conflicting = first.clone();
    conflicting["bpm"] = json!(1);
    let error = lazy
        .mutate(|db| db.create("heartrate", conflicting.clone()))
        .unwrap_err();
    assert!(matches!(error, EngineError::DuplicateKey(_)), "{error:?}");
    // A stored record of the (now evicted) target partition is checked too.
    lazy_query(&lazy, month("2026-02"));
    assert_eq!(loaded(&lazy), ["2026-02"]);
    let mut existing = all[25].clone();
    assert!(existing["timestamp"]
        .as_str()
        .unwrap()
        .starts_with("2026-01"));
    existing["bpm"] = json!(2);
    let error = lazy
        .mutate(|db| db.create("heartrate", existing.clone()))
        .unwrap_err();
    assert!(matches!(error, EngineError::DuplicateKey(_)), "{error:?}");
    assert_eq!(fs::read(&january).unwrap(), after);

    // Evicted partition, in a batch with another partition.
    lazy_query(&lazy, month("2026-03"));
    assert_eq!(loaded(&lazy), ["2026-03"]);
    let second = sample("2026-01-21T08:00:00.000Z", 101);
    let third = sample("2026-03-21T08:00:00.000Z", 102);
    lazy.mutate(|db| db.create_many("heartrate", vec![second.clone(), third.clone()]))
        .unwrap();
    assert_eq!(loaded(&lazy).len(), 1);

    // New partition: no file to read; the file is created.
    let reads_before = reads.lock().unwrap().values().sum::<usize>();
    let new = sample("2026-09-01T00:00:00.000Z", 103);
    lazy.mutate(|db| db.create("heartrate", new.clone()))
        .unwrap();
    assert_eq!(reads.lock().unwrap().values().sum::<usize>(), reads_before);
    let september = root(dir.path()).join("2026-09.jsonl");
    assert_eq!(
        fs::read_to_string(&september).unwrap(),
        format!("{}\n", serde_json::to_string(&new).unwrap())
    );
    assert_eq!(loaded(&lazy), ["2026-09"]);
    assert_eq!(
        lazy_query(&lazy, filtered(json!({"timestamp": {"$gte": "2026-09"}}))),
        vec![new.clone()]
    );
    lazy.close().unwrap();

    let eager = open_eager(dir.path());
    let mut expected = all;
    expected.extend([first, second, third, new]);
    let mut actual = eager_query(&eager, QueryInput::default());
    let key = |record: &Value| record["id"].as_str().unwrap().to_owned();
    expected.sort_by_key(key);
    actual.sort_by_key(key);
    assert_eq!(actual, expected);
}

#[test]
fn create_without_the_partition_field_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let lazy = open_lazy(dir.path(), policy(1, FullScanPolicy::Error));
    let error = lazy
        .mutate(|db| db.create("heartrate", json!({"id": "x", "bpm": 60, "source": "rest"})))
        .unwrap_err();
    assert!(
        matches!(
            error,
            EngineError::Validation(_) | EngineError::SourceConfig(_)
        ),
        "{error:?}"
    );
    assert_eq!(
        fs::read_dir(root(dir.path())).unwrap().count(),
        MONTHS.len()
    );
}

// ── Load-time checks ─────────────────────────────────────────────────────────

#[test]
fn wrong_partition_and_duplicate_checks_run_when_a_partition_loads() {
    let dir = tempfile::tempdir().unwrap();
    write_partition(
        dir.path(),
        "2026-01",
        &[
            sample("2026-01-05T00:00:00Z", 1),
            sample("2026-02-05T00:00:00Z", 2),
        ],
    );
    let shared = json!({"id": "heartrate:shared", "timestamp": "2026-03-05T00:00:00Z", "bpm": 60, "source": "rest"});
    let mut april = shared.clone();
    april["timestamp"] = json!("2026-04-05T00:00:00Z");
    write_partition(dir.path(), "2026-03", &[shared]);
    write_partition(dir.path(), "2026-04", &[april]);
    // Open decodes nothing, so it succeeds.
    let lazy = open_lazy(dir.path(), policy(4, FullScanPolicy::Allow));
    let error = lazy.query("heartrate", month("2026-01"), None).unwrap_err();
    assert!(
        source_config_message(&error).contains("wrong partition"),
        "{error:?}"
    );
    // Each partition alone is valid; together they repeat an ID.
    lazy_query(&lazy, month("2026-03"));
    let error = lazy
        .query(
            "heartrate",
            filtered(json!({"timestamp": {"$gte": "2026-03"}})),
            None,
        )
        .unwrap_err();
    assert!(
        source_config_message(&error).contains("Duplicate partition record"),
        "{error:?}"
    );
    // The failed load left the loaded partitions consistent.
    assert_eq!(lazy_query(&lazy, month("2026-03")).len(), 1);
}

// ── Preconditions ────────────────────────────────────────────────────────────

#[test]
fn open_rejects_sources_that_do_not_qualify() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let lazy = || lazy_options(policy(2, FullScanPolicy::Allow));
    let open = |config: NativeSourceRuntimeConfig, options: NativeSourceRuntimeOptions| {
        NativeRuntime::open_sources_with_options(config, options)
            .err()
            .expect("open must fail")
    };
    let with = |edit: &dyn Fn(&mut CollectionDescriptor)| {
        let mut config = config(dir.path());
        edit(&mut config.collections[0].descriptor);
        config
    };
    let cases: Vec<(&str, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions)> = vec![
        ("append_only", with(&|d| d.append_only = false), lazy()),
        (
            "unique_fields",
            with(&|d| {
                d.unique_fields = vec![UniqueConstraintDescriptor::Single("timestamp".into())]
            }),
            lazy(),
        ),
        (
            "relationships from",
            with(&|d| {
                d.relationships = vec![(
                    "owner".into(),
                    RelationshipDescriptor {
                        kind: RelationshipKind::Ref,
                        target: "heartrate".into(),
                        foreign_key: Some("ownerId".into()),
                    },
                )]
            }),
            lazy(),
        ),
        (
            "unknown source",
            config(dir.path()),
            NativeSourceRuntimeOptions {
                lazy_partitions: IndexMap::from([(
                    "missing".to_owned(),
                    policy(1, FullScanPolicy::Allow),
                )]),
                watch_debounce: None,
                ..Default::default()
            },
        ),
        (
            "JSONL",
            NativeSourceRuntimeConfig {
                collections: config(dir.path()).collections,
                sources: vec![partitioned(&dir.path().join("json"), "json")],
            },
            lazy(),
        ),
    ];
    for (expected, config, options) in cases {
        let error = open(config, options);
        assert!(
            source_config_message(&error).contains(expected),
            "{expected}: {error:?}"
        );
    }

    // Relationships into the collection, and a source that is not partitioned.
    let mut notes = descriptor("notes");
    notes.append_only = false;
    notes.indexes = vec![];
    notes.ordered_indexes = vec![];
    notes.duplicate_ids = DuplicateIdPolicy::Error;
    notes.relationships = vec![(
        "sample".into(),
        RelationshipDescriptor {
            kind: RelationshipKind::Ref,
            target: "heartrate".into(),
            foreign_key: Some("sampleId".into()),
        },
    )];
    let notes_source = DatabaseSourceConfig::CollectionFile(CollectionFileSourceConfig {
        id: "notes".into(),
        collection: "notes".into(),
        path: dir.path().join("notes.json").to_string_lossy().into_owned(),
        format: None,
        prose: None,
    });
    let mut config_in = config(dir.path());
    config_in
        .collections
        .push(NativeCollectionConfig::new(notes.clone()));
    config_in.sources.push(notes_source.clone());
    let error = open(config_in, lazy());
    assert!(
        source_config_message(&error).contains("relationships into"),
        "{error:?}"
    );

    notes.relationships = vec![];
    let mut config_file = config(dir.path());
    config_file
        .collections
        .push(NativeCollectionConfig::new(notes));
    config_file.sources.push(notes_source);
    let error = open(
        config_file,
        NativeSourceRuntimeOptions {
            lazy_partitions: IndexMap::from([(
                "notes".to_owned(),
                policy(1, FullScanPolicy::Allow),
            )]),
            watch_debounce: None,
            ..Default::default()
        },
    );
    assert!(
        source_config_message(&error).contains("Partitioned"),
        "{error:?}"
    );
}

// ── File watcher ─────────────────────────────────────────────────────────────

#[test]
fn external_files_are_listed_and_loaded_partitions_refresh_while_lazy() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let lazy = NativeRuntime::open_sources_with_options(
        config(dir.path()),
        NativeSourceRuntimeOptions {
            watch_debounce: Some(Duration::from_millis(20)),
            lazy_watch_interval: Duration::from_millis(50),
            lazy_partitions: IndexMap::from([(
                SOURCE.to_owned(),
                policy(2, FullScanPolicy::Error),
            )]),
            ..Default::default()
        },
    )
    .unwrap();
    let june_watch = lazy
        .watch(
            "heartrate",
            WatchQueryConfig {
                r#where: Some(json!({"timestamp": {"$gte": "2026-06", "$lt": "2026-07"}})),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    assert_eq!(june_watch.recv().unwrap(), json!([]));
    let changes = lazy.read(|db| Ok(db.subscribe_change_events())).unwrap();

    // Own append: the stored state follows; no refresh is published.
    lazy.mutate(|db| db.create("heartrate", sample("2026-04-20T00:00:00Z", 7)))
        .unwrap();
    std::thread::sleep(Duration::from_millis(400));
    let events = std::iter::from_fn(|| changes.try_recv().ok()).count();
    assert_eq!(events, 1, "own append must publish once and not reload");
    assert!(lazy.last_reload_error().unwrap().is_none());

    // A new file appears: listed, and loaded because the watch covers it.
    let june = [
        sample("2026-06-02T00:00:00Z", 8),
        sample("2026-06-03T00:00:00Z", 9),
    ];
    write_partition(dir.path(), "2026-06", &june);
    wait_until("the watch to see the new file", || {
        june_watch
            .try_recv()
            .is_ok_and(|value| value.as_array().is_some_and(|rows| rows.len() == 2))
    });
    assert!(loaded(&lazy).contains(&"2026-06".to_owned()));
    // A new file no watch covers is listed, not loaded.
    write_partition(dir.path(), "2027-01", &[sample("2027-01-02T00:00:00Z", 10)]);
    wait_until("the uncovered file in the listing", || {
        lazy.lazy_partition_status(SOURCE)
            .unwrap()
            .unwrap()
            .partitions
            .iter()
            .any(|path| path.ends_with("2027-01.jsonl"))
    });
    assert!(!loaded(&lazy).contains(&"2027-01".to_owned()));
    assert_eq!(
        lazy_query(
            &lazy,
            filtered(json!({"timestamp": {"$startsWith": "2027"}}))
        )
        .len(),
        1
    );

    // A loaded partition changes on disk: the next poll decodes it again.
    lazy_query(&lazy, month("2026-03"));
    let march = root(dir.path()).join("2026-03.jsonl");
    let mut content = fs::read_to_string(&march).unwrap();
    content.push('\n');
    content.push_str(&serde_json::to_string(&sample("2026-03-30T00:00:00Z", 11)).unwrap());
    fs::write(&march, content).unwrap();
    wait_until("the changed partition", || {
        lazy.read(|db| {
            Ok(db
                .collection("heartrate")
                .unwrap()
                .get("heartrate:2026-03-30T00:00:00Z")
                .is_some())
        })
        .unwrap()
    });
    assert_eq!(lazy_query(&lazy, month("2026-03")).len(), 12);
    lazy.close().unwrap();
}

#[test]
fn explicit_reload_drops_removed_files_and_lists_new_ones() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let lazy = open_lazy(dir.path(), policy(2, FullScanPolicy::Error));
    lazy_query(&lazy, month("2026-01"));
    write_partition(dir.path(), "2026-07", &[sample("2026-07-02T00:00:00Z", 1)]);
    fs::remove_file(root(dir.path()).join("2026-01.jsonl")).unwrap();
    lazy.reload().unwrap();
    let status = lazy.lazy_partition_status(SOURCE).unwrap().unwrap();
    assert!(status
        .partitions
        .iter()
        .any(|path| path.ends_with("2026-07.jsonl")));
    assert!(!status
        .partitions
        .iter()
        .any(|path| path.ends_with("2026-01.jsonl")));
    assert!(status.loaded.is_empty());
    assert_eq!(resident_len(&lazy), 0);
    assert!(lazy_query(&lazy, month("2026-01")).is_empty());
    assert_eq!(lazy_query(&lazy, month("2026-07")).len(), 1);
}

// ── Review regressions ───────────────────────────────────────────────────────

#[test]
fn unchanged_reload_keeps_loaded_records_and_identical_retries_write_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let all = seed(dir.path());
    let lazy = open_lazy(dir.path(), policy(2, FullScanPolicy::Error));
    let before = lazy_query(&lazy, month("2026-01"));
    assert_eq!(before.len(), 11);
    lazy.reload().unwrap();
    assert_eq!(resident_len(&lazy), 11, "reload dropped the loaded records");
    assert_eq!(lazy_query(&lazy, month("2026-01")), before);
    // An identical retry of a stored record must not append a duplicate ID.
    let january = root(dir.path()).join("2026-01.jsonl");
    let bytes = fs::read(&january).unwrap();
    let stored = all[25].clone();
    lazy.mutate(|db| db.create("heartrate", stored.clone()))
        .unwrap();
    assert_eq!(fs::read(&january).unwrap(), bytes, "identical retry wrote");
    lazy.reload().unwrap();
    lazy.mutate(|db| db.create("heartrate", stored.clone()))
        .unwrap();
    assert_eq!(fs::read(&january).unwrap(), bytes, "identical retry wrote");
}

fn watched_runtime(dir: &Path) -> NativeRuntime {
    NativeRuntime::open_sources_with_options(
        config(dir),
        NativeSourceRuntimeOptions {
            watch_debounce: Some(Duration::from_millis(20)),
            lazy_watch_interval: Duration::from_millis(50),
            lazy_partitions: IndexMap::from([(
                SOURCE.to_owned(),
                policy(2, FullScanPolicy::Error),
            )]),
            ..Default::default()
        },
    )
    .unwrap()
}

#[test]
fn a_watched_new_partition_that_fails_to_load_is_retried_after_it_is_corrected() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let lazy = watched_runtime(dir.path());
    let watch = lazy
        .watch(
            "heartrate",
            WatchQueryConfig {
                r#where: Some(json!({"timestamp": {"$gte": "2026-06", "$lt": "2026-07"}})),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    assert_eq!(watch.recv().unwrap(), json!([]));
    // A June file that holds a July record: wrong partition, so it cannot load.
    write_partition(
        dir.path(),
        "2026-06",
        &[
            sample("2026-06-02T00:00:00Z", 1),
            sample("2026-07-02T00:00:00Z", 2),
        ],
    );
    wait_until("the load error", || {
        lazy.last_reload_error()
            .unwrap()
            .is_some_and(|error| error.to_string().contains("wrong partition"))
    });
    assert!(!loaded(&lazy).contains(&"2026-06".to_owned()));
    // The corrected file loads and reaches the watch.
    write_partition(
        dir.path(),
        "2026-06",
        &[
            sample("2026-06-02T00:00:00Z", 1),
            sample("2026-06-03T00:00:00Z", 2),
        ],
    );
    wait_until("the corrected partition in the watch", || {
        watch
            .try_recv()
            .is_ok_and(|value| value.as_array().is_some_and(|rows| rows.len() == 2))
    });
    assert!(lazy.last_reload_error().unwrap().is_none());
    let status = lazy.lazy_partition_status(SOURCE).unwrap().unwrap();
    assert!(status
        .pinned
        .iter()
        .any(|path| path.ends_with("2026-06.jsonl")));
    lazy.close().unwrap();
}

#[test]
fn full_scan_error_applies_to_empty_and_fully_loaded_collections() {
    // Empty: no partition files at all.
    let empty = tempfile::tempdir().unwrap();
    let lazy = open_lazy(empty.path(), policy(2, FullScanPolicy::Error));
    let error = lazy
        .query("heartrate", QueryInput::default(), None)
        .unwrap_err();
    assert_eq!(operation_reason(&error), "lazy-full-scan");
    let error = lazy.find_by_id("heartrate", "heartrate:none").unwrap_err();
    assert_eq!(operation_reason(&error), "lazy-full-scan");
    assert!(lazy_query(&lazy, month("2026-01")).is_empty());

    // Fully loaded: every partition resident through filtered queries.
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let lazy = open_lazy(dir.path(), policy(MONTHS.len(), FullScanPolicy::Error));
    for (prefix, _) in MONTHS {
        lazy_query(&lazy, month(prefix));
    }
    assert_eq!(loaded(&lazy).len(), MONTHS.len());
    for input in [QueryInput::default(), filtered(json!({"bpm": 60}))] {
        let error = lazy.query("heartrate", input, None).unwrap_err();
        assert_eq!(operation_reason(&error), "lazy-full-scan");
    }
    let error = lazy
        .aggregate("heartrate", None, &AggregateConfig::count())
        .unwrap_err();
    assert_eq!(operation_reason(&error), "lazy-full-scan");
    let error = lazy.find_by_id("heartrate", "heartrate:none").unwrap_err();
    assert_eq!(operation_reason(&error), "lazy-full-scan");
    let error = lazy
        .watch("heartrate", WatchQueryConfig::default())
        .err()
        .unwrap();
    assert_eq!(operation_reason(&error), "lazy-full-scan");
}

// ── Loads during a mutation (review round 2) ─────────────────────────────────
//
// No managed watch runs in these tests (`watch_debounce: None`), so the lazy
// watcher never polls: the only load of the new June file is the one the
// mutation itself triggers.

fn line(record: &Value) -> String {
    serde_json::to_string(record).unwrap()
}

fn june_watch(
    lazy: &NativeRuntime,
) -> proseql_native::NativeWatch<proseql_engine::reactive::ValueSubscription> {
    let watch = lazy
        .watch(
            "heartrate",
            WatchQueryConfig {
                r#where: Some(json!({"timestamp": {"$gte": "2026-06", "$lt": "2026-07"}})),
                sort: vec![("timestamp".to_owned(), SortOrder::Asc)],
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    assert_eq!(watch.recv().unwrap(), json!([]));
    watch
}

fn wait_for_watch(
    watch: &proseql_native::NativeWatch<proseql_engine::reactive::ValueSubscription>,
    expected: &[Value],
) {
    let expected = Value::Array(expected.to_vec());
    let mut last = None;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Ok(value) = watch.try_recv() {
            if value == expected {
                return;
            }
            last = Some(value);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("watch never delivered {expected}; last delivery {last:?}");
}

fn june_sample(day: u32, n: usize) -> Value {
    sample(&format!("2026-06-{day:02}T00:00:00Z"), n)
}

#[test]
fn a_create_into_a_new_watched_partition_writes_only_the_new_record() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let lazy = open_lazy(dir.path(), policy(2, FullScanPolicy::Error));
    let watch = june_watch(&lazy);
    let (a, b) = (june_sample(2, 1), june_sample(3, 2));
    let june = write_partition(dir.path(), "2026-06", std::slice::from_ref(&a));

    let created = lazy.mutate(|db| db.create("heartrate", b.clone())).unwrap();
    assert_eq!(created, b);
    assert_eq!(
        fs::read_to_string(&june).unwrap(),
        format!("{}\n{}\n", line(&a), line(&b)),
        "the loaded record must not be written again"
    );
    assert_eq!(
        lazy_query(&lazy, month("2026-06")),
        vec![a.clone(), b.clone()]
    );
    wait_for_watch(&watch, &[a.clone(), b.clone()]);
    lazy.close().unwrap();
    let eager = open_eager(dir.path());
    assert_eq!(eager_query(&eager, month("2026-06")), vec![a, b]);
}

#[test]
fn an_identical_retry_into_a_new_watched_partition_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let lazy = open_lazy(dir.path(), policy(2, FullScanPolicy::Error));
    let watch = june_watch(&lazy);
    let a = june_sample(2, 1);
    let june = write_partition(dir.path(), "2026-06", std::slice::from_ref(&a));
    let bytes = fs::read(&june).unwrap();

    assert_eq!(
        lazy.mutate(|db| db.create("heartrate", a.clone())).unwrap(),
        a
    );
    assert_eq!(fs::read(&june).unwrap(), bytes, "identical retry wrote");
    assert_eq!(lazy_query(&lazy, month("2026-06")), vec![a.clone()]);
    wait_for_watch(&watch, std::slice::from_ref(&a));
    lazy.close().unwrap();
    assert_eq!(fs::read(&june).unwrap(), bytes);
}

#[test]
fn a_conflicting_create_into_a_new_watched_partition_rolls_back_and_keeps_its_records() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let lazy = open_lazy(dir.path(), policy(2, FullScanPolicy::Error));
    let watch = june_watch(&lazy);
    let a = june_sample(2, 1);
    let june = write_partition(dir.path(), "2026-06", std::slice::from_ref(&a));
    let bytes = fs::read(&june).unwrap();

    let mut conflicting = a.clone();
    conflicting["bpm"] = json!(1);
    let error = lazy
        .mutate(|db| db.create("heartrate", conflicting.clone()))
        .unwrap_err();
    assert!(matches!(error, EngineError::DuplicateKey(_)), "{error:?}");
    assert_eq!(fs::read(&june).unwrap(), bytes);
    assert_eq!(lazy_query(&lazy, month("2026-06")), vec![a.clone()]);
    assert_eq!(
        lazy.find_by_id("heartrate", a["id"].as_str().unwrap())
            .unwrap(),
        Some(a.clone())
    );
    wait_for_watch(&watch, std::slice::from_ref(&a));
    lazy.close().unwrap();
    assert_eq!(fs::read(&june).unwrap(), bytes);
    let eager = open_eager(dir.path());
    assert_eq!(eager_query(&eager, month("2026-06")), vec![a.clone()]);
    let reopened = open_lazy(dir.path(), policy(2, FullScanPolicy::Error));
    assert_eq!(lazy_query(&reopened, month("2026-06")), vec![a]);
}

#[test]
fn a_find_by_id_scan_inside_a_mutation_loads_a_watched_partition_without_writing_it() {
    let dir = tempfile::tempdir().unwrap();
    let all = seed(dir.path());
    let lazy = open_lazy(dir.path(), policy(1, FullScanPolicy::Allow));
    let watch = june_watch(&lazy);
    // June is listed but not loaded: its first content cannot load (a July
    // record in it), so a reload leaves it pending for the watch.
    write_partition(
        dir.path(),
        "2026-06",
        &[june_sample(2, 1), sample("2026-07-01T00:00:00Z", 9)],
    );
    let error = lazy.reload().unwrap_err();
    assert!(
        source_config_message(&error).contains("wrong partition"),
        "{error:?}"
    );
    assert!(!loaded(&lazy).contains(&"2026-06".to_owned()));
    let a = june_sample(2, 1);
    let june = write_partition(dir.path(), "2026-06", std::slice::from_ref(&a));
    let june_bytes = fs::read(&june).unwrap();
    let april = root(dir.path()).join("2026-04.jsonl");
    let april_bytes = fs::read(&april).unwrap();
    let b = sample("2026-04-20T00:00:00Z", 2);

    lazy.mutate(|db| {
        // A miss among loaded partitions is a full scan: every partition,
        // including the new June file, loads inside the transaction.
        assert_eq!(
            db.find_by_id("heartrate", a["id"].as_str().unwrap())?,
            Some(a.clone())
        );
        db.create("heartrate", b.clone())
    })
    .unwrap();
    assert_eq!(fs::read(&june).unwrap(), june_bytes, "June was rewritten");
    let mut expected_april = april_bytes.clone();
    expected_april.extend_from_slice(format!("\n{}\n", line(&b)).as_bytes());
    assert_eq!(fs::read(&april).unwrap(), expected_april);
    assert_eq!(lazy_query(&lazy, month("2026-06")), vec![a.clone()]);
    wait_for_watch(&watch, std::slice::from_ref(&a));

    // The same scan in a mutation that fails keeps every loaded record.
    let mut conflicting = all[0].clone();
    conflicting["bpm"] = json!(1);
    let error = lazy
        .mutate(|db| {
            db.find_by_id("heartrate", "heartrate:none")?;
            db.create("heartrate", conflicting.clone())
        })
        .unwrap_err();
    assert!(matches!(error, EngineError::DuplicateKey(_)), "{error:?}");
    assert_eq!(lazy_query(&lazy, month("2026-06")), vec![a]);
    assert_eq!(lazy_query(&lazy, month("2025-11")).len(), 11);
    assert_eq!(fs::read(&june).unwrap(), june_bytes);
}

#[test]
fn a_conflicting_cold_append_rolls_back_and_keeps_the_loaded_partition() {
    let dir = tempfile::tempdir().unwrap();
    let all = seed(dir.path());
    let lazy = open_lazy(dir.path(), policy(1, FullScanPolicy::Error));
    let january = root(dir.path()).join("2026-01.jsonl");
    let bytes = fs::read(&january).unwrap();
    let mut conflicting = all[25].clone();
    conflicting["bpm"] = json!(1);
    let fresh = sample("2026-01-21T00:00:00Z", 3);
    // The batch loads January for the ID check, then fails on the conflict.
    let error = lazy
        .mutate(|db| db.create_many("heartrate", vec![fresh.clone(), conflicting.clone()]))
        .unwrap_err();
    assert!(matches!(error, EngineError::DuplicateKey(_)), "{error:?}");
    assert_eq!(fs::read(&january).unwrap(), bytes);
    assert_eq!(loaded(&lazy), ["2026-01"]);
    let rows = lazy_query(&lazy, month("2026-01"));
    assert_eq!(rows.len(), 11);
    assert!(rows.contains(&all[25]));
    assert!(lazy
        .find_by_id("heartrate", fresh["id"].as_str().unwrap())
        .is_err_and(|error| operation_reason(&error) == "lazy-full-scan"));
}

#[test]
fn dropping_the_last_covering_watch_stops_retrying_a_failed_partition() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let (host, reads) = CountingHost::new();
    let lazy = NativeRuntime::open_sources_with_host(
        config(dir.path()),
        host,
        NativeSourceRuntimeOptions {
            watch_debounce: Some(Duration::from_millis(20)),
            lazy_watch_interval: Duration::from_millis(30),
            lazy_partitions: IndexMap::from([(
                SOURCE.to_owned(),
                policy(2, FullScanPolicy::Error),
            )]),
            ..Default::default()
        },
    )
    .unwrap();
    let first = june_watch(&lazy);
    let second = june_watch(&lazy);
    // A June file that cannot load: it stays pending for the watches.
    let june = write_partition(
        dir.path(),
        "2026-06",
        &[june_sample(2, 1), sample("2026-07-02T00:00:00Z", 2)],
    )
    .to_string_lossy()
    .into_owned();
    wait_until("the load error", || {
        lazy.last_reload_error()
            .unwrap()
            .is_some_and(|error| error.to_string().contains("wrong partition"))
    });
    let reads_of_june = || reads.lock().unwrap().get(&june).copied().unwrap_or(0);
    // While a watch covers June, the watcher keeps checking the file.
    drop(first);
    let before = reads_of_june();
    wait_until("the watcher to read the pending file again", || {
        reads_of_june() > before
    });
    // After the last covering watch is gone, it never reads the file again.
    drop(second);
    std::thread::sleep(Duration::from_millis(150));
    let settled = reads_of_june();
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(reads_of_june(), settled, "the poller still reads June");
    assert!(!loaded(&lazy).contains(&"2026-06".to_owned()));
    lazy.close().unwrap();
}

// ── Opt-in bounded reads: one global query, not monthly pages/aggregates ──────

#[test]
fn bounded_queries_keep_global_natural_sort_page_cursor_search_and_selection_semantics() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let eager = open_eager(dir.path());
    for bound in [1, 2, 3] {
        let lazy = open_lazy(dir.path(), policy(bound, FullScanPolicy::Allow));
        for filter in [
            None,
            Some(json!({"bpm":{"$gte":80}})),
            Some(json!({"source":{"$in":["workout","rest","awake"]}})),
            Some(json!({"timestamp":{"$gte":"2025-12", "$lt":"2026-03"}})),
            Some(json!({"$search":{"query":"rest", "fields":["source"]}})),
        ] {
            for sort in [
                vec![],
                vec![("timestamp".into(), SortOrder::Desc)],
                vec![("bpm".into(), SortOrder::Asc)],
            ] {
                for select in [None, Some(json!(["id", "bpm"])), Some(json!({"id":true}))] {
                    let input = QueryInput {
                        r#where: filter.clone(),
                        sort: sort.clone(),
                        offset: Some(3),
                        limit: Some(9),
                        select,
                        ..Default::default()
                    };
                    let (rows, stats) = lazy
                        .query_bounded_with_stats("heartrate", input.clone())
                        .unwrap();
                    assert_eq!(rows, eager_query(&eager, input.clone()), "{input:?}");
                    assert!(stats.partitions_resident <= bound);
                    assert_eq!(stats.pinned_partitions, 0);
                    assert_eq!(stats.retained_partition_limit, bound);
                }
            }
        }
        for cursor in [
            proseql_engine::query::CursorConfig {
                key: "timestamp".into(),
                after: None,
                before: None,
                limit: 7,
            },
            proseql_engine::query::CursorConfig {
                key: "timestamp".into(),
                after: Some("2026-01-01T00:00:00.000Z".into()),
                before: None,
                limit: 8,
            },
            proseql_engine::query::CursorConfig {
                key: "timestamp".into(),
                after: None,
                before: Some("2026-02-10T05:00:00.000Z".into()),
                limit: 6,
            },
        ] {
            let input = QueryInput {
                select: Some(json!(["id"])),
                ..Default::default()
            };
            assert_eq!(
                lazy.query_cursor_bounded("heartrate", input.clone(), &cursor)
                    .unwrap(),
                eager
                    .query_cursor("heartrate", input, &cursor, None)
                    .unwrap()
            );
        }
    }
}

#[test]
fn bounded_aggregates_accumulate_individual_rows_in_eager_order() {
    let dir = tempfile::tempdir().unwrap();
    for (index, (month, _)) in MONTHS.iter().enumerate() {
        let mut rows = vec![sample(&format!("{month}-01T00:00:00Z"), index)];
        rows[0]["bpm"] = json!([1e16, -1e16, 1.0, 1e16, -1e16, 1.0][index]);
        if index == 1 {
            let mut row = sample(&format!("{month}-02T00:00:00Z"), 9);
            row["bpm"] = json!(1.0);
            rows.push(row);
        }
        write_partition(dir.path(), month, &rows);
    }
    let eager = open_eager(dir.path());
    let lazy = open_lazy(dir.path(), policy(1, FullScanPolicy::Allow));
    let aggregate = AggregateConfig {
        count: true,
        sum: vec!["bpm".into()],
        avg: vec!["bpm".into()],
        min: vec!["bpm".into(), "source".into()],
        max: vec!["bpm".into(), "source".into()],
    };
    for filter in [
        None,
        Some(json!({"timestamp":{"$gte":"2025-12", "$lt":"2026-04"}})),
        Some(json!({"$search":{"query":"rest", "fields":["source"]}})),
        Some(json!({"source":{"$in":["rest","awake","workout","live"]}})),
    ] {
        assert_eq!(
            lazy.aggregate_bounded("heartrate", filter.clone(), &aggregate)
                .unwrap(),
            eager
                .aggregate("heartrate", filter.clone(), &aggregate)
                .unwrap()
        );
        let groups = ["source".into()];
        assert_eq!(
            lazy.aggregate_grouped_bounded("heartrate", filter.clone(), &groups, &aggregate)
                .unwrap(),
            eager
                .aggregate_grouped("heartrate", filter, &groups, &aggregate)
                .unwrap()
        );
    }
}

#[test]
fn bounded_load_errors_pins_and_duplicates_across_evicted_partitions_are_not_hidden() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let lazy = open_lazy(dir.path(), policy(1, FullScanPolicy::Allow));
    let watch = lazy
        .watch(
            "heartrate",
            WatchQueryConfig {
                r#where: month("2025-11").r#where,
                select: Some(json!(["id"])),
                ..Default::default()
            },
        )
        .unwrap();
    let (_, stats) = lazy
        .query_bounded_with_stats("heartrate", QueryInput::default())
        .unwrap();
    assert_eq!(stats.pinned_partitions, 1);
    assert_eq!(stats.partitions_resident, 2);
    drop(watch);
    let (_, stats) = lazy
        .query_bounded_with_stats("heartrate", QueryInput::default())
        .unwrap();
    assert_eq!(stats.pinned_partitions, 0);
    assert_eq!(stats.partitions_resident, 1);
    let last = loaded(&lazy)[0].clone();
    let path = root(dir.path()).join(format!("{last}.jsonl"));
    fs::write(&path, "broken\n").unwrap();
    assert!(lazy.reload().is_err());
    assert!(
        !lazy
            .query_bounded("heartrate", month(&last))
            .unwrap()
            .is_empty(),
        "failed reload keeps last known good"
    );
    // A malformed *incoming* partition must fail even for a zero-result filter.
    let bad = root(dir.path()).join("2025-11.jsonl");
    fs::write(&bad, "broken\n").unwrap();
    assert_eq!(
        lazy.query_bounded("heartrate", filtered(json!({"bpm":{"$lt":-1}})))
            .unwrap_err()
            .tag(),
        "SerializationError"
    );
    assert_eq!(loaded(&lazy), [last]);
    lazy.close().unwrap();
    seed(dir.path());
    let mut a = sample("2025-11-01T00:00:00Z", 1);
    a["id"] = json!("same-id");
    let mut b = sample("2026-04-01T00:00:00Z", 1);
    b["id"] = json!("same-id");
    write_partition(dir.path(), "2025-11", &[a]);
    write_partition(dir.path(), "2026-04", &[b]);
    let duplicate = open_lazy(dir.path(), policy(1, FullScanPolicy::Allow));
    assert_eq!(
        duplicate
            .query_bounded("heartrate", filtered(json!({"bpm":{"$lt":-1}})))
            .unwrap_err()
            .tag(),
        "SourceConfigError"
    );
    let refused = open_lazy(dir.path(), policy(1, FullScanPolicy::Error));
    assert_eq!(
        operation_reason(
            &refused
                .query_bounded("heartrate", QueryInput::default())
                .unwrap_err()
        ),
        "lazy-full-scan"
    );
    assert!(loaded(&refused).is_empty());
}

#[test]
fn bounded_windows_read_each_file_at_most_once_and_warm_hits_keep_lru_and_indexes() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let eager = open_eager(dir.path());
    let (host, reads) = CountingHost::new();
    let lazy = NativeRuntime::open_sources_with_host(
        config(dir.path()),
        host,
        lazy_options(policy(1, FullScanPolicy::Allow)),
    )
    .unwrap();
    lazy.query_bounded("heartrate", month("2026-02")).unwrap();
    reads.lock().unwrap().clear();
    let input = filtered(
        json!({"timestamp":{"$gte":"2026-01-01T00:00:00Z","$lte":"2026-03-31T23:59:59Z"}}),
    );
    let (rows, stats) = lazy
        .query_bounded_with_stats("heartrate", input.clone())
        .unwrap();
    assert_eq!(rows, eager_query(&eager, input));
    assert_eq!(stats.partitions_read, 2);
    assert_eq!(reads.lock().unwrap().len(), 2);
    assert!(reads.lock().unwrap().values().all(|count| *count == 1));
    assert_eq!(loaded(&lazy), ["2026-03"]);
    let warm = open_lazy(dir.path(), policy(2, FullScanPolicy::Allow));
    warm.query_bounded("heartrate", month("2025-11")).unwrap();
    warm.query_bounded("heartrate", month("2025-12")).unwrap();
    let (_, stats) = warm
        .query_bounded_with_stats("heartrate", month("2025-11"))
        .unwrap();
    assert_eq!(stats.partitions_read, 0);
    warm.query_bounded("heartrate", month("2026-01")).unwrap();
    assert_eq!(loaded(&warm), ["2025-11", "2026-01"]);
    let (_, stats) = warm
        .query_with_stats("heartrate", month("2026-01"), None)
        .unwrap();
    assert_eq!(stats.index_used, IndexUsed::Ordered);
    assert_eq!(stats.partitions_read, 0);
}

#[test]
fn bounded_id_checks_include_the_initial_cache_outside_the_query_scope() {
    let dir = tempfile::tempdir().unwrap();
    let all = seed(dir.path());
    let lazy = open_lazy(dir.path(), policy(2, FullScanPolicy::Allow));
    lazy.query_bounded(
        "heartrate",
        filtered(json!({"timestamp":{"$gte":"2025-11","$lt":"2025-12-31T23:59:59.999999Z"}})),
    )
    .unwrap();
    assert_eq!(loaded(&lazy), ["2025-11", "2025-12"]);
    let mut row = sample("2026-04-15T00:00:00Z", 1);
    row["id"] = all[0]["id"].clone();
    write_partition(dir.path(), "2026-04", &[row]);
    let input = filtered(json!({"timestamp":{"$gte":"2026-01","$lt":"2026-05"}}));
    assert_eq!(
        lazy.query_bounded("heartrate", input).unwrap_err().tag(),
        "SourceConfigError"
    );
}
