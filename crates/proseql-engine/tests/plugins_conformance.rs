use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use proseql_engine::{
    callbacks::CallbackRegistry,
    clock::FixedClock,
    collection::Collection,
    descriptor::{CollectionDescriptor, IdStrategy, SchemaNode, StructField, ValidationMode},
    errors::EngineError,
    id_gen::{IdGenerator, SequentialGenerator},
    plugins::{
        build_plugin_registry, finalize_plugins, initialize_plugins, shutdown_plugins,
        validate_collection_id_generators, GlobalHookIds, PluginCodecMetadata, PluginDefinition,
        PluginIdGeneratorMetadata, PluginOperatorMetadata,
    },
    relationships::Database,
};
use serde_json::json;

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
                    schema: SchemaNode::Optional(Box::new(SchemaNode::Num)),
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
        },
        id_strategy: IdStrategy::Provided,
        relationships: vec![],
        indexes: vec![],
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
        append_only: false,
        validation_mode: ValidationMode::Strict,
    }
}

fn seeded_db(registry: Arc<CallbackRegistry>) -> Database {
    let mut collection = Collection::new_with_clock(
        "users",
        descriptor(),
        Arc::clone(&registry),
        Box::new(SequentialGenerator::new("user")),
        Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
    );
    collection
        .create(json!({"id":"u1","name":"Alice","score":7}))
        .unwrap();
    collection
        .create(json!({"id":"u2","name":"Bob","score":2}))
        .unwrap();
    let mut collections = IndexMap::new();
    collections.insert("users".into(), collection);
    Database::new(collections, registry)
}

#[test]
fn plugin_validation_rejects_empty_name() {
    let mut callbacks = CallbackRegistry::new();
    let error = build_plugin_registry(&[PluginDefinition::default()], &mut callbacks).unwrap_err();
    assert!(matches!(
        error,
        proseql_engine::errors::EngineError::Plugin(_)
    ));
}

#[test]
fn plugin_validation_rejects_invalid_codec_metadata() {
    let mut callbacks = CallbackRegistry::new();
    let plugin = PluginDefinition {
        name: "codec".into(),
        codecs: vec![PluginCodecMetadata {
            name: "".into(),
            extensions: vec!["json".into()],
            encode_callback_id: "encode".into(),
            decode_callback_id: "decode".into(),
        }],
        ..PluginDefinition::default()
    };
    let error = build_plugin_registry(&[plugin], &mut callbacks).unwrap_err();
    assert!(matches!(
        error,
        proseql_engine::errors::EngineError::Plugin(_)
    ));
}

#[test]
fn plugin_validation_rejects_invalid_operator_name() {
    let mut callbacks = CallbackRegistry::new();
    let plugin = PluginDefinition {
        name: "ops".into(),
        operators: vec![PluginOperatorMetadata {
            name: "regex".into(),
        }],
        ..PluginDefinition::default()
    };
    let error = build_plugin_registry(&[plugin], &mut callbacks).unwrap_err();
    assert!(matches!(
        error,
        proseql_engine::errors::EngineError::Plugin(_)
    ));
}

#[test]
fn plugin_validation_rejects_invalid_id_generator_metadata() {
    let mut callbacks = CallbackRegistry::new();
    let plugin = PluginDefinition {
        name: "ids".into(),
        id_generators: vec![PluginIdGeneratorMetadata { name: "".into() }],
        ..PluginDefinition::default()
    };
    let error = build_plugin_registry(&[plugin], &mut callbacks).unwrap_err();
    assert!(matches!(
        error,
        proseql_engine::errors::EngineError::Plugin(_)
    ));
}

#[test]
fn plugin_validation_rejects_missing_dependencies() {
    let mut callbacks = CallbackRegistry::new();
    let plugin = PluginDefinition {
        name: "dependent".into(),
        dependencies: vec!["missing".into()],
        ..PluginDefinition::default()
    };
    let error = build_plugin_registry(&[plugin], &mut callbacks).unwrap_err();
    assert!(matches!(
        error,
        proseql_engine::errors::EngineError::Plugin(_)
    ));
}

#[test]
fn plugin_validation_rejects_declared_conflicts() {
    let mut callbacks = CallbackRegistry::new();
    let a = PluginDefinition {
        name: "a".into(),
        conflicts: vec!["b".into()],
        ..PluginDefinition::default()
    };
    let b = PluginDefinition {
        name: "b".into(),
        ..PluginDefinition::default()
    };
    let error = build_plugin_registry(&[a, b], &mut callbacks).unwrap_err();
    assert!(matches!(
        error,
        proseql_engine::errors::EngineError::Plugin(_)
    ));
}

#[test]
fn plugin_validation_rejects_built_in_operator_conflicts() {
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_custom_operator("$eq", vec!["string".into()], Box::new(|_, _| true));
    let plugin = PluginDefinition {
        name: "ops".into(),
        operators: vec![PluginOperatorMetadata { name: "$eq".into() }],
        ..PluginDefinition::default()
    };
    let error = build_plugin_registry(&[plugin], &mut callbacks).unwrap_err();
    assert!(matches!(
        error,
        proseql_engine::errors::EngineError::Plugin(_)
    ));
}

#[test]
fn plugin_validation_rejects_duplicate_operator_names() {
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_custom_operator("$custom", vec!["number".into()], Box::new(|_, _| true));
    let a = PluginDefinition {
        name: "a".into(),
        operators: vec![PluginOperatorMetadata {
            name: "$custom".into(),
        }],
        ..PluginDefinition::default()
    };
    let b = PluginDefinition {
        name: "b".into(),
        operators: vec![PluginOperatorMetadata {
            name: "$custom".into(),
        }],
        ..PluginDefinition::default()
    };
    let error = build_plugin_registry(&[a, b], &mut callbacks).unwrap_err();
    assert!(matches!(
        error,
        proseql_engine::errors::EngineError::Plugin(_)
    ));
}

#[test]
fn plugin_validation_rejects_unregistered_operator_metadata() {
    let mut callbacks = CallbackRegistry::new();
    let plugin = PluginDefinition {
        name: "ops".into(),
        operators: vec![PluginOperatorMetadata {
            name: "$custom".into(),
        }],
        ..PluginDefinition::default()
    };
    let error = build_plugin_registry(&[plugin], &mut callbacks).unwrap_err();
    assert!(matches!(
        error,
        proseql_engine::errors::EngineError::Plugin(_)
    ));
}

#[test]
fn plugin_validation_rejects_unregistered_id_generator_metadata() {
    let mut callbacks = CallbackRegistry::new();
    let plugin = PluginDefinition {
        name: "ids".into(),
        id_generators: vec![PluginIdGeneratorMetadata {
            name: "snowflake".into(),
        }],
        ..PluginDefinition::default()
    };
    let error = build_plugin_registry(&[plugin], &mut callbacks).unwrap_err();
    assert!(matches!(
        error,
        proseql_engine::errors::EngineError::Plugin(_)
    ));
}

#[test]
fn plugin_validation_rejects_missing_global_hook_callbacks() {
    let mut callbacks = CallbackRegistry::new();
    let plugin = PluginDefinition {
        name: "hooks".into(),
        global_hooks: GlobalHookIds {
            before_create: vec!["missing".into()],
            ..GlobalHookIds::default()
        },
        ..PluginDefinition::default()
    };
    let error = build_plugin_registry(&[plugin], &mut callbacks).unwrap_err();
    assert!(matches!(
        error,
        proseql_engine::errors::EngineError::Plugin(_)
    ));
}

#[test]
fn plugin_validation_rejects_missing_lifecycle_callbacks() {
    let mut callbacks = CallbackRegistry::new();
    let plugin = PluginDefinition {
        name: "life".into(),
        initialize_callback_id: Some("missing".into()),
        ..PluginDefinition::default()
    };
    let error = build_plugin_registry(&[plugin], &mut callbacks).unwrap_err();
    assert!(matches!(
        error,
        proseql_engine::errors::EngineError::Plugin(_)
    ));
}

#[test]
fn plugin_registry_sets_global_hook_ids_on_callbacks() {
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_before_create_hook("global", Box::new(|ctx| Ok(ctx.data.clone())));
    let plugin = PluginDefinition {
        name: "hooks".into(),
        global_hooks: GlobalHookIds {
            before_create: vec!["global".into()],
            ..GlobalHookIds::default()
        },
        ..PluginDefinition::default()
    };
    let registry = build_plugin_registry(&[plugin], &mut callbacks).unwrap();
    assert_eq!(registry.global_hooks.before_create, vec!["global"]);
    assert_eq!(
        callbacks.global_before_create_hooks(),
        &["global".to_string()]
    );
}

#[test]
fn initialize_runs_in_registration_order() {
    let trace = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut callbacks = CallbackRegistry::new();
    for (id, label) in [("init-a", "a"), ("init-b", "b")] {
        let trace = Arc::clone(&trace);
        callbacks.register_lifecycle_callback(
            id,
            Box::new(move || {
                trace.lock().unwrap().push(label.to_string());
                Ok(())
            }),
        );
    }
    let registry = build_plugin_registry(
        &[
            PluginDefinition {
                name: "a".into(),
                initialize_callback_id: Some("init-a".into()),
                ..PluginDefinition::default()
            },
            PluginDefinition {
                name: "b".into(),
                initialize_callback_id: Some("init-b".into()),
                ..PluginDefinition::default()
            },
        ],
        &mut callbacks,
    )
    .unwrap();
    initialize_plugins(&registry, &callbacks).unwrap();
    assert_eq!(trace.lock().unwrap().clone(), vec!["a", "b"]);
}

#[test]
fn shutdown_runs_in_reverse_order_and_swallows_errors() {
    let trace = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut callbacks = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        callbacks.register_lifecycle_callback(
            "down-a",
            Box::new(move || {
                trace.lock().unwrap().push("a".into());
                Ok(())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        callbacks.register_lifecycle_callback(
            "down-b",
            Box::new(move || {
                trace.lock().unwrap().push("b".into());
                Err(proseql_engine::errors::EngineError::Operation(
                    proseql_engine::errors::OperationError {
                        operation: "shutdown".into(),
                        reason: "fail".into(),
                        message: "fail".into(),
                    },
                ))
            }),
        );
    }
    let registry = build_plugin_registry(
        &[
            PluginDefinition {
                name: "a".into(),
                shutdown_callback_id: Some("down-a".into()),
                ..PluginDefinition::default()
            },
            PluginDefinition {
                name: "b".into(),
                shutdown_callback_id: Some("down-b".into()),
                ..PluginDefinition::default()
            },
        ],
        &mut callbacks,
    )
    .unwrap();
    shutdown_plugins(&registry, &callbacks);
    assert_eq!(trace.lock().unwrap().clone(), vec!["b", "a"]);
}

#[test]
fn validate_collection_id_generators_uses_plugin_registry_names() {
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_id_generator(
        "snowflake",
        Box::new(|| Box::new(SequentialGenerator::new("snow")) as Box<dyn IdGenerator>),
    );
    let registry = build_plugin_registry(
        &[PluginDefinition {
            name: "ids".into(),
            id_generators: vec![PluginIdGeneratorMetadata {
                name: "snowflake".into(),
            }],
            ..PluginDefinition::default()
        }],
        &mut callbacks,
    )
    .unwrap();
    let mut collection = descriptor();
    collection.id_generator = Some("snowflake".into());
    validate_collection_id_generators(&[collection], &registry).unwrap();
}

#[test]
fn validate_collection_id_generators_rejects_unknown_names() {
    let mut callbacks = CallbackRegistry::new();
    let registry = build_plugin_registry(&[], &mut callbacks).unwrap();
    let mut collection = descriptor();
    collection.id_generator = Some("missing".into());
    assert!(validate_collection_id_generators(&[collection], &registry).is_err());
}

#[test]
fn custom_operators_participate_in_query_pipeline() {
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_custom_operator(
        "$multipleOf",
        vec!["number".into()],
        Box::new(|value, operand| {
            let Some(number) = value.as_i64() else {
                return false;
            };
            let Some(divisor) = operand.as_i64() else {
                return false;
            };
            number % divisor == 0
        }),
    );
    let _ = build_plugin_registry(
        &[PluginDefinition {
            name: "ops".into(),
            operators: vec![PluginOperatorMetadata {
                name: "$multipleOf".into(),
            }],
            ..PluginDefinition::default()
        }],
        &mut callbacks,
    )
    .unwrap();
    let registry = Arc::new(callbacks);
    let db = seeded_db(registry);
    let results = db
        .query(
            "users",
            proseql_engine::query::QueryInput {
                r#where: Some(json!({"score": {"$multipleOf": 7}})),
                ..Default::default()
            },
            None,
        )
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["id"], json!("u1"));
}

#[test]
fn named_id_generator_is_selected_and_preserves_explicit_ids() {
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_id_generator(
        "snowflake",
        Box::new(|| Box::new(SequentialGenerator::new("snow")) as Box<dyn IdGenerator>),
    );
    let mut descriptor = descriptor();
    descriptor.id_strategy = IdStrategy::NamedGenerator {
        name: "snowflake".into(),
    };
    let registry = Arc::new(callbacks);
    let mut collection = Collection::new_with_clock(
        "users",
        descriptor.clone(),
        Arc::clone(&registry),
        Box::new(SequentialGenerator::new("fallback")),
        Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
    );
    let created = collection.create(json!({"name":"Alice"})).unwrap();
    assert_eq!(created["id"], json!("snow-1"));
    let explicit = collection
        .create(json!({"id":"manual","name":"Bob"}))
        .unwrap();
    assert_eq!(explicit["id"], json!("manual"));

    let mut collection_many = Collection::new_with_clock(
        "users",
        descriptor,
        Arc::clone(&registry),
        Box::new(SequentialGenerator::new("fallback")),
        Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
    );
    let result = collection_many
        .create_many(
            vec![json!({"name":"A"}), json!({"id":"fixed","name":"B"})],
            false,
        )
        .unwrap();
    assert_eq!(result.created[0]["id"], json!("snow-1"));
    assert_eq!(result.created[1]["id"], json!("fixed"));
}

#[test]
fn missing_named_id_generator_fails_loudly_in_create_and_create_many() {
    let registry = Arc::new(CallbackRegistry::new());
    let mut descriptor = descriptor();
    descriptor.id_strategy = IdStrategy::NamedGenerator {
        name: "missing".into(),
    };
    let mut collection = Collection::new_with_clock(
        "users",
        descriptor.clone(),
        Arc::clone(&registry),
        Box::new(SequentialGenerator::new("fallback")),
        Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
    );
    assert!(matches!(
        collection.create(json!({"name":"Alice"})),
        Err(EngineError::Operation(_))
    ));
    assert!(matches!(
        collection.create_many(vec![json!({"name":"Alice"})], false),
        Err(EngineError::Operation(_))
    ));
}

#[test]
fn finalize_flushes_before_reverse_shutdown_and_swallows_errors() {
    let trace = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut callbacks = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        callbacks.register_lifecycle_callback(
            "down-a",
            Box::new(move || {
                trace.lock().unwrap().push("shutdown-a".into());
                Ok(())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        callbacks.register_lifecycle_callback(
            "down-b",
            Box::new(move || {
                trace.lock().unwrap().push("shutdown-b".into());
                Err(EngineError::Operation(
                    proseql_engine::errors::OperationError {
                        operation: "shutdown".into(),
                        reason: "fail".into(),
                        message: "fail".into(),
                    },
                ))
            }),
        );
    }
    let registry = build_plugin_registry(
        &[
            PluginDefinition {
                name: "a".into(),
                shutdown_callback_id: Some("down-a".into()),
                ..PluginDefinition::default()
            },
            PluginDefinition {
                name: "b".into(),
                shutdown_callback_id: Some("down-b".into()),
                ..PluginDefinition::default()
            },
        ],
        &mut callbacks,
    )
    .unwrap();

    let error = finalize_plugins(&registry, &callbacks, || {
        trace.lock().unwrap().push("flush".into());
        Err(EngineError::Operation(
            proseql_engine::errors::OperationError {
                operation: "flush".into(),
                reason: "fail".into(),
                message: "fail".into(),
            },
        ))
    })
    .unwrap_err();

    assert!(matches!(error, EngineError::Operation(_)));
    assert_eq!(
        trace.lock().unwrap().clone(),
        vec!["flush", "shutdown-b", "shutdown-a"]
    );
}

#[test]
fn unknown_and_type_incompatible_custom_operators_are_silently_ignored() {
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_custom_operator(
        "$multipleOf",
        vec!["number".into()],
        Box::new(|value, operand| value.as_i64().unwrap() % operand.as_i64().unwrap() == 0),
    );
    let _ = build_plugin_registry(
        &[PluginDefinition {
            name: "ops".into(),
            operators: vec![PluginOperatorMetadata {
                name: "$multipleOf".into(),
            }],
            ..PluginDefinition::default()
        }],
        &mut callbacks,
    )
    .unwrap();
    let registry = Arc::new(callbacks);
    let db = seeded_db(registry);
    let ignored_only = db
        .query(
            "users",
            proseql_engine::query::QueryInput {
                r#where: Some(json!({"name": {"$multipleOf": 3, "$unknown": 1}})),
                ..Default::default()
            },
            None,
        )
        .unwrap();
    assert_eq!(ignored_only.len(), 2);
}
