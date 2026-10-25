//! Actual record-payload allocation lifetimes, not post-trim cache counters.
//! This is its own test executable: no other test shares its allocator counters.
use indexmap::IndexMap;
use proseql_engine::{
    descriptor::{CollectionDescriptor, SchemaNode, StructField},
    query::QueryInput,
};
use proseql_native::{
    LazyPartitionPolicy, NativeCollectionConfig, NativeRuntime, NativeSourceRuntimeConfig,
    NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{
    DatabaseSourceConfig, PartitionKey, PartitionedSourceConfig, TimeBucket,
};
use serde_json::json;
use std::{
    alloc::{GlobalAlloc, Layout, System},
    fs,
    sync::atomic::{AtomicUsize, Ordering},
};

const PAYLOAD: usize = 8192;
const ROWS: usize = 4;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
struct PayloadAllocator;
fn tracked(layout: Layout) -> bool {
    layout.size() == PAYLOAD && layout.align() == 1
}
fn added() {
    let live = LIVE.fetch_add(1, Ordering::SeqCst) + 1;
    PEAK.fetch_max(live, Ordering::SeqCst);
}
unsafe impl GlobalAlloc for PayloadAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc(layout);
        if !p.is_null() && tracked(layout) {
            added();
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        if tracked(layout) {
            LIVE.fetch_sub(1, Ordering::SeqCst);
        }
        System.dealloc(p, layout)
    }
    unsafe fn realloc(&self, p: *mut u8, old: Layout, size: usize) -> *mut u8 {
        let next = System.realloc(p, old, size);
        if !next.is_null() {
            if tracked(old) {
                LIVE.fetch_sub(1, Ordering::SeqCst);
            }
            if size == PAYLOAD && old.align() == 1 {
                added();
            }
        }
        next
    }
}
#[global_allocator]
static ALLOCATOR: PayloadAllocator = PayloadAllocator;

#[test]
fn scoped_queries_never_retain_more_than_n_partitions_plus_one_incoming_payload() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("samples");
    fs::create_dir(&root).unwrap();
    for month in 1..=10 {
        let raw = (0..ROWS).map(|row| json!({"id":format!("{month}-{row}"), "timestamp":format!("2025-{month:02}-01T00:00:{row:02}Z"), "payload":"x".repeat(PAYLOAD), "value":row}).to_string()).collect::<Vec<_>>().join("\n") + "\n";
        fs::write(root.join(format!("2025-{month:02}.jsonl")), raw).unwrap();
    }
    assert_eq!(LIVE.load(Ordering::SeqCst), 0);
    for bound in [0, 1, 2, 3] {
        // Start with the repository benchmark descriptor to keep the native
        // source struct-literal contract under test, without a test-only host.
        let mut descriptor = CollectionDescriptor {
            name: "samples".into(),
            schema: SchemaNode::Unknown,
            id_strategy: proseql_engine::descriptor::IdStrategy::Provided,
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
            append_only: true,
            duplicate_ids: Default::default(),
            validation_mode: proseql_engine::descriptor::ValidationMode::Strict,
        };
        descriptor.schema = SchemaNode::Struct {
            fields: [
                ("id", SchemaNode::Str),
                ("timestamp", SchemaNode::Str),
                ("payload", SchemaNode::Str),
                ("value", SchemaNode::Num),
            ]
            .into_iter()
            .map(|(name, schema)| StructField {
                name: name.into(),
                schema,
            })
            .collect(),
        };
        descriptor.append_only = true;
        descriptor.ordered_indexes = vec!["timestamp".into()];
        let runtime = NativeRuntime::open_sources_with_options(
            NativeSourceRuntimeConfig {
                collections: vec![NativeCollectionConfig::new(descriptor)],
                sources: vec![DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
                    id: "samples".into(),
                    collection: "samples".into(),
                    root: root.to_string_lossy().into_owned(),
                    format: "jsonl".into(),
                    partition_by: PartitionKey::TimeBucket {
                        field: "timestamp".into(),
                        bucket: TimeBucket::Month,
                    },
                    prose: None,
                })],
            },
            NativeSourceRuntimeOptions {
                watch_debounce: None,
                lazy_partitions: IndexMap::from([(
                    "samples".into(),
                    LazyPartitionPolicy::new(bound),
                )]),
                ..Default::default()
            },
        )
        .unwrap();
        PEAK.store(0, Ordering::SeqCst);
        let result = runtime
            .query_bounded(
                "samples",
                QueryInput {
                    r#where: Some(json!({"value":{"$lt":0}})),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(result.is_empty());
        assert_eq!(
            LIVE.load(Ordering::SeqCst),
            0,
            "the counter tracks actual retained Value string allocations"
        );
        assert!(
            PEAK.load(Ordering::SeqCst) <= (bound + 1) * ROWS,
            "actual live row payloads {} exceed N+1 {}",
            PEAK.load(Ordering::SeqCst),
            (bound + 1) * ROWS
        );

        eprintln!(
            "LIVE_PAYLOAD_SCAN N={bound} actual_peak={} retained={}",
            PEAK.load(Ordering::SeqCst),
            LIVE.load(Ordering::SeqCst)
        );
        for path in ["cursor", "aggregate", "grouped"] {
            PEAK.store(LIVE.load(Ordering::SeqCst), Ordering::SeqCst);
            match path {
                "cursor" => {
                    let page = runtime
                        .query_cursor_bounded(
                            "samples",
                            QueryInput {
                                r#where: Some(json!({"value":{"$lt":0}})),
                                ..Default::default()
                            },
                            &proseql_engine::query::CursorConfig {
                                key: "timestamp".into(),
                                after: None,
                                before: None,
                                limit: 2,
                            },
                        )
                        .unwrap();
                    assert!(page.items.is_empty());
                }
                "aggregate" => {
                    let result = runtime
                        .aggregate_bounded(
                            "samples",
                            None,
                            &proseql_engine::query::AggregateConfig::count(),
                        )
                        .unwrap();
                    assert_eq!(result.count, Some((10 * ROWS) as u64));
                }
                _ => {
                    let result = runtime
                        .aggregate_grouped_bounded(
                            "samples",
                            None,
                            &["value".into()],
                            &proseql_engine::query::AggregateConfig::count(),
                        )
                        .unwrap();
                    assert_eq!(result.len(), ROWS);
                }
            }
            assert!(
                PEAK.load(Ordering::SeqCst) <= (bound + 1) * ROWS,
                "{path} payload peak {}",
                PEAK.load(Ordering::SeqCst)
            );
            eprintln!(
                "LIVE_PAYLOAD_PATH N={bound} path={path} actual_peak={}",
                PEAK.load(Ordering::SeqCst)
            );
        }

        // Ascending and repeated 1–3-month scopes, with no selected payloads.
        for repeat in 0..2 {
            for month in 1..=10 {
                let end = (month + 1 + (month - 1) % 3).min(11);
                PEAK.store(LIVE.load(Ordering::SeqCst), Ordering::SeqCst);
                let rows=runtime.query_bounded("samples",QueryInput {r#where:Some(json!({"timestamp":{"$gte":format!("2025-{month:02}-01T00:00:00Z"),"$lt":format!("2025-{end:02}-01T00:00:00Z")},"value":{"$lt":0}})),..Default::default()}).unwrap();
                assert!(rows.is_empty());
                assert!(
                    PEAK.load(Ordering::SeqCst) <= (bound + 1) * ROWS,
                    "bound={bound}, repeat={repeat}, month={month}, peak={}",
                    PEAK.load(Ordering::SeqCst)
                );
            }
        }
        let january = root.join("2025-01.jsonl");
        let good = fs::read(&january).unwrap();
        let good_text = std::str::from_utf8(&good).unwrap();
        let before_error = runtime
            .lazy_partition_status("samples")
            .unwrap()
            .unwrap()
            .loaded;
        for bad in [
            "broken\n".to_owned(),
            good_text.replace("\"value\":3", "\"value\":\"invalid\""),
            good_text.replace("\"id\":\"1-3\"", "\"id\":\"\""),
            good_text.replace("2025-01-", "2025-02-"),
            good_text.replace("\"id\":\"1-3\"", "\"id\":\"1-0\""),
            good_text.replace("\"id\":\"1-3\"", "\"id\":\"10-0\""),
        ] {
            assert_ne!(bad, good_text);
            fs::write(&january, bad).unwrap();
            PEAK.store(LIVE.load(Ordering::SeqCst), Ordering::SeqCst);
            assert!(runtime
                .query_bounded(
                    "samples",
                    QueryInput {
                        r#where: Some(json!({"value":{"$lt":0}})),
                        ..Default::default()
                    }
                )
                .is_err());
            assert!(
                PEAK.load(Ordering::SeqCst) <= (bound + 1) * ROWS,
                "failed candidate payload peak {}",
                PEAK.load(Ordering::SeqCst)
            );
            assert_eq!(
                LIVE.load(Ordering::SeqCst),
                0,
                "failed candidate payloads were actually freed"
            );
            assert_eq!(
                runtime
                    .lazy_partition_status("samples")
                    .unwrap()
                    .unwrap()
                    .loaded,
                before_error,
                "validation must precede replacement eviction"
            );
        }
        fs::write(&january, good).unwrap();
        let watch=runtime.watch("samples",proseql_engine::reactive::WatchQueryConfig {r#where:Some(json!({"timestamp":{"$gte":"2025-01-01T00:00:00Z","$lt":"2025-01-31T23:59:59Z"}})),select:Some(json!(["id"])),..Default::default()}).unwrap();
        let status = runtime.lazy_partition_status("samples").unwrap().unwrap();
        let pinned = status.pinned.len();
        assert_eq!(pinned, 0);
        PEAK.store(LIVE.load(Ordering::SeqCst), Ordering::SeqCst);
        let (_, stats) = runtime
            .query_bounded_with_stats(
                "samples",
                QueryInput {
                    r#where: Some(json!({"value":{"$lt":0}})),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(stats.pinned_partitions, pinned);
        // Pinned engine records + their committed watch snapshot are explicit
        // extra payloads. No unpinned snapshot may accumulate across the scan.
        assert!(
            PEAK.load(Ordering::SeqCst) <= (bound + 1 + 2 * pinned) * ROWS,
            "pinned payload peak {}",
            PEAK.load(Ordering::SeqCst)
        );
        drop(watch);
        if bound == 0 {
            assert_eq!(
                LIVE.load(Ordering::SeqCst),
                0,
                "watch release must free its payloads without another query"
            );
        }
        runtime
            .query_bounded(
                "samples",
                QueryInput {
                    r#where: Some(json!({"value":{"$lt":0}})),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(LIVE.load(Ordering::SeqCst), 0);
        if bound == 0 {
            let watch=runtime.watch("samples",proseql_engine::reactive::WatchQueryConfig {r#where:Some(json!({"timestamp":{"$gte":"2025-01-01T00:00:00Z","$lt":"2025-01-31T23:59:59Z"}})),select:Some(json!(["id"])),..Default::default()}).unwrap();
            let entered = std::sync::Arc::new(std::sync::Barrier::new(2));
            let release = std::sync::Arc::new(std::sync::Barrier::new(2));
            std::thread::scope(|scope| {
                let entered_worker = std::sync::Arc::clone(&entered);
                let release_worker = std::sync::Arc::clone(&release);
                let runtime_ref = &runtime;
                let reader = scope.spawn(move || {
                    runtime_ref
                        .read(|_| {
                            entered_worker.wait();
                            release_worker.wait();
                            Ok(())
                        })
                        .unwrap()
                });
                entered.wait();
                drop(watch);
                release.wait();
                reader.join().unwrap();
            });
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            while LIVE.load(Ordering::SeqCst) > 0 && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert_eq!(
                LIVE.load(Ordering::SeqCst),
                0,
                "a watch dropped during a locked read must reclaim without another query"
            );
        }
        eprintln!("LIVE_PAYLOAD_PROOF N={bound} rows_per_partition={ROWS} all_unpinned_peaks<=N+1 pinned_records_and_snapshot_reported=true");
        runtime.close().unwrap();
        assert_eq!(
            LIVE.load(Ordering::SeqCst),
            0,
            "a closed runtime must release its rows even while the handle remains alive"
        );
        drop(runtime);
        assert_eq!(
            LIVE.load(Ordering::SeqCst),
            0,
            "all payloads were really dropped"
        );
    }
}
