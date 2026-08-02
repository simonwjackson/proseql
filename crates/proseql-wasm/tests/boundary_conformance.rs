use std::sync::{Arc, Mutex};

use proseql_engine::clock::FixedClock;
use proseql_engine::descriptor::{
    CollectionDescriptor, ComputedFieldDescriptor, IdStrategy, RelationshipDescriptor,
    RelationshipKind, SchemaNode, StructField, ValidationMode,
};
use proseql_engine::errors::{EngineError, OperationError};
use proseql_engine::id_gen::{IdGenerator, SequentialGenerator};
use proseql_engine::reactive::{ManualReactiveScheduler, ReactiveScheduler, WatchDelivery};
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
fn owned_transaction_session_spans_steps_and_rolls_back_without_snapshot_commands() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users":[{"id":"u1","name":"Alice"}]}),
    );
    let session = expect_ok(&runtime.begin_transaction_json(handle))["sessionHandle"]
        .as_u64()
        .unwrap() as u32;
    let created = expect_ok(
        &runtime.transaction_step_json(
            session,
            "create",
            Some(
                json!({"collection":"users","data":{"id":"u2","name":"Bob"}})
                    .to_string()
                    .as_str(),
            ),
        ),
    );
    assert_eq!(created["id"], json!("u2"));
    let own_write = expect_ok(
        &runtime.transaction_step_json(
            session,
            "findById",
            Some(
                json!({"collection":"users","id":"u2","__proseqlProjectResult":true})
                    .to_string()
                    .as_str(),
            ),
        ),
    );
    assert_eq!(own_write["k"], json!("f"));
    assert!(own_write["r"].is_number(), "{own_write}");
    expect_ok(&runtime.rollback_transaction_json(session));
    let error = expect_error_tag(
        &runtime.dispatch_json(
            handle,
            "findById",
            Some(json!({"collection":"users","id":"u2"}).to_string().as_str()),
        ),
        "NotFoundError",
    );
    assert_eq!(error["id"], json!("u2"));
}

#[test]
fn transaction_defect_poisons_session_and_forces_rollback() {
    let (mut runtime, _) = make_runtime();
    runtime
        .callbacks_mut()
        .register_before_create_hook("panic-create", |_ctx| -> Result<Value, EngineError> {
            panic!("transaction callback defect")
        });
    let mut descriptor = users_descriptor();
    descriptor.before_create_hooks = vec!["panic-create".into()];
    let handle = create_database(
        &mut runtime,
        vec![descriptor],
        json!({"users":[{"id":"u1","name":"Alice"}]}),
    );
    let session = expect_ok(&runtime.begin_transaction_json(handle))["sessionHandle"]
        .as_u64()
        .unwrap() as u32;
    expect_defect(
        &runtime.transaction_step_json(
            session,
            "create",
            Some(
                json!({"collection":"users","data":{"id":"u2","name":"Bob"}})
                    .to_string()
                    .as_str(),
            ),
        ),
    );
    let step = expect_error_tag(
        &runtime.transaction_step_json(
            session,
            "findById",
            Some(json!({"collection":"users","id":"u1"}).to_string().as_str()),
        ),
        "OperationError",
    );
    assert_eq!(step["reason"], json!("session-poisoned"));
    let commit = expect_error_tag(&runtime.commit_transaction_json(session), "OperationError");
    assert_eq!(commit["reason"], json!("session-poisoned"));
    assert_eq!(
        dispatch(
            &mut runtime,
            handle,
            "findById",
            json!({"collection":"users","id":"u1"})
        )["name"],
        json!("Alice")
    );
}

#[test]
fn owned_transaction_commit_returns_one_journal_and_projection_delta() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users":[{"id":"u1","name":"Alice"}]}),
    );
    let session = expect_ok(&runtime.begin_transaction_json(handle))["sessionHandle"]
        .as_u64()
        .unwrap() as u32;
    expect_ok(
        &runtime.transaction_step_json(
            session,
            "update",
            Some(
                json!({"collection":"users","id":"u1","data":{"name":"Updated"}})
                    .to_string()
                    .as_str(),
            ),
        ),
    );
    let raw = runtime.commit_transaction_json(session);
    let response = parse_response(&raw);
    assert_eq!(response["kind"], json!("ok"), "{response}");
    assert_eq!(response["value"]["changedCollections"], json!(["users"]));
    assert_eq!(response["value"]["journalEntries"], json!(1));
    assert!(response["value"]["journalBytes"].as_u64().unwrap() > 0);
    assert!(response.get("projection").is_some());
    assert_eq!(
        dispatch(
            &mut runtime,
            handle,
            "findById",
            json!({"collection":"users","id":"u1"}),
        )["name"],
        json!("Updated")
    );
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
fn typed_partial_relationship_effect_carries_projection_sync_on_the_error_response() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor(), companies_descriptor()],
        json!({}),
    );
    let response = parse_response(
        &runtime.dispatch_json(
            handle,
            "createWithRelationships",
            Some(
                json!({
                    "collection": "users",
                    "data": {
                        "id": "u1",
                        "company": {"$create": {"id": "c1", "name": "Created first"}}
                    }
                })
                .to_string()
                .as_str(),
            ),
        ),
    );
    assert_eq!(response["kind"], json!("error"));
    assert_eq!(response["error"]["_tag"], json!("ValidationError"));
    assert_eq!(
        response["projection"]["changes"][0]["collection"],
        json!("companies")
    );
    assert_eq!(
        response["projection"]["changes"][0]["id"],
        json!("fallback-1")
    );
    assert!(response["projection"]["changes"][0].get("value").is_none());
    let dumped = dispatch_no_payload(&mut runtime, handle, "dumpAll");
    assert_eq!(dumped["companies"][0]["name"], json!("Created first"));
    assert!(dumped["users"].as_array().unwrap().is_empty());
}

#[test]
fn transaction_typed_partial_effect_can_be_caught_and_committed_with_projection_sync() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor(), companies_descriptor()],
        json!({}),
    );
    let session = expect_ok(&runtime.begin_transaction_json(handle))["sessionHandle"]
        .as_u64()
        .unwrap() as u32;
    let response = parse_response(
        &runtime.transaction_step_json(
            session,
            "createWithRelationships",
            Some(
                json!({
                    "collection": "users",
                    "data": {
                        "id": "u1",
                        "company": {"$create": {"id": "c1", "name": "Created first"}}
                    }
                })
                .to_string()
                .as_str(),
            ),
        ),
    );
    assert_eq!(response["kind"], json!("error"));
    assert_eq!(response["error"]["_tag"], json!("ValidationError"));
    assert_eq!(
        response["projection"]["changes"][0]["collection"],
        json!("companies")
    );
    let committed = expect_ok(&runtime.commit_transaction_json(session));
    assert_eq!(committed["changedCollections"], json!(["companies"]));
    let dumped = dispatch_no_payload(&mut runtime, handle, "dumpAll");
    assert_eq!(dumped["companies"][0]["name"], json!("Created first"));
    assert!(dumped["users"].as_array().unwrap().is_empty());
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
fn relationship_side_effect_carries_value_for_a_materialized_non_owner_row() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor(), companies_descriptor()],
        json!({
            "companies": [{"id": "c1", "name": "Before"}],
            "users": [{"id": "u1", "name": "Alice", "companyId": "c1"}]
        }),
    );
    let projected = expect_ok(
        &runtime.dispatch_projected_json(
            handle,
            "findById",
            Some(
                json!({"collection": "companies", "id": "c1"})
                    .to_string()
                    .as_str(),
            ),
        ),
    );
    assert_eq!(projected["r"][2]["name"], json!("Before"));

    let response = parse_response(
        &runtime.dispatch_json(
            handle,
            "updateWithRelationships",
            Some(
                json!({
                    "collection": "users",
                    "id": "u1",
                    "data": {"company": {"$update": {"name": "After"}}}
                })
                .to_string()
                .as_str(),
            ),
        ),
    );
    assert_eq!(response["kind"], json!("ok"));
    let related = response["projection"]["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["collection"] == json!("companies"))
        .unwrap();
    assert_eq!(related["value"]["name"], json!("After"));
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
    let before = expect_ok(&runtime.projection_handles_json(handle))["collections"]["users"][0]
        ["handle"]
        .as_str()
        .unwrap()
        .to_owned();
    dispatch(
        &mut runtime,
        handle,
        "reloadCollection",
        json!({"collection": "users", "records": [{"id": "u1", "name": "Bob"}]}),
    );
    let reset = expect_ok(&runtime.projection_changes_json(handle));
    let dumped = dispatch_no_payload(&mut runtime, handle, "dumpAll");
    assert_eq!(dumped["users"], json!([{"id": "u1", "name": "Bob"}]));
    let after = reset["resetCollections"]["users"][0]["handle"]
        .as_str()
        .unwrap();
    assert_ne!(after, before);
    assert!(reset["resetCollections"]["users"][0].get("value").is_none());
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
    let before = expect_ok(&runtime.projection_handles_json(handle))["collections"]["users"][0]
        ["handle"]
        .as_str()
        .unwrap()
        .to_owned();
    let committed = dispatch(
        &mut runtime,
        handle,
        "commitSnapshotTransaction",
        json!({
            "collections": {
                "users": [{"id": "u1", "name": "Bob"}],
                "companies": [{"id": "c1", "name": "Acme"}]
            }
        }),
    );
    assert_eq!(committed["changedCollections"], json!(["users"]));
    let reset = expect_ok(&runtime.projection_changes_json(handle));
    assert_eq!(
        dispatch_no_payload(&mut runtime, handle, "dumpAll")["users"],
        json!([{"id": "u1", "name": "Bob"}])
    );
    assert_ne!(
        reset["resetCollections"]["users"][0]["handle"],
        json!(before)
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
    assert_eq!(dumped["users"], json!([{"id": "u1", "name": "Bob"}]));
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
fn fast_find_by_id_authorizes_exact_collection_id_slot_and_token() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor(), posts_descriptor()],
        json!({
            "users":[{"id":"u1","name":"Alice"}],
            "posts":[{"id":"u1","title":"Same id, different collection"}]
        }),
    );
    let handles = expect_ok(&runtime.projection_handles_json(handle));
    let user_handle = handles["collections"]["users"][0]["handle"]
        .as_str()
        .unwrap();
    let token = user_handle
        .split(':')
        .map(|part| part.parse::<u32>().unwrap())
        .collect::<Vec<_>>();
    let (slot, generation, revision) = (token[0], token[1], token[2]);

    assert_eq!(
        runtime.fast_find_by_id(handle, 0, "u1", slot, generation, revision),
        0
    );
    expect_ok(&runtime.dispatch_projected_json(
        handle,
        "findById",
        Some(json!({"collection":"users","id":"u1"}).to_string().as_str()),
    ));
    assert_eq!(
        runtime.fast_find_by_id(handle, 0, "u1", slot, generation, revision),
        1
    );
    assert_eq!(
        runtime.fast_find_by_id(handle, 1, "u1", slot, generation, revision),
        0,
        "wrong collection index"
    );
    assert_eq!(
        runtime.fast_find_by_id(handle, 0, "missing", slot, generation, revision),
        0,
        "wrong requested id"
    );
    assert_eq!(
        runtime.fast_find_by_id(handle, 0, "u1", slot + 1, generation, revision),
        0,
        "wrong slot"
    );
    assert_eq!(
        runtime.fast_find_by_id(handle, 0, "u1", slot, generation + 1, revision),
        0,
        "wrong generation"
    );
    assert_eq!(
        runtime.fast_find_by_id(handle, 0, "u1", slot, generation, revision + 1),
        0,
        "wrong revision"
    );
    assert_eq!(
        runtime.fast_find_by_id(handle, 99, "u1", slot, generation, revision),
        0,
        "out-of-range collection index"
    );

    expect_ok(&runtime.dispatch_json(
        handle,
        "delete",
        Some(json!({"collection":"users","id":"u1"}).to_string().as_str()),
    ));
    expect_ok(
        &runtime.dispatch_json(
            handle,
            "create",
            Some(
                json!({"collection":"users","data":{"id":"u2","name":"Reused"}})
                    .to_string()
                    .as_str(),
            ),
        ),
    );
    assert_eq!(
        runtime.fast_find_by_id(handle, 0, "u2", slot, generation, revision),
        0,
        "reused slot rejects the deleted row token"
    );
    let reused_handles = expect_ok(&runtime.projection_handles_json(handle));
    let reused_handle = reused_handles["collections"]["users"][0]["handle"]
        .as_str()
        .unwrap();
    let reused = reused_handle
        .split(':')
        .map(|part| part.parse::<u32>().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(reused[0], slot);
    assert!(reused[1] > generation);
    expect_ok(&runtime.dispatch_projected_json(
        handle,
        "findById",
        Some(json!({"collection":"users","id":"u2"}).to_string().as_str()),
    ));
    assert_eq!(
        runtime.fast_find_by_id(handle, 0, "u2", reused[0], reused[1], reused[2]),
        1,
        "the reused slot accepts only its current materialized token"
    );
}

#[test]
fn projected_reads_use_stable_revision_safe_handles_and_ordered_descriptors() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users":[{"id":"u1","name":"Alice"},{"id":"u2","name":"Bob"}]}),
    );

    let handles = expect_ok(&runtime.projection_handles_json(handle));
    let first_row = handles["collections"]["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == json!("u1"))
        .unwrap();
    let first_handle = first_row["handle"].as_str().unwrap().to_owned();

    let descriptor = expect_ok(
        &runtime.dispatch_projected_json(
            handle,
            "query",
            Some(
                json!({"collection":"users","query":{"sort":{"id":"desc"}}})
                    .to_string()
                    .as_str(),
            ),
        ),
    );
    assert_eq!(descriptor["k"], json!("q"));
    assert_eq!(descriptor["r"][0][1], json!("u2"));
    assert_eq!(descriptor["r"][1][1], json!("u1"));
    assert_eq!(descriptor["r"][1][2]["name"], json!("Alice"));
    let repeated = expect_ok(&runtime.dispatch_projected_json(
        handle,
        "findById",
        Some(json!({"collection":"users","id":"u1"}).to_string().as_str()),
    ));
    let first_slot = first_handle
        .split(':')
        .next()
        .unwrap()
        .parse::<usize>()
        .unwrap();
    assert_eq!(repeated["k"], json!("f"));
    assert_eq!(repeated["r"], json!(first_slot));

    let deleted_response = parse_response(&runtime.dispatch_json(
        handle,
        "delete",
        Some(json!({"collection":"users","id":"u1"}).to_string().as_str()),
    ));
    assert_eq!(
        deleted_response["projection"]["changes"][0]["handle"],
        json!(first_handle)
    );
    assert_eq!(
        deleted_response["projection"]["changes"][0]["deleted"],
        json!(true)
    );

    let recreated_response = parse_response(
        &runtime.dispatch_json(
            handle,
            "create",
            Some(
                json!({"collection":"users","data":{"id":"u1","name":"Recreated"}})
                    .to_string()
                    .as_str(),
            ),
        ),
    );
    assert_eq!(recreated_response["value"]["name"], json!("Recreated"));
    let recreated = &recreated_response["projection"];
    let recreated_handle = recreated["changes"][0]["handle"].as_str().unwrap();
    assert_ne!(recreated_handle, first_handle);
    assert!(recreated["changes"][0].get("value").is_none());
}

#[test]
fn unchanged_upsert_many_rows_publish_observed_materialization_metadata() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users":[{"id":"u1","name":"Alice"}]}),
    );
    expect_ok(&runtime.projection_handles_json(handle));

    let response = parse_response(
        &runtime.dispatch_json(
            handle,
            "upsertMany",
            Some(
                json!({
                    "collection":"users",
                    "items":[{
                        "where":{"id":"u1"},
                        "create":{"name":"unused"},
                        "update":{"name":"Alice"}
                    }]
                })
                .to_string()
                .as_str(),
            ),
        ),
    );
    assert_eq!(response["value"]["unchanged"][0]["id"], json!("u1"));
    let observed = &response["projection"]["changes"][0];
    assert_eq!(observed["id"], json!("u1"));
    assert!(observed["handle"].as_str().is_some());
    assert!(observed.get("value").is_none());

    expect_ok(
        &runtime.synchronize_projection_json(
            handle,
            &json!([{
                "collection":"users",
                "id":"u1",
                "handle":observed["handle"],
                "value":{"id":"u1","name":"Caller mutation"}
            }])
            .to_string(),
        ),
    );
    assert_eq!(
        dispatch(
            &mut runtime,
            handle,
            "findById",
            json!({"collection":"users","id":"u1"}),
        )["name"],
        json!("Caller mutation")
    );
}

#[test]
fn failed_upsert_many_does_not_mark_an_unobserved_projection_handle() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users":[{"id":"u1","name":"Alice"}]}),
    );
    expect_ok(&runtime.projection_handles_json(handle));

    let response = parse_response(
        &runtime.dispatch_json(
            handle,
            "upsertMany",
            Some(
                json!({
                    "collection":"users",
                    "items":[{
                        "where":{"id":"u1"},
                        "create":{"name":"unused"},
                        "update":{"name":42}
                    }]
                })
                .to_string()
                .as_str(),
            ),
        ),
    );
    assert_eq!(response["kind"], json!("error"));
    assert_eq!(response["projection"]["changes"], json!([]));
    let projected = expect_ok(&runtime.dispatch_projected_json(
        handle,
        "findById",
        Some(json!({"collection":"users","id":"u1"}).to_string().as_str()),
    ));
    assert_eq!(projected["r"][2]["name"], json!("Alice"));
}

#[test]
fn contiguous_query_positions_authorize_distinct_equal_storage_rows() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users":[{"id":"u1","name":"Alice"},{"id":"u2","name":"Bob"}]}),
    );
    let handles = expect_ok(&runtime.projection_handles_json(handle));
    for id in ["u1", "u2"] {
        expect_ok(&runtime.dispatch_projected_json(
            handle,
            "findById",
            Some(json!({"collection":"users","id":id}).to_string().as_str()),
        ));
        let row_handle = handles["collections"]["users"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == json!(id))
            .unwrap()["handle"]
            .as_str()
            .unwrap();
        expect_ok(
            &runtime.synchronize_projection_json(
                handle,
                &json!([{
                    "collection":"users",
                    "id":id,
                    "handle":row_handle,
                    "value":{"id":"shared","name":"Same"}
                }])
                .to_string(),
            ),
        );
    }

    let response = expect_ok(
        &runtime.dispatch_projected_json(
            handle,
            "query",
            Some(
                json!({"collection":"users","query":{}})
                    .to_string()
                    .as_str(),
            ),
        ),
    );
    assert_eq!(response["k"], json!("c"));
    let additions = response["a"].as_array().unwrap();
    assert_eq!(additions.len(), 2);
    assert_eq!(additions[0][0], json!(0));
    assert_eq!(additions[1][0], json!(1));
    assert_eq!(additions[0][1], json!(0));
    assert_eq!(additions[1][1], json!(1));
}

#[test]
fn caller_mutated_projection_sync_is_authorized_and_not_a_formal_mutation() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users":[{"id":"u1","name":"Alice"}]}),
    );
    let handles = expect_ok(&runtime.projection_handles_json(handle));
    expect_ok(&runtime.dispatch_projected_json(
        handle,
        "findById",
        Some(json!({"collection":"users","id":"u1"}).to_string().as_str()),
    ));
    let row_handle = handles["collections"]["users"][0]["handle"]
        .as_str()
        .unwrap();
    expect_ok(
        &runtime.synchronize_projection_json(
            handle,
            &json!([{
                "collection":"users",
                "id":"u1",
                "handle":row_handle,
                "value":{"id":"u1","name":"Caller mutation"}
            }])
            .to_string(),
        ),
    );
    assert!(runtime.last_changes(handle).unwrap().is_empty());
    let found = dispatch(
        &mut runtime,
        handle,
        "findById",
        json!({"collection":"users","id":"u1"}),
    );
    assert_eq!(found["name"], json!("Caller mutation"));

    let stale = runtime.synchronize_projection_json(
        handle,
        &json!([{
            "collection":"users",
            "id":"u1",
            "handle":"stale",
            "value":{"id":"u1","name":"Rejected"}
        }])
        .to_string(),
    );
    assert_eq!(
        expect_error_tag(&stale, "OperationError")["reason"],
        json!("stale-materialized-handle")
    );
}

#[test]
fn projected_reads_inline_only_rust_authored_overlays() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users":[{"id":"u1","name":"Alice"}]}),
    );
    let descriptor = expect_ok(
        &runtime.dispatch_projected_json(
            handle,
            "query",
            Some(
                json!({"collection":"users","query":{"select":{"name":true}}})
                    .to_string()
                    .as_str(),
            ),
        ),
    );
    assert_eq!(descriptor["k"], json!("q"));
    assert!(descriptor["r"][0][0].is_null());
    assert_eq!(descriptor["r"][0][1], json!({"name":"Alice"}));
}

#[test]
fn unobserved_bulk_mutations_publish_metadata_without_materializing_values() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(
        &mut runtime,
        vec![users_descriptor()],
        json!({"users":[{"id":"u1","name":"Alice"},{"id":"u2","name":"Bob"}]}),
    );
    let response = parse_response(
        &runtime.dispatch_json(
            handle,
            "updateMany",
            Some(
                json!({"collection":"users","where":{},"data":{"name":"Updated"}})
                    .to_string()
                    .as_str(),
            ),
        ),
    );
    assert_eq!(response["kind"], json!("ok"));
    let sync = &response["projection"];
    assert_eq!(sync["changes"].as_array().unwrap().len(), 2);
    assert!(sync["changes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|change| change.get("value").is_none()));
}

#[test]
fn successful_mutation_publishes_exact_authoritative_delta() {
    let (mut runtime, _) = make_runtime();
    let handle = create_database(&mut runtime, vec![users_descriptor()], json!({}));

    expect_ok(
        &runtime.dispatch_json(
            handle,
            "create",
            Some(
                json!({"collection":"users","data":{"id":"u1","name":"Alice"}})
                    .to_string()
                    .as_str(),
            ),
        ),
    );

    let changes = runtime.last_changes(handle).unwrap();
    let changes = changes.entities().collect::<Vec<_>>();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].collection, "users");
    assert_eq!(changes[0].id, "u1");
    assert_eq!(changes[0].before, None);
    assert_eq!(changes[0].after.as_ref().unwrap()["name"], json!("Alice"));
    assert_eq!(changes[0].before_position, None);
    assert_eq!(changes[0].after_position, Some(0));
}

#[test]
fn panic_after_mutation_does_not_publish_a_safe_delta() {
    let (mut runtime, _) = make_runtime();
    runtime
        .callbacks_mut()
        .register_after_create_hook("panic-after-create", |_| panic!("after create panic"));
    let mut descriptor = users_descriptor();
    descriptor.after_create_hooks = vec!["panic-after-create".into()];
    let handle = create_database(&mut runtime, vec![descriptor], json!({}));

    let defect = expect_defect(
        &runtime.dispatch_json(
            handle,
            "create",
            Some(
                json!({"collection":"users","data":{"id":"u1","name":"Alice"}})
                    .to_string()
                    .as_str(),
            ),
        ),
    );
    assert!(defect["message"]
        .as_str()
        .unwrap()
        .contains("unexpected defect"));
    assert_eq!(defect["projection"]["invalidated"], json!(true));
    assert!(runtime.last_changes(handle).unwrap().is_empty());

    // The mutation itself happened; only its delta is unsafe after a defect.
    let dumped = dispatch_no_payload(&mut runtime, handle, "dumpAll");
    assert_eq!(dumped["users"][0]["id"], json!("u1"));
    let projected = expect_ok(&runtime.dispatch_projected_json(
        handle,
        "findById",
        Some(json!({"collection":"users","id":"u1"}).to_string().as_str()),
    ));
    assert_eq!(projected["k"], json!("f"));
    assert_eq!(projected["r"][1], json!("u1"));
    assert_eq!(projected["r"][2]["name"], json!("Alice"));
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
        move |delivery| {
            if let WatchDelivery::Value(value) = delivery {
                events_clone.lock().unwrap().push(value);
            }
        },
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

fn typed_watch_error(phase: &str) -> EngineError {
    EngineError::Operation(OperationError {
        operation: "watch".into(),
        reason: format!("typed-{phase}"),
        message: format!("typed watch {phase} failure"),
    })
}

#[test]
fn typed_watch_errors_cross_initial_immediate_and_debounced_runtime_deliveries() {
    let (mut initial_runtime, _) = make_runtime();
    let initial_error = typed_watch_error("initial");
    let initial_callback_error = initial_error.clone();
    initial_runtime
        .callbacks_mut()
        .register_computed("typedWatch", move |_| {
            std::panic::panic_any(initial_callback_error.clone())
        });
    let mut initial_descriptor = users_descriptor();
    initial_descriptor.computed_fields = vec![ComputedFieldDescriptor {
        name: "typed".into(),
        callback_id: "typedWatch".into(),
    }];
    let initial_handle = create_database(
        &mut initial_runtime,
        vec![initial_descriptor],
        json!({"users": [{"id": "u1", "name": "Alice"}]}),
    );
    let initial_deliveries = Arc::new(Mutex::new(Vec::new()));
    let initial_capture = Arc::clone(&initial_deliveries);
    let initial_subscription = expect_ok(
        &initial_runtime.subscribe_watch_json(
            initial_handle,
            json!({"collection":"users", "config":{"debounceMs":0}})
                .to_string()
                .as_str(),
            move |delivery| initial_capture.lock().unwrap().push(delivery),
        ),
    )
    .as_u64()
    .unwrap() as u32;
    assert_eq!(
        *initial_deliveries.lock().unwrap(),
        vec![WatchDelivery::Error(initial_error)]
    );
    assert_eq!(
        expect_ok(&initial_runtime.unsubscribe_json(initial_handle, initial_subscription)),
        json!(true)
    );
    assert_eq!(
        expect_ok(&initial_runtime.unsubscribe_json(initial_handle, initial_subscription)),
        json!(false)
    );

    for (phase, debounce_ms) in [("immediate", 0), ("debounced", 25)] {
        let (mut runtime, scheduler) = make_runtime();
        let expected = typed_watch_error(phase);
        let callback_error = expected.clone();
        runtime
            .callbacks_mut()
            .register_computed("typedWatch", move |value| {
                if value["name"] == "boom" {
                    std::panic::panic_any(callback_error.clone());
                }
                value["id"].clone()
            });
        let mut descriptor = users_descriptor();
        descriptor.computed_fields = vec![ComputedFieldDescriptor {
            name: "typed".into(),
            callback_id: "typedWatch".into(),
        }];
        let handle = create_database(
            &mut runtime,
            vec![descriptor],
            json!({"users": [{"id": "u1", "name": "Alice"}]}),
        );
        let deliveries = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::clone(&deliveries);
        let subscription = expect_ok(
            &runtime.subscribe_watch_json(
                handle,
                json!({"collection":"users", "config":{"debounceMs":debounce_ms}})
                    .to_string()
                    .as_str(),
                move |delivery| capture.lock().unwrap().push(delivery),
            ),
        )
        .as_u64()
        .unwrap() as u32;
        assert!(matches!(
            deliveries.lock().unwrap().as_slice(),
            [WatchDelivery::Value(_)]
        ));
        dispatch(
            &mut runtime,
            handle,
            "update",
            json!({"collection":"users", "id":"u1", "data":{"name":"boom"}}),
        );
        if debounce_ms > 0 {
            assert_eq!(deliveries.lock().unwrap().len(), 1);
        }
        scheduler.advance(debounce_ms as u64);
        let captured = deliveries.lock().unwrap().clone();
        assert_eq!(captured.len(), 2);
        assert_eq!(captured[1], WatchDelivery::Error(expected));
        assert_eq!(
            expect_ok(&runtime.unsubscribe_json(handle, subscription)),
            json!(true)
        );
        assert_eq!(
            expect_ok(&runtime.unsubscribe_json(handle, subscription)),
            json!(false)
        );
    }
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
            move |delivery| {
                if let WatchDelivery::Value(value) = delivery {
                    events_clone.lock().unwrap().push(value);
                }
            },
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
