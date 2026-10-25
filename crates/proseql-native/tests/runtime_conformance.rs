use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use indexmap::IndexMap;
use proseql_engine::descriptor::{
    CollectionDescriptor, IdStrategy, MigrationDescriptor, RelationshipDescriptor,
    RelationshipKind, SchemaNode, StructField, ValidationMode,
};
use proseql_engine::errors::{EngineError, StorageError, StorageOperation};
use proseql_engine::reactive::WatchQueryConfig;
use proseql_native::{NativeCollectionConfig, NativeRuntime, NativeRuntimeConfig};
use proseql_storage::host::{StorageEvent, StorageHost, WatchHandle};
use proseql_storage::memory::MemoryStorageHost;
use proseql_storage::persistence::DurableStorageHost;
use serde_json::json;

fn descriptor(name: &str, fields: Vec<StructField>) -> CollectionDescriptor {
    CollectionDescriptor {
        name: name.into(),
        schema: SchemaNode::Struct { fields },
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
        version: Some(1),
        migrations: vec![],
        append_only: false,
        duplicate_ids: Default::default(),
        validation_mode: ValidationMode::Strict,
    }
}

fn config() -> NativeRuntimeConfig {
    NativeRuntimeConfig {
        path: "/state/reader.json".into(),
        collections: vec![
            NativeCollectionConfig::new(descriptor(
                "positions",
                vec![
                    StructField {
                        name: "id".into(),
                        schema: SchemaNode::Str,
                    },
                    StructField {
                        name: "page".into(),
                        schema: SchemaNode::Num,
                    },
                    StructField {
                        name: "revision".into(),
                        schema: SchemaNode::Num,
                    },
                    StructField {
                        name: "createdAt".into(),
                        schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
                    },
                    StructField {
                        name: "updatedAt".into(),
                        schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
                    },
                ],
            )),
            NativeCollectionConfig::new(descriptor(
                "metadata",
                vec![
                    StructField {
                        name: "id".into(),
                        schema: SchemaNode::Str,
                    },
                    StructField {
                        name: "title".into(),
                        schema: SchemaNode::Str,
                    },
                    StructField {
                        name: "createdAt".into(),
                        schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
                    },
                    StructField {
                        name: "updatedAt".into(),
                        schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
                    },
                ],
            )),
        ],
    }
}

fn relational_config() -> NativeRuntimeConfig {
    let timestamp_fields = || {
        vec![
            StructField {
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ]
    };
    let mut parent_fields = vec![
        StructField {
            name: "id".into(),
            schema: SchemaNode::Str,
        },
        StructField {
            name: "name".into(),
            schema: SchemaNode::Str,
        },
    ];
    parent_fields.extend(timestamp_fields());
    let mut child_fields = vec![
        StructField {
            name: "id".into(),
            schema: SchemaNode::Str,
        },
        StructField {
            name: "parentId".into(),
            schema: SchemaNode::Str,
        },
        StructField {
            name: "name".into(),
            schema: SchemaNode::Str,
        },
    ];
    child_fields.extend(timestamp_fields());
    let parents = descriptor("parents", parent_fields);
    let mut children = descriptor("children", child_fields);
    children.relationships = vec![(
        "parent".into(),
        RelationshipDescriptor {
            kind: RelationshipKind::Ref,
            target: "parents".into(),
            foreign_key: Some("parentId".into()),
        },
    )];
    NativeRuntimeConfig {
        path: "/state/relations.json".into(),
        collections: vec![
            NativeCollectionConfig::new(parents),
            NativeCollectionConfig::new(children),
        ],
    }
}

fn valid_relational_state() -> IndexMap<String, IndexMap<String, serde_json::Value>> {
    IndexMap::from([
        (
            "parents".into(),
            IndexMap::from([("parent-1".into(), json!({"id":"parent-1","name":"Parent"}))]),
        ),
        (
            "children".into(),
            IndexMap::from([(
                "child-1".into(),
                json!({"id":"child-1","parentId":"parent-1","name":"Child"}),
            )]),
        ),
    ])
}

#[test]
fn multi_collection_transaction_is_visible_only_after_durable_commit_and_reopens() {
    let host = Arc::new(MemoryStorageHost::default());
    let runtime = NativeRuntime::open_with_host(config(), host.clone()).unwrap();
    runtime
        .mutate(|db| {
            db.create("positions", json!({"id":"book-1","page":5,"revision":1}))?;
            db.create("metadata", json!({"id":"book-1","title":"Corrected"}))?;
            Ok(())
        })
        .unwrap();
    runtime.close().unwrap();

    let reopened = NativeRuntime::open_with_host(config(), host).unwrap();
    assert_eq!(
        reopened.find_by_id("positions", "book-1").unwrap().unwrap()["page"],
        json!(5)
    );
    assert_eq!(
        reopened.find_by_id("metadata", "book-1").unwrap().unwrap()["title"],
        json!("Corrected")
    );
}

#[derive(Clone)]
struct FailingDurableHost {
    inner: MemoryStorageHost,
    fail: Arc<Mutex<bool>>,
}
impl FailingDurableHost {
    fn new() -> Self {
        Self {
            inner: MemoryStorageHost::default(),
            fail: Arc::new(Mutex::new(false)),
        }
    }
}
impl StorageHost for FailingDurableHost {
    fn read(&self, p: &str) -> Result<String, EngineError> {
        self.inner.read(p)
    }
    fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, EngineError> {
        self.inner.read_range(path, offset, len)
    }
    fn stat(&self, path: &str) -> Result<Option<proseql_storage::host::FileStat>, EngineError> {
        self.inner.stat(path)
    }
    fn write(&self, p: &str, d: &str) -> Result<(), EngineError> {
        self.inner.write(p, d)
    }
    fn append(&self, p: &str, d: &str) -> Result<(), EngineError> {
        self.inner.append(p, d)
    }
    fn exists(&self, p: &str) -> Result<bool, EngineError> {
        self.inner.exists(p)
    }
    fn remove(&self, p: &str) -> Result<(), EngineError> {
        self.inner.remove(p)
    }
    fn ensure_dir(&self, p: &str) -> Result<(), EngineError> {
        self.inner.ensure_dir(p)
    }
    fn list_directory(&self, p: &str) -> Result<Vec<String>, EngineError> {
        self.inner.list_directory(p)
    }
    fn list_recursive(&self, p: &str) -> Result<Vec<String>, EngineError> {
        self.inner.list_recursive(p)
    }
    fn watch(
        &self,
        p: &str,
        c: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        self.inner.watch(p, c)
    }
    fn watch_dir(
        &self,
        p: &str,
        c: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        self.inner.watch_dir(p, c)
    }
}
impl DurableStorageHost for FailingDurableHost {
    fn replace_durable(&self, path: &str, data: &str) -> Result<(), EngineError> {
        if *self.fail.lock().unwrap() {
            return Err(EngineError::Storage(Box::new(StorageError {
                path: path.into(),
                operation: StorageOperation::Write,
                message: "injected durable commit failure".into(),
                cause: None,
            })));
        }
        self.inner.write(path, data)
    }
}

#[test]
fn failed_durable_commit_rolls_back_visible_state() {
    let host = Arc::new(FailingDurableHost::new());
    let runtime = NativeRuntime::open_with_host(config(), host.clone()).unwrap();
    runtime
        .mutate(|db| {
            db.create("positions", json!({"id":"book-1","page":1,"revision":1}))?;
            Ok(())
        })
        .unwrap();
    *host.fail.lock().unwrap() = true;

    let error = runtime
        .mutate(|db| {
            db.update_if_revision("positions", "book-1", 1, json!({"page":2,"revision":2}))?;
            Ok(())
        })
        .unwrap_err();
    assert!(matches!(error, EngineError::Storage(_)));
    assert_eq!(
        runtime.find_by_id("positions", "book-1").unwrap().unwrap()["page"],
        json!(1)
    );
}

#[test]
fn same_revision_race_has_exactly_one_durable_winner() {
    let host = Arc::new(MemoryStorageHost::default());
    let runtime = NativeRuntime::open_with_host(config(), host).unwrap();
    runtime
        .mutate(|db| {
            db.create("positions", json!({"id":"book-1","page":1,"revision":1}))?;
            Ok(())
        })
        .unwrap();

    let handles = [2, 3]
        .into_iter()
        .map(|page| {
            let runtime = runtime.clone();
            thread::spawn(move || {
                runtime.mutate(|db| {
                    db.update_if_revision(
                        "positions",
                        "book-1",
                        1,
                        json!({"page":page,"revision":2}),
                    )?;
                    Ok(())
                })
            })
        })
        .collect::<Vec<_>>();
    let results = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(EngineError::Concurrency(_))))
            .count(),
        1
    );
}

#[derive(Default)]
struct BlockState {
    enabled: bool,
    entered: bool,
    released: bool,
}

#[derive(Clone, Default)]
struct BlockingDurableHost {
    inner: MemoryStorageHost,
    state: Arc<(Mutex<BlockState>, Condvar)>,
}

impl BlockingDurableHost {
    fn block_next_commit(&self) {
        let (lock, _) = &*self.state;
        *lock.lock().unwrap() = BlockState {
            enabled: true,
            entered: false,
            released: false,
        };
    }

    fn wait_until_commit_entered(&self) {
        let (lock, signal) = &*self.state;
        let mut state = lock.lock().unwrap();
        while !state.entered {
            state = signal.wait(state).unwrap();
        }
    }

    fn release_commit(&self) {
        let (lock, signal) = &*self.state;
        lock.lock().unwrap().released = true;
        signal.notify_all();
    }
}

impl StorageHost for BlockingDurableHost {
    fn read(&self, path: &str) -> Result<String, EngineError> {
        self.inner.read(path)
    }
    fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, EngineError> {
        self.inner.read_range(path, offset, len)
    }
    fn stat(&self, path: &str) -> Result<Option<proseql_storage::host::FileStat>, EngineError> {
        self.inner.stat(path)
    }
    fn write(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.inner.write(path, data)
    }
    fn append(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.inner.append(path, data)
    }
    fn exists(&self, path: &str) -> Result<bool, EngineError> {
        self.inner.exists(path)
    }
    fn remove(&self, path: &str) -> Result<(), EngineError> {
        self.inner.remove(path)
    }
    fn ensure_dir(&self, path: &str) -> Result<(), EngineError> {
        self.inner.ensure_dir(path)
    }
    fn list_directory(&self, path: &str) -> Result<Vec<String>, EngineError> {
        self.inner.list_directory(path)
    }
    fn list_recursive(&self, path: &str) -> Result<Vec<String>, EngineError> {
        self.inner.list_recursive(path)
    }
    fn watch(
        &self,
        path: &str,
        callback: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        self.inner.watch(path, callback)
    }
    fn watch_dir(
        &self,
        path: &str,
        callback: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        self.inner.watch_dir(path, callback)
    }
}

impl DurableStorageHost for BlockingDurableHost {
    fn replace_durable(&self, path: &str, data: &str) -> Result<(), EngineError> {
        let (lock, signal) = &*self.state;
        let mut state = lock.lock().unwrap();
        if state.enabled {
            state.entered = true;
            signal.notify_all();
            while !state.released {
                state = signal.wait(state).unwrap();
            }
            state.enabled = false;
        }
        drop(state);
        self.inner.write(path, data)
    }
}

#[test]
fn close_waits_for_active_commit_then_rejects_later_operations() {
    let host = Arc::new(BlockingDurableHost::default());
    let runtime = NativeRuntime::open_with_host(config(), host.clone()).unwrap();
    runtime
        .mutate(|db| {
            db.create("positions", json!({"id":"book-1","page":1,"revision":1}))?;
            Ok(())
        })
        .unwrap();
    host.block_next_commit();

    let committing = {
        let runtime = runtime.clone();
        thread::spawn(move || {
            runtime.mutate(|db| {
                db.update_if_revision("positions", "book-1", 1, json!({"page":2,"revision":2}))?;
                Ok(())
            })
        })
    };
    host.wait_until_commit_entered();
    let (closed_tx, closed_rx) = mpsc::channel();
    let closing = {
        let runtime = runtime.clone();
        thread::spawn(move || closed_tx.send(runtime.close()).unwrap())
    };
    assert!(closed_rx.recv_timeout(Duration::from_millis(25)).is_err());
    host.release_commit();
    committing.join().unwrap().unwrap();
    closed_rx
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    closing.join().unwrap();

    assert!(matches!(
        runtime.find_by_id("positions", "book-1"),
        Err(EngineError::Operation(_))
    ));
    let reopened = NativeRuntime::open_with_host(config(), host).unwrap();
    assert_eq!(
        reopened.find_by_id("positions", "book-1").unwrap().unwrap()["page"],
        json!(2)
    );
}

#[test]
fn corrupt_startup_source_fails_closed() {
    let host = Arc::new(MemoryStorageHost::default());
    host.write("/state/reader.json", "{not valid json").unwrap();
    assert!(NativeRuntime::open_with_host(config(), host).is_err());
}

#[test]
fn whole_source_replacement_validates_before_promotion() {
    let host = Arc::new(MemoryStorageHost::default());
    let runtime = NativeRuntime::open_with_host(config(), host).unwrap();
    let invalid = IndexMap::from([
        (
            "positions".into(),
            IndexMap::from([(
                "book-1".into(),
                json!({"id":"book-1","page":"bad","revision":1}),
            )]),
        ),
        ("metadata".into(), IndexMap::new()),
    ]);
    assert!(runtime.replace_all(invalid).is_err());
    assert!(runtime.find_by_id("positions", "book-1").unwrap().is_none());
}

#[test]
fn whole_source_replacement_refreshes_active_reactive_watches_once() {
    let host = Arc::new(MemoryStorageHost::default());
    let runtime = NativeRuntime::open_with_host(config(), host).unwrap();
    let watch = runtime
        .read(|db| db.watch("positions", WatchQueryConfig::default()))
        .unwrap();
    assert_eq!(watch.recv().unwrap(), json!([]));

    runtime
        .replace_all(IndexMap::from([
            (
                "positions".into(),
                IndexMap::from([(
                    "book-1".into(),
                    json!({"id":"book-1","page":7,"revision":1}),
                )]),
            ),
            ("metadata".into(), IndexMap::new()),
        ]))
        .unwrap();

    assert_eq!(watch.recv().unwrap().as_array().unwrap().len(), 1);
    assert!(watch.try_recv().is_err());
}

#[test]
fn explicit_reload_retains_lkg_and_reports_malformed_candidate() {
    let host = Arc::new(MemoryStorageHost::default());
    let runtime = NativeRuntime::open_with_host(config(), host.clone()).unwrap();
    runtime
        .mutate(|db| {
            db.create("positions", json!({"id":"book-1","page":1,"revision":1}))?;
            Ok(())
        })
        .unwrap();
    host.write("/state/reader.json", "{broken").unwrap();

    assert!(runtime.reload().is_err());
    assert_eq!(
        runtime.find_by_id("positions", "book-1").unwrap().unwrap()["page"],
        json!(1)
    );
    assert!(runtime.last_reload_error().unwrap().is_some());
}

#[test]
fn managed_watch_debounces_external_changes_suppresses_self_writes_and_stops_on_close() {
    let host = Arc::new(MemoryStorageHost::default());
    let runtime = NativeRuntime::open_with_host(config(), host.clone()).unwrap();
    runtime
        .start_managed_watch(Duration::from_millis(10))
        .unwrap();
    runtime
        .mutate(|db| {
            db.create("positions", json!({"id":"book-1","page":1,"revision":1}))?;
            Ok(())
        })
        .unwrap();
    thread::sleep(Duration::from_millis(40));
    assert!(runtime.last_reload_error().unwrap().is_none());

    let mut external: serde_json::Value =
        serde_json::from_str(&host.read("/state/reader.json").unwrap()).unwrap();
    external["positions"]["book-1"]["page"] = json!(2);
    external["positions"]["book-1"]["revision"] = json!(2);
    host.write(
        "/state/reader.json",
        &serde_json::to_string_pretty(&external).unwrap(),
    )
    .unwrap();
    thread::sleep(Duration::from_millis(40));
    assert_eq!(
        runtime.find_by_id("positions", "book-1").unwrap().unwrap()["page"],
        json!(2)
    );

    host.write("/state/reader.json", "{broken").unwrap();
    thread::sleep(Duration::from_millis(40));
    assert!(runtime.last_reload_error().unwrap().is_some());
    assert_eq!(
        runtime.find_by_id("positions", "book-1").unwrap().unwrap()["page"],
        json!(2)
    );

    runtime.close().unwrap();
    host.write("/state/reader.json", "still broken").unwrap();
}

#[test]
fn unregistered_descriptor_callbacks_migrations_and_generators_fail_open_typed() {
    for mutate_descriptor in [
        |descriptor: &mut CollectionDescriptor| descriptor.before_create_hooks.push("hook".into()),
        |descriptor: &mut CollectionDescriptor| {
            descriptor.migrations.push(MigrationDescriptor {
                from: 0,
                to: 1,
                description: None,
                callback_id: "migration".into(),
            })
        },
        |descriptor: &mut CollectionDescriptor| descriptor.id_generator = Some("custom".into()),
    ] {
        let mut candidate = config();
        mutate_descriptor(&mut candidate.collections[0].descriptor);
        let error =
            NativeRuntime::open_with_host(candidate, Arc::new(MemoryStorageHost::default()))
                .err()
                .expect("unregistered callback should fail");
        assert!(matches!(error, EngineError::Operation(_)));
    }
}

#[test]
fn rollback_failure_quarantines_runtime_without_shadowing_persistence_error() {
    let host = Arc::new(FailingDurableHost::new());
    let runtime = NativeRuntime::open_with_host(config(), host.clone()).unwrap();
    runtime
        .mutate(|db| {
            db.create("positions", json!({"id":"book-1","page":1,"revision":1}))?;
            Ok(())
        })
        .unwrap();
    runtime.inject_rollback_failure_once().unwrap();
    *host.fail.lock().unwrap() = true;

    let error = runtime
        .mutate(|db| {
            db.update_if_revision("positions", "book-1", 1, json!({"page":2,"revision":2}))?;
            Ok(())
        })
        .unwrap_err();
    match error {
        EngineError::Storage(error) => assert_eq!(error.message, "injected durable commit failure"),
        other => panic!("original persistence error was shadowed: {other:?}"),
    }
    assert!(matches!(
        runtime.find_by_id("positions", "book-1"),
        Err(EngineError::Operation(_))
    ));
}

#[test]
fn relationally_invalid_replace_all_leaves_disk_and_visible_lkg_unchanged() {
    let host = Arc::new(MemoryStorageHost::default());
    let runtime = NativeRuntime::open_with_host(relational_config(), host.clone()).unwrap();
    runtime.replace_all(valid_relational_state()).unwrap();
    let before = host.read("/state/relations.json").unwrap();

    let mut invalid = valid_relational_state();
    invalid["children"]["child-1"]["parentId"] = json!("missing-parent");
    assert!(matches!(
        runtime.replace_all(invalid),
        Err(EngineError::ForeignKey(_))
    ));

    assert_eq!(host.read("/state/relations.json").unwrap(), before);
    assert_eq!(
        runtime.find_by_id("children", "child-1").unwrap().unwrap()["parentId"],
        json!("parent-1")
    );
}

#[test]
fn relationally_invalid_startup_state_fails_closed() {
    let host = Arc::new(MemoryStorageHost::default());
    let runtime = NativeRuntime::open_with_host(relational_config(), host.clone()).unwrap();
    runtime.replace_all(valid_relational_state()).unwrap();
    runtime.close().unwrap();

    let mut source: serde_json::Value =
        serde_json::from_str(&host.read("/state/relations.json").unwrap()).unwrap();
    source["children"]["child-1"]["parentId"] = json!("missing-parent");
    host.write(
        "/state/relations.json",
        &serde_json::to_string_pretty(&source).unwrap(),
    )
    .unwrap();

    let error = NativeRuntime::open_with_host(relational_config(), host)
        .err()
        .expect("invalid relationship must fail startup");
    assert!(matches!(error, EngineError::ForeignKey(_)));
}

#[test]
fn failed_final_flush_closes_runtime_and_preserves_original_storage_error() {
    let host = Arc::new(FailingDurableHost::new());
    let runtime = NativeRuntime::open_with_host(config(), host.clone()).unwrap();
    runtime
        .mutate(|db| {
            db.create("positions", json!({"id":"book-1","page":1,"revision":1}))?;
            Ok(())
        })
        .unwrap();
    *host.fail.lock().unwrap() = true;

    let error = runtime.close().unwrap_err();
    match error {
        EngineError::Storage(error) => assert_eq!(error.message, "injected durable commit failure"),
        other => panic!("unexpected close error: {other:?}"),
    }
    assert!(matches!(
        runtime.find_by_id("positions", "book-1"),
        Err(EngineError::Operation(_))
    ));
    assert!(runtime.close().is_ok());
}
