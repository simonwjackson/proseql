//! Synthetic real-filesystem source sessions. This executable counts actual
//! 8192-byte payload allocations, including source and watch copies.
use indexmap::IndexMap;
use proseql_engine::{
    descriptor::{CollectionDescriptor, IdStrategy, SchemaNode, ValidationMode},
    query::QueryInput,
};
use proseql_native::{
    FullScanPolicy, LazyPartitionPolicy, NativeCollectionConfig, NativeRuntime,
    NativeSourceRuntimeConfig, NativeSourceRuntimeOptions, NativeSourceSessions,
};
use proseql_storage::source_config::{
    CollectionFileSourceConfig, DatabaseSourceConfig, DocumentSourceConfig, PartitionKey,
    PartitionedSourceConfig, SourceCollectionSelection, TimeBucket, UnknownCollectionPolicy,
};
use serde_json::{json, Value};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    fs,
    panic::{catch_unwind, AssertUnwindSafe},
    path::Path,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

const PAYLOAD: usize = 8192;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static TOTAL_LIVE: AtomicUsize = AtomicUsize::new(0);
struct PayloadAllocator;
unsafe impl GlobalAlloc for PayloadAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = System.alloc(layout);
        if !pointer.is_null() {
            TOTAL_LIVE.fetch_add(layout.size(), Ordering::SeqCst);
        }
        if !pointer.is_null() && layout.size() == PAYLOAD && layout.align() == 1 {
            LIVE.fetch_add(1, Ordering::SeqCst);
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        TOTAL_LIVE.fetch_sub(layout.size(), Ordering::SeqCst);
        if layout.size() == PAYLOAD && layout.align() == 1 {
            LIVE.fetch_sub(1, Ordering::SeqCst);
        }
        System.dealloc(pointer, layout);
    }
    unsafe fn realloc(&self, pointer: *mut u8, old: Layout, size: usize) -> *mut u8 {
        let next = System.realloc(pointer, old, size);
        if !next.is_null() {
            TOTAL_LIVE.fetch_sub(old.size(), Ordering::SeqCst);
            TOTAL_LIVE.fetch_add(size, Ordering::SeqCst);
            if old.size() == PAYLOAD && old.align() == 1 {
                LIVE.fetch_sub(1, Ordering::SeqCst);
            }
            if size == PAYLOAD && old.align() == 1 {
                LIVE.fetch_add(1, Ordering::SeqCst);
            }
        }
        next
    }
}
#[global_allocator]
static ALLOCATOR: PayloadAllocator = PayloadAllocator;

fn descriptor(name: &str, append_only: bool) -> NativeCollectionConfig {
    NativeCollectionConfig::new(CollectionDescriptor {
        name: name.into(),
        schema: SchemaNode::Unknown,
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
        duplicate_ids: Default::default(),
        validation_mode: ValidationMode::Strict,
    })
}
fn row(i: usize) -> Value {
    json!({"id":format!("synthetic-{i}"),"timestamp":format!("2025-01-01T00:00:{i:02}Z"),"shard":format!("{:02x}",i%256),"payload":"x".repeat(PAYLOAD)})
}
fn prepare(root: &Path) -> NativeSourceRuntimeConfig {
    let records = (0..4).map(row).collect::<Vec<_>>();
    let lines = records
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(root.join("records.jsonl"), &lines).unwrap();
    fs::create_dir(root.join("docs")).unwrap();
    let document_rows = records
        .iter()
        .map(|row| (row["id"].as_str().unwrap().to_owned(), row.clone()))
        .collect::<IndexMap<_, _>>();
    fs::write(
        root.join("docs/records.yaml"),
        format!(
            "documents:\n{}\n",
            document_rows
                .iter()
                .map(|(id, row)| format!("  {}: {row}", serde_json::to_string(id).unwrap()))
                .collect::<Vec<_>>()
                .join("\n")
        ),
    )
    .unwrap();
    fs::create_dir(root.join("yaml-parts")).unwrap();
    fs::write(
        root.join("yaml-parts/2025-01.yaml"),
        serde_json::to_string(&document_rows).unwrap(),
    )
    .unwrap();
    fs::create_dir(root.join("samples")).unwrap();
    fs::write(root.join("samples/2025-01.jsonl"), &lines).unwrap();
    fs::create_dir(root.join("raw")).unwrap();
    for shard in 0..256 {
        fs::write(
            root.join("raw").join(format!("{shard:02x}.jsonl")),
            if shard < records.len() {
                records[shard].to_string() + "\n"
            } else {
                String::new()
            },
        )
        .unwrap();
    }
    NativeSourceRuntimeConfig {
        collections: vec![
            descriptor("file", false),
            descriptor("documents", false),
            descriptor("yaml", false),
            descriptor("samples", true),
            descriptor("raw", true),
        ],
        sources: vec![
            DatabaseSourceConfig::CollectionFile(CollectionFileSourceConfig {
                id: "file".into(),
                collection: "file".into(),
                path: root.join("records.jsonl").to_string_lossy().into(),
                format: Some("jsonl".into()),
                prose: None,
            }),
            DatabaseSourceConfig::Documents(DocumentSourceConfig {
                id: "documents".into(),
                root: root.join("docs").to_string_lossy().into(),
                include: Some(vec!["records.yaml".into()]),
                exclude: vec![],
                format: Some("yaml".into()),
                collections: Some(SourceCollectionSelection::Named(vec!["documents".into()])),
                unknown_collections: UnknownCollectionPolicy::Preserve,
                outbox: "records.yaml".into(),
                optional: false,
            }),
            DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
                id: "yaml".into(),
                collection: "yaml".into(),
                root: root.join("yaml-parts").to_string_lossy().into(),
                format: "yaml".into(),
                prose: None,
                partition_by: PartitionKey::TimeBucket {
                    field: "timestamp".into(),
                    bucket: TimeBucket::Month,
                },
            }),
            DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
                id: "samples".into(),
                collection: "samples".into(),
                root: root.join("samples").to_string_lossy().into(),
                format: "jsonl".into(),
                prose: None,
                partition_by: PartitionKey::TimeBucket {
                    field: "timestamp".into(),
                    bucket: TimeBucket::Month,
                },
            }),
            DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
                id: "raw".into(),
                collection: "raw".into(),
                root: root.join("raw").to_string_lossy().into(),
                format: "jsonl".into(),
                prose: None,
                partition_by: PartitionKey::Field {
                    field: "shard".into(),
                },
            }),
        ],
    }
}
fn options() -> NativeSourceRuntimeOptions {
    NativeSourceRuntimeOptions {
        watch_debounce: None,
        lazy_partitions: IndexMap::from([
            (
                "samples".into(),
                LazyPartitionPolicy {
                    max_loaded_partitions: 0,
                    full_scan: FullScanPolicy::Allow,
                },
            ),
            (
                "raw".into(),
                LazyPartitionPolicy {
                    max_loaded_partitions: 0,
                    full_scan: FullScanPolicy::Allow,
                },
            ),
        ]),
        ..Default::default()
    }
}
fn no_payloads() {
    assert_eq!(
        LIVE.load(Ordering::SeqCst),
        0,
        "historical payloads survived the session boundary"
    );
}

struct DiscardedResult<'a> {
    owner: &'a NativeSourceSessions,
    dropped_before_release: &'a AtomicBool,
    _rows: Vec<Value>,
}
impl Drop for DiscardedResult<'_> {
    fn drop(&mut self) {
        let still_owned = matches!(
            self.owner.open_session(),
            Err(proseql_engine::errors::EngineError::Operation(ref error))
                if error.reason == "session-reentrant"
        );
        self.dropped_before_release
            .store(still_owned, Ordering::SeqCst);
    }
}

#[test]
fn source_sessions_release_payloads_after_reads_writes_errors_and_unwinding() {
    let dir = tempfile::tempdir().unwrap();
    let config = prepare(dir.path());
    no_payloads();
    let sessions = NativeSourceSessions::new(config, options()).unwrap();
    no_payloads();
    for _ in 0..2 {
        for collection in ["file", "documents", "yaml", "samples", "raw"] {
            let result = sessions
                .with_session(|runtime| runtime.query_bounded(collection, QueryInput::default()))
                .unwrap();
            assert_eq!(result.len(), 4);
            assert!(
                LIVE.load(Ordering::SeqCst) >= 4,
                "the counter must observe caller-owned returned payloads"
            );
            drop(result);
            no_payloads();
        }
    }
    let retained_clone: NativeRuntime = sessions
        .with_session(|runtime| Ok(runtime.clone()))
        .unwrap();
    assert!(retained_clone.read(|_| Ok(())).is_err());
    no_payloads();
    drop(retained_clone);
    let output = sessions
        .with_session(|runtime| runtime.mutate(|tx| tx.create("samples", row(4))))
        .unwrap();
    assert_eq!(output["id"], "synthetic-4");
    drop(output);
    no_payloads();
    let count = sessions
        .with_session(|runtime| {
            runtime
                .query_bounded("samples", QueryInput::default())
                .map(|rows| rows.len())
        })
        .unwrap();
    assert_eq!(count, 5);
    no_payloads();
    assert!(sessions
        .with_session(|runtime| runtime.mutate(|tx| tx.create("samples", row(4))))
        .is_err());
    no_payloads();
    let count = sessions
        .with_session(|runtime| {
            runtime.mutate(|tx| {
                tx.update("file", "synthetic-0", json!({"payload":"updated"}))?;
                tx.update("documents", "synthetic-0", json!({"payload":"updated"}))?;
                tx.update("yaml", "synthetic-0", json!({"payload":"updated"}))?;
                Ok(3)
            })
        })
        .unwrap();
    assert_eq!(count, 3);
    no_payloads();
    assert!(
        catch_unwind(AssertUnwindSafe(|| sessions.with_session::<()>(
            |runtime| {
                let _ = runtime.query_bounded("samples", QueryInput::default())?;
                panic!("synthetic caller cancellation by unwind");
            }
        )))
        .is_err()
    );
    no_payloads();
    assert!(sessions
        .with_session(|runtime| runtime
            .query_bounded("samples", QueryInput::default())
            .map(|rows| rows.len()))
        .is_ok());
    no_payloads();
    let bytes = fs::read(dir.path().join("records.jsonl")).unwrap();
    fs::write(dir.path().join("records.jsonl"), "{invalid json\n").unwrap();
    assert!(sessions.with_session(|_| Ok(())).is_err());
    no_payloads();
    fs::write(dir.path().join("records.jsonl"), bytes).unwrap();
    eprintln!("SESSION_PROOF phase=poisoned_mutation");
    let escaped = std::sync::Mutex::new(None);
    let stable_bytes = fs::read(dir.path().join("records.jsonl")).unwrap();
    assert!(
        catch_unwind(AssertUnwindSafe(|| sessions.with_session::<()>(
            |runtime| {
                *escaped.lock().unwrap() = Some(runtime.clone());
                runtime.mutate::<()>(|tx| {
                    tx.create("file", row(8))?;
                    panic!("synthetic mutation unwind");
                })
            }
        )))
        .is_err()
    );
    assert_eq!(
        fs::read(dir.path().join("records.jsonl")).unwrap(),
        stable_bytes
    );
    no_payloads();
    drop(escaped);
    eprintln!("SESSION_PROOF phase=discard_result_before_release");
    let discarded_before_release = AtomicBool::new(false);
    let failure = sessions.with_session(|runtime| {
        let rows = runtime.query_bounded("samples", QueryInput::default())?;
        assert!(catch_unwind(AssertUnwindSafe(|| runtime.mutate::<()>(|_| {
            panic!("synthetic poisoned close with returned rows");
        })))
        .is_err());
        Ok(DiscardedResult {
            owner: &sessions,
            dropped_before_release: &discarded_before_release,
            _rows: rows,
        })
    });
    assert!(failure.is_err());
    drop(failure);
    assert!(
        discarded_before_release.load(Ordering::SeqCst),
        "discarded output must drop before the source lease and allocator policy"
    );
    no_payloads();
    eprintln!("SESSION_PROOF phase=quarantine");
    let error = sessions
        .with_session(|runtime| {
            runtime.inject_rollback_failure_once()?;
            runtime.mutate(|tx| tx.create("file", row(0)))
        })
        .unwrap_err();
    assert!(matches!(
        error,
        proseql_engine::errors::EngineError::DuplicateKey(_)
    ));
    no_payloads();
    for collection in ["file", "documents", "yaml"] {
        let row = sessions
            .with_session(|runtime| runtime.find_by_id(collection, "synthetic-0"))
            .unwrap()
            .unwrap();
        assert_eq!(row["payload"], "updated");
        drop(row);
        no_payloads();
    }
    eprintln!("SESSION_PROOF phase=concurrent_sessions");
    std::thread::scope(|scope| {
        for i in 10..30 {
            let owner = &sessions;
            scope.spawn(move || {
                owner
                    .with_session(|runtime| {
                        runtime.mutate(|tx| tx.create("file", row(i))).map(|_| ())
                    })
                    .unwrap()
            });
        }
    });
    assert_eq!(
        sessions
            .with_session(|runtime| runtime
                .query_bounded("file", QueryInput::default())
                .map(|rows| rows.len()))
            .unwrap(),
        24
    );
    no_payloads();
    let session = sessions.open_session().unwrap();
    eprintln!("SESSION_PROOF phase=active_watch");
    let (sender, receiver) = std::sync::mpsc::channel();
    let watch = session
        .watch_with_callback(
            "samples",
            proseql_engine::reactive::WatchQueryConfig {
                select: Some(json!(["id"])),
                ..Default::default()
            },
            Box::new(move |value| {
                let _ = sender.send(value);
            }),
        )
        .unwrap();
    assert_eq!(
        receiver
            .recv_timeout(std::time::Duration::from_secs(30))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        5
    );
    drop(session.mutate(|tx| tx.create("samples", row(5))).unwrap());
    assert_eq!(
        receiver
            .recv_timeout(std::time::Duration::from_secs(30))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        6
    );
    drop(watch);
    drop(session);
    no_payloads();
    eprintln!("SESSION_PROOF phase=poisoned_single_file");
    let single_path = dir.path().join("single.json");
    let initial = json!({"single":{"synthetic-0":row(0)}}).to_string();
    fs::write(&single_path, &initial).unwrap();
    let single = NativeRuntime::open(proseql_native::NativeRuntimeConfig {
        path: single_path.to_string_lossy().into(),
        collections: vec![descriptor("single", false)],
    })
    .unwrap();
    assert!(catch_unwind(AssertUnwindSafe(|| single.mutate::<()>(|tx| {
        tx.create("single", row(1))?;
        panic!("synthetic single-file mutation unwind");
    })))
    .is_err());
    assert!(single.close().is_err());
    assert_eq!(fs::read_to_string(&single_path).unwrap(), initial);
    no_payloads();
    let session = sessions.open_session().unwrap();
    eprintln!("SESSION_PROOF phase=reentrant_session");
    let nested = sessions.with_session(|_| Ok(()));
    assert!(
        nested.is_err(),
        "reentrant sessions must fail, not deadlock"
    );
    drop(session);
    no_payloads();
    eprintln!("SESSION_PROOF phase=failed_callback_batch_capacity");
    let mut collection = descriptor("hooked", false);
    collection
        .descriptor
        .after_create_hooks
        .push("audit".into());
    let mut options = NativeSourceRuntimeOptions {
        watch_debounce: None,
        ..Default::default()
    };
    options
        .callbacks
        .register_after_create_hook("audit".to_owned(), Box::new(|_| Ok(())));
    let hooked = NativeSourceSessions::new(
        NativeSourceRuntimeConfig {
            collections: vec![collection],
            sources: vec![DatabaseSourceConfig::CollectionFile(
                CollectionFileSourceConfig {
                    id: "hooked".into(),
                    collection: "hooked".into(),
                    path: dir.path().join("hooked.jsonl").to_string_lossy().into(),
                    format: Some("jsonl".into()),
                    prose: None,
                },
            )],
        },
        options,
    )
    .unwrap();
    hooked.with_session(|_| Ok(())).unwrap();
    let before = TOTAL_LIVE.load(Ordering::SeqCst);
    let failure = hooked.with_session(|runtime| {
        runtime.mutate(|tx| {
            for i in 100..1124 {
                drop(tx.create("hooked", row(i))?);
            }
            tx.create("hooked", row(100))
        })
    });
    assert!(failure.is_err());
    drop(failure);
    no_payloads();
    let delta = TOTAL_LIVE.load(Ordering::SeqCst).saturating_sub(before);
    eprintln!("SESSION_PROOF failed_batch_idle_live_delta={delta}");
    assert!(
        delta <= 64 * 1024,
        "failed callback batch retained {delta} bytes after its records were freed"
    );
}
