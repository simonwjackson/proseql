use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use proseql_engine::{
    callbacks::CallbackRegistry,
    clock::FixedClock,
    collection::Collection,
    descriptor::{
        CollectionDescriptor, IdStrategy, IndexDescriptor, RelationshipDescriptor,
        RelationshipKind, SchemaNode, StructField, ValidationMode,
    },
    errors::{EngineError, HookError, HookOperation},
    id_gen::SequentialGenerator,
    plugins::{build_plugin_registry, GlobalHookIds, PluginDefinition},
    relationships::Database,
};
use serde_json::{json, Value};

fn schema() -> SchemaNode {
    SchemaNode::Struct {
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
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "deletedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::NullOr(Box::new(
                    SchemaNode::Str,
                )))),
            },
        ],
    }
}

fn descriptor() -> CollectionDescriptor {
    CollectionDescriptor {
        name: "users".into(),
        schema: schema(),
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

fn hookless_descriptor(mut descriptor: CollectionDescriptor) -> CollectionDescriptor {
    descriptor.before_create_hooks.clear();
    descriptor.after_create_hooks.clear();
    descriptor.before_update_hooks.clear();
    descriptor.after_update_hooks.clear();
    descriptor.before_delete_hooks.clear();
    descriptor.after_delete_hooks.clear();
    descriptor.on_change_hooks.clear();
    descriptor
}

fn make_collection(
    registry: Arc<CallbackRegistry>,
    descriptor: CollectionDescriptor,
    seed: Vec<Value>,
) -> Collection {
    let hookful_descriptor = descriptor;
    let mut collection = Collection::new_with_clock(
        "users",
        hookless_descriptor(hookful_descriptor.clone()),
        Arc::clone(&registry),
        Box::new(SequentialGenerator::new("user")),
        Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
    );
    for value in seed {
        collection.create(value).unwrap();
    }
    collection.descriptor = hookful_descriptor;
    collection
}

fn make_db(
    registry: Arc<CallbackRegistry>,
    descriptor: CollectionDescriptor,
    seed: Vec<Value>,
) -> Database {
    let collection = make_collection(Arc::clone(&registry), descriptor, seed);
    let mut collections = IndexMap::new();
    collections.insert("users".into(), collection);
    Database::new(collections, registry)
}

fn company_schema() -> SchemaNode {
    SchemaNode::Struct {
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
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    }
}

fn users_with_company_descriptor() -> CollectionDescriptor {
    let mut descriptor = descriptor();
    descriptor.relationships = vec![(
        "company".into(),
        RelationshipDescriptor {
            kind: RelationshipKind::Ref,
            target: "companies".into(),
            foreign_key: Some("companyId".into()),
        },
    )];
    descriptor.schema = SchemaNode::Struct {
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
                name: "companyId".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::NullOr(Box::new(
                    SchemaNode::Str,
                )))),
            },
            StructField {
                name: "createdAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "updatedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "deletedAt".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::NullOr(Box::new(
                    SchemaNode::Str,
                )))),
            },
        ],
    };
    descriptor
}

fn make_company_db(
    registry: Arc<CallbackRegistry>,
    users_descriptor: CollectionDescriptor,
    users_seed: Vec<Value>,
) -> Database {
    let users = make_collection(Arc::clone(&registry), users_descriptor, users_seed);
    let mut companies = Collection::new_with_clock(
        "companies",
        CollectionDescriptor {
            name: "companies".into(),
            schema: company_schema(),
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
        },
        Arc::clone(&registry),
        Box::new(SequentialGenerator::new("company")),
        Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
    );
    companies.create(json!({"id":"c1","name":"Acme"})).unwrap();
    let mut collections = IndexMap::new();
    collections.insert("users".into(), users);
    collections.insert("companies".into(), companies);
    Database::new(collections, registry)
}

fn trace() -> Arc<Mutex<Vec<String>>> {
    Arc::new(Mutex::new(Vec::new()))
}

fn read_trace(trace: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    trace.lock().unwrap().clone()
}

#[test]
fn before_create_transforms_inserted_entity() {
    let mut registry = CallbackRegistry::new();
    registry.register_before_create_hook(
        "before-create",
        Box::new(|ctx| {
            let mut obj = ctx.data.as_object().cloned().unwrap();
            obj.insert(
                "name".into(),
                json!(ctx.data["name"].as_str().unwrap().to_ascii_lowercase()),
            );
            Ok(Value::Object(obj))
        }),
    );
    let mut descriptor = descriptor();
    descriptor.before_create_hooks = vec!["before-create".into()];
    let registry = Arc::new(registry);
    let mut db = make_db(registry, descriptor, vec![]);
    let created = db
        .create("users", json!({"id":"u1","name":"ALICE"}))
        .unwrap();
    assert_eq!(created["name"], json!("alice"));
}

#[test]
fn before_create_rejection_returns_hook_error_and_preserves_state() {
    let mut registry = CallbackRegistry::new();
    registry.register_before_create_hook(
        "reject-create",
        Box::new(|ctx| {
            Err(EngineError::Hook(HookError {
                hook: "beforeCreate".into(),
                collection: ctx.collection.clone(),
                operation: HookOperation::Create,
                reason: "nope".into(),
                message: "nope".into(),
            }))
        }),
    );
    let mut descriptor = descriptor();
    descriptor.before_create_hooks = vec!["reject-create".into()];
    let registry = Arc::new(registry);
    let mut db = make_db(Arc::clone(&registry), descriptor, vec![]);
    let error = db
        .create("users", json!({"id":"u1","name":"Alice"}))
        .unwrap_err();
    assert!(matches!(error, EngineError::Hook(_)));
    assert!(db.collection("users").unwrap().get("u1").is_none());
}

#[test]
fn create_fk_failure_after_before_create_id_rewrite_restores_storage_key_by_delta() {
    let mut registry = CallbackRegistry::new();
    registry.register_before_create_hook(
        "rewrite-id",
        Box::new(|ctx| {
            let mut obj = ctx.data.as_object().cloned().unwrap();
            obj.insert("id".into(), json!("hooked-id"));
            Ok(Value::Object(obj))
        }),
    );
    let mut users_descriptor = users_with_company_descriptor();
    users_descriptor.before_create_hooks = vec!["rewrite-id".into()];
    users_descriptor.indexes = vec![IndexDescriptor::Single("companyId".into())];
    users_descriptor.search_index = vec!["name".into()];
    let registry = Arc::new(registry);
    let mut db = make_company_db(Arc::clone(&registry), users_descriptor, vec![]);

    let error = db
        .create(
            "users",
            json!({"id":"u1","name":"Alice","companyId":"missing"}),
        )
        .unwrap_err();

    assert!(matches!(error, EngineError::ForeignKey(_)));
    let users = db.collection("users").unwrap();
    assert_eq!(users.len(), 0);
    assert!(users.get("u1").is_none());
    assert!(users.get("hooked-id").is_none());
    assert!(users
        .narrow_candidates(&json!({"companyId":"missing"}))
        .unwrap_or_default()
        .is_empty());
    assert!(users
        .narrow_candidates(&json!({"$search":{"query":"alice","fields":["name"]}}))
        .unwrap_or_default()
        .is_empty());
}

#[test]
fn before_update_transforms_update_payload() {
    let mut registry = CallbackRegistry::new();
    registry.register_before_update_hook(
        "before-update",
        Box::new(|ctx| {
            let mut obj = ctx.update.as_object().cloned().unwrap();
            obj.insert("name".into(), json!("Updated"));
            Ok(Value::Object(obj))
        }),
    );
    let mut descriptor = descriptor();
    descriptor.before_update_hooks = vec!["before-update".into()];
    let registry = Arc::new(registry);
    let mut db = make_db(
        registry,
        descriptor,
        vec![json!({"id":"u1","name":"Alice"})],
    );
    let updated = db.update("users", "u1", json!({"name":"Ignored"})).unwrap();
    assert_eq!(updated["name"], json!("Updated"));
}

#[test]
fn before_update_rejection_preserves_existing_entity() {
    let mut registry = CallbackRegistry::new();
    registry.register_before_update_hook(
        "reject-update",
        Box::new(|ctx| {
            Err(EngineError::Hook(HookError {
                hook: "beforeUpdate".into(),
                collection: ctx.collection.clone(),
                operation: HookOperation::Update,
                reason: "stop".into(),
                message: "stop".into(),
            }))
        }),
    );
    let mut descriptor = descriptor();
    descriptor.before_update_hooks = vec!["reject-update".into()];
    let registry = Arc::new(registry);
    let mut db = make_db(
        registry,
        descriptor,
        vec![json!({"id":"u1","name":"Alice"})],
    );
    let error = db.update("users", "u1", json!({"name":"Bob"})).unwrap_err();
    assert!(matches!(error, EngineError::Hook(_)));
    assert_eq!(
        db.collection("users").unwrap().get("u1").unwrap()["name"],
        json!("Alice")
    );
}

#[test]
fn before_delete_rejection_preserves_entity() {
    let mut registry = CallbackRegistry::new();
    registry.register_before_delete_hook(
        "reject-delete",
        Box::new(|ctx| {
            Err(EngineError::Hook(HookError {
                hook: "beforeDelete".into(),
                collection: ctx.collection.clone(),
                operation: HookOperation::Delete,
                reason: "stop".into(),
                message: "stop".into(),
            }))
        }),
    );
    let mut descriptor = descriptor();
    descriptor.before_delete_hooks = vec!["reject-delete".into()];
    let registry = Arc::new(registry);
    let mut db = make_db(
        registry,
        descriptor,
        vec![json!({"id":"u1","name":"Alice"})],
    );
    let error = db.delete("users", "u1").unwrap_err();
    assert!(matches!(error, EngineError::Hook(_)));
    assert!(db.collection("users").unwrap().get("u1").is_some());
}

#[test]
fn direct_collection_create_runs_after_create_then_on_change() {
    let trace = trace();
    let mut registry = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        registry.register_after_create_hook(
            "after-create",
            Box::new(move |_| {
                trace.lock().unwrap().push("after-create".into());
                Ok(())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        registry.register_on_change_hook(
            "on-change",
            Box::new(move |ctx| {
                let tag = match ctx {
                    proseql_engine::hooks::OnChangeContext::Create { .. } => "on-change:create",
                    _ => "unexpected",
                };
                trace.lock().unwrap().push(tag.into());
                Ok(())
            }),
        );
    }
    let mut descriptor = descriptor();
    descriptor.after_create_hooks = vec!["after-create".into()];
    descriptor.on_change_hooks = vec!["on-change".into()];
    let registry = Arc::new(registry);
    let mut collection = make_collection(registry, descriptor, vec![]);

    collection
        .create(json!({"id":"u1","name":"Alice"}))
        .unwrap();

    assert_eq!(read_trace(&trace), vec!["after-create", "on-change:create"]);
}

#[test]
fn direct_collection_delete_variants_run_after_delete_then_on_change() {
    let trace = trace();
    let mut registry = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        registry.register_after_delete_hook(
            "after-delete",
            Box::new(move |_| {
                trace.lock().unwrap().push("after-delete".into());
                Ok(())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        registry.register_on_change_hook(
            "on-change",
            Box::new(move |ctx| {
                let tag = match ctx {
                    proseql_engine::hooks::OnChangeContext::Delete { .. } => "on-change:delete",
                    _ => "unexpected",
                };
                trace.lock().unwrap().push(tag.into());
                Ok(())
            }),
        );
    }
    let mut descriptor = descriptor();
    descriptor.after_delete_hooks = vec!["after-delete".into()];
    descriptor.on_change_hooks = vec!["on-change".into()];
    let registry = Arc::new(registry);

    let mut hard = make_collection(
        Arc::clone(&registry),
        descriptor.clone(),
        vec![json!({"id":"u1","name":"Alice"})],
    );
    hard.delete("u1").unwrap();
    assert_eq!(read_trace(&trace), vec!["after-delete", "on-change:delete"]);

    trace.lock().unwrap().clear();
    let mut soft = make_collection(registry, descriptor, vec![json!({"id":"u2","name":"Bob"})]);
    soft.delete_with_options("u2", true).unwrap();
    assert_eq!(read_trace(&trace), vec!["after-delete", "on-change:delete"]);
}

#[test]
fn direct_collection_post_hook_errors_are_swallowed() {
    let mut registry = CallbackRegistry::new();
    registry.register_after_create_hook(
        "after-create",
        Box::new(|_| {
            Err(EngineError::Operation(
                proseql_engine::errors::OperationError {
                    operation: "afterCreate".into(),
                    reason: "fail".into(),
                    message: "fail".into(),
                },
            ))
        }),
    );
    registry.register_after_delete_hook(
        "after-delete",
        Box::new(|_| {
            Err(EngineError::Operation(
                proseql_engine::errors::OperationError {
                    operation: "afterDelete".into(),
                    reason: "fail".into(),
                    message: "fail".into(),
                },
            ))
        }),
    );
    registry.register_on_change_hook(
        "on-change",
        Box::new(|_| {
            Err(EngineError::Operation(
                proseql_engine::errors::OperationError {
                    operation: "onChange".into(),
                    reason: "fail".into(),
                    message: "fail".into(),
                },
            ))
        }),
    );
    let mut descriptor = descriptor();
    descriptor.after_create_hooks = vec!["after-create".into()];
    descriptor.after_delete_hooks = vec!["after-delete".into()];
    descriptor.on_change_hooks = vec!["on-change".into()];
    let registry = Arc::new(registry);
    let mut collection = make_collection(registry, descriptor, vec![]);

    assert!(collection.create(json!({"id":"u1","name":"Alice"})).is_ok());
    assert!(collection.delete("u1").is_ok());
}

#[test]
fn after_and_on_change_hooks_run_in_order_for_create_update_delete() {
    let trace = trace();
    let mut registry = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        registry.register_after_create_hook(
            "after-create",
            Box::new(move |_| {
                trace.lock().unwrap().push("after-create".into());
                Ok(())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        registry.register_after_update_hook(
            "after-update",
            Box::new(move |_| {
                trace.lock().unwrap().push("after-update".into());
                Ok(())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        registry.register_after_delete_hook(
            "after-delete",
            Box::new(move |_| {
                trace.lock().unwrap().push("after-delete".into());
                Ok(())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        registry.register_on_change_hook(
            "on-change",
            Box::new(move |ctx| {
                let tag = match ctx {
                    proseql_engine::hooks::OnChangeContext::Create { .. } => "on-change:create",
                    proseql_engine::hooks::OnChangeContext::Update { .. } => "on-change:update",
                    proseql_engine::hooks::OnChangeContext::Delete { .. } => "on-change:delete",
                };
                trace.lock().unwrap().push(tag.into());
                Ok(())
            }),
        );
    }
    let mut descriptor = descriptor();
    descriptor.after_create_hooks = vec!["after-create".into()];
    descriptor.after_update_hooks = vec!["after-update".into()];
    descriptor.after_delete_hooks = vec!["after-delete".into()];
    descriptor.on_change_hooks = vec!["on-change".into()];
    let registry = Arc::new(registry);
    let mut db = make_db(registry, descriptor, vec![]);
    db.create("users", json!({"id":"u1","name":"Alice"}))
        .unwrap();
    db.update("users", "u1", json!({"name":"Bob"})).unwrap();
    db.delete("users", "u1").unwrap();
    assert_eq!(
        read_trace(&trace),
        vec![
            "after-create",
            "on-change:create",
            "after-update",
            "on-change:update",
            "after-delete",
            "on-change:delete",
        ]
    );
}

#[test]
fn after_and_on_change_errors_are_swallowed() {
    let mut registry = CallbackRegistry::new();
    registry.register_after_create_hook(
        "after-create",
        Box::new(|_| {
            Err(EngineError::Operation(
                proseql_engine::errors::OperationError {
                    operation: "afterCreate".into(),
                    reason: "fail".into(),
                    message: "fail".into(),
                },
            ))
        }),
    );
    registry.register_on_change_hook(
        "on-change",
        Box::new(|_| {
            Err(EngineError::Operation(
                proseql_engine::errors::OperationError {
                    operation: "onChange".into(),
                    reason: "fail".into(),
                    message: "fail".into(),
                },
            ))
        }),
    );
    let mut descriptor = descriptor();
    descriptor.after_create_hooks = vec!["after-create".into()];
    descriptor.on_change_hooks = vec!["on-change".into()];
    let registry = Arc::new(registry);
    let mut db = make_db(registry, descriptor, vec![]);
    assert!(db
        .create("users", json!({"id":"u1","name":"Alice"}))
        .is_ok());
}

#[test]
fn missing_local_after_create_hook_fails_before_mutation_for_create_variants() {
    let mut descriptor = descriptor();
    descriptor.after_create_hooks = vec!["missing-after-create".into()];
    let registry = Arc::new(CallbackRegistry::new());

    let mut create_db = make_db(Arc::clone(&registry), descriptor.clone(), vec![]);
    let error = create_db
        .create("users", json!({"id":"u1","name":"Alice"}))
        .unwrap_err();
    assert!(matches!(error, EngineError::Hook(_)));
    assert!(create_db.collection("users").unwrap().is_empty());

    let mut create_many_db = make_db(Arc::clone(&registry), descriptor.clone(), vec![]);
    let error = create_many_db
        .create_many("users", vec![json!({"id":"u1","name":"Alice"})], false)
        .unwrap_err();
    assert!(matches!(error, EngineError::Hook(_)));
    assert!(create_many_db.collection("users").unwrap().is_empty());

    let mut upsert_db = make_db(Arc::clone(&registry), descriptor.clone(), vec![]);
    let error = upsert_db
        .upsert(
            "users",
            json!({"id":"u1"}),
            json!({"name":"Alice"}),
            json!({"name":"ignored"}),
        )
        .unwrap_err();
    assert!(matches!(error, EngineError::Hook(_)));
    assert!(upsert_db.collection("users").unwrap().is_empty());

    let mut upsert_many_db = make_db(Arc::clone(&registry), descriptor, vec![]);
    let error = upsert_many_db
        .upsert_many(
            "users",
            vec![(
                json!({"id":"u1"}),
                json!({"name":"Alice"}),
                json!({"name":"ignored"}),
            )],
        )
        .unwrap_err();
    assert!(matches!(error, EngineError::Hook(_)));
    assert!(upsert_many_db.collection("users").unwrap().is_empty());
}

#[test]
fn missing_local_after_update_hook_fails_before_mutation_for_update_variants() {
    let mut descriptor = descriptor();
    descriptor.after_update_hooks = vec!["missing-after-update".into()];
    let registry = Arc::new(CallbackRegistry::new());

    let mut update_db = make_db(
        Arc::clone(&registry),
        descriptor.clone(),
        vec![json!({"id":"u1","name":"Alice"})],
    );
    let error = update_db
        .update("users", "u1", json!({"name":"Bob"}))
        .unwrap_err();
    assert!(matches!(error, EngineError::Hook(_)));
    assert_eq!(
        update_db.collection("users").unwrap().get("u1").unwrap()["name"],
        json!("Alice")
    );

    let mut update_many_db = make_db(
        Arc::clone(&registry),
        descriptor.clone(),
        vec![json!({"id":"u1","name":"Alice"})],
    );
    let error = update_many_db
        .update_many("users", json!({}), json!({"name":"Bob"}))
        .unwrap_err();
    assert!(matches!(error, EngineError::Hook(_)));
    assert_eq!(
        update_many_db
            .collection("users")
            .unwrap()
            .get("u1")
            .unwrap()["name"],
        json!("Alice")
    );

    let mut upsert_db = make_db(
        Arc::clone(&registry),
        descriptor.clone(),
        vec![json!({"id":"u1","name":"Alice"})],
    );
    let error = upsert_db
        .upsert(
            "users",
            json!({"id":"u1"}),
            json!({"name":"ignored"}),
            json!({"name":"Bob"}),
        )
        .unwrap_err();
    assert!(matches!(error, EngineError::Hook(_)));
    assert_eq!(
        upsert_db.collection("users").unwrap().get("u1").unwrap()["name"],
        json!("Alice")
    );

    let mut upsert_many_db = make_db(
        Arc::clone(&registry),
        descriptor,
        vec![json!({"id":"u1","name":"Alice"})],
    );
    let error = upsert_many_db
        .upsert_many(
            "users",
            vec![(
                json!({"id":"u1"}),
                json!({"name":"ignored"}),
                json!({"name":"Bob"}),
            )],
        )
        .unwrap_err();
    assert!(matches!(error, EngineError::Hook(_)));
    assert_eq!(
        upsert_many_db
            .collection("users")
            .unwrap()
            .get("u1")
            .unwrap()["name"],
        json!("Alice")
    );
}

#[test]
fn raw_no_op_upsert_many_does_not_validate_missing_after_update_hooks() {
    let mut descriptor = descriptor();
    descriptor.after_update_hooks = vec!["missing-after-update".into()];
    let registry = Arc::new(CallbackRegistry::new());
    let mut db = make_db(
        registry,
        descriptor,
        vec![json!({"id":"u1","name":"Alice"})],
    );

    let result = db
        .upsert_many(
            "users",
            vec![(
                json!({"id":"u1"}),
                json!({"name":"ignored"}),
                json!({"name":"Alice"}),
            )],
        )
        .unwrap();

    assert!(result.created.is_empty());
    assert!(result.updated.is_empty());
    assert_eq!(result.unchanged.len(), 1);
}

#[test]
fn missing_local_after_delete_hook_fails_before_mutation_for_delete_variants() {
    let mut descriptor = descriptor();
    descriptor.after_delete_hooks = vec!["missing-after-delete".into()];
    let registry = Arc::new(CallbackRegistry::new());

    let mut delete_db = make_db(
        Arc::clone(&registry),
        descriptor.clone(),
        vec![json!({"id":"u1","name":"Alice"})],
    );
    let error = delete_db.delete("users", "u1").unwrap_err();
    assert!(matches!(error, EngineError::Hook(_)));
    assert!(delete_db.collection("users").unwrap().get("u1").is_some());

    let mut delete_many_db = make_db(
        Arc::clone(&registry),
        descriptor,
        vec![json!({"id":"u1","name":"Alice"})],
    );
    let error = delete_many_db
        .delete_many("users", json!({}), false, None)
        .unwrap_err();
    assert!(matches!(error, EngineError::Hook(_)));
    assert!(delete_many_db
        .collection("users")
        .unwrap()
        .get("u1")
        .is_some());
}

#[test]
fn missing_local_on_change_hook_fails_before_mutation_for_create() {
    let mut descriptor = descriptor();
    descriptor.on_change_hooks = vec!["missing-on-change".into()];
    let registry = Arc::new(CallbackRegistry::new());

    let mut create_db = make_db(Arc::clone(&registry), descriptor, vec![]);
    let error = create_db
        .create("users", json!({"id":"u1","name":"Alice"}))
        .unwrap_err();
    assert!(matches!(error, EngineError::Hook(_)));
    assert!(create_db.collection("users").unwrap().is_empty());
}

#[test]
fn global_after_and_on_change_hooks_are_prepended_before_collection_hooks() {
    let trace = trace();
    let mut callbacks = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        callbacks.register_after_create_hook(
            "global-after",
            Box::new(move |_| {
                trace.lock().unwrap().push("global-after".into());
                Ok(())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        callbacks.register_after_create_hook(
            "local-after",
            Box::new(move |_| {
                trace.lock().unwrap().push("local-after".into());
                Ok(())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        callbacks.register_on_change_hook(
            "global-change",
            Box::new(move |_| {
                trace.lock().unwrap().push("global-change".into());
                Ok(())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        callbacks.register_on_change_hook(
            "local-change",
            Box::new(move |_| {
                trace.lock().unwrap().push("local-change".into());
                Ok(())
            }),
        );
    }
    let plugin = PluginDefinition {
        name: "audit".into(),
        global_hooks: GlobalHookIds {
            after_create: vec!["global-after".into()],
            on_change: vec!["global-change".into()],
            ..GlobalHookIds::default()
        },
        ..PluginDefinition::default()
    };
    let _ = build_plugin_registry(&[plugin], &mut callbacks).unwrap();
    let mut descriptor = descriptor();
    descriptor.after_create_hooks = vec!["local-after".into()];
    descriptor.on_change_hooks = vec!["local-change".into()];
    let registry = Arc::new(callbacks);
    let mut db = make_db(registry, descriptor, vec![]);
    db.create("users", json!({"id":"u1","name":"Alice"}))
        .unwrap();
    assert_eq!(
        read_trace(&trace),
        vec![
            "global-after",
            "local-after",
            "global-change",
            "local-change"
        ]
    );
}

#[test]
fn global_plugin_hooks_are_prepended_before_collection_hooks() {
    let trace = trace();
    let mut callbacks = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        callbacks.register_before_create_hook(
            "global",
            Box::new(move |ctx| {
                trace.lock().unwrap().push("global".into());
                Ok(ctx.data.clone())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        callbacks.register_before_create_hook(
            "local",
            Box::new(move |ctx| {
                trace.lock().unwrap().push("local".into());
                Ok(ctx.data.clone())
            }),
        );
    }
    let plugin = PluginDefinition {
        name: "audit".into(),
        global_hooks: GlobalHookIds {
            before_create: vec!["global".into()],
            ..GlobalHookIds::default()
        },
        ..PluginDefinition::default()
    };
    let _ = build_plugin_registry(&[plugin], &mut callbacks).unwrap();
    let mut descriptor = descriptor();
    descriptor.before_create_hooks = vec!["local".into()];
    let registry = Arc::new(callbacks);
    let mut db = make_db(registry, descriptor, vec![]);
    db.create("users", json!({"id":"u1","name":"Alice"}))
        .unwrap();
    assert_eq!(read_trace(&trace), vec!["global", "local"]);
}

#[test]
fn create_many_runs_before_and_after_hooks_for_each_created_entity() {
    let trace = trace();
    let mut callbacks = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        callbacks.register_before_create_hook(
            "before",
            Box::new(move |ctx| {
                trace
                    .lock()
                    .unwrap()
                    .push(format!("before:{}", ctx.data["id"].as_str().unwrap()));
                Ok(ctx.data.clone())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        callbacks.register_after_create_hook(
            "after",
            Box::new(move |ctx| {
                trace
                    .lock()
                    .unwrap()
                    .push(format!("after:{}", ctx.entity["id"].as_str().unwrap()));
                Ok(())
            }),
        );
    }
    let mut descriptor = descriptor();
    descriptor.before_create_hooks = vec!["before".into()];
    descriptor.after_create_hooks = vec!["after".into()];
    let registry = Arc::new(callbacks);
    let mut db = make_db(registry, descriptor, vec![]);
    let result = db
        .create_many(
            "users",
            vec![json!({"id":"u1","name":"A"}), json!({"id":"u2","name":"B"})],
            false,
        )
        .unwrap();
    assert_eq!(result.created.len(), 2);
    assert_eq!(
        read_trace(&trace),
        vec!["before:u1", "before:u2", "after:u1", "after:u2"]
    );
}

#[test]
fn update_many_runs_before_and_after_hooks_for_each_updated_entity() {
    let trace = trace();
    let mut callbacks = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        callbacks.register_before_update_hook(
            "before",
            Box::new(move |ctx| {
                trace.lock().unwrap().push(format!("before:{}", ctx.id));
                Ok(ctx.update.clone())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        callbacks.register_after_update_hook(
            "after",
            Box::new(move |ctx| {
                trace.lock().unwrap().push(format!("after:{}", ctx.id));
                Ok(())
            }),
        );
    }
    let mut descriptor = descriptor();
    descriptor.before_update_hooks = vec!["before".into()];
    descriptor.after_update_hooks = vec!["after".into()];
    let registry = Arc::new(callbacks);
    let mut db = make_db(
        registry,
        descriptor,
        vec![json!({"id":"u1","name":"A"}), json!({"id":"u2","name":"B"})],
    );
    let result = db
        .update_many("users", json!({}), json!({"name":"Updated"}))
        .unwrap();
    assert_eq!(result.count, 2);
    assert_eq!(
        read_trace(&trace),
        vec!["before:u1", "before:u2", "after:u1", "after:u2"]
    );
}

#[test]
fn delete_many_runs_before_and_after_hooks_for_each_deleted_entity() {
    let trace = trace();
    let mut callbacks = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        callbacks.register_before_delete_hook(
            "before",
            Box::new(move |ctx| {
                trace.lock().unwrap().push(format!("before:{}", ctx.id));
                Ok(())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        callbacks.register_after_delete_hook(
            "after",
            Box::new(move |ctx| {
                trace.lock().unwrap().push(format!("after:{}", ctx.id));
                Ok(())
            }),
        );
    }
    let mut descriptor = descriptor();
    descriptor.before_delete_hooks = vec!["before".into()];
    descriptor.after_delete_hooks = vec!["after".into()];
    let registry = Arc::new(callbacks);
    let mut db = make_db(
        registry,
        descriptor,
        vec![json!({"id":"u1","name":"A"}), json!({"id":"u2","name":"B"})],
    );
    let result = db.delete_many("users", json!({}), false, None).unwrap();
    assert_eq!(result.count, 2);
    assert_eq!(
        read_trace(&trace),
        vec!["before:u1", "before:u2", "after:u1", "after:u2"]
    );
}

#[test]
fn upsert_create_path_runs_hooks() {
    let trace = trace();
    let mut callbacks = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        callbacks.register_before_create_hook(
            "before-create",
            Box::new(move |ctx| {
                trace.lock().unwrap().push("before-create".into());
                Ok(ctx.data.clone())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        callbacks.register_after_create_hook(
            "after-create",
            Box::new(move |_| {
                trace.lock().unwrap().push("after-create".into());
                Ok(())
            }),
        );
    }
    let mut descriptor = descriptor();
    descriptor.before_create_hooks = vec!["before-create".into()];
    descriptor.after_create_hooks = vec!["after-create".into()];
    let registry = Arc::new(callbacks);
    let mut db = make_db(registry, descriptor, vec![]);
    let outcome = db
        .upsert(
            "users",
            json!({"id":"u1"}),
            json!({"name":"Alice"}),
            json!({"name":"Updated"}),
        )
        .unwrap();
    assert_eq!(
        outcome.action,
        proseql_engine::collection::UpsertAction::Created
    );
    assert_eq!(read_trace(&trace), vec!["before-create", "after-create"]);
}

#[test]
fn upsert_update_path_runs_hooks() {
    let trace = trace();
    let mut callbacks = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        callbacks.register_before_update_hook(
            "before-update",
            Box::new(move |ctx| {
                trace.lock().unwrap().push("before-update".into());
                Ok(ctx.update.clone())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        callbacks.register_after_update_hook(
            "after-update",
            Box::new(move |_| {
                trace.lock().unwrap().push("after-update".into());
                Ok(())
            }),
        );
    }
    let mut descriptor = descriptor();
    descriptor.before_update_hooks = vec!["before-update".into()];
    descriptor.after_update_hooks = vec!["after-update".into()];
    let registry = Arc::new(callbacks);
    let mut db = make_db(
        registry,
        descriptor,
        vec![json!({"id":"u1","name":"Alice"})],
    );
    let outcome = db
        .upsert(
            "users",
            json!({"id":"u1"}),
            json!({"name":"Alice"}),
            json!({"name":"Updated"}),
        )
        .unwrap();
    assert_eq!(
        outcome.action,
        proseql_engine::collection::UpsertAction::Updated
    );
    assert_eq!(read_trace(&trace), vec!["before-update", "after-update"]);
}

#[test]
fn create_many_skip_duplicates_turns_hook_rejection_into_skipped_entry() {
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_before_create_hook(
        "reject",
        Box::new(|ctx| {
            if ctx.data["id"] == json!("u2") {
                Err(EngineError::Hook(HookError {
                    hook: "beforeCreate".into(),
                    collection: ctx.collection.clone(),
                    operation: HookOperation::Create,
                    reason: "reject".into(),
                    message: "reject".into(),
                }))
            } else {
                Ok(ctx.data.clone())
            }
        }),
    );
    let mut descriptor = descriptor();
    descriptor.before_create_hooks = vec!["reject".into()];
    let registry = Arc::new(callbacks);
    let mut db = make_db(registry, descriptor, vec![]);
    let result = db
        .create_many(
            "users",
            vec![json!({"id":"u1","name":"A"}), json!({"id":"u2","name":"B"})],
            true,
        )
        .unwrap();
    assert_eq!(result.created.len(), 1);
    assert_eq!(result.skipped.len(), 1);
}

#[test]
fn create_many_fk_skip_runs_post_hooks_only_for_committed_entities() {
    let trace = trace();
    let mut callbacks = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        callbacks.register_after_create_hook(
            "after-create",
            Box::new(move |ctx| {
                trace
                    .lock()
                    .unwrap()
                    .push(format!("after:{}", ctx.entity["id"].as_str().unwrap()));
                Ok(())
            }),
        );
    }
    let mut descriptor = users_with_company_descriptor();
    descriptor.after_create_hooks = vec!["after-create".into()];
    let registry = Arc::new(callbacks);
    let mut db = make_company_db(Arc::clone(&registry), descriptor, vec![]);
    let result = db
        .create_many(
            "users",
            vec![
                json!({"id":"u1","name":"Alice","companyId":"c1"}),
                json!({"id":"u2","name":"Bob","companyId":"missing"}),
            ],
            true,
        )
        .unwrap();
    assert_eq!(result.created.len(), 1);
    assert_eq!(read_trace(&trace), vec!["after:u1"]);
}

#[test]
fn update_many_fk_failure_rolls_back_before_after_hooks_fire() {
    let trace = trace();
    let mut callbacks = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        callbacks.register_after_update_hook(
            "after-update",
            Box::new(move |ctx| {
                trace.lock().unwrap().push(format!("after:{}", ctx.id));
                Ok(())
            }),
        );
    }
    let mut descriptor = users_with_company_descriptor();
    descriptor.after_update_hooks = vec!["after-update".into()];
    let registry = Arc::new(callbacks);
    let mut db = make_company_db(
        Arc::clone(&registry),
        descriptor,
        vec![json!({"id":"u1","name":"Alice","companyId":"c1"})],
    );
    let error = db
        .update_many("users", json!({}), json!({"companyId":"missing"}))
        .unwrap_err();
    assert!(matches!(error, EngineError::ForeignKey(_)));
    assert!(read_trace(&trace).is_empty());
}

#[test]
fn upsert_update_fk_failure_rolls_back_before_after_hooks_fire() {
    let trace = trace();
    let mut callbacks = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        callbacks.register_after_update_hook(
            "after-update",
            Box::new(move |_| {
                trace.lock().unwrap().push("after-update".into());
                Ok(())
            }),
        );
    }
    let mut descriptor = users_with_company_descriptor();
    descriptor.after_update_hooks = vec!["after-update".into()];
    let registry = Arc::new(callbacks);
    let mut db = make_company_db(
        Arc::clone(&registry),
        descriptor,
        vec![json!({"id":"u1","name":"Alice","companyId":"c1"})],
    );
    let error = db
        .upsert(
            "users",
            json!({"id":"u1"}),
            json!({"name":"ignored"}),
            json!({"companyId":"missing"}),
        )
        .unwrap_err();
    assert!(matches!(error, EngineError::ForeignKey(_)));
    assert!(read_trace(&trace).is_empty());
}

#[test]
fn upsert_many_fk_failure_rolls_back_before_post_hooks_fire() {
    let trace = trace();
    let mut callbacks = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        callbacks.register_after_create_hook(
            "after-create",
            Box::new(move |ctx| {
                trace
                    .lock()
                    .unwrap()
                    .push(format!("create:{}", ctx.entity["id"].as_str().unwrap()));
                Ok(())
            }),
        );
    }
    {
        let trace = Arc::clone(&trace);
        callbacks.register_after_update_hook(
            "after-update",
            Box::new(move |ctx| {
                trace.lock().unwrap().push(format!("update:{}", ctx.id));
                Ok(())
            }),
        );
    }
    let mut descriptor = users_with_company_descriptor();
    descriptor.after_create_hooks = vec!["after-create".into()];
    descriptor.after_update_hooks = vec!["after-update".into()];
    let registry = Arc::new(callbacks);
    let mut db = make_company_db(
        Arc::clone(&registry),
        descriptor,
        vec![json!({"id":"u1","name":"Alice","companyId":"c1"})],
    );
    let error = db
        .upsert_many(
            "users",
            vec![
                (
                    json!({"id":"u1"}),
                    json!({"name":"ignored"}),
                    json!({"companyId":"c1"}),
                ),
                (
                    json!({"id":"u2"}),
                    json!({"name":"Bob","companyId":"missing"}),
                    json!({"name":"unused"}),
                ),
            ],
        )
        .unwrap_err();
    assert!(matches!(error, EngineError::ForeignKey(_)));
    assert!(read_trace(&trace).is_empty());
}

#[test]
fn transformed_before_update_payload_controls_fk_validation_and_after_context() {
    let trace_log = trace();
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_before_update_hook(
        "before-update",
        Box::new(|ctx| {
            let mut obj = ctx.update.as_object().cloned().unwrap_or_default();
            obj.insert("companyId".into(), json!("missing"));
            Ok(Value::Object(obj))
        }),
    );
    {
        let trace = Arc::clone(&trace_log);
        callbacks.register_after_update_hook(
            "after-update",
            Box::new(move |ctx| {
                trace
                    .lock()
                    .unwrap()
                    .push(ctx.update["companyId"].as_str().unwrap().to_owned());
                Ok(())
            }),
        );
    }
    let mut descriptor = users_with_company_descriptor();
    descriptor.before_update_hooks = vec!["before-update".into()];
    descriptor.after_update_hooks = vec!["after-update".into()];
    let registry = Arc::new(callbacks);
    let mut db = make_company_db(
        Arc::clone(&registry),
        descriptor.clone(),
        vec![json!({"id":"u1","name":"Alice","companyId":"c1"})],
    );
    let error = db.update("users", "u1", json!({"name":"Bob"})).unwrap_err();
    assert!(matches!(error, EngineError::ForeignKey(_)));
    assert!(read_trace(&trace_log).is_empty());

    let mut callbacks_ok = CallbackRegistry::new();
    callbacks_ok.register_before_update_hook(
        "before-update",
        Box::new(|ctx| {
            let mut obj = ctx.update.as_object().cloned().unwrap_or_default();
            obj.insert("companyId".into(), json!("c1"));
            Ok(Value::Object(obj))
        }),
    );
    let trace_ok_log = trace();
    {
        let trace_ok = Arc::clone(&trace_ok_log);
        callbacks_ok.register_after_update_hook(
            "after-update",
            Box::new(move |ctx| {
                trace_ok
                    .lock()
                    .unwrap()
                    .push(ctx.update["companyId"].as_str().unwrap().to_owned());
                Ok(())
            }),
        );
    }
    let registry_ok = Arc::new(callbacks_ok);
    let mut db_ok = make_company_db(
        Arc::clone(&registry_ok),
        descriptor,
        vec![json!({"id":"u1","name":"Alice","companyId":"c1"})],
    );
    db_ok.update("users", "u1", json!({"name":"Bob"})).unwrap();
    assert_eq!(read_trace(&trace_ok_log), vec!["c1"]);
}

#[test]
fn before_create_id_transform_keeps_storage_key_at_pre_hook_resolved_id() {
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_before_create_hook(
        "rewrite-id",
        Box::new(|ctx| {
            let mut obj = ctx.data.as_object().cloned().unwrap();
            obj.insert("id".into(), json!("hooked-u1"));
            Ok(Value::Object(obj))
        }),
    );
    let mut descriptor = descriptor();
    descriptor.before_create_hooks = vec!["rewrite-id".into()];
    let registry = Arc::new(callbacks);
    let mut db = make_db(Arc::clone(&registry), descriptor.clone(), vec![]);
    let created = db
        .create("users", json!({"id":"u1","name":"Alice"}))
        .unwrap();
    assert_eq!(created["id"], json!("hooked-u1"));
    assert!(db.collection("users").unwrap().get("u1").is_some());
    assert!(db.collection("users").unwrap().get("hooked-u1").is_none());

    let mut db_dup = make_db(
        registry,
        descriptor,
        vec![json!({"id":"u1","name":"Existing"})],
    );
    let error = db_dup
        .create("users", json!({"id":"u1","name":"Duplicate"}))
        .unwrap_err();
    assert!(matches!(error, EngineError::DuplicateKey(_)));
}

#[test]
fn relationship_aware_create_does_not_run_plain_hooks() {
    let trace = trace();
    let mut callbacks = CallbackRegistry::new();
    {
        let trace = Arc::clone(&trace);
        callbacks.register_before_create_hook(
            "before-create",
            Box::new(move |ctx| {
                trace
                    .lock()
                    .unwrap()
                    .push(format!("hook:{}", ctx.collection));
                Ok(ctx.data.clone())
            }),
        );
    }
    let mut descriptor = descriptor();
    descriptor.before_create_hooks = vec!["before-create".into()];
    let registry = Arc::new(callbacks);
    let mut db = make_db(registry, descriptor, vec![]);
    db.create_with_relationships("users", json!({"id":"u1","name":"Alice"}))
        .unwrap();
    assert!(read_trace(&trace).is_empty());
}
