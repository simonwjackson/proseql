use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use proseql_engine::{
    callbacks::CallbackRegistry,
    clock::FixedClock,
    collection::Collection,
    descriptor::{
        CollectionDescriptor, IdStrategy, RelationshipDescriptor, RelationshipKind, SchemaNode,
        StructField, ValidationMode,
    },
    errors::EngineError,
    id_gen::SequentialGenerator,
    reactive::ChangeOperation,
    relationships::{CascadeOption, Database, DeleteRelationshipsOptions},
    transactions::TransactionPersistenceHook,
};
use serde_json::{json, Value};

fn base_descriptor(name: &str, schema: SchemaNode) -> CollectionDescriptor {
    CollectionDescriptor {
        name: name.into(),
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
    let mut descriptor = base_descriptor("users", user_schema());
    descriptor.relationships = vec![
        (
            "posts".into(),
            RelationshipDescriptor {
                kind: RelationshipKind::Inverse,
                target: "posts".into(),
                foreign_key: Some("authorId".into()),
            },
        ),
        (
            "company".into(),
            RelationshipDescriptor {
                kind: RelationshipKind::Ref,
                target: "companies".into(),
                foreign_key: Some("companyId".into()),
            },
        ),
    ];
    descriptor
}

fn posts_descriptor() -> CollectionDescriptor {
    let mut descriptor = base_descriptor("posts", post_schema());
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
    let mut descriptor = base_descriptor("companies", company_schema());
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

fn seed(mut collection: Collection, values: Vec<Value>) -> Collection {
    for value in values {
        collection.create(value).expect("seed");
    }
    collection
}

fn make_db() -> Database {
    let registry = Arc::new(CallbackRegistry::new());
    let users = seed(
        Collection::new_with_clock(
            "users",
            users_descriptor(),
            Arc::clone(&registry),
            Box::new(SequentialGenerator::new("user")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
        vec![json!({"id":"u1","name":"Alice","companyId":"c1"})],
    );
    let posts = seed(
        Collection::new_with_clock(
            "posts",
            posts_descriptor(),
            Arc::clone(&registry),
            Box::new(SequentialGenerator::new("post")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
        vec![json!({"id":"p1","title":"Hello","authorId":"u1"})],
    );
    let companies = seed(
        Collection::new_with_clock(
            "companies",
            companies_descriptor(),
            Arc::clone(&registry),
            Box::new(SequentialGenerator::new("company")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
        vec![json!({"id":"c1","name":"Acme"})],
    );
    let mut collections = IndexMap::new();
    collections.insert("users".into(), users);
    collections.insert("posts".into(), posts);
    collections.insert("companies".into(), companies);
    Database::new(collections, registry)
}

#[derive(Default)]
struct Recorder {
    scheduled: Mutex<Vec<String>>,
}

impl TransactionPersistenceHook for Recorder {
    fn schedule(&self, collection: &str) {
        self.scheduled.lock().unwrap().push(collection.to_owned());
    }
}

fn scheduled(recorder: &Recorder) -> Vec<String> {
    recorder.scheduled.lock().unwrap().clone()
}

#[test]
fn manual_transaction_reads_own_writes_and_commit_persists() {
    let mut db = make_db();
    let recorder = Recorder::default();
    let mut tx = db.begin_transaction(Some(&recorder)).unwrap();
    tx.create("users", json!({"id":"u2","name":"Bob"})).unwrap();
    assert_eq!(
        tx.find_by_id("users", "u2").unwrap().unwrap()["name"],
        json!("Bob")
    );
    tx.commit().unwrap();
    assert_eq!(
        db.collection("users").unwrap().get("u2").unwrap()["name"],
        json!("Bob")
    );
    assert_eq!(scheduled(&recorder), vec!["users"]);
}

#[test]
fn rollback_restores_state_and_returns_transaction_error() {
    let mut db = make_db();
    let mut tx = db.begin_transaction(None).unwrap();
    tx.create("users", json!({"id":"u2","name":"Bob"})).unwrap();
    let error = tx.rollback().unwrap_err();
    match error {
        EngineError::Transaction(error) => {
            assert_eq!(
                error.operation,
                proseql_engine::errors::TransactionOperation::Rollback
            );
            assert_eq!(error.reason, "transaction rolled back");
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert!(db.collection("users").unwrap().get("u2").is_none());
}

#[test]
fn callback_transaction_auto_rolls_back_and_rethrows_original_error() {
    let mut db = make_db();
    let error = db
        .transaction::<(), _>(None, |tx| {
            tx.create("users", json!({"id":"u2","name":"Bob"}))?;
            Err(EngineError::Operation(
                proseql_engine::errors::OperationError {
                    operation: "custom".into(),
                    reason: "boom".into(),
                    message: "boom".into(),
                },
            ))
        })
        .unwrap_err();
    assert!(matches!(error, EngineError::Operation(_)));
    assert!(db.collection("users").unwrap().get("u2").is_none());
}

#[test]
fn callback_transaction_commits_on_success() {
    let mut db = make_db();
    let value = db
        .transaction::<_, _>(None, |tx| {
            tx.update("users", "u1", json!({"name":"Alice Updated"}))?;
            Ok("done")
        })
        .unwrap();
    assert_eq!(value, "done");
    assert_eq!(
        db.collection("users").unwrap().get("u1").unwrap()["name"],
        json!("Alice Updated")
    );
}

#[test]
fn nested_callback_transactions_use_nested_reason() {
    let mut db = make_db();
    let error = db
        .transaction::<(), _>(None, |tx| tx.transaction::<(), _>(None, |_| Ok(())))
        .unwrap_err();
    match error {
        EngineError::Transaction(error) => {
            assert_eq!(
                error.operation,
                proseql_engine::errors::TransactionOperation::Begin
            );
            assert_eq!(error.reason, "nested transactions not supported");
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn nested_manual_transactions_use_active_reason() {
    let mut db = make_db();
    let mut tx = db.begin_transaction(None).unwrap();
    let error = tx.begin_transaction(None).unwrap_err();
    match error {
        EngineError::Transaction(error) => {
            assert_eq!(error.reason, "another transaction is already active");
        }
        other => panic!("unexpected error: {other:?}"),
    }
    let _ = tx.rollback();
}

#[test]
fn inactive_transaction_guards_all_mutations() {
    let mut db = make_db();
    let mut tx = db.begin_transaction(None).unwrap();
    tx.commit().unwrap();
    let error = tx
        .create("users", json!({"id":"u2","name":"Bob"}))
        .unwrap_err();
    match error {
        EngineError::Transaction(error) => {
            assert_eq!(error.reason, "transaction is no longer active")
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn second_commit_and_second_rollback_are_inactive_errors() {
    let mut db = make_db();
    let mut tx = db.begin_transaction(None).unwrap();
    tx.commit().unwrap();
    assert!(matches!(
        tx.commit().unwrap_err(),
        EngineError::Transaction(_)
    ));

    let mut tx2 = db.begin_transaction(None).unwrap();
    let _ = tx2.rollback();
    assert!(matches!(
        tx2.rollback().unwrap_err(),
        EngineError::Transaction(_)
    ));
}

#[test]
fn no_reactive_events_are_emitted_during_active_transaction() {
    let mut db = make_db();
    let sub = db.subscribe_change_events();
    let mut tx = db.begin_transaction(None).unwrap();
    tx.create("users", json!({"id":"u2","name":"Bob"})).unwrap();
    assert!(sub.try_recv().is_err());
    tx.commit().unwrap();
    let event = sub.recv().unwrap();
    assert_eq!(event.collection, "users");
    assert_eq!(event.operation, ChangeOperation::Update);
}

#[test]
fn commit_emits_one_update_per_mutated_collection() {
    let mut db = make_db();
    let sub = db.subscribe_change_events();
    let mut tx = db.begin_transaction(None).unwrap();
    tx.create("users", json!({"id":"u2","name":"Bob"})).unwrap();
    tx.update("posts", "p1", json!({"title":"Updated"}))
        .unwrap();
    tx.update("users", "u1", json!({"name":"Alice Updated"}))
        .unwrap();
    tx.commit().unwrap();
    let first = sub.recv().unwrap();
    let second = sub.recv().unwrap();
    let mut collections = vec![first.collection, second.collection];
    collections.sort();
    assert_eq!(collections, vec!["posts", "users"]);
}

#[test]
fn rollback_emits_no_events_and_no_persistence() {
    let mut db = make_db();
    let sub = db.subscribe_change_events();
    let recorder = Recorder::default();
    let mut tx = db.begin_transaction(Some(&recorder)).unwrap();
    tx.create("users", json!({"id":"u2","name":"Bob"})).unwrap();
    let _ = tx.rollback();
    assert!(sub.try_recv().is_err());
    assert!(scheduled(&recorder).is_empty());
}

#[test]
fn mutated_collections_are_deduplicated_and_ordered() {
    let mut db = make_db();
    let mut tx = db.begin_transaction(None).unwrap();
    tx.update("users", "u1", json!({"name":"A1"})).unwrap();
    tx.update("users", "u1", json!({"name":"A2"})).unwrap();
    tx.update("posts", "p1", json!({"title":"T1"})).unwrap();
    let collections = tx.mutated_collections().iter().cloned().collect::<Vec<_>>();
    assert_eq!(collections, vec!["users", "posts"]);
}

#[test]
fn relationship_mutations_track_all_changed_collections() {
    let mut db = make_db();
    let mut tx = db.begin_transaction(None).unwrap();
    tx.create_with_relationships(
        "users",
        json!({"id":"u2","name":"Bob","posts":{"$create":[{"title":"Post"}]}}),
    )
    .unwrap();
    let collections = tx.mutated_collections().iter().cloned().collect::<Vec<_>>();
    assert_eq!(collections, vec!["users", "posts"]);
}

#[test]
fn transaction_query_reads_mutated_state() {
    let mut db = make_db();
    let mut tx = db.begin_transaction(None).unwrap();
    tx.create("users", json!({"id":"u2","name":"Bob"})).unwrap();
    let results = tx.query("users", Default::default(), None).unwrap();
    assert_eq!(results.len(), 2);
    assert!(results.iter().any(|entity| entity["id"] == json!("u2")));
}

#[test]
fn commit_schedules_persistence_once_per_collection_even_after_many_mutations() {
    let mut db = make_db();
    let recorder = Recorder::default();
    let mut tx = db.begin_transaction(Some(&recorder)).unwrap();
    tx.update("users", "u1", json!({"name":"A1"})).unwrap();
    tx.update("users", "u1", json!({"name":"A2"})).unwrap();
    tx.update("posts", "p1", json!({"title":"T1"})).unwrap();
    tx.commit().unwrap();
    assert_eq!(scheduled(&recorder), vec!["users", "posts"]);
}

#[test]
fn read_only_transactions_leave_mutated_collections_empty() {
    let mut db = make_db();
    let tx = db.begin_transaction(None).unwrap();
    assert_eq!(
        tx.find_by_id("users", "u1").unwrap().unwrap()["name"],
        json!("Alice")
    );
    assert!(tx.mutated_collections().is_empty());
}

#[test]
fn commit_after_caught_relationship_error_persists_partial_side_effect_collections() {
    let mut db = make_db();
    let recorder = Recorder::default();
    let sub = db.subscribe_change_events();
    let mut tx = db.begin_transaction(Some(&recorder)).unwrap();

    let error = tx
        .create_with_relationships(
            "users",
            json!({
                "id": "u2",
                "name": 42,
                "posts": {"$create": [{"title": "Nested"}]}
            }),
        )
        .unwrap_err();
    assert!(matches!(error, EngineError::Validation(_)));
    assert!(tx.mutated_collections().iter().any(|name| name == "posts"));

    tx.commit().unwrap();
    assert_eq!(scheduled(&recorder), vec!["posts"]);
    let event = sub.recv().unwrap();
    assert_eq!(event.collection, "posts");
    assert_eq!(event.operation, ChangeOperation::Update);
    assert!(sub.try_recv().is_err());
    assert!(db.collection("posts").unwrap().get("post-1").is_some());
    assert!(db.collection("users").unwrap().get("u2").is_none());
}

#[test]
fn commit_after_relationship_delete_emits_owner_and_related_updates_once() {
    let mut db = make_db();
    let sub = db.subscribe_change_events();
    let mut tx = db.begin_transaction(None).unwrap();
    tx.delete_with_relationships(
        "companies",
        "c1",
        DeleteRelationshipsOptions {
            include: HashMap::from_iter([("employees".to_owned(), CascadeOption::SetNull)]),
            ..DeleteRelationshipsOptions::default()
        },
    )
    .unwrap();
    tx.commit().unwrap();
    let first = sub.recv().unwrap();
    let second = sub.recv().unwrap();
    let mut collections = vec![first.collection, second.collection];
    collections.sort();
    assert_eq!(collections, vec!["companies", "users"]);
}
