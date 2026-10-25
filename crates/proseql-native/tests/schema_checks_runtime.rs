use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use indexmap::IndexMap;
use proseql_engine::descriptor::{
    CollectionDescriptor, IdStrategy, SchemaCheck, SchemaNode, StructField, ValidationMode,
};
use proseql_engine::errors::EngineError;
use proseql_native::{
    CallbackRegistry, LazyPartitionPolicy, NativeCollectionConfig, NativeRuntime,
    NativeRuntimeConfig, NativeRuntimeOptions, NativeSourceRuntimeConfig,
    NativeSourceRuntimeOptions,
};
use proseql_storage::source_config::{
    CollectionFileSourceConfig, DatabaseSourceConfig, DocumentGraphFragmentErrorPolicy,
    DocumentGraphRootConfig, DocumentGraphSourceConfig, DocumentSourceConfig, PartitionKey,
    PartitionedSourceConfig, SourceCollectionSelection, UnknownCollectionPolicy,
};
use serde_json::json;

fn descriptor() -> CollectionDescriptor {
    CollectionDescriptor {
        name: "items".into(),
        schema: SchemaNode::Struct {
            fields: vec![
                StructField {
                    name: "id".into(),
                    schema: SchemaNode::Str,
                },
                StructField {
                    name: "name".into(),
                    schema: SchemaNode::Checked {
                        inner: Box::new(SchemaNode::Str),
                        checks: vec![SchemaCheck::new(
                            "custom/allowed-name",
                            json!(null),
                            "an allowed name",
                            Some("allowed-name".into()),
                        )],
                    },
                },
            ],
        },
        id_strategy: IdStrategy::Provided,
        relationships: vec![],
        indexes: vec![],
        ordered_indexes: vec![],
        unique_fields: vec![],
        before_create_hooks: vec![],
        before_update_hooks: vec![],
        before_delete_hooks: vec![],
        after_create_hooks: vec![],
        after_update_hooks: vec![],
        after_delete_hooks: vec![],
        on_change_hooks: vec![],
        computed_fields: vec![],
        search_index: vec![],
        id_generator: None,
        version: None,
        migrations: vec![],
        append_only: false,
        duplicate_ids: Default::default(),
        validation_mode: ValidationMode::Strict,
    }
}

fn scores_field(value: SchemaNode) -> StructField {
    StructField {
        name: "scores".into(),
        schema: SchemaNode::Record {
            key: Box::new(SchemaNode::Checked {
                inner: Box::new(SchemaNode::Str),
                checks: vec![SchemaCheck::new(
                    "custom/safe-key",
                    json!(null),
                    "a safe key",
                    Some("safe-key".into()),
                )],
            }),
            value: Box::new(value),
        },
    }
}

fn callbacks(calls: &Arc<AtomicUsize>) -> CallbackRegistry {
    let mut callbacks = CallbackRegistry::new();
    let calls = Arc::clone(calls);
    callbacks.register_predicate(
        "allowed-name",
        Box::new(move |value| {
            calls.fetch_add(1, Ordering::SeqCst);
            value == "allowed"
        }),
    );
    callbacks
}

fn single_config(path: &str) -> NativeRuntimeConfig {
    NativeRuntimeConfig {
        path: path.into(),
        collections: vec![NativeCollectionConfig::new(descriptor())],
    }
}

fn assert_predicate_rejection(error: &EngineError) {
    assert_eq!(error.tag(), "ValidationError", "{error}");
    assert!(error.to_string().contains("an allowed name"), "{error}");
    assert!(!error.to_string().contains("not registered"), "{error}");
}

#[test]
fn empty_native_open_refuses_a_missing_schema_predicate() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db.json");
    let result = NativeRuntime::open(single_config(path.to_str().unwrap()));
    let error = result
        .err()
        .expect("missing predicate must fail before loading records");
    assert!(error.to_string().contains("allowed-name"), "{error}");
    assert!(error.to_string().contains("items"), "{error}");
    assert!(!path.exists());
}

#[test]
fn registered_predicate_rejects_create_without_changing_memory_or_disk() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db.json");
    let calls = Arc::new(AtomicUsize::new(0));
    let runtime = NativeRuntime::open_with_options(
        single_config(path.to_str().unwrap()),
        NativeRuntimeOptions {
            callbacks: callbacks(&calls),
            ..Default::default()
        },
    )
    .unwrap();
    runtime
        .mutate(|db| db.create("items", json!({"id":"one","name":"allowed"})))
        .unwrap();
    let before = std::fs::read(&path).unwrap();
    let error = runtime
        .mutate(|db| db.create("items", json!({"id":"bad","name":"blocked"})))
        .unwrap_err();
    assert_predicate_rejection(&error);
    assert!(runtime.find_by_id("items", "bad").unwrap().is_none());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(calls.load(Ordering::SeqCst) >= 2);
}

#[test]
fn single_file_open_and_reload_apply_the_registered_predicate_and_keep_last_known_good() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db.json");
    let valid = json!({"items":{"one":{"id":"one","name":"allowed"}}}).to_string();
    let invalid = json!({"items":{"one":{"id":"one","name":"blocked"}}}).to_string();
    std::fs::write(&path, &valid).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let runtime = NativeRuntime::open_with_options(
        single_config(path.to_str().unwrap()),
        NativeRuntimeOptions {
            callbacks: callbacks(&calls),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(calls.load(Ordering::SeqCst) > 0);
    let watch = runtime.watch("items", Default::default()).unwrap();
    assert_eq!(watch.recv().unwrap()[0]["name"], "allowed");
    std::fs::write(&path, &invalid).unwrap();
    let error = runtime.reload().unwrap_err();
    assert_predicate_rejection(&error);
    assert_eq!(
        runtime.find_by_id("items", "one").unwrap().unwrap()["name"],
        "allowed"
    );
    assert_predicate_rejection(&runtime.last_reload_error().unwrap().unwrap());
    assert!(watch.try_recv().is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), invalid);
    assert!(NativeRuntime::open_with_options(
        single_config(path.to_str().unwrap()),
        NativeRuntimeOptions {
            callbacks: callbacks(&calls),
            ..Default::default()
        }
    )
    .is_err());
    std::fs::write(&path, valid).unwrap();
    runtime.reload().unwrap();
    assert!(runtime.last_reload_error().unwrap().is_none());
}

#[test]
fn source_and_lazy_reload_validate_host_checks_before_replacing_last_known_good() {
    for mode in [
        "documents",
        "graph",
        "file",
        "partitioned",
        "lazy",
        "lazy-resident-zero",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_str().unwrap();
        let file = if mode == "documents" || mode == "graph" {
            "allowed.yaml"
        } else if mode.starts_with("lazy") {
            "allowed.jsonl"
        } else {
            "allowed.json"
        };
        let path = temp.path().join(file);
        let content = |name: &str, score: &str| {
            // Rejected keys must be dropped before their values are decoded.
            let record = json!({"id":"allowed.one","name":name,"scores":{"unsafe":{"invalid":"number"},"ok":score}});
            let records = json!({"allowed.one":record});
            match mode {
                "documents" | "graph" => json!({"items":records}).to_string(),
                "lazy" | "lazy-resident-zero" => format!("{record}\n"),
                _ => records.to_string(),
            }
        };
        let source = match mode {
            "documents" => DatabaseSourceConfig::Documents(DocumentSourceConfig {
                id: "source".into(),
                root: root.into(),
                include: Some(vec!["*.yaml".into()]),
                exclude: vec![],
                format: Some("yaml".into()),
                collections: Some(SourceCollectionSelection::Named(vec!["items".into()])),
                unknown_collections: UnknownCollectionPolicy::Error,
                outbox: "generated.yaml".into(),
                optional: false,
            }),
            "graph" => DatabaseSourceConfig::DocumentGraph(DocumentGraphSourceConfig {
                id: "source".into(),
                roots: vec![DocumentGraphRootConfig {
                    id: None,
                    root: root.into(),
                    optional: false,
                    include: Some(vec!["*.yaml".into()]),
                    exclude: vec![],
                    collections: Some(SourceCollectionSelection::Named(vec!["items".into()])),
                }],
                collections: Some(SourceCollectionSelection::Named(vec!["items".into()])),
                include: None,
                exclude: vec![],
                transform_callback_id: None,
                on_fragment_error: DocumentGraphFragmentErrorPolicy::Error,
            }),
            "file" => DatabaseSourceConfig::CollectionFile(CollectionFileSourceConfig {
                id: "source".into(),
                collection: "items".into(),
                path: path.to_str().unwrap().into(),
                format: Some("json".into()),
                prose: None,
            }),
            _ => DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
                id: "source".into(),
                collection: "items".into(),
                root: root.into(),
                format: if mode.starts_with("lazy") {
                    "jsonl"
                } else {
                    "json"
                }
                .into(),
                partition_by: PartitionKey::Prefix {
                    field: "id".into(),
                    delimiter: ".".into(),
                },
                prose: None,
            }),
        };
        let mut descriptor = descriptor();
        descriptor.append_only = mode.starts_with("lazy");
        if let SchemaNode::Struct { fields } = &mut descriptor.schema {
            fields.push(scores_field(SchemaNode::NumFromStr));
        }
        let config = NativeSourceRuntimeConfig {
            collections: vec![NativeCollectionConfig::new(descriptor)],
            sources: vec![source],
        };
        std::fs::write(&path, content("allowed", "2")).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut callbacks = callbacks(&calls);
        callbacks.register_predicate("safe-key", Box::new(|value| value == "ok"));
        let runtime = NativeRuntime::open_sources_with_options(
            config,
            NativeSourceRuntimeOptions {
                callbacks,
                watch_debounce: None,
                execution_model: if mode == "lazy-resident-zero" {
                    proseql_native::ExecutionModel::Resident
                } else {
                    proseql_native::ExecutionModel::Streaming
                },
                lazy_partitions: if mode.starts_with("lazy") {
                    IndexMap::from([(
                        "source".into(),
                        LazyPartitionPolicy::new(if mode == "lazy-resident-zero" { 0 } else { 1 }),
                    )])
                } else {
                    IndexMap::new()
                },
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            runtime.find_by_id("items", "allowed.one").unwrap().unwrap()["name"],
            "allowed",
            "{mode}"
        );
        assert_eq!(
            runtime.find_by_id("items", "allowed.one").unwrap().unwrap()["scores"],
            json!({"ok":2}),
            "{mode}"
        );
        assert!(calls.load(Ordering::SeqCst) > 0, "{mode}");
        std::fs::write(&path, content("blocked", "3")).unwrap();
        if mode.starts_with("lazy") {
            // No watch owns a last-known-good result. Reload lists the files;
            // every read of the invalid generation must fail, never return it.
            runtime.reload().unwrap();
            assert_predicate_rejection(&runtime.find_by_id("items", "allowed.one").unwrap_err());
            assert_predicate_rejection(
                &runtime
                    .query("items", Default::default(), None)
                    .unwrap_err(),
            );
            assert_predicate_rejection(
                &runtime
                    .aggregate(
                        "items",
                        None,
                        &proseql_engine::query::AggregateConfig::count(),
                    )
                    .unwrap_err(),
            );
            assert!(runtime.last_reload_error().unwrap().is_none());
        } else {
            let error = runtime.reload().unwrap_err();
            assert_predicate_rejection(&error);
            assert_eq!(
                runtime.find_by_id("items", "allowed.one").unwrap().unwrap()["name"],
                "allowed",
                "{mode}"
            );
            assert!(runtime.last_reload_error().unwrap().is_some(), "{mode}");
        }
        std::fs::write(&path, content("allowed", "4")).unwrap();
        runtime.reload().unwrap();
        assert_eq!(
            runtime.find_by_id("items", "allowed.one").unwrap().unwrap()["scores"],
            json!({"ok":4}),
            "{mode}"
        );
        assert!(runtime.last_reload_error().unwrap().is_none(), "{mode}");
    }
}

#[test]
fn nested_host_checks_receive_decoded_values_and_keep_builtin_checks() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db.json");
    let mut config = single_config(path.to_str().unwrap());
    config.collections[0].descriptor.schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "values".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Array {
                    item: Box::new(SchemaNode::Record {
                        key: Box::new(SchemaNode::Str),
                        value: Box::new(SchemaNode::Checked {
                            inner: Box::new(SchemaNode::NumFromStr),
                            checks: vec![
                                SchemaCheck::new(
                                    "effect/schema/isGreaterThan",
                                    json!({"exclusiveMinimum":0}),
                                    "a positive number",
                                    None,
                                ),
                                SchemaCheck::new(
                                    "custom/eight",
                                    json!(null),
                                    "the number eight",
                                    Some("eight".into()),
                                ),
                            ],
                        }),
                    }),
                })),
            },
        ],
    };
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_predicate("eight", Box::new(|value| value.as_i64() == Some(8)));
    std::fs::write(
        &path,
        json!({"items":{"one":{"id":"one","values":[{"score":"8"}]}}}).to_string(),
    )
    .unwrap();
    let runtime = NativeRuntime::open_with_options(
        config,
        NativeRuntimeOptions {
            callbacks,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        runtime.find_by_id("items", "one").unwrap().unwrap()["values"][0]["score"],
        8
    );
    for (value, message) in [("3", "the number eight"), ("-8", "a positive number")] {
        std::fs::write(
            &path,
            json!({"items":{"one":{"id":"one","values":[{"score":value}]}}}).to_string(),
        )
        .unwrap();
        let error = runtime.reload().unwrap_err();
        assert_eq!(error.tag(), "ValidationError");
        assert!(error.to_string().contains(message), "{error}");
        assert_eq!(
            runtime.find_by_id("items", "one").unwrap().unwrap()["values"][0]["score"],
            8
        );
    }
}

#[test]
fn record_key_host_predicate_drops_invalid_keys_on_create_update_and_reload() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db.json");
    let mut config = single_config(path.to_str().unwrap());
    config.collections[0].descriptor.schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            scores_field(SchemaNode::Num),
        ],
    };
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_predicate("safe-key", Box::new(|value| value == "ok"));
    let runtime = NativeRuntime::open_with_options(
        config.clone(),
        NativeRuntimeOptions {
            callbacks,
            ..Default::default()
        },
    )
    .unwrap();
    let created = runtime
        .mutate(|db| db.create("items", json!({"id":"one","scores":{"unsafe":1,"ok":2}})))
        .unwrap();
    assert_eq!(created["scores"], json!({"ok":2}));
    assert_eq!(
        runtime.find_by_id("items", "one").unwrap().unwrap()["scores"],
        json!({"ok":2})
    );
    let updated = runtime
        .mutate(|db| db.update("items", "one", json!({"scores":{"unsafe":2,"ok":3}})))
        .unwrap();
    assert_eq!(updated["scores"], json!({"ok":3}));
    assert_eq!(
        runtime.find_by_id("items", "one").unwrap().unwrap()["scores"],
        json!({"ok":3})
    );
    std::fs::write(
        &path,
        json!({"items":{"one":{"id":"one","scores":{"unsafe":3,"ok":4}}}}).to_string(),
    )
    .unwrap();
    runtime.reload().unwrap();
    assert_eq!(
        runtime.find_by_id("items", "one").unwrap().unwrap()["scores"],
        json!({"ok":4})
    );
    assert!(runtime.last_reload_error().unwrap().is_none());
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_predicate("safe-key", Box::new(|value| value == "ok"));
    let reopened = NativeRuntime::open_with_options(
        config,
        NativeRuntimeOptions {
            callbacks,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        reopened.find_by_id("items", "one").unwrap().unwrap()["scores"],
        json!({"ok":4})
    );
}

#[test]
fn derived_ids_and_number_from_string_survive_host_key_filtering_and_bulk_loads() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db.json");
    let mut config = single_config(path.to_str().unwrap());
    config.collections[0].descriptor.id_strategy = IdStrategy::DerivedFromKey;
    config.collections[0].descriptor.schema = SchemaNode::Struct {
        fields: vec![scores_field(SchemaNode::NumFromStr)],
    };
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_predicate("safe-key", Box::new(|value| value == "ok"));
    std::fs::write(
        &path,
        json!({"items":{"one":{"scores":{"unsafe":{},"ok":"2"}}}}).to_string(),
    )
    .unwrap();
    let runtime = NativeRuntime::open_with_options(
        config,
        NativeRuntimeOptions {
            callbacks,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        runtime.find_by_id("items", "one").unwrap().unwrap(),
        json!({"id":"one","scores":{"ok":2}})
    );
    std::fs::write(
        &path,
        json!({"items":{"one":{"scores":{"unsafe":{},"ok":"4"}}}}).to_string(),
    )
    .unwrap();
    runtime.reload().unwrap();
    assert_eq!(
        runtime.find_by_id("items", "one").unwrap().unwrap(),
        json!({"id":"one","scores":{"ok":4}})
    );
    runtime
        .replace_all(IndexMap::from([(
            "items".into(),
            IndexMap::from([(
                "one".into(),
                json!({"id":"one","scores":{"unsafe":12,"ok":6}}),
            )]),
        )]))
        .unwrap();
    assert_eq!(
        runtime.find_by_id("items", "one").unwrap().unwrap(),
        json!({"id":"one","scores":{"ok":6}})
    );
}
