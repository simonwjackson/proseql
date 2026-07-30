use std::sync::{Arc, Mutex};

use proseql_engine::clock::FixedClock;
use proseql_engine::descriptor::{
    CollectionDescriptor, ComputedFieldDescriptor, IdStrategy, RelationshipDescriptor,
    RelationshipKind, SchemaNode, StructField, ValidationMode,
};
use proseql_engine::errors::EngineError;
use proseql_engine::id_gen::{IdGenerator, SequentialGenerator};
use proseql_engine::reactive::{ManualReactiveScheduler, ReactiveScheduler};
use proseql_wasm::{Runtime, RuntimeConfig};
use serde_json::{json, Value};

fn base_collection(name: &str, schema: SchemaNode) -> CollectionDescriptor {
    CollectionDescriptor {
        name: name.to_owned(),
        schema,
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

fn user_schema() -> SchemaNode {
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
                name: "score".into(),
                schema: SchemaNode::OptionalWithDefault {
                    inner: Box::new(SchemaNode::Num),
                    default_callback_id: "scoreDefault".into(),
                },
            },
            StructField {
                name: "scores".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Array {
                    item: Box::new(SchemaNode::Num),
                })),
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
        ],
    }
}

fn post_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "title".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "authorId".into(),
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
        ],
    }
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

fn users_descriptor() -> CollectionDescriptor {
    let mut descriptor = base_collection("users", user_schema());
    descriptor.relationships = vec![
        (
            "company".into(),
            RelationshipDescriptor {
                kind: RelationshipKind::Ref,
                target: "companies".into(),
                foreign_key: Some("companyId".into()),
            },
        ),
        (
            "posts".into(),
            RelationshipDescriptor {
                kind: RelationshipKind::Inverse,
                target: "posts".into(),
                foreign_key: Some("authorId".into()),
            },
        ),
    ];
    descriptor
}

fn posts_descriptor() -> CollectionDescriptor {
    let mut descriptor = base_collection("posts", post_schema());
    descriptor.relationships = vec![(
        "author".into(),
        RelationshipDescriptor {
            kind: RelationshipKind::Ref,
            target: "users".into(),
            foreign_key: Some("authorId".into()),
        },
    )];
    descriptor
}

fn companies_descriptor() -> CollectionDescriptor {
    let mut descriptor = base_collection("companies", company_schema());
    descriptor.relationships = vec![(
        "employees".into(),
        RelationshipDescriptor {
            kind: RelationshipKind::Inverse,
            target: "users".into(),
            foreign_key: Some("companyId".into()),
        },
    )];
    descriptor
}

fn make_runtime() -> (Runtime, Arc<ManualReactiveScheduler>) {
    let scheduler = Arc::new(ManualReactiveScheduler::default());
    let mut runtime = Runtime::with_config(RuntimeConfig {
        clock_factory: Arc::new(|| {
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z"))
                as Box<dyn proseql_engine::clock::Clock>
        }),
        fallback_id_generator_factory: Arc::new(|| {
            Box::new(SequentialGenerator::new("fallback")) as Box<dyn IdGenerator>
        }),
        reactive_scheduler_factory: {
            let scheduler = Arc::clone(&scheduler);
            Arc::new(move || Arc::clone(&scheduler) as Arc<dyn ReactiveScheduler>)
        },
    });
    runtime
        .callbacks_mut()
        .register_default("scoreDefault", || json!(7));
    runtime
        .callbacks_mut()
        .register_computed("displayName", |value| {
            let name = value.get("name").and_then(Value::as_str).unwrap_or("");
            json!(format!("{name}!"))
        });
    runtime
        .callbacks_mut()
        .register_predicate("gt3", |value| value.as_i64().unwrap_or_default() > 3);
    runtime.callbacks_mut().register_custom_operator(
        "$prefix",
        vec!["string".into()],
        |field, operand| {
            field
                .as_str()
                .zip(operand.as_str())
                .map(|(field, operand)| field.starts_with(operand))
                .unwrap_or(false)
        },
    );
    runtime
        .callbacks_mut()
        .register_id_generator("customIds", || {
            Box::new(SequentialGenerator::new("custom")) as Box<dyn IdGenerator>
        });
    (runtime, scheduler)
}

fn parse_response(raw: &str) -> Value {
    serde_json::from_str(raw).expect("valid bridge response")
}

fn expect_ok(raw: &str) -> Value {
    let response = parse_response(raw);
    assert_eq!(response["kind"], json!("ok"), "{response}");
    response["value"].clone()
}

fn expect_error_tag(raw: &str, tag: &str) -> Value {
    let response = parse_response(raw);
    assert_eq!(response["kind"], json!("error"), "{response}");
    assert_eq!(response["error"]["_tag"], json!(tag), "{response}");
    response["error"].clone()
}

fn expect_defect(raw: &str) -> Value {
    let response = parse_response(raw);
    assert_eq!(response["kind"], json!("defect"), "{response}");
    response
}

fn create_database(
    runtime: &mut Runtime,
    collections: Vec<CollectionDescriptor>,
    initial_collections: Value,
) -> u32 {
    let value = expect_ok(
        &runtime.create_database_json(
            json!({
                "descriptor": { "collections": collections, "sources": [] },
                "initialCollections": initial_collections,
            })
            .to_string()
            .as_str(),
        ),
    );
    value.as_u64().unwrap() as u32
}

fn dispatch(runtime: &mut Runtime, handle: u32, method: &str, payload: Value) -> Value {
    expect_ok(&runtime.dispatch_json(handle, method, Some(payload.to_string().as_str())))
}

fn dispatch_no_payload(runtime: &mut Runtime, handle: u32, method: &str) -> Value {
    expect_ok(&runtime.dispatch_json(handle, method, None))
}

#[test]
fn create_and_drop_handle_round_trip() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(&mut runtime, vec![users_descriptor()], json!({}));
    assert!(handle > 0);
    assert_eq!(expect_ok(&runtime.drop_database_json(handle)), json!(true));
}

#[test]
fn create_database_invalid_json_returns_operation_error() {
    let (mut runtime, _) = make_runtime();
    let error = expect_error_tag(&runtime.create_database_json("{"), "OperationError");
    assert_eq!(error["reason"], json!("invalid-json"));
}

#[test]
fn drop_unknown_handle_returns_false() {
    let (mut runtime, _) = make_runtime();
    assert_eq!(expect_ok(&runtime.drop_database_json(999)), json!(false));
}

#[test]
fn unknown_handle_returns_error_payload() {
    let (mut runtime, _) = make_runtime();
    let error = expect_error_tag(
        &runtime.dispatch_json(999, "dumpAll", None),
        "OperationError",
    );
    assert_eq!(error["reason"], json!("unknown-handle"));
}

#[test]
fn unknown_command_returns_error_payload() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(&mut runtime, vec![users_descriptor()], json!({}));
    let error = expect_error_tag(
        &runtime.dispatch_json(handle, "nope", Some("{}")),
        "OperationError",
    );
    assert_eq!(error["reason"], json!("unknown-command"));
}

#[test]
fn handle_isolation_keeps_databases_separate() {
    let (mut runtime, _) = make_runtime();
    let a = create_database(&mut runtime, vec![users_descriptor()], json!({}));
    let b = create_database(&mut runtime, vec![users_descriptor()], json!({}));
    dispatch(
        &mut runtime,
        a,
        "create",
        json!({"collection": "users", "data": {"id": "u1", "name": "Alice"}}),
    );
    dispatch(
        &mut runtime,
        b,
        "create",
        json!({"collection": "users", "data": {"id": "u2", "name": "Bob"}}),
    );
    assert_eq!(
        dispatch_no_payload(&mut runtime, a, "dumpAll")["users"][0]["id"],
        json!("u1")
    );
    assert_eq!(
        dispatch_no_payload(&mut runtime, b, "dumpAll")["users"][0]["id"],
        json!("u2")
    );
}

#[test]
fn create_and_query_round_trip() {
    let (mut runtime, _) = make_runtime();
    let mut descriptor = users_descriptor();
    descriptor.computed_fields = vec![ComputedFieldDescriptor {
        name: "displayName".into(),
        callback_id: "displayName".into(),
    }];
    let handle = create_database(&mut runtime, vec![descriptor], json!({}));
    let created = dispatch(
        &mut runtime,
        handle,
        "create",
        json!({"collection": "users", "data": {"id": "u1", "name": "Alice"}}),
    );
    assert_eq!(created["score"], json!(7));
    let queried = dispatch(
        &mut runtime,
        handle,
        "query",
        json!({
            "collection": "users",
            "query": {"where": {"name": {"$prefix": "Al"}}, "select": ["displayName"]}
        }),
    );
    assert_eq!(queried, json!([{"displayName": "Alice!"}]));
}

#[test]
fn create_many_returns_created_and_skipped_entries() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(&mut runtime, vec![users_descriptor()], json!({}));
    let result = dispatch(
        &mut runtime,
        handle,
        "createMany",
        json!({
            "collection": "users",
            "skipDuplicates": true,
            "items": [
                {"id": "u1", "name": "Alice"},
                {"id": "u1", "name": "Duplicate"},
                {"id": "u2", "name": "Bob"}
            ]
        }),
    );
    assert_eq!(result["created"].as_array().unwrap().len(), 2);
    assert_eq!(result["skipped"].as_array().unwrap().len(), 1);
}

#[test]
fn update_many_updates_matching_entities() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users": [{"id": "u1", "name": "Alice"}, {"id": "u2", "name": "Bob"}]}),
    );
    let result = dispatch(
        &mut runtime,
        handle,
        "updateMany",
        json!({"collection": "users", "where": {"name": "Alice"}, "data": {"name": "Alicia"}}),
    );
    assert_eq!(result["count"], json!(1));
    assert_eq!(result["updated"][0]["name"], json!("Alicia"));
}

#[test]
fn delete_many_honors_limit() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users": [{"id": "u1", "name": "A"}, {"id": "u2", "name": "B"}]}),
    );
    let result = dispatch(
        &mut runtime,
        handle,
        "deleteMany",
        json!({"collection": "users", "where": {}, "limit": 1}),
    );
    assert_eq!(result["count"], json!(1));
    assert_eq!(
        dispatch_no_payload(&mut runtime, handle, "dumpAll")["users"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn upsert_create_path_attaches_created_action() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(&mut runtime, vec![users_descriptor()], json!({}));
    let result = dispatch(
        &mut runtime,
        handle,
        "upsert",
        json!({
            "collection": "users",
            "where": {"id": "u1"},
            "create": {"name": "Alice"},
            "update": {"name": "unused"}
        }),
    );
    assert_eq!(result["__action"], json!("created"));
}

#[test]
fn upsert_update_path_attaches_updated_action() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users": [{"id": "u1", "name": "Alice"}]}),
    );
    let result = dispatch(
        &mut runtime,
        handle,
        "upsert",
        json!({
            "collection": "users",
            "where": {"id": "u1"},
            "create": {"name": "unused"},
            "update": {"name": "Alicia"}
        }),
    );
    assert_eq!(result["__action"], json!("updated"));
}

#[test]
fn upsert_many_returns_created_updated_and_unchanged() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users": [{"id": "u1", "name": "Alice"}, {"id": "u3", "name": "Bob"}]}),
    );
    let result = dispatch(
        &mut runtime,
        handle,
        "upsertMany",
        json!({
            "collection": "users",
            "items": [
                {"where": {"id": "u1"}, "create": {"name": "unused"}, "update": {"name": "Alicia"}},
                {"where": {"id": "u2"}, "create": {"name": "Bob"}, "update": {"name": "unused"}},
                {"where": {"id": "u3"}, "create": {"name": "unused"}, "update": {"name": "Bob"}}
            ]
        }),
    );
    assert_eq!(result["created"].as_array().unwrap().len(), 1);
    assert_eq!(result["updated"].as_array().unwrap().len(), 1);
    assert_eq!(result["unchanged"].as_array().unwrap().len(), 1);
}

#[test]
fn query_cursor_returns_cursor_page_shape() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({
            "users": [
                {"id": "u1", "name": "A"},
                {"id": "u2", "name": "B"},
                {"id": "u3", "name": "C"}
            ]
        }),
    );
    let result = dispatch(
        &mut runtime,
        handle,
        "queryCursor",
        json!({
            "collection": "users",
            "query": {"sort": {"id": "asc"}},
            "cursor": {"key": "id", "limit": 2}
        }),
    );
    assert_eq!(result["items"].as_array().unwrap().len(), 2);
    assert_eq!(result["pageInfo"]["hasNextPage"], json!(true));
}

#[test]
fn aggregate_returns_expected_shape() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users": [{"id": "u1", "name": "A", "score": 2}, {"id": "u2", "name": "B", "score": 4}]}),
    );
    let result = dispatch(
        &mut runtime,
        handle,
        "aggregate",
        json!({"collection": "users", "config": {"count": true, "sum": ["score"], "avg": ["score"]}}),
    );
    assert_eq!(result["count"], json!(2));
    assert_eq!(result["sum"]["score"], json!(6.0));
}

#[test]
fn group_aggregate_returns_grouped_rows() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor(), companies_descriptor()],
        json!({
            "users": [
                {"id": "u1", "name": "A", "companyId": "c1"},
                {"id": "u2", "name": "B", "companyId": "c1"},
                {"id": "u3", "name": "C", "companyId": "c2"}
            ],
            "companies": [
                {"id": "c1", "name": "Acme"},
                {"id": "c2", "name": "Globex"}
            ]
        }),
    );
    let result = dispatch(
        &mut runtime,
        handle,
        "groupAggregate",
        json!({"collection": "users", "config": {"count": true, "groupBy": ["companyId"]}}),
    );
    assert_eq!(result.as_array().unwrap().len(), 2);
}

#[test]
fn relationship_create_connects_foreign_key() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor(), companies_descriptor()],
        json!({"companies": [{"id": "c1", "name": "Acme"}]}),
    );
    let created = dispatch(
        &mut runtime,
        handle,
        "createWithRelationships",
        json!({
            "collection": "users",
            "data": {"id": "u1", "name": "Alice", "company": {"$connect": {"id": "c1"}}}
        }),
    );
    assert_eq!(created["companyId"], json!("c1"));
}

#[test]
fn relationship_update_changes_foreign_key() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor(), companies_descriptor()],
        json!({
            "companies": [{"id": "c1", "name": "A"}, {"id": "c2", "name": "B"}],
            "users": [{"id": "u1", "name": "Alice", "companyId": "c1"}]
        }),
    );
    let updated = dispatch(
        &mut runtime,
        handle,
        "updateWithRelationships",
        json!({"collection": "users", "id": "u1", "data": {"company": {"$connect": {"id": "c2"}}}}),
    );
    assert_eq!(updated["companyId"], json!("c2"));
}

#[test]
fn delete_with_relationships_cascades_to_children() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor(), posts_descriptor()],
        json!({
            "users": [{"id": "u1", "name": "Alice"}],
            "posts": [{"id": "p1", "title": "Hello", "authorId": "u1"}]
        }),
    );
    let result = dispatch(
        &mut runtime,
        handle,
        "deleteWithRelationships",
        json!({
            "collection": "users",
            "id": "u1",
            "options": {"soft": false, "include": {"posts": "cascade"}}
        }),
    );
    assert_eq!(result["cascaded"]["posts"]["count"], json!(1));
}

#[test]
fn delete_many_with_relationships_cascades_to_children() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor(), posts_descriptor()],
        json!({
            "users": [{"id": "u1", "name": "Alice"}],
            "posts": [{"id": "p1", "title": "Hello", "authorId": "u1"}]
        }),
    );
    let result = dispatch(
        &mut runtime,
        handle,
        "deleteManyWithRelationships",
        json!({
            "collection": "users",
            "where": {"id": "u1"},
            "options": {"soft": false, "include": {"posts": "cascade"}}
        }),
    );
    assert_eq!(result["count"], json!(1));
    assert_eq!(result["cascaded"]["posts"]["count"], json!(1));
}

#[test]
fn dump_collection_returns_collection_contents() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users": [{"id": "u1", "name": "Alice"}]}),
    );
    let dumped = dispatch(
        &mut runtime,
        handle,
        "dumpCollection",
        json!({"collection": "users"}),
    );
    assert_eq!(dumped.as_array().unwrap().len(), 1);
}

#[test]
fn dump_all_returns_all_collections() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor(), companies_descriptor()],
        json!({"users": [{"id": "u1", "name": "Alice"}], "companies": [{"id": "c1", "name": "Acme"}]}),
    );
    let dumped = dispatch_no_payload(&mut runtime, handle, "dumpAll");
    assert_eq!(dumped["users"].as_array().unwrap().len(), 1);
    assert_eq!(dumped["companies"].as_array().unwrap().len(), 1);
}

#[test]
fn reload_collection_replaces_existing_state() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users": [{"id": "u1", "name": "Alice"}]}),
    );
    dispatch(
        &mut runtime,
        handle,
        "reloadCollection",
        json!({"collection": "users", "records": [{"id": "u2", "name": "Bob"}]}),
    );
    let dumped = dispatch_no_payload(&mut runtime, handle, "dumpAll");
    assert_eq!(dumped["users"], json!([{"id": "u2", "name": "Bob"}]));
}

#[test]
fn commit_snapshot_transaction_swaps_atomically_and_rolls_back_on_error() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor(), companies_descriptor()],
        json!({
            "users": [{"id": "u1", "name": "Alice"}],
            "companies": [{"id": "c1", "name": "Acme"}]
        }),
    );
    let committed = dispatch(
        &mut runtime,
        handle,
        "commitSnapshotTransaction",
        json!({
            "collections": {
                "users": [{"id": "u2", "name": "Bob"}],
                "companies": [{"id": "c1", "name": "Acme"}]
            }
        }),
    );
    assert_eq!(committed["changedCollections"], json!(["users"]));
    assert_eq!(
        dispatch_no_payload(&mut runtime, handle, "dumpAll")["users"],
        json!([{"id": "u2", "name": "Bob"}])
    );

    let response = runtime.dispatch_json(
        handle,
        "commitSnapshotTransaction",
        Some(
            json!({
                "collections": {
                    "users": [{"id": "u3"}],
                    "companies": [{"id": "c2", "name": "Globex"}]
                }
            })
            .to_string()
            .as_str(),
        ),
    );
    expect_error_tag(&response, "ValidationError");
    let dumped = dispatch_no_payload(&mut runtime, handle, "dumpAll");
    assert_eq!(dumped["users"], json!([{"id": "u2", "name": "Bob"}]));
    assert_eq!(dumped["companies"], json!([{"id": "c1", "name": "Acme"}]));
}

#[test]
fn transaction_runs_create_and_query_subset() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(&mut runtime, vec![users_descriptor()], json!({}));
    let result = dispatch(
        &mut runtime,
        handle,
        "transaction",
        json!({
            "operations": [
                {"kind": "create", "collection": "users", "data": {"id": "u1", "name": "Alice"}},
                {"kind": "query", "collection": "users"}
            ]
        }),
    );
    assert_eq!(result.as_array().unwrap().len(), 2);
}

#[test]
fn transaction_rolls_back_on_error() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(&mut runtime, vec![users_descriptor()], json!({}));
    let response = runtime.dispatch_json(
        handle,
        "transaction",
        Some(
            json!({
                "operations": [
                    {"kind": "create", "collection": "users", "data": {"id": "u1", "name": "Alice"}},
                    {"kind": "update", "collection": "users", "id": "missing", "data": {"name": "Nope"}}
                ]
            })
            .to_string()
            .as_str(),
        ),
    );
    expect_error_tag(&response, "NotFoundError");
    assert!(
        dispatch_no_payload(&mut runtime, handle, "dumpAll")["users"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn transaction_query_cursor_subset_returns_cursor_page() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users": [{"id": "u1", "name": "A"}, {"id": "u2", "name": "B"}]}),
    );
    let result = dispatch(
        &mut runtime,
        handle,
        "transaction",
        json!({
            "operations": [
                {"kind": "queryCursor", "collection": "users", "query": {"sort": {"id": "asc"}}, "cursor": {"key": "id", "limit": 1}}
            ]
        }),
    );
    assert_eq!(result[0]["kind"], json!("cursorPage"));
}

#[test]
fn dry_run_reports_migration_statuses() {
    let (mut runtime, _) = make_runtime();
    let value = expect_ok(&runtime.dry_run_migrations_json(
        json!({
            "collections": [
                {"name": "users", "exists": true, "currentVersion": 0, "targetVersion": 1, "migrations": [{"from": 0, "to": 1, "callback_id": "m1"}]},
                {"name": "posts", "exists": false, "currentVersion": 0, "targetVersion": 1, "migrations": []}
            ]
        })
        .to_string()
        .as_str(),
    ));
    assert_eq!(value["collections"][0]["status"], json!("needs-migration"));
    assert_eq!(value["collections"][1]["status"], json!("no-file"));
}

#[test]
fn default_callback_applies_on_create() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(&mut runtime, vec![users_descriptor()], json!({}));
    let created = dispatch(
        &mut runtime,
        handle,
        "create",
        json!({"collection": "users", "data": {"id": "u1", "name": "Alice"}}),
    );
    assert_eq!(created["score"], json!(7));
}

#[test]
fn predicate_callback_supports_remove_by_operator() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users": [{"id": "u1", "name": "Alice", "scores": [1, 2, 4, 5]}]}),
    );
    let updated = dispatch(
        &mut runtime,
        handle,
        "update",
        json!({"collection": "users", "id": "u1", "data": {"scores": {"$removeBy": "gt3"}}}),
    );
    assert_eq!(updated["scores"], json!([1, 2]));
}

#[test]
fn custom_operator_filters_query_results() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users": [{"id": "u1", "name": "Alice"}, {"id": "u2", "name": "Bob"}]}),
    );
    let queried = dispatch(
        &mut runtime,
        handle,
        "query",
        json!({"collection": "users", "query": {"where": {"name": {"$prefix": "Al"}}}}),
    );
    assert_eq!(queried, json!([{"id": "u1", "name": "Alice"}]));
}

#[test]
fn computed_callback_materializes_fields_in_query_results() {
    let (mut runtime, _) = make_runtime();
    let mut descriptor = users_descriptor();
    descriptor.computed_fields = vec![ComputedFieldDescriptor {
        name: "displayName".into(),
        callback_id: "displayName".into(),
    }];
    let handle = create_database(
        &mut runtime,
        vec![descriptor],
        json!({"users": [{"id": "u1", "name": "Alice"}]}),
    );
    let queried = dispatch(
        &mut runtime,
        handle,
        "query",
        json!({"collection": "users", "query": {"select": ["displayName"]}}),
    );
    assert_eq!(queried, json!([{"displayName": "Alice!"}]));
}

#[test]
fn id_generator_callback_is_honored_for_named_generators() {
    let (mut runtime, _) = make_runtime();
    let mut descriptor = users_descriptor();
    descriptor.id_generator = Some("customIds".into());
    let handle = create_database(&mut runtime, vec![descriptor], json!({}));
    let created = dispatch(
        &mut runtime,
        handle,
        "create",
        json!({"collection": "users", "data": {"name": "Alice"}}),
    );
    assert_eq!(created["id"], json!("custom-1"));
}

#[test]
fn before_create_hook_transforms_payload() {
    let (mut runtime, _) = make_runtime();
    runtime
        .callbacks_mut()
        .register_before_create_hook("trim", |ctx| {
            let mut data = ctx.data.as_object().cloned().unwrap_or_default();
            data.insert("name".to_owned(), json!("Trimmed"));
            Ok(Value::Object(data))
        });
    let mut descriptor = users_descriptor();
    descriptor.before_create_hooks = vec!["trim".into()];
    let handle = create_database(&mut runtime, vec![descriptor], json!({}));
    let created = dispatch(
        &mut runtime,
        handle,
        "create",
        json!({"collection": "users", "data": {"id": "u1", "name": "Alice"}}),
    );
    assert_eq!(created["name"], json!("Trimmed"));
}

#[test]
fn before_update_hook_transforms_payload() {
    let (mut runtime, _) = make_runtime();
    runtime
        .callbacks_mut()
        .register_before_update_hook("force", |ctx| {
            let mut update = ctx.update.as_object().cloned().unwrap_or_default();
            update.insert("name".to_owned(), json!("Forced"));
            Ok(Value::Object(update))
        });
    let mut descriptor = users_descriptor();
    descriptor.before_update_hooks = vec!["force".into()];
    let handle = create_database(
        &mut runtime,
        vec![descriptor],
        json!({"users": [{"id": "u1", "name": "Alice"}]}),
    );
    let updated = dispatch(
        &mut runtime,
        handle,
        "update",
        json!({"collection": "users", "id": "u1", "data": {"name": "Bob"}}),
    );
    assert_eq!(updated["name"], json!("Forced"));
}

#[test]
fn before_delete_hook_rejection_surfaces_as_hook_error() {
    let (mut runtime, _) = make_runtime();
    runtime
        .callbacks_mut()
        .register_before_delete_hook("reject", |_| {
            Err(EngineError::Operation(
                proseql_engine::errors::OperationError {
                    operation: "reject".into(),
                    reason: "nope".into(),
                    message: "blocked".into(),
                },
            ))
        });
    let mut descriptor = users_descriptor();
    descriptor.before_delete_hooks = vec!["reject".into()];
    let handle = create_database(
        &mut runtime,
        vec![descriptor],
        json!({"users": [{"id": "u1", "name": "Alice"}]}),
    );
    expect_error_tag(
        &runtime.dispatch_json(
            handle,
            "delete",
            Some(
                json!({"collection": "users", "id": "u1"})
                    .to_string()
                    .as_str(),
            ),
        ),
        "HookError",
    );
}

#[test]
fn after_create_and_on_change_hooks_run() {
    let (mut runtime, _) = make_runtime();
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let a = Arc::clone(&events);
    runtime
        .callbacks_mut()
        .register_after_create_hook("after", move |_| {
            a.lock().unwrap().push("afterCreate".into());
            Ok(())
        });
    let b = Arc::clone(&events);
    runtime
        .callbacks_mut()
        .register_on_change_hook("change", move |_| {
            b.lock().unwrap().push("onChange".into());
            Ok(())
        });
    let mut descriptor = users_descriptor();
    descriptor.after_create_hooks = vec!["after".into()];
    descriptor.on_change_hooks = vec!["change".into()];
    let handle = create_database(&mut runtime, vec![descriptor], json!({}));
    dispatch(
        &mut runtime,
        handle,
        "create",
        json!({"collection": "users", "data": {"id": "u1", "name": "Alice"}}),
    );
    assert_eq!(
        events.lock().unwrap().as_slice(),
        ["afterCreate", "onChange"]
    );
}

#[test]
fn after_update_and_after_delete_hooks_run() {
    let (mut runtime, _) = make_runtime();
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let a = Arc::clone(&events);
    runtime
        .callbacks_mut()
        .register_after_update_hook("afterUpdate", move |_| {
            a.lock().unwrap().push("afterUpdate".into());
            Ok(())
        });
    let b = Arc::clone(&events);
    runtime
        .callbacks_mut()
        .register_after_delete_hook("afterDelete", move |_| {
            b.lock().unwrap().push("afterDelete".into());
            Ok(())
        });
    let mut descriptor = users_descriptor();
    descriptor.after_update_hooks = vec!["afterUpdate".into()];
    descriptor.after_delete_hooks = vec!["afterDelete".into()];
    let handle = create_database(
        &mut runtime,
        vec![descriptor],
        json!({"users": [{"id": "u1", "name": "Alice"}]}),
    );
    dispatch(
        &mut runtime,
        handle,
        "update",
        json!({"collection": "users", "id": "u1", "data": {"name": "Alicia"}}),
    );
    dispatch(
        &mut runtime,
        handle,
        "delete",
        json!({"collection": "users", "id": "u1"}),
    );
    assert_eq!(
        events.lock().unwrap().as_slice(),
        ["afterUpdate", "afterDelete"]
    );
}

#[test]
fn collator_callback_controls_sort_order() {
    let (mut runtime, _) = make_runtime();
    runtime.callbacks_mut().register_collator(|a, b| b.cmp(a));
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users": [{"id": "u1", "name": "Alice"}, {"id": "u2", "name": "Bob"}]}),
    );
    let queried = dispatch(
        &mut runtime,
        handle,
        "query",
        json!({"collection": "users", "query": {"sort": {"name": "asc"}}}),
    );
    assert_eq!(queried[0]["name"], json!("Bob"));
}

#[test]
fn panic_in_callback_returns_defect_response() {
    let (mut runtime, _) = make_runtime();
    runtime
        .callbacks_mut()
        .register_computed("boom", |_| panic!("boom"));
    let mut descriptor = users_descriptor();
    descriptor.computed_fields = vec![ComputedFieldDescriptor {
        name: "boom".into(),
        callback_id: "boom".into(),
    }];
    let handle = create_database(
        &mut runtime,
        vec![descriptor],
        json!({"users": [{"id": "u1", "name": "Alice"}]}),
    );
    let defect = expect_defect(
        &runtime.dispatch_json(
            handle,
            "query",
            Some(
                json!({"collection": "users", "query": {"select": ["boom"]}})
                    .to_string()
                    .as_str(),
            ),
        ),
    );
    assert!(defect["message"]
        .as_str()
        .unwrap()
        .contains("unexpected defect"));
}

#[test]
fn initial_records_preserve_existing_timestamps_and_absence() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({
            "users": [
                {"id": "u1", "name": "Alice", "createdAt": "1999-01-01T00:00:00.000Z", "updatedAt": "1999-01-02T00:00:00.000Z"},
                {"id": "u2", "name": "Bob"}
            ]
        }),
    );
    let dumped = dispatch_no_payload(&mut runtime, handle, "dumpAll");
    assert_eq!(
        dumped["users"][0]["createdAt"],
        json!("1999-01-01T00:00:00.000Z")
    );
    assert!(dumped["users"][1].get("createdAt").is_none());
}

#[test]
fn watch_subscription_emits_initial_and_update_and_unsubscribe_cleans_up() {
    let (mut runtime, scheduler) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users": [{"id": "u1", "name": "Alice"}]}),
    );
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events_clone = Arc::clone(&events);
    let subscription_id = expect_ok(&runtime.subscribe_watch_json(
        handle,
        json!({"collection": "users"}).to_string().as_str(),
        move |value| events_clone.lock().unwrap().push(value),
    ))
    .as_u64()
    .unwrap() as u32;
    assert_eq!(events.lock().unwrap().len(), 1);
    dispatch(
        &mut runtime,
        handle,
        "create",
        json!({"collection": "users", "data": {"id": "u2", "name": "Bob"}}),
    );
    scheduler.advance(10);
    assert_eq!(events.lock().unwrap().len(), 2);
    assert_eq!(
        expect_ok(&runtime.unsubscribe_json(handle, subscription_id)),
        json!(true)
    );
    dispatch(
        &mut runtime,
        handle,
        "create",
        json!({"collection": "users", "data": {"id": "u3", "name": "Cara"}}),
    );
    scheduler.advance(10);
    assert_eq!(events.lock().unwrap().len(), 2);
}

#[test]
fn watch_by_id_emits_null_after_delete() {
    let (mut runtime, scheduler) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users": [{"id": "u1", "name": "Alice"}]}),
    );
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events_clone = Arc::clone(&events);
    expect_ok(
        &runtime.subscribe_watch_by_id_json(
            handle,
            json!({"collection": "users", "id": "u1"})
                .to_string()
                .as_str(),
            move |value| events_clone.lock().unwrap().push(value),
        ),
    );
    dispatch(
        &mut runtime,
        handle,
        "delete",
        json!({"collection": "users", "id": "u1"}),
    );
    scheduler.advance(10);
    let guard = events.lock().unwrap();
    assert_eq!(guard.len(), 2);
    assert_eq!(guard[1], Value::Null);
}

#[test]
fn watch_requires_scheduler_when_not_injected() {
    let mut runtime = Runtime::new();
    runtime
        .callbacks_mut()
        .register_default("scoreDefault", || json!(7));
    let handle = create_database(&mut runtime, vec![users_descriptor()], json!({}));
    let error = expect_error_tag(
        &runtime.subscribe_watch_json(
            handle,
            json!({"collection": "users"}).to_string().as_str(),
            |_| {},
        ),
        "OperationError",
    );
    assert_eq!(error["reason"], json!("missing-reactive-scheduler"));
}

#[test]
fn unsubscribe_missing_subscription_returns_false() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(&mut runtime, vec![users_descriptor()], json!({}));
    assert_eq!(
        expect_ok(&runtime.unsubscribe_json(handle, 999)),
        json!(false)
    );
}
