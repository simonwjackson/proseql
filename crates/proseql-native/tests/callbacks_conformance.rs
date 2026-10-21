//! Same callback data and semantics as engine hooks/plugins conformance; only
//! post-hook timing differs: native waits for durability before dispatch.
use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use proseql_engine::collection::Collection;
use proseql_engine::descriptor::{
    CollectionDescriptor, ComputedFieldDescriptor, IdStrategy, MigrationDescriptor, SchemaNode,
    StructField, ValidationMode,
};
use proseql_engine::errors::{EngineError, OperationError};
use proseql_engine::id_gen::{IdGenerator, SequentialGenerator};
use proseql_engine::plugins::PluginCodecMetadata;
use proseql_engine::query::pipeline::QueryInput;
use proseql_engine::relationships::Database;
use proseql_native::{
    CallbackRegistry, NativeCollectionConfig, NativeRuntime, NativeRuntimeConfig,
    NativeRuntimeOptions, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{
    CollectionFileSourceConfig, DatabaseSourceConfig, DocumentSourceConfig, PartitionKey,
    PartitionedSourceConfig, SourceCollectionSelection, UnknownCollectionPolicy,
};
use serde_json::{json, Value};

type Events = Arc<Mutex<Vec<String>>>;

fn error() -> EngineError {
    EngineError::Operation(OperationError {
        operation: "test-callback".into(),
        reason: "rejected".into(),
        message: "callback rejected input".into(),
    })
}

fn descriptor() -> CollectionDescriptor {
    CollectionDescriptor {
        name: "users".into(),
        schema: SchemaNode::Struct {
            fields: vec![
                StructField {
                    name: "id".into(),
                    schema: SchemaNode::Str,
                },
                StructField {
                    name: "name".into(),
                    schema: SchemaNode::Str,
                },
                StructField {
                    name: "score".into(),
                    schema: SchemaNode::Num,
                },
            ],
        },
        id_strategy: IdStrategy::Provided,
        relationships: vec![],
        indexes: vec![],
        ordered_indexes: vec![],
        unique_fields: vec![],
        before_create_hooks: vec!["normalize".into()],
        after_create_hooks: vec!["created".into()],
        before_update_hooks: vec!["update".into()],
        after_update_hooks: vec!["updated".into()],
        before_delete_hooks: vec!["delete".into()],
        after_delete_hooks: vec!["deleted".into()],
        on_change_hooks: vec!["changed".into()],
        computed_fields: vec![ComputedFieldDescriptor {
            name: "double".into(),
            callback_id: "double".into(),
        }],
        search_index: vec![],
        id_generator: Some("sequence".into()),
        version: Some(1),
        migrations: vec![MigrationDescriptor {
            from: 0,
            to: 1,
            description: None,
            callback_id: "upgrade".into(),
        }],
        append_only: false,
        duplicate_ids: Default::default(),
        validation_mode: ValidationMode::Strict,
    }
}

fn record_event(events: &Events, event: &str) {
    events.lock().unwrap().push(event.into());
}

fn registry(events: Events) -> CallbackRegistry {
    let mut callbacks = CallbackRegistry::new();
    let log = Arc::clone(&events);
    callbacks.register_before_create_hook(
        "normalize",
        Box::new(move |ctx| {
            record_event(&log, "beforeCreate");
            if ctx.data["name"] == "reject" {
                return Err(error());
            }
            let mut data = ctx.data.clone();
            data["name"] = json!(data["name"].as_str().unwrap().trim().to_uppercase());
            Ok(data)
        }),
    );
    let log = Arc::clone(&events);
    callbacks.register_before_update_hook(
        "update",
        Box::new(move |ctx| {
            record_event(&log, "beforeUpdate");
            Ok(ctx.update.clone())
        }),
    );
    let log = Arc::clone(&events);
    callbacks.register_before_delete_hook(
        "delete",
        Box::new(move |_| {
            record_event(&log, "beforeDelete");
            Ok(())
        }),
    );
    let log = Arc::clone(&events);
    callbacks.register_after_create_hook(
        "created",
        Box::new(move |_| {
            record_event(&log, "afterCreate");
            Ok(())
        }),
    );
    let log = Arc::clone(&events);
    callbacks.register_after_update_hook(
        "updated",
        Box::new(move |_| {
            record_event(&log, "afterUpdate");
            Ok(())
        }),
    );
    let log = Arc::clone(&events);
    callbacks.register_after_delete_hook(
        "deleted",
        Box::new(move |_| {
            record_event(&log, "afterDelete");
            Ok(())
        }),
    );
    callbacks.register_on_change_hook(
        "changed",
        Box::new(move |_| {
            record_event(&events, "onChange");
            Ok(())
        }),
    );
    callbacks.register_computed(
        "double",
        Box::new(|value| json!(value["score"].as_i64().unwrap() * 2)),
    );
    callbacks.register_migration(
        "upgrade",
        Box::new(|records| {
            let mut records = records.clone();
            for record in records.values_mut() {
                record["score"] = json!(7);
            }
            Ok(records)
        }),
    );
    callbacks.register_id_generator(
        "sequence",
        Box::new(|| Box::new(SequentialGenerator::new("user")) as Box<dyn IdGenerator>),
    );
    callbacks.register_custom_operator(
        "$multipleOf",
        vec!["number".into()],
        Box::new(|value, operand| value.as_i64().unwrap() % operand.as_i64().unwrap() == 0),
    );
    callbacks.register_codec_encode(
        "encode",
        Box::new(|value, _| Ok(format!("native:{}", value))),
    );
    callbacks.register_codec_decode(
        "decode",
        Box::new(|raw| {
            serde_json::from_str(raw.strip_prefix("native:").ok_or_else(error)?)
                .map_err(|_| error())
        }),
    );
    callbacks
}

fn codec() -> PluginCodecMetadata {
    PluginCodecMetadata {
        name: "native-json".into(),
        extensions: vec!["native".into()],
        encode_callback_id: "encode".into(),
        decode_callback_id: "decode".into(),
    }
}

fn config(path: &str) -> NativeRuntimeConfig {
    NativeRuntimeConfig {
        path: path.into(),
        collections: vec![NativeCollectionConfig::new(descriptor())],
    }
}

fn options(callbacks: CallbackRegistry) -> NativeRuntimeOptions {
    NativeRuntimeOptions {
        callbacks,
        plugin_codecs: vec![codec()],
        ..Default::default()
    }
}

fn engine(callbacks: CallbackRegistry) -> Database {
    let callbacks = Arc::new(callbacks);
    let collection = Collection::new(
        "users",
        descriptor(),
        Arc::clone(&callbacks),
        callbacks.instantiate_id_generator("sequence").unwrap(),
    );
    Database::new(IndexMap::from([("users".into(), collection)]), callbacks)
}

#[test]
fn native_registry_matches_engine_hooks_computed_generator_operator_and_codec() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("users.native");
    let path = path.to_str().unwrap();
    std::fs::write(path, "native:{\"users\":{\"_version\":0,\"old\":{\"id\":\"old\",\"name\":\"Alice\",\"score\":0}}}").unwrap();
    let events = Events::default();
    let expected_events = Events::default();
    let runtime =
        NativeRuntime::open_with_options(config(path), options(registry(Arc::clone(&events))))
            .unwrap();
    let mut expected = engine(registry(Arc::clone(&expected_events)));
    expected
        .commit_snapshot_transaction(IndexMap::from([(
            "users".into(),
            vec![json!({"id":"old","name":"Alice","score":7})],
        )]))
        .unwrap();
    let input = json!({"name":" Bob ","score":6});
    assert_eq!(
        runtime
            .mutate(|db| db.create("users", input.clone()))
            .unwrap(),
        expected.create("users", input).unwrap()
    );
    let query = QueryInput {
        r#where: Some(json!({"score":{"$multipleOf":3}})),
        ..Default::default()
    };
    let rows = runtime.query("users", query.clone(), None).unwrap();
    assert_eq!(rows, expected.query("users", query, None).unwrap());
    assert_eq!(rows[0]["double"], 12);
    assert_eq!(rows[0]["id"], "user-1");
    assert_eq!(
        runtime
            .mutate(|db| db.update("users", "user-1", json!({"score":9})))
            .unwrap(),
        expected
            .update("users", "user-1", json!({"score":9}))
            .unwrap()
    );
    runtime.mutate(|db| db.delete("users", "user-1")).unwrap();
    expected.delete("users", "user-1").unwrap();
    assert_eq!(*events.lock().unwrap(), *expected_events.lock().unwrap());
    assert_eq!(
        *events.lock().unwrap(),
        [
            "beforeCreate",
            "afterCreate",
            "onChange",
            "beforeUpdate",
            "afterUpdate",
            "onChange",
            "beforeDelete",
            "afterDelete",
            "onChange"
        ]
    );
    let persisted = std::fs::read_to_string(path).unwrap();
    let saved: Value = serde_json::from_str(persisted.strip_prefix("native:").unwrap()).unwrap();
    assert_eq!(saved["users"]["_version"], 1);
    assert_eq!(saved["users"]["old"]["score"], 7);
    assert!(saved["users"]["old"].get("double").is_none());
    runtime.close().unwrap();
    let reopened =
        NativeRuntime::open_with_options(config(path), options(registry(Events::default())))
            .unwrap();
    assert_eq!(
        reopened.find_by_id("users", "old").unwrap().unwrap()["score"],
        7
    );
}

#[test]
fn failing_before_hook_and_rolled_back_batch_leave_disk_and_post_hooks_unchanged() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("users.native");
    let path = path.to_str().unwrap();
    let events = Events::default();
    let runtime =
        NativeRuntime::open_with_options(config(path), options(registry(Arc::clone(&events))))
            .unwrap();
    runtime.flush().unwrap();
    let before = std::fs::read(path).unwrap();
    assert!(runtime
        .mutate(|db| db.create("users", json!({"id":"bad","name":"reject","score":1})))
        .is_err());
    assert_eq!(std::fs::read(path).unwrap(), before);
    assert!(runtime.find_by_id("users", "bad").unwrap().is_none());
    assert_eq!(*events.lock().unwrap(), ["beforeCreate"]);
    events.lock().unwrap().clear();
    let result: Result<(), EngineError> = runtime.mutate(|db| {
        db.create("users", json!({"id":"rolled-back","name":"Bob","score":1}))?;
        Err(error())
    });
    assert!(result.is_err());
    assert_eq!(*events.lock().unwrap(), ["beforeCreate"]);
    assert_eq!(std::fs::read(path).unwrap(), before);
    assert!(runtime
        .find_by_id("users", "rolled-back")
        .unwrap()
        .is_none());
}

#[test]
fn post_hooks_see_durable_data_can_reenter_and_cannot_veto_success() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("users.native");
    let path = path.to_str().unwrap().to_owned();
    let runtime_slot = Arc::new(Mutex::new(None::<NativeRuntime>));
    let called = Arc::new(Mutex::new(0));
    let mut callbacks = registry(Events::default());
    let slot = Arc::clone(&runtime_slot);
    let seen = Arc::clone(&called);
    let disk_path = path.clone();
    callbacks.register_after_create_hook(
        "created",
        Box::new(move |ctx| {
            let raw = std::fs::read_to_string(&disk_path).unwrap();
            let persisted: Value =
                serde_json::from_str(raw.strip_prefix("native:").unwrap()).unwrap();
            assert_eq!(
                persisted["users"][ctx.entity["id"].as_str().unwrap()],
                ctx.entity
            );
            let runtime = slot.lock().unwrap().as_ref().unwrap().clone();
            assert_eq!(
                runtime
                    .find_by_id("users", ctx.entity["id"].as_str().unwrap())
                    .unwrap(),
                Some(ctx.entity.clone())
            );
            *seen.lock().unwrap() += 1;
            Err(error())
        }),
    );
    let runtime = NativeRuntime::open_with_options(config(&path), options(callbacks)).unwrap();
    *runtime_slot.lock().unwrap() = Some(runtime.clone());
    runtime
        .mutate(|db| db.create("users", json!({"id":"kept","name":"Bob","score":1})))
        .unwrap();
    assert_eq!(*called.lock().unwrap(), 1);
    assert!(runtime.find_by_id("users", "kept").unwrap().is_some());
    runtime_slot.lock().unwrap().take();
}

#[test]
fn unregistered_ids_are_refused_at_open_with_collection_and_id() {
    type DescriptorMutation = (&'static str, fn(&mut CollectionDescriptor));
    let mutations: Vec<DescriptorMutation> = vec![
        (
            "before-create",
            (|d| d.before_create_hooks.push("before-create".into())),
        ),
        (
            "after-create",
            (|d| d.after_create_hooks.push("after-create".into())),
        ),
        (
            "before-update",
            (|d| d.before_update_hooks.push("before-update".into())),
        ),
        (
            "after-update",
            (|d| d.after_update_hooks.push("after-update".into())),
        ),
        (
            "before-delete",
            (|d| d.before_delete_hooks.push("before-delete".into())),
        ),
        (
            "after-delete",
            (|d| d.after_delete_hooks.push("after-delete".into())),
        ),
        (
            "on-change",
            (|d| d.on_change_hooks.push("on-change".into())),
        ),
        (
            "computed",
            (|d| {
                d.computed_fields.push(ComputedFieldDescriptor {
                    name: "missing".into(),
                    callback_id: "computed".into(),
                })
            }),
        ),
        (
            "migration",
            (|d| d.migrations[0].callback_id = "migration".into()),
        ),
        ("generator", (|d| d.id_generator = Some("generator".into()))),
    ];
    for (id, mutate) in mutations {
        let mut config = config("/unused.native");
        mutate(&mut config.collections[0].descriptor);
        let error = NativeRuntime::open_with_options(config, options(registry(Events::default())))
            .err()
            .unwrap();
        assert_eq!(error.tag(), "OperationError");
        assert!(error.to_string().contains("users"), "{error}");
        assert!(error.to_string().contains(id), "{error}");
    }
    let mut missing_codec = codec();
    missing_codec.encode_callback_id = "missing-encoder".into();
    let error = NativeRuntime::open_with_options(
        config("/unused.native"),
        NativeRuntimeOptions {
            callbacks: registry(Events::default()),
            plugin_codecs: vec![missing_codec],
            ..Default::default()
        },
    )
    .err()
    .unwrap();
    assert!(error.to_string().contains("native-json"));
    assert!(error.to_string().contains("missing-encoder"));
}

#[test]
fn source_modes_share_registered_migrations_hooks_operators_and_codecs() {
    for mode in ["documents", "collection-file", "partitioned"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_str().unwrap();
        let path = temp.path().join(if mode == "documents" {
            "Alice.yaml"
        } else {
            "Alice.native"
        });
        let section = json!({"_version":0,"old":{"id":"old","name":"Alice","score":0}});
        let seed = if mode == "documents" {
            json!({"users":section})
        } else {
            section
        };
        std::fs::write(
            &path,
            if mode == "documents" {
                "users:\n  _version: 0\n  old:\n    id: old\n    name: Alice\n    score: 0\n".into()
            } else {
                format!("native:{seed}")
            },
        )
        .unwrap();
        let source = match mode {
            "documents" => DatabaseSourceConfig::Documents(DocumentSourceConfig {
                id: "users".into(),
                root: root.into(),
                include: Some(vec!["*.yaml".into()]),
                exclude: vec![],
                format: Some("yaml".into()),
                collections: Some(SourceCollectionSelection::Named(vec!["users".into()])),
                unknown_collections: UnknownCollectionPolicy::Error,
                outbox: "generated.yaml".into(),
                optional: false,
            }),
            "collection-file" => DatabaseSourceConfig::CollectionFile(CollectionFileSourceConfig {
                id: "users".into(),
                collection: "users".into(),
                path: path.to_str().unwrap().into(),
                format: Some("native".into()),
                prose: None,
            }),
            _ => DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
                id: "users".into(),
                collection: "users".into(),
                root: root.into(),
                format: "native".into(),
                partition_by: PartitionKey::Field {
                    field: "name".into(),
                },
                prose: None,
            }),
        };
        let events = Events::default();
        let runtime = NativeRuntime::open_sources_with_options(
            NativeSourceRuntimeConfig {
                collections: config("").collections,
                sources: vec![source.clone()],
            },
            NativeSourceRuntimeOptions {
                callbacks: registry(Arc::clone(&events)),
                plugin_codecs: vec![codec()],
                watch_debounce: None,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            runtime.find_by_id("users", "old").unwrap().unwrap()["score"],
            7,
            "{mode}"
        );
        runtime
            .mutate(|db| db.create("users", json!({"name":"Bob","score":6})))
            .unwrap();
        assert_eq!(
            runtime
                .query(
                    "users",
                    QueryInput {
                        r#where: Some(json!({"score":{"$multipleOf":3}})),
                        ..Default::default()
                    },
                    None
                )
                .unwrap()[0]["double"],
            12,
            "{mode}"
        );
        assert_eq!(
            *events.lock().unwrap(),
            ["beforeCreate", "afterCreate", "onChange"]
        );
        // A migrated existing file keeps its old bytes until it changes, then
        // writes the target version and must reopen without re-migrating.
        runtime
            .mutate(|db| db.update("users", "old", json!({"score":8})))
            .unwrap();
        runtime.close().unwrap();
        let reopened = NativeRuntime::open_sources_with_options(
            NativeSourceRuntimeConfig {
                collections: config("").collections,
                sources: vec![source],
            },
            NativeSourceRuntimeOptions {
                callbacks: registry(Events::default()),
                plugin_codecs: vec![codec()],
                watch_debounce: None,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            reopened.find_by_id("users", "old").unwrap().unwrap()["score"],
            8,
            "{mode}"
        );
    }
}

#[test]
fn migration_and_codec_errors_never_promote_failed_candidates() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("users.native");
    let path = path.to_str().unwrap();
    let original = "native:{\"users\":{\"_version\":0,\"old\":{\"id\":\"old\",\"name\":\"Alice\",\"score\":0}}}";
    std::fs::write(path, original).unwrap();
    let mut callbacks = registry(Events::default());
    callbacks.register_migration("upgrade", Box::new(|_| Err(error())));
    assert!(NativeRuntime::open_with_options(config(path), options(callbacks)).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), original);
    let mut callbacks = registry(Events::default());
    // Only fail mutation encoding; successful migration encoding remains valid.
    callbacks.register_codec_encode(
        "encode",
        Box::new(|value, _| {
            if value["users"].get("bad").is_some() {
                Err(error())
            } else {
                Ok(format!("native:{value}"))
            }
        }),
    );
    let runtime = NativeRuntime::open_with_options(config(path), options(callbacks)).unwrap();
    runtime.flush().unwrap();
    let before = std::fs::read(path).unwrap();
    assert!(runtime
        .mutate(|db| db.create("users", json!({"id":"bad","name":"Bob","score":1})))
        .is_err());
    assert!(runtime.find_by_id("users", "bad").unwrap().is_none());
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn post_hooks_keep_operation_order_and_global_hooks_run_once_after_batch_commit() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("users.native");
    let events = Events::default();
    let log = Arc::clone(&events);
    let mut callbacks = registry(Arc::clone(&events));
    callbacks.register_after_create_hook(
        "global",
        Box::new(move |_| {
            record_event(&log, "globalAfterCreate");
            Ok(())
        }),
    );
    callbacks.set_global_after_create_hooks(vec!["global".into()]);
    let runtime =
        NativeRuntime::open_with_options(config(path.to_str().unwrap()), options(callbacks))
            .unwrap();
    runtime
        .mutate(|db| {
            db.create_many(
                "users",
                vec![
                    json!({"id":"a","name":"Alice","score":1}),
                    json!({"id":"b","name":"Bob","score":2}),
                ],
            )?;
            // No post-commit hook has run during the mutation.
            assert_eq!(*events.lock().unwrap(), ["beforeCreate", "beforeCreate"]);
            db.update("users", "a", json!({"score":3}))?;
            db.delete("users", "b")?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        *events.lock().unwrap(),
        [
            "beforeCreate",
            "beforeCreate",
            "beforeUpdate",
            "beforeDelete",
            "globalAfterCreate",
            "afterCreate",
            "onChange",
            "globalAfterCreate",
            "afterCreate",
            "onChange",
            "afterUpdate",
            "onChange",
            "afterDelete",
            "onChange"
        ]
    );
}

#[test]
fn a_durable_write_failure_discards_queued_post_hooks() {
    use proseql_storage::fs::{DurabilityFaultInjector, DurabilityFaultPoint, FsStorageHost};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    struct FailWrite(Arc<AtomicBool>);
    impl DurabilityFaultInjector for FailWrite {
        fn check(&self, point: DurabilityFaultPoint) -> Result<(), EngineError> {
            if point == DurabilityFaultPoint::StageWrite && self.0.load(Ordering::SeqCst) {
                Err(error())
            } else {
                Ok(())
            }
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("users.native");
    let path = path.to_str().unwrap();
    let enabled = Arc::new(AtomicBool::new(false));
    let host = Arc::new(
        FsStorageHost::new_polling_with_fault_injector(
            Duration::from_secs(2),
            Arc::new(FailWrite(Arc::clone(&enabled))),
        )
        .unwrap(),
    );
    let events = Events::default();
    let runtime = NativeRuntime::open_with_host_and_options(
        config(path),
        host,
        options(registry(Arc::clone(&events))),
    )
    .unwrap();
    runtime.flush().unwrap();
    let original = std::fs::read(path).unwrap();
    enabled.store(true, Ordering::SeqCst);
    assert!(runtime
        .mutate(|db| db.create("users", json!({"id":"a","name":"Alice","score":1})))
        .is_err());
    assert_eq!(*events.lock().unwrap(), ["beforeCreate"]);
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert!(runtime.find_by_id("users", "a").unwrap().is_none());
}

#[test]
fn lazy_sources_still_refuse_registered_hooks_computed_fields_and_migrations() {
    use proseql_native::LazyPartitionPolicy;
    for kind in ["hook", "computed", "migration", "global"] {
        let mut descriptor = descriptor();
        descriptor.before_create_hooks.clear();
        descriptor.before_update_hooks.clear();
        descriptor.before_delete_hooks.clear();
        descriptor.after_create_hooks.clear();
        descriptor.after_update_hooks.clear();
        descriptor.after_delete_hooks.clear();
        descriptor.on_change_hooks.clear();
        descriptor.append_only = true;
        if kind != "computed" {
            descriptor.computed_fields.clear();
        }
        if kind != "migration" {
            descriptor.migrations.clear();
            descriptor.version = None;
        }
        if kind == "hook" {
            descriptor.after_create_hooks.push("created".into());
        }
        let mut callbacks = registry(Events::default());
        if kind == "global" {
            callbacks.set_global_on_change_hooks(vec!["changed".into()]);
        }
        let error = NativeRuntime::open_sources_with_options(
            NativeSourceRuntimeConfig {
                collections: vec![NativeCollectionConfig::new(descriptor)],
                sources: vec![DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
                    id: "history".into(),
                    collection: "users".into(),
                    root: "/unused-callback-lazy".into(),
                    format: "jsonl".into(),
                    partition_by: PartitionKey::Field {
                        field: "name".into(),
                    },
                    prose: None,
                })],
            },
            NativeSourceRuntimeOptions {
                callbacks,
                lazy_partitions: IndexMap::from([("history".into(), LazyPartitionPolicy::new(1))]),
                watch_debounce: None,
                ..Default::default()
            },
        )
        .err()
        .unwrap();
        assert!(
            error.to_string().contains(if kind == "migration" {
                "Versioned partitions"
            } else {
                "Lazy"
            }),
            "{kind}: {error}"
        );
    }
}
