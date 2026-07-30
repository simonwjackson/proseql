use std::collections::VecDeque;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use indexmap::IndexMap;
use proseql_engine::descriptor::{IdStrategy, SchemaNode, StructField};
use proseql_engine::errors::{EngineError, StorageError, StorageOperation};
use proseql_formats::FormatRegistry;
#[cfg(not(target_arch = "wasm32"))]
use proseql_storage::document_graph::load_document_graph_sources;
#[cfg(not(target_arch = "wasm32"))]
use proseql_storage::fs::FsStorageHost;
use proseql_storage::host::StorageHost;
use proseql_storage::reload::{LastKnownGood, ReloadCoordinator};
use proseql_storage::source_config::{
    normalize_source_config, DatabaseSourceConfig, DocumentGraphFragmentErrorPolicy,
    DocumentGraphRootConfig, DocumentGraphSourceConfig, SourceCollectionSelection,
    SourceConfigInput,
};
use proseql_storage::writer::{DebounceScheduler, KeyedDebouncedWriter, SaveSink};
use serde_json::json;
#[cfg(not(target_arch = "wasm32"))]
use tempfile::tempdir;

#[derive(Default)]
struct RecordingSink {
    writes: Arc<Mutex<Vec<(String, String)>>>,
    fail: Arc<Mutex<bool>>,
}

impl SaveSink for RecordingSink {
    fn save(&self, key: &str, value: &str) -> Result<(), EngineError> {
        if *self.fail.lock().unwrap() {
            return Err(EngineError::Storage(Box::new(StorageError {
                path: key.to_owned(),
                operation: StorageOperation::Write,
                message: "boom".to_owned(),
                cause: None,
            })));
        }
        self.writes
            .lock()
            .unwrap()
            .push((key.to_owned(), value.to_owned()));
        Ok(())
    }
}

#[test]
fn last_known_good_only_swaps_on_success() {
    let lkg = LastKnownGood::new(json!({"version": 1}));
    assert!(lkg.reload(|| Ok(json!({"version": 2}))).is_ok());
    assert_eq!(lkg.current(), json!({"version": 2}));

    let err = lkg.reload(|| {
        Err(EngineError::Storage(Box::new(StorageError {
            path: "/db.yaml".to_owned(),
            operation: StorageOperation::Read,
            message: "broken".to_owned(),
            cause: None,
        })))
    });
    assert!(err.is_err());
    assert_eq!(lkg.current(), json!({"version": 2}));
}

#[test]
fn reload_coordinator_tracks_last_error_and_keeps_last_known_good() {
    let lkg = LastKnownGood::new(1_i32);
    let coordinator = ReloadCoordinator::new(lkg.clone());
    coordinator.reload(|| Ok(2)).unwrap();
    assert_eq!(lkg.current(), 2);

    coordinator
        .reload(|| {
            Err(EngineError::Storage(Box::new(StorageError {
                path: "/db.yaml".to_owned(),
                operation: StorageOperation::Read,
                message: "broken".to_owned(),
                cause: None,
            })))
        })
        .unwrap_err();

    assert_eq!(lkg.current(), 2);
    assert!(matches!(
        coordinator.last_error(),
        Some(EngineError::Storage(_))
    ));
}

#[test]
fn keyed_debounced_writer_latest_save_wins_per_key() {
    let sink = RecordingSink::default();
    let writer = KeyedDebouncedWriter::new(Arc::new(sink), Duration::from_millis(30));
    writer.schedule("a", "one").unwrap();
    writer.schedule("a", "two").unwrap();
    writer.schedule("b", "three").unwrap();
    std::thread::sleep(Duration::from_millis(120));

    let mut writes = writer.sink().writes.lock().unwrap().clone();
    writes.sort();
    assert_eq!(
        writes,
        vec![
            ("a".to_owned(), "two".to_owned()),
            ("b".to_owned(), "three".to_owned())
        ]
    );
}

#[test]
fn keyed_debounced_writer_flush_writes_pending_entries_immediately() {
    let sink = RecordingSink::default();
    let writer = KeyedDebouncedWriter::new(Arc::new(sink), Duration::from_secs(60));
    writer.schedule("a", "one").unwrap();
    writer.schedule("b", "two").unwrap();
    writer.flush().unwrap();

    let writes = writer.sink().writes.lock().unwrap().clone();
    assert_eq!(writes.len(), 2);
}

#[derive(Default)]
struct ManualScheduler {
    jobs: Mutex<VecDeque<Box<dyn FnOnce() + Send>>>,
}

impl ManualScheduler {
    fn run_next(&self) {
        let job = self.jobs.lock().unwrap().pop_front().expect("queued job");
        job();
    }
}

impl DebounceScheduler for ManualScheduler {
    fn schedule(&self, _delay: Duration, job: Box<dyn FnOnce() + Send>) -> Result<(), EngineError> {
        self.jobs.lock().unwrap().push_back(job);
        Ok(())
    }
}

struct ImmediateScheduler;

impl DebounceScheduler for ImmediateScheduler {
    fn schedule(&self, _delay: Duration, job: Box<dyn FnOnce() + Send>) -> Result<(), EngineError> {
        job();
        Ok(())
    }
}

#[test]
fn keyed_debounced_writer_supports_injected_scheduler() {
    let sink = RecordingSink::default();
    let writer = KeyedDebouncedWriter::new_with_scheduler(
        Arc::new(sink),
        Duration::from_secs(60),
        Arc::new(ImmediateScheduler),
    );
    writer.schedule("a", "one").unwrap();

    let writes = writer.sink().writes.lock().unwrap().clone();
    assert_eq!(writes, vec![("a".to_owned(), "one".to_owned())]);
}

#[test]
fn keyed_debounced_writer_stale_timer_after_flush_cannot_consume_newer_value() {
    let scheduler = Arc::new(ManualScheduler::default());
    let sink = RecordingSink::default();
    let writer = KeyedDebouncedWriter::new_with_scheduler(
        Arc::new(sink),
        Duration::from_secs(60),
        scheduler.clone(),
    );

    writer.schedule("a", "one").unwrap();
    writer.flush().unwrap();
    writer.schedule("a", "two").unwrap();

    scheduler.run_next();
    assert_eq!(
        writer.sink().writes.lock().unwrap().clone(),
        vec![("a".to_owned(), "one".to_owned())]
    );

    scheduler.run_next();
    assert_eq!(
        writer.sink().writes.lock().unwrap().clone(),
        vec![
            ("a".to_owned(), "one".to_owned()),
            ("a".to_owned(), "two".to_owned())
        ]
    );
}

struct BlockingSink {
    started_tx: Mutex<Option<mpsc::Sender<String>>>,
    release_rx: Mutex<mpsc::Receiver<Result<(), EngineError>>>,
}

impl SaveSink for BlockingSink {
    fn save(&self, key: &str, _value: &str) -> Result<(), EngineError> {
        if let Some(tx) = self.started_tx.lock().unwrap().as_ref() {
            tx.send(key.to_owned()).unwrap();
        }
        self.release_rx.lock().unwrap().recv().unwrap()
    }
}

struct SpawnScheduler;

impl DebounceScheduler for SpawnScheduler {
    fn schedule(&self, _delay: Duration, job: Box<dyn FnOnce() + Send>) -> Result<(), EngineError> {
        thread::spawn(job);
        Ok(())
    }
}

#[test]
fn keyed_debounced_writer_flush_waits_for_earlier_in_flight_work_and_propagates_errors() {
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let sink = Arc::new(BlockingSink {
        started_tx: Mutex::new(Some(started_tx)),
        release_rx: Mutex::new(release_rx),
    });
    let writer = Arc::new(KeyedDebouncedWriter::new_with_scheduler(
        sink,
        Duration::from_secs(60),
        Arc::new(SpawnScheduler),
    ));

    writer.schedule("/data/a.json", "one").unwrap();
    assert_eq!(
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        "/data/a.json"
    );

    let writer_for_flush = writer.clone();
    let (result_tx, result_rx) = mpsc::channel();
    thread::spawn(move || {
        result_tx.send(writer_for_flush.flush()).unwrap();
    });

    assert!(result_rx.recv_timeout(Duration::from_millis(150)).is_err());
    release_tx
        .send(Err(EngineError::Storage(Box::new(StorageError {
            path: "/data/a.json".to_owned(),
            operation: StorageOperation::Write,
            message: "boom".to_owned(),
            cause: None,
        }))))
        .unwrap();
    assert!(matches!(
        result_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        Err(EngineError::Storage(_))
    ));
}

#[test]
fn keyed_debounced_writer_propagates_flush_errors() {
    let sink = Arc::new(RecordingSink::default());
    let writer = KeyedDebouncedWriter::new(sink.clone(), Duration::from_secs(60));
    writer.schedule("/data/a.json", "one").unwrap();
    *sink.fail.lock().unwrap() = true;
    let err = writer.flush().unwrap_err();
    assert!(matches!(err, EngineError::Storage(_)));
}

#[test]
fn failed_timed_write_remains_pending_and_flush_retries_it() {
    let scheduler = Arc::new(ManualScheduler::default());
    let sink = Arc::new(RecordingSink::default());
    let writer = KeyedDebouncedWriter::new_with_scheduler(
        sink.clone(),
        Duration::from_secs(60),
        scheduler.clone(),
    );

    writer.schedule("/data/a.json", "one").unwrap();
    *sink.fail.lock().unwrap() = true;
    scheduler.run_next();

    assert!(writer.sink().writes.lock().unwrap().is_empty());

    *sink.fail.lock().unwrap() = false;
    writer.flush().unwrap();
    assert_eq!(
        writer.sink().writes.lock().unwrap().clone(),
        vec![("/data/a.json".to_owned(), "one".to_owned())]
    );
}

#[derive(Default)]
struct OrderedFailingSink {
    writes: Arc<Mutex<Vec<String>>>,
    fail_on: Arc<Mutex<Option<String>>>,
}

impl SaveSink for OrderedFailingSink {
    fn save(&self, key: &str, _value: &str) -> Result<(), EngineError> {
        self.writes.lock().unwrap().push(key.to_owned());
        if self.fail_on.lock().unwrap().as_deref() == Some(key) {
            return Err(EngineError::Storage(Box::new(StorageError {
                path: key.to_owned(),
                operation: StorageOperation::Write,
                message: "boom".to_owned(),
                cause: None,
            })));
        }
        Ok(())
    }
}

#[test]
fn keyed_debounced_writer_flush_preserves_insertion_order_and_stops_on_first_error() {
    let sink = Arc::new(OrderedFailingSink::default());
    let writer = KeyedDebouncedWriter::new(sink.clone(), Duration::from_secs(60));
    writer.schedule("/data/second.json", "2").unwrap();
    writer.schedule("/data/first.json", "1").unwrap();
    writer.schedule("/data/third.json", "3").unwrap();
    *sink.fail_on.lock().unwrap() = Some("/data/first.json".to_owned());

    let err = writer.flush().unwrap_err();
    assert!(matches!(err, EngineError::Storage(_)));
    assert_eq!(
        sink.writes.lock().unwrap().clone(),
        vec!["/data/second.json", "/data/first.json"]
    );

    *sink.fail_on.lock().unwrap() = None;
    writer.flush().unwrap();
    assert_eq!(
        sink.writes.lock().unwrap().clone(),
        vec!["/data/second.json", "/data/first.json"]
    );
}

fn graph_reload_config(root: &str) -> proseql_storage::source_config::NormalizedSourceConfig {
    normalize_source_config(SourceConfigInput {
        collections: IndexMap::from([(
            "foods".to_owned(),
            proseql_storage::persistence::CollectionStorageConfig {
                name: "foods".to_owned(),
                schema: SchemaNode::Struct {
                    fields: vec![
                        StructField {
                            name: "name".to_owned(),
                            schema: SchemaNode::Str,
                        },
                        StructField {
                            name: "macros".to_owned(),
                            schema: SchemaNode::Struct {
                                fields: vec![StructField {
                                    name: "cal".to_owned(),
                                    schema: SchemaNode::Num,
                                }],
                            },
                        },
                    ],
                },
                id_strategy: IdStrategy::DerivedFromKey,
                version: None,
                migrations: vec![],
            },
        )]),
        sources: vec![DatabaseSourceConfig::DocumentGraph(
            DocumentGraphSourceConfig {
                id: "graph".to_owned(),
                roots: vec![DocumentGraphRootConfig {
                    id: None,
                    root: root.to_owned(),
                    optional: false,
                    include: Some(vec!["**/*.yaml".to_owned()]),
                    exclude: vec![],
                    collections: Some(SourceCollectionSelection::All),
                }],
                collections: Some(SourceCollectionSelection::All),
                include: None,
                exclude: vec![],
                transform_callback_id: None,
                on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
            },
        )],
    })
    .unwrap()
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn fs_watch_dir_reload_coordinator_updates_on_valid_edit_and_keeps_last_known_good_on_invalid_edit()
{
    let dir = tempdir().unwrap();
    let nested = dir.path().join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    let file = nested.join("foods.yaml");
    std::fs::write(
        &file,
        "foods:\n  apple:\n    name: Apple\n    macros:\n      cal: 10\n",
    )
    .unwrap();

    let host = FsStorageHost::new_polling(Duration::from_millis(50)).unwrap();
    let config = graph_reload_config(dir.path().to_str().unwrap());
    let initial =
        load_document_graph_sources(&host, &FormatRegistry::with_builtins(), &config, None, None)
            .unwrap();
    let lkg = LastKnownGood::new(initial);
    let coordinator = ReloadCoordinator::new(lkg.clone());
    let (event_tx, event_rx) = mpsc::channel();
    let (reload_tx, reload_rx) = mpsc::channel();
    let handle = host
        .watch_dir(
            dir.path().to_str().unwrap(),
            Box::new(move |_| {
                event_tx.send(()).unwrap();
            }),
        )
        .unwrap();

    let host_for_thread = host.clone();
    let config_for_thread = config.clone();
    let coordinator_for_thread = coordinator.clone();
    let reloader = thread::spawn(move || {
        while event_rx.recv().is_ok() {
            while event_rx.recv_timeout(Duration::from_millis(75)).is_ok() {}
            let result = coordinator_for_thread.reload(|| {
                load_document_graph_sources(
                    &host_for_thread,
                    &FormatRegistry::with_builtins(),
                    &config_for_thread,
                    None,
                    None,
                )
            });
            reload_tx.send(result).unwrap();
        }
    });

    let sentinel = nested.join("sentinel.txt");
    std::fs::write(&sentinel, "ready\n").unwrap();
    reload_rx
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();

    let mut saw_valid_reload = false;
    for attempt in 0..10 {
        std::fs::write(
            &file,
            format!(
                "foods:\n  apple:\n    name: Apple Reloaded\n    macros:\n      cal: {}\n",
                attempt + 12
            ),
        )
        .unwrap();
        if reload_rx.recv_timeout(Duration::from_millis(700)).is_ok() {
            saw_valid_reload = true;
            break;
        }
    }
    assert!(saw_valid_reload, "expected reload after valid edit");
    assert!(
        lkg.current().collections["foods"]["apple"]["macros"]["cal"]
            .as_i64()
            .unwrap()
            >= 12
    );

    let mut invalid_error = None;
    for _ in 0..10 {
        std::fs::write(&file, "foods: [\n").unwrap();
        if let Ok(result) = reload_rx.recv_timeout(Duration::from_millis(700)) {
            invalid_error = Some(result.unwrap_err());
            break;
        }
    }
    let err = invalid_error.expect("expected reload error after invalid edit");
    assert!(matches!(err, EngineError::Serialization(_)));
    assert_eq!(
        coordinator.last_error().map(|error| error.tag()),
        Some("SerializationError")
    );
    assert!(
        lkg.current().collections["foods"]["apple"]["macros"]["cal"]
            .as_i64()
            .unwrap()
            >= 12
    );

    handle.stop().unwrap();
    drop(handle);
    reloader.join().unwrap();
}
