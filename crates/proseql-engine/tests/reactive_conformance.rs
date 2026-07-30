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
    query::QueryInput,
    reactive::{
        ChangeEvent, ChangeOperation, ManualReactiveScheduler, ReactiveScheduler,
        UnsupportedReactiveScheduler, WatchQueryConfig,
    },
    relationships::{CascadeOption, Database, DeleteRelationshipsOptions},
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

fn book_schema() -> SchemaNode {
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
                name: "author".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "year".into(),
                schema: SchemaNode::Num,
            },
            StructField {
                name: "genre".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "meta".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Unknown)),
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

fn books_descriptor() -> CollectionDescriptor {
    base_descriptor("books", book_schema())
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

fn people_schema() -> SchemaNode {
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
                name: "managerId".into(),
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

fn people_descriptor() -> CollectionDescriptor {
    let mut descriptor = base_descriptor("people", people_schema());
    descriptor.relationships = vec![(
        "manager".into(),
        RelationshipDescriptor {
            kind: RelationshipKind::Ref,
            target: "people".into(),
            foreign_key: Some("managerId".into()),
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

fn make_books_db_with_scheduler(books: Vec<Value>) -> (Database, Arc<ManualReactiveScheduler>) {
    let scheduler = Arc::new(ManualReactiveScheduler::default());
    let registry = Arc::new(CallbackRegistry::new());
    let books = seed(
        Collection::new_with_clock(
            "books",
            books_descriptor(),
            Arc::clone(&registry),
            Box::new(SequentialGenerator::new("book")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
        books,
    );
    let mut collections = IndexMap::new();
    collections.insert("books".into(), books);
    (
        Database::new_with_reactive_scheduler(
            collections,
            registry,
            Arc::clone(&scheduler) as Arc<dyn ReactiveScheduler>,
        ),
        scheduler,
    )
}

fn make_books_db_with_registry_and_scheduler(
    books: Vec<Value>,
    registry: Arc<CallbackRegistry>,
    scheduler: Arc<dyn ReactiveScheduler>,
) -> Database {
    let books = seed(
        Collection::new_with_clock(
            "books",
            books_descriptor(),
            Arc::clone(&registry),
            Box::new(SequentialGenerator::new("book")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
        books,
    );
    let mut collections = IndexMap::new();
    collections.insert("books".into(), books);
    Database::new_with_reactive_scheduler(collections, registry, scheduler)
}

fn make_books_db_with_arc_scheduler(
    books: Vec<Value>,
    scheduler: Arc<dyn ReactiveScheduler>,
) -> Database {
    make_books_db_with_registry_and_scheduler(books, Arc::new(CallbackRegistry::new()), scheduler)
}

fn make_relationship_db_with_scheduler() -> (Database, Arc<ManualReactiveScheduler>) {
    let scheduler = Arc::new(ManualReactiveScheduler::default());
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

    (
        Database::new_with_reactive_scheduler(
            collections,
            registry,
            Arc::clone(&scheduler) as Arc<dyn ReactiveScheduler>,
        ),
        scheduler,
    )
}

fn books_fixture() -> Vec<Value> {
    vec![
        json!({"id":"1","title":"Dune","author":"Frank Herbert","year":1965,"genre":"sci-fi","meta":{"rank":1,"note":"a"}}),
        json!({"id":"2","title":"Neuromancer","author":"William Gibson","year":1984,"genre":"sci-fi","meta":{"rank":2,"note":"b"}}),
        json!({"id":"3","title":"The Hobbit","author":"J.R.R. Tolkien","year":1937,"genre":"fantasy","meta":{"rank":3,"note":"c"}}),
    ]
}

fn make_people_db_with_scheduler(people: Vec<Value>) -> (Database, Arc<ManualReactiveScheduler>) {
    let scheduler = Arc::new(ManualReactiveScheduler::default());
    let registry = Arc::new(CallbackRegistry::new());
    let people = seed(
        Collection::new_with_clock(
            "people",
            people_descriptor(),
            Arc::clone(&registry),
            Box::new(SequentialGenerator::new("person")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
        people,
    );
    let mut collections = IndexMap::new();
    collections.insert("people".into(), people);
    (
        Database::new_with_reactive_scheduler(
            collections,
            registry,
            Arc::clone(&scheduler) as Arc<dyn ReactiveScheduler>,
        ),
        scheduler,
    )
}

fn drain_events(sub: &proseql_engine::reactive::ChangeEventSubscription) -> Vec<ChangeEvent> {
    let mut values = Vec::new();
    while let Ok(value) = sub.try_recv() {
        values.push(value);
    }
    values
}

#[test]
fn change_event_serializes_to_ts_wire_shape() {
    let event = ChangeEvent {
        collection: "books".into(),
        operation: ChangeOperation::Reload,
    };
    assert_eq!(
        serde_json::to_value(&event).unwrap(),
        json!({"collection":"books","operation":"reload"})
    );
}

#[test]
fn watch_initial_emits_current_results_and_empty_array() {
    let (db, _) = make_books_db_with_scheduler(books_fixture());
    let all = db.watch("books", WatchQueryConfig::default()).unwrap();
    let empty_db = make_books_db_with_scheduler(vec![]).0;
    let empty = empty_db
        .watch("books", WatchQueryConfig::default())
        .unwrap();

    assert_eq!(all.try_recv().unwrap().as_array().unwrap().len(), 3);
    assert_eq!(empty.try_recv().unwrap(), json!([]));
}

#[test]
fn watch_applies_filter_sort_offset_limit_and_select_pipeline() {
    let (db, _) = make_books_db_with_scheduler(books_fixture());
    let sub = db
        .watch(
            "books",
            WatchQueryConfig {
                r#where: Some(json!({"genre":"sci-fi"})),
                sort: vec![("year".into(), proseql_engine::query::SortOrder::Desc)],
                offset: Some(1),
                limit: Some(1),
                select: Some(json!(["title", "year"])),
                debounce_ms: None,
            },
        )
        .unwrap();

    assert_eq!(
        sub.try_recv().unwrap(),
        json!([{"title":"Dune","year":1965}])
    );
}

#[test]
fn watch_dedups_same_collection_filtered_out_mutations_and_ignores_unrelated_collections() {
    let (mut db, scheduler) = make_books_db_with_scheduler(books_fixture());
    let books = db
        .watch(
            "books",
            WatchQueryConfig {
                r#where: Some(json!({"genre":"sci-fi"})),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    let initial = books.try_recv().unwrap();
    assert_eq!(initial.as_array().unwrap().len(), 2);

    db.create(
        "books",
        json!({"id":"4","title":"The Name of the Wind","author":"Patrick Rothfuss","year":2007,"genre":"fantasy"}),
    )
    .unwrap();
    scheduler.advance(10);
    assert!(books.try_recv().is_err());

    let (mut rel_db, rel_scheduler) = make_relationship_db_with_scheduler();
    let users = rel_db.watch("users", WatchQueryConfig::default()).unwrap();
    users.try_recv().unwrap();
    rel_db
        .create("posts", json!({"id":"p2","title":"Other","authorId":"u1"}))
        .unwrap();
    rel_scheduler.advance(10);
    assert!(users.try_recv().is_err());
}

#[test]
fn watch_dedup_is_structural_and_order_sensitive() {
    let (mut db, scheduler) = make_books_db_with_scheduler(vec![
        json!({"id":"1","title":"Dune","author":"Frank Herbert","year":1965,"genre":"sci-fi"}),
        json!({"id":"2","title":"Neuromancer","author":"William Gibson","year":1984,"genre":"sci-fi"}),
    ]);
    let sub = db.watch("books", WatchQueryConfig::default()).unwrap();
    let first = sub.try_recv().unwrap();
    assert_eq!(
        first
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["1", "2"]
    );

    db.reload_collection(
        "books",
        vec![
            json!({"id":"2","title":"Neuromancer","author":"William Gibson","year":1984,"genre":"sci-fi","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z"}),
            json!({"id":"1","title":"Dune","author":"Frank Herbert","year":1965,"genre":"sci-fi","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z"}),
        ],
    )
    .unwrap();
    scheduler.advance(10);
    let second = sub.try_recv().unwrap();
    assert_eq!(
        second
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["2", "1"]
    );
    assert_ne!(
        serde_json::to_string(&first).unwrap(),
        serde_json::to_string(&second).unwrap()
    );
}

#[test]
fn watch_burst_emits_final_snapshot_at_debounce_fire() {
    let (mut db, scheduler) = make_books_db_with_scheduler(books_fixture());
    let sub = db
        .watch(
            "books",
            WatchQueryConfig {
                sort: vec![("year".into(), proseql_engine::query::SortOrder::Asc)],
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    sub.try_recv().unwrap();

    for i in 0..5 {
        db.update("books", "1", json!({"year": 1965 + i})).unwrap();
    }

    scheduler.advance(9);
    assert!(sub.try_recv().is_err());
    scheduler.advance(1);
    let emission = sub.try_recv().unwrap();
    assert_eq!(emission.as_array().unwrap()[1]["year"], json!(1969));
    assert!(sub.try_recv().is_err());
}

#[test]
fn watch_respects_independent_debounce_intervals() {
    let (mut db, scheduler) = make_books_db_with_scheduler(books_fixture());
    let fast = db
        .watch(
            "books",
            WatchQueryConfig {
                debounce_ms: Some(20),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    let slow = db
        .watch(
            "books",
            WatchQueryConfig {
                debounce_ms: Some(150),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    fast.try_recv().unwrap();
    slow.try_recv().unwrap();

    db.create(
        "books",
        json!({"id":"4","title":"Foundation","author":"Isaac Asimov","year":1951,"genre":"sci-fi"}),
    )
    .unwrap();

    scheduler.advance(20);
    assert_eq!(fast.try_recv().unwrap().as_array().unwrap().len(), 4);
    assert!(slow.try_recv().is_err());
    scheduler.advance(130);
    assert_eq!(slow.try_recv().unwrap().as_array().unwrap().len(), 4);
}

#[test]
fn watch_zero_and_negative_debounce_clamp_to_zero() {
    let (mut db, _) = make_books_db_with_scheduler(books_fixture());
    let zero = db
        .watch(
            "books",
            WatchQueryConfig {
                debounce_ms: Some(0),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    let negative = db
        .watch(
            "books",
            WatchQueryConfig {
                debounce_ms: Some(-5),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    zero.try_recv().unwrap();
    negative.try_recv().unwrap();

    db.create(
        "books",
        json!({"id":"4","title":"Foundation","author":"Isaac Asimov","year":1951,"genre":"sci-fi"}),
    )
    .unwrap();

    assert_eq!(zero.try_recv().unwrap().as_array().unwrap().len(), 4);
    assert_eq!(negative.try_recv().unwrap().as_array().unwrap().len(), 4);
}

#[test]
fn subscription_drop_cleans_up_watch_and_event_counts() {
    let (db, _) = make_books_db_with_scheduler(books_fixture());
    assert_eq!(db.watch_subscription_count(), 0);
    assert_eq!(db.event_subscription_count(), 0);

    let watch = db.watch("books", WatchQueryConfig::default()).unwrap();
    let event = db.subscribe_change_events();
    let callback_values = Arc::new(Mutex::new(Vec::new()));
    let callback_values_clone = Arc::clone(&callback_values);
    let callback = db.watch_with_callback(
        "books",
        WatchQueryConfig::default(),
        Box::new(move |value| callback_values_clone.lock().unwrap().push(value)),
    );

    assert_eq!(db.watch_subscription_count(), 2);
    assert_eq!(db.event_subscription_count(), 1);
    drop(watch);
    drop(event);
    drop(callback);
    assert_eq!(db.watch_subscription_count(), 0);
    assert_eq!(db.event_subscription_count(), 0);
    assert_eq!(callback_values.lock().unwrap().len(), 1);
}

#[test]
fn watch_by_id_existing_missing_update_delete_recreate_and_unrelated_dedup() {
    let (mut db, scheduler) = make_books_db_with_scheduler(books_fixture());
    let existing = db.watch_by_id("books", "1", None).unwrap();
    let missing = db.watch_by_id("books", "9", None).unwrap();

    assert_eq!(existing.try_recv().unwrap()["title"], json!("Dune"));
    assert_eq!(missing.try_recv().unwrap(), Value::Null);

    db.update("books", "1", json!({"title":"Dune Messiah"}))
        .unwrap();
    scheduler.advance(10);
    assert_eq!(existing.try_recv().unwrap()["title"], json!("Dune Messiah"));
    assert!(missing.try_recv().is_err());

    db.delete("books", "1").unwrap();
    scheduler.advance(10);
    assert_eq!(existing.try_recv().unwrap(), Value::Null);

    db.create(
        "books",
        json!({"id":"1","title":"Dune Returns","author":"Frank Herbert","year":1969,"genre":"sci-fi"}),
    )
    .unwrap();
    scheduler.advance(10);
    assert_eq!(existing.try_recv().unwrap()["title"], json!("Dune Returns"));

    db.update("books", "2", json!({"title":"Count Zero"}))
        .unwrap();
    scheduler.advance(10);
    assert!(existing.try_recv().is_err());
}

#[test]
fn raw_change_events_emit_for_successful_singular_crud_and_not_for_failures() {
    let (mut db, _) = make_books_db_with_scheduler(books_fixture());
    let events = db.subscribe_change_events();

    db.create(
        "books",
        json!({"id":"4","title":"Foundation","author":"Isaac Asimov","year":1951,"genre":"sci-fi"}),
    )
    .unwrap();
    db.update("books", "4", json!({"title":"Foundation and Empire"}))
        .unwrap();
    db.delete("books", "4").unwrap();

    assert_eq!(
        drain_events(&events),
        vec![
            ChangeEvent {
                collection: "books".into(),
                operation: ChangeOperation::Create
            },
            ChangeEvent {
                collection: "books".into(),
                operation: ChangeOperation::Update
            },
            ChangeEvent {
                collection: "books".into(),
                operation: ChangeOperation::Delete
            },
        ]
    );

    assert!(matches!(
        db.delete("books", "does-not-exist"),
        Err(EngineError::NotFound(_))
    ));
    assert!(events.try_recv().is_err());
}

#[test]
fn relationship_operations_emit_owner_only_and_skip_noops_and_failures() {
    let (mut db, scheduler) = make_relationship_db_with_scheduler();
    let events = db.subscribe_change_events();
    let users_watch = db.watch("users", WatchQueryConfig::default()).unwrap();
    let posts_watch = db.watch("posts", WatchQueryConfig::default()).unwrap();
    users_watch.try_recv().unwrap();
    posts_watch.try_recv().unwrap();

    db.create_with_relationships(
        "users",
        json!({"id":"u2","name":"Bob","posts":{"$create":{"title":"Nested"}}}),
    )
    .unwrap();
    scheduler.advance(10);
    assert_eq!(
        events.try_recv().unwrap(),
        ChangeEvent {
            collection: "users".into(),
            operation: ChangeOperation::Create
        }
    );
    assert_eq!(users_watch.try_recv().unwrap().as_array().unwrap().len(), 2);
    assert!(posts_watch.try_recv().is_err());

    db.update_with_relationships("users", "u1", json!({"posts":{"$connect":{"id":"p1"}}}))
        .unwrap();
    scheduler.advance(10);
    assert_eq!(
        events.try_recv().unwrap(),
        ChangeEvent {
            collection: "users".into(),
            operation: ChangeOperation::Update
        }
    );
    assert!(users_watch.try_recv().is_err());
    assert!(posts_watch.try_recv().is_err());

    let delete_many = DeleteRelationshipsOptions {
        soft: false,
        limit: None,
        include: [("posts".to_string(), CascadeOption::SetNull)]
            .into_iter()
            .collect(),
    };
    db.delete_many_with_relationships("users", &|entity| entity["id"] == "u2", delete_many)
        .unwrap();
    scheduler.advance(10);
    assert_eq!(
        events.try_recv().unwrap(),
        ChangeEvent {
            collection: "users".into(),
            operation: ChangeOperation::Delete
        }
    );
    assert_eq!(users_watch.try_recv().unwrap().as_array().unwrap().len(), 1);
    assert!(posts_watch.try_recv().is_err());

    let no_op = db.update_with_relationships("users", "u1", json!({"company":{"$delete":true}}));
    assert!(no_op.is_ok());
    scheduler.advance(10);
    assert_eq!(
        events.try_recv().unwrap(),
        ChangeEvent {
            collection: "users".into(),
            operation: ChangeOperation::Update
        }
    );
    assert!(users_watch.try_recv().is_err());
    assert!(posts_watch.try_recv().is_err());

    let failure = db.create_with_relationships(
        "users",
        json!({"id":"u3","name":"Broken","company":{"$connect":{"id":"missing"}}}),
    );
    assert!(matches!(failure, Err(EngineError::ForeignKey(_))));
    scheduler.advance(10);
    assert!(events.try_recv().is_err());
}

#[test]
fn reload_collection_replaces_state_emits_raw_reload_even_when_unchanged_and_keeps_old_on_invalid()
{
    let (mut db, scheduler) = make_books_db_with_scheduler(books_fixture());
    let events = db.subscribe_change_events();
    let watch = db
        .watch(
            "books",
            WatchQueryConfig {
                sort: vec![("year".into(), proseql_engine::query::SortOrder::Asc)],
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    watch.try_recv().unwrap();

    db.reload_collection(
        "books",
        vec![
            json!({"id":"1","title":"Dune","author":"Frank Herbert","year":1965,"genre":"sci-fi","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z"}),
            json!({"id":"2","title":"Neuromancer","author":"William Gibson","year":1984,"genre":"sci-fi","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z"}),
            json!({"id":"4","title":"Foundation","author":"Isaac Asimov","year":1951,"genre":"sci-fi","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z"}),
        ],
    )
    .unwrap();
    scheduler.advance(10);
    assert_eq!(
        events.try_recv().unwrap(),
        ChangeEvent {
            collection: "books".into(),
            operation: ChangeOperation::Reload
        }
    );
    let changed = watch.try_recv().unwrap();
    assert_eq!(changed.as_array().unwrap()[0]["title"], json!("Foundation"));

    db.reload_collection(
        "books",
        vec![
            json!({"id":"1","title":"Dune","author":"Frank Herbert","year":1965,"genre":"sci-fi","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z"}),
            json!({"id":"2","title":"Neuromancer","author":"William Gibson","year":1984,"genre":"sci-fi","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z"}),
            json!({"id":"4","title":"Foundation","author":"Isaac Asimov","year":1951,"genre":"sci-fi","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z"}),
        ],
    )
    .unwrap();
    scheduler.advance(10);
    assert_eq!(
        events.try_recv().unwrap(),
        ChangeEvent {
            collection: "books".into(),
            operation: ChangeOperation::Reload
        }
    );
    assert!(watch.try_recv().is_err());

    let invalid = db.reload_collection("books", vec![json!({"id":"1","title":"Broken"})]);
    assert!(matches!(invalid, Err(EngineError::Validation(_))));
    scheduler.advance(10);
    assert!(events.try_recv().is_err());
    assert!(watch.try_recv().is_err());
    assert_eq!(
        db.collection("books").unwrap().list().len(),
        3,
        "invalid reload must preserve last known good state"
    );
}

#[test]
fn reload_collection_rejects_dangling_foreign_keys_atomically_and_emits_no_reload() {
    let (mut db, scheduler) = make_relationship_db_with_scheduler();
    let events = db.subscribe_change_events();
    let users_watch = db.watch("users", WatchQueryConfig::default()).unwrap();
    users_watch.try_recv().unwrap();

    let error = db.reload_collection(
        "users",
        vec![json!({
            "id":"u1",
            "name":"Alice",
            "companyId":"missing",
            "createdAt":"2024-01-01T00:00:00.000Z",
            "updatedAt":"2024-01-01T00:00:00.000Z"
        })],
    );
    assert!(matches!(error, Err(EngineError::ForeignKey(_))));
    scheduler.advance(10);
    assert!(events.try_recv().is_err());
    assert!(users_watch.try_recv().is_err());

    let users = db.query("users", QueryInput::default(), None).unwrap();
    assert_eq!(users.len(), 1);
    assert_eq!(users[0]["companyId"], json!("c1"));
    assert_eq!(users[0]["name"], json!("Alice"));
}

#[test]
fn failed_relationship_mutations_sync_partial_side_effects_without_publishing_events() {
    let (mut db, scheduler) = make_relationship_db_with_scheduler();
    let events = db.subscribe_change_events();
    let posts_watch = db.watch("posts", WatchQueryConfig::default()).unwrap();
    posts_watch.try_recv().unwrap();

    let create_failure = db.create_with_relationships(
        "users",
        json!({
            "id":"u2",
            "name":"Broken",
            "posts":{"$create":{"title":"Nested side effect"}},
            "company":{"$connect":{"id":"missing"}}
        }),
    );
    assert!(matches!(create_failure, Err(EngineError::ForeignKey(_))));
    scheduler.advance(10);
    assert!(events.try_recv().is_err());
    assert!(posts_watch.try_recv().is_err());

    db.publish_change_event(ChangeEvent {
        collection: "posts".into(),
        operation: ChangeOperation::Update,
    });
    scheduler.advance(10);
    assert_eq!(
        events.try_recv().unwrap(),
        ChangeEvent {
            collection: "posts".into(),
            operation: ChangeOperation::Update,
        }
    );
    let after_create_failure = posts_watch.try_recv().unwrap();
    assert!(after_create_failure
        .as_array()
        .unwrap()
        .iter()
        .any(|post| post["title"] == json!("Nested side effect")));

    let update_failure = db.update_with_relationships(
        "users",
        "u1",
        json!({
            "posts":{"$disconnect":true},
            "name": 123
        }),
    );
    assert!(matches!(update_failure, Err(EngineError::Validation(_))));
    scheduler.advance(10);
    assert!(events.try_recv().is_err());
    assert!(posts_watch.try_recv().is_err());

    db.publish_change_event(ChangeEvent {
        collection: "posts".into(),
        operation: ChangeOperation::Update,
    });
    scheduler.advance(10);
    assert_eq!(
        events.try_recv().unwrap(),
        ChangeEvent {
            collection: "posts".into(),
            operation: ChangeOperation::Update,
        }
    );
    let after_update_failure = posts_watch.try_recv().unwrap();
    let hello = after_update_failure
        .as_array()
        .unwrap()
        .iter()
        .find(|post| post["id"] == json!("p1"))
        .cloned()
        .unwrap();
    assert_eq!(hello["authorId"], Value::Null);
}

#[test]
fn watch_config_wire_round_trips_ts_shape_and_sort_order() {
    let config = WatchQueryConfig {
        r#where: Some(json!({"genre":"sci-fi"})),
        sort: vec![
            ("year".into(), proseql_engine::query::SortOrder::Asc),
            ("title".into(), proseql_engine::query::SortOrder::Desc),
        ],
        offset: Some(1),
        limit: Some(2),
        select: Some(json!(["title"])),
        debounce_ms: Some(25),
    };

    let wire = serde_json::to_value(&config).unwrap();
    assert_eq!(
        wire,
        json!({
            "where":{"genre":"sci-fi"},
            "sort":{"year":"asc","title":"desc"},
            "offset":1,
            "limit":2,
            "select":["title"],
            "debounceMs":25
        })
    );

    let decoded: WatchQueryConfig =
        serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
    assert_eq!(decoded.r#where, config.r#where);
    assert_eq!(decoded.sort, config.sort);
    assert_eq!(decoded.offset, config.offset);
    assert_eq!(decoded.limit, config.limit);
    assert_eq!(decoded.select, config.select);
    assert_eq!(decoded.debounce_ms, config.debounce_ms);
}

#[test]
fn callback_watch_drop_prevents_scheduled_invocation_and_self_drop_does_not_deadlock() {
    let (mut db, scheduler) = make_books_db_with_scheduler(books_fixture());

    let dropped_values = Arc::new(Mutex::new(Vec::new()));
    let dropped_values_clone = Arc::clone(&dropped_values);
    let dropped = db
        .watch_with_callback(
            "books",
            WatchQueryConfig {
                debounce_ms: Some(10),
                ..WatchQueryConfig::default()
            },
            Box::new(move |value| dropped_values_clone.lock().unwrap().push(value)),
        )
        .unwrap();
    assert_eq!(dropped_values.lock().unwrap().len(), 1);
    db.create(
        "books",
        json!({"id":"4","title":"Foundation","author":"Isaac Asimov","year":1951,"genre":"sci-fi"}),
    )
    .unwrap();
    drop(dropped);
    scheduler.advance(10);
    assert_eq!(dropped_values.lock().unwrap().len(), 1);

    let self_drop_values = Arc::new(Mutex::new(Vec::new()));
    let self_drop_handle: Arc<Mutex<Option<proseql_engine::reactive::CallbackSubscription>>> =
        Arc::new(Mutex::new(None));
    let self_drop_values_clone = Arc::clone(&self_drop_values);
    let self_drop_handle_clone = Arc::clone(&self_drop_handle);
    let callback = db
        .watch_with_callback(
            "books",
            WatchQueryConfig {
                debounce_ms: Some(10),
                ..WatchQueryConfig::default()
            },
            Box::new(move |value| {
                self_drop_values_clone.lock().unwrap().push(value);
                self_drop_handle_clone.lock().unwrap().take();
            }),
        )
        .unwrap();
    *self_drop_handle.lock().unwrap() = Some(callback);
    assert_eq!(self_drop_values.lock().unwrap().len(), 1);
    self_drop_values.lock().unwrap().clear();

    db.update("books", "4", json!({"title":"Foundation and Empire"}))
        .unwrap();
    scheduler.advance(10);
    assert_eq!(self_drop_values.lock().unwrap().len(), 1);

    db.update("books", "4", json!({"title":"Second Foundation"}))
        .unwrap();
    scheduler.advance(10);
    assert_eq!(self_drop_values.lock().unwrap().len(), 1);
}

#[test]
fn unsupported_scheduler_allows_raw_events_and_crud_but_rejects_watchs_with_typed_error() {
    let scheduler = Arc::new(UnsupportedReactiveScheduler) as Arc<dyn ReactiveScheduler>;
    let mut db = make_books_db_with_arc_scheduler(books_fixture(), scheduler);

    let watch_error = match db.watch("books", WatchQueryConfig::default()) {
        Ok(_) => panic!("watch should require an injected scheduler"),
        Err(error) => error,
    };
    match watch_error {
        EngineError::Operation(error) => {
            assert_eq!(error.operation, "watch");
            assert!(error.reason.contains("missing-reactive-scheduler"));
            assert!(error.message.contains("new_with_reactive_scheduler"));
        }
        other => panic!("expected OperationError, got {other:?}"),
    }

    let by_id_error = match db.watch_by_id("books", "1", None) {
        Ok(_) => panic!("watch_by_id should require an injected scheduler"),
        Err(error) => error,
    };
    match by_id_error {
        EngineError::Operation(error) => {
            assert_eq!(error.operation, "watchById");
            assert!(error.message.contains("new_with_reactive_scheduler"));
        }
        other => panic!("expected OperationError, got {other:?}"),
    }

    let events = db.subscribe_change_events();
    db.create(
        "books",
        json!({"id":"4","title":"Foundation","author":"Isaac Asimov","year":1951,"genre":"sci-fi"}),
    )
    .unwrap();
    assert_eq!(
        events.try_recv().unwrap(),
        ChangeEvent {
            collection: "books".into(),
            operation: ChangeOperation::Create,
        }
    );
}

#[test]
fn database_batch_wrappers_publish_ts_gated_events_and_preserve_fk_semantics() {
    let scheduler = Arc::new(ManualReactiveScheduler::default());
    let registry = Arc::new(CallbackRegistry::new());

    let mut post_descriptor = base_descriptor(
        "posts",
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
        },
    );
    post_descriptor.relationships = vec![(
        "author".into(),
        RelationshipDescriptor {
            kind: RelationshipKind::Ref,
            target: "users".into(),
            foreign_key: Some("authorId".into()),
        },
    )];

    let users = seed(
        Collection::new_with_clock(
            "users",
            users_descriptor(),
            Arc::clone(&registry),
            Box::new(SequentialGenerator::new("user")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
        vec![
            json!({"id":"u1","name":"Alice","companyId":null}),
            json!({"id":"u2","name":"Bob","companyId":null}),
        ],
    );
    let posts = seed(
        Collection::new_with_clock(
            "posts",
            post_descriptor,
            Arc::clone(&registry),
            Box::new(SequentialGenerator::new("post")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
        vec![json!({"id":"p1","title":"Hello","authorId":"u1"})],
    );

    let mut collections = IndexMap::new();
    collections.insert("users".into(), users);
    collections.insert("posts".into(), posts);
    let mut db = Database::new_with_reactive_scheduler(
        collections,
        registry,
        Arc::clone(&scheduler) as Arc<dyn ReactiveScheduler>,
    );
    let events = db.subscribe_change_events();

    let created = db
        .create_many(
            "posts",
            vec![
                json!({"id":"p2","title":"Valid","authorId":"u1"}),
                json!({"id":"p3","title":"Invalid","authorId":"missing"}),
            ],
            true,
        )
        .unwrap();
    assert_eq!(created.created.len(), 1);
    assert_eq!(created.created[0]["id"], json!("p2"));
    assert_eq!(created.skipped.len(), 1);
    assert_eq!(
        created.skipped[0].reason,
        "Foreign key violation: FK constraint: 'posts' references non-existent 'users' (authorId=missing)"
    );
    assert_eq!(
        events.try_recv().unwrap(),
        ChangeEvent {
            collection: "posts".into(),
            operation: ChangeOperation::Create,
        }
    );

    let create_failure = db.create_many(
        "posts",
        vec![json!({"id":"p4","title":"Broken","authorId":"missing"})],
        false,
    );
    assert!(matches!(create_failure, Err(EngineError::ForeignKey(_))));
    assert!(events.try_recv().is_err());
    assert!(db.collection("posts").unwrap().get("p4").is_none());

    let updated = db
        .update_many("posts", json!({"authorId":"u1"}), json!({"authorId":"u2"}))
        .unwrap();
    assert_eq!(updated.count, 2);
    assert_eq!(
        events.try_recv().unwrap(),
        ChangeEvent {
            collection: "posts".into(),
            operation: ChangeOperation::Update,
        }
    );

    let update_failure = db.update_many("posts", json!({"id":"p1"}), json!({"authorId":"missing"}));
    assert!(matches!(update_failure, Err(EngineError::ForeignKey(_))));
    assert_eq!(
        db.collection("posts").unwrap().get("p1").unwrap()["authorId"],
        json!("u2")
    );
    assert!(events.try_recv().is_err());

    let upsert_created = db
        .upsert(
            "posts",
            json!({"id":"p5"}),
            json!({"title":"Created","authorId":"u1"}),
            json!({"title":"ignored"}),
        )
        .unwrap();
    assert_eq!(
        upsert_created.action,
        proseql_engine::collection::UpsertAction::Created
    );
    assert_eq!(
        events.try_recv().unwrap(),
        ChangeEvent {
            collection: "posts".into(),
            operation: ChangeOperation::Create,
        }
    );

    let upsert_failure = db.upsert(
        "posts",
        json!({"id":"p5"}),
        json!({"title":"ignored"}),
        json!({"authorId":"missing"}),
    );
    assert!(matches!(upsert_failure, Err(EngineError::ForeignKey(_))));
    assert_eq!(
        db.collection("posts").unwrap().get("p5").unwrap()["authorId"],
        json!("u1")
    );
    assert!(events.try_recv().is_err());

    let many = db
        .upsert_many(
            "posts",
            vec![
                (
                    json!({"id":"p6"}),
                    json!({"title":"Created many","authorId":"u1"}),
                    json!({"title":"ignored"}),
                ),
                (
                    json!({"id":"p2"}),
                    json!({"title":"ignored"}),
                    json!({"title":"Updated many"}),
                ),
            ],
        )
        .unwrap();
    assert_eq!(many.created.len(), 1);
    assert_eq!(many.updated.len(), 1);
    assert_eq!(
        drain_events(&events),
        vec![
            ChangeEvent {
                collection: "posts".into(),
                operation: ChangeOperation::Create,
            },
            ChangeEvent {
                collection: "posts".into(),
                operation: ChangeOperation::Update,
            },
        ]
    );

    let upsert_many_failure = db.upsert_many(
        "posts",
        vec![
            (
                json!({"id":"p6"}),
                json!({"title":"ignored"}),
                json!({"authorId":"missing"}),
            ),
            (
                json!({"id":"p7"}),
                json!({"title":"Broken many","authorId":"u1"}),
                json!({"title":"ignored"}),
            ),
        ],
    );
    assert!(matches!(
        upsert_many_failure,
        Err(EngineError::ForeignKey(_))
    ));
    assert!(db.collection("posts").unwrap().get("p7").is_none());
    assert_eq!(
        db.collection("posts").unwrap().get("p6").unwrap()["authorId"],
        json!("u1")
    );
    assert!(events.try_recv().is_err());

    let deleted = db
        .delete_many("posts", json!({"authorId":"u2"}), false, None)
        .unwrap();
    assert_eq!(deleted.count, 2);
    assert_eq!(
        events.try_recv().unwrap(),
        ChangeEvent {
            collection: "posts".into(),
            operation: ChangeOperation::Delete,
        }
    );

    let delete_none = db
        .delete_many("posts", json!({"authorId":"missing"}), false, None)
        .unwrap();
    assert_eq!(delete_none.count, 0);
    assert!(events.try_recv().is_err());
}

#[test]
fn batch_fk_validation_uses_pre_batch_state_for_self_refs() {
    let (mut db, _) = make_people_db_with_scheduler(vec![]);

    let skipped = db
        .create_many(
            "people",
            vec![
                json!({"id":"b","name":"Boss"}),
                json!({"id":"a","name":"Alice","managerId":"b"}),
            ],
            true,
        )
        .unwrap();
    assert_eq!(skipped.created.len(), 1);
    assert_eq!(skipped.created[0]["id"], json!("b"));
    assert_eq!(skipped.skipped.len(), 1);
    assert_eq!(skipped.skipped[0].data["id"], json!("a"));
    assert_eq!(
        skipped.skipped[0].reason,
        "Foreign key violation: FK constraint: 'people' references non-existent 'people' (managerId=b)"
    );
    assert!(db.collection("people").unwrap().get("a").is_none());

    let failure = db.create_many(
        "people",
        vec![
            json!({"id":"d","name":"Dana"}),
            json!({"id":"c","name":"Carol","managerId":"d"}),
        ],
        false,
    );
    assert!(matches!(failure, Err(EngineError::ForeignKey(_))));
    assert!(db.collection("people").unwrap().get("c").is_none());
    assert!(db.collection("people").unwrap().get("d").is_none());

    let upsert_failure = db.upsert_many(
        "people",
        vec![
            (
                json!({"id":"manager"}),
                json!({"name":"Manager"}),
                json!({"name":"ignored"}),
            ),
            (
                json!({"id":"employee"}),
                json!({"name":"Employee","managerId":"manager"}),
                json!({"name":"ignored"}),
            ),
        ],
    );
    assert!(matches!(upsert_failure, Err(EngineError::ForeignKey(_))));
    assert!(db.collection("people").unwrap().get("manager").is_none());
    assert!(db.collection("people").unwrap().get("employee").is_none());
}

#[test]
fn fk_validation_gates_match_ts_for_singular_updates_but_not_upsert_many_updates() {
    let (mut db, scheduler) = make_relationship_db_with_scheduler();
    db.delete("users", "u1").unwrap();
    let watch = db.watch("posts", WatchQueryConfig::default()).unwrap();
    assert_eq!(watch.try_recv().unwrap().as_array().unwrap().len(), 1);

    let singular = db
        .update("posts", "p1", json!({"title":"Single ok"}))
        .unwrap();
    assert_eq!(singular["title"], json!("Single ok"));
    assert_eq!(singular["authorId"], json!("u1"));
    scheduler.advance(10);
    assert_eq!(
        watch.try_recv().unwrap().as_array().unwrap()[0]["title"],
        json!("Single ok")
    );

    let unrelated = db
        .update_many("posts", json!({"id":"p1"}), json!({"title":"Still ok"}))
        .unwrap();
    assert_eq!(unrelated.count, 1);
    scheduler.advance(10);
    assert_eq!(
        watch.try_recv().unwrap().as_array().unwrap()[0]["title"],
        json!("Still ok")
    );

    db.create("users", json!({"id":"u1","name":"Alice"}))
        .unwrap();
    let touched = db.update_many("posts", json!({"id":"p1"}), json!({"authorId":"u1"}));
    assert!(touched.is_ok());

    db.delete("users", "u1").unwrap();
    let no_touch_upsert = db
        .upsert(
            "posts",
            json!({"id":"p1"}),
            json!({"title":"ignored","authorId":"u1"}),
            json!({"title":"upsert ok"}),
        )
        .unwrap();
    assert_eq!(no_touch_upsert.entity["title"], json!("upsert ok"));
    assert_eq!(no_touch_upsert.entity["authorId"], json!("u1"));

    db.create("users", json!({"id":"u1","name":"Alice"}))
        .unwrap();
    let touch_upsert = db.upsert(
        "posts",
        json!({"id":"p1"}),
        json!({"title":"ignored","authorId":"u1"}),
        json!({"authorId":"u1"}),
    );
    assert!(touch_upsert.is_ok());

    db.delete("users", "u1").unwrap();
    let many_failure = db.upsert_many(
        "posts",
        vec![
            (
                json!({"id":"p1"}),
                json!({"title":"ignored","authorId":"missing"}),
                json!({"title":"batch should fail"}),
            ),
            (
                json!({"id":"p2"}),
                json!({"title":"Created","authorId":"u1"}),
                json!({"title":"ignored"}),
            ),
        ],
    );
    assert!(matches!(many_failure, Err(EngineError::ForeignKey(_))));
    assert!(db.collection("posts").unwrap().get("p2").is_none());
    assert_eq!(
        db.collection("posts").unwrap().get("p1").unwrap()["title"],
        json!("upsert ok")
    );
    assert_eq!(
        db.collection("posts").unwrap().get("p1").unwrap()["authorId"],
        json!("u1")
    );
}

#[test]
fn debounce_cancellation_keeps_one_pending_task_per_watcher() {
    let (mut db, scheduler) = make_books_db_with_scheduler(books_fixture());
    let a = db
        .watch(
            "books",
            WatchQueryConfig {
                debounce_ms: Some(25),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    let b = db
        .watch(
            "books",
            WatchQueryConfig {
                debounce_ms: Some(25),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    assert_eq!(scheduler.pending_task_count(), 0);

    for i in 0..100 {
        db.update("books", "1", json!({"title": format!("Dune {i}")}))
            .unwrap();
    }

    assert_eq!(scheduler.pending_task_count(), 2);
    scheduler.advance(25);
    assert_eq!(scheduler.pending_task_count(), 0);
    assert_eq!(
        a.try_recv().unwrap().as_array().unwrap()[0]["title"],
        json!("Dune 99")
    );
    assert_eq!(
        b.try_recv().unwrap().as_array().unwrap()[0]["title"],
        json!("Dune 99")
    );
    assert!(a.try_recv().is_err());
    assert!(b.try_recv().is_err());
}

#[test]
fn callback_panics_do_not_deadlock_or_break_later_subscribers() {
    let (mut db, scheduler) = make_books_db_with_scheduler(books_fixture());
    let panic_sub = db
        .watch_with_callback(
            "books",
            WatchQueryConfig {
                debounce_ms: Some(10),
                ..WatchQueryConfig::default()
            },
            Box::new(|_| panic!("boom")),
        )
        .unwrap();
    db.update("books", "1", json!({"title":"Panicking"}))
        .unwrap();
    scheduler.advance(10);
    drop(panic_sub);

    let values = Arc::new(Mutex::new(Vec::new()));
    let values_clone = Arc::clone(&values);
    let healthy = db
        .watch_with_callback(
            "books",
            WatchQueryConfig {
                debounce_ms: Some(10),
                ..WatchQueryConfig::default()
            },
            Box::new(move |value| values_clone.lock().unwrap().push(value)),
        )
        .unwrap();
    assert_eq!(values.lock().unwrap().len(), 1);
    db.update("books", "1", json!({"title":"Healthy"})).unwrap();
    scheduler.advance(10);
    assert_eq!(values.lock().unwrap().len(), 2);
    drop(healthy);
}

#[test]
fn panicking_collator_does_not_kill_manual_scheduler_or_future_tasks() {
    let scheduler = Arc::new(ManualReactiveScheduler::default());

    let mut panicking_registry = CallbackRegistry::new();
    panicking_registry.register_collator(Box::new(|_, _| panic!("boom")));
    let mut panicking_db = make_books_db_with_registry_and_scheduler(
        books_fixture(),
        Arc::new(panicking_registry),
        Arc::clone(&scheduler) as Arc<dyn ReactiveScheduler>,
    );
    let panicking_watch = panicking_db
        .watch(
            "books",
            WatchQueryConfig {
                sort: vec![("title".into(), proseql_engine::query::SortOrder::Asc)],
                debounce_ms: Some(10),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();

    panicking_db
        .update("books", "1", json!({"year": 1966}))
        .unwrap();
    scheduler.advance(10);
    assert_eq!(scheduler.pending_task_count(), 0);
    drop(panicking_watch);

    let mut healthy_db = make_books_db_with_arc_scheduler(
        books_fixture(),
        Arc::clone(&scheduler) as Arc<dyn ReactiveScheduler>,
    );
    let healthy_watch = healthy_db
        .watch(
            "books",
            WatchQueryConfig {
                debounce_ms: Some(10),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    assert_eq!(
        healthy_watch.try_recv().unwrap().as_array().unwrap().len(),
        3
    );

    healthy_db
        .update("books", "1", json!({"title": "Recovered"}))
        .unwrap();
    scheduler.advance(10);
    assert_eq!(scheduler.pending_task_count(), 0);
    assert_eq!(
        healthy_watch.try_recv().unwrap().as_array().unwrap()[0]["title"],
        json!("Recovered")
    );
}

#[test]
fn channel_watch_is_lazy_and_first_consume_reads_current_snapshot_without_duplicate() {
    let (mut db, scheduler) = make_books_db_with_scheduler(books_fixture());
    let sub = db
        .watch(
            "books",
            WatchQueryConfig {
                sort: vec![("year".into(), proseql_engine::query::SortOrder::Asc)],
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();

    db.update("books", "1", json!({"year": 2000})).unwrap();
    assert_eq!(
        sub.try_recv().unwrap().as_array().unwrap()[2]["year"],
        json!(2000)
    );
    scheduler.advance(10);
    assert!(sub.try_recv().is_err());

    let buffered = db.watch("books", WatchQueryConfig::default()).unwrap();
    db.update("books", "1", json!({"year": 2001})).unwrap();
    scheduler.advance(10);
    assert_eq!(
        buffered.try_recv().unwrap().as_array().unwrap()[0]["year"],
        json!(2001)
    );
    assert!(buffered.try_recv().is_err());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn native_thread_scheduler_uses_one_worker_for_many_scheduled_events() {
    let scheduler = Arc::new(proseql_engine::reactive::ThreadReactiveScheduler::default());
    let mut db = make_books_db_with_arc_scheduler(
        books_fixture(),
        Arc::clone(&scheduler) as Arc<dyn ReactiveScheduler>,
    );
    let sub = db
        .watch(
            "books",
            WatchQueryConfig {
                debounce_ms: Some(5),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    sub.try_recv().unwrap();

    for i in 0..5 {
        db.update("books", "1", json!({"title": format!("Dune {i}")}))
            .unwrap();
    }

    assert_eq!(scheduler.pending_task_count(), 1);
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert!(sub.try_recv().is_ok());
    assert_eq!(scheduler.pending_task_count(), 0);
    assert_eq!(scheduler.worker_spawn_count(), 1);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn native_thread_scheduler_survives_panicking_collator_jobs() {
    use std::time::Duration;

    let scheduler = Arc::new(proseql_engine::reactive::ThreadReactiveScheduler::default());

    let mut panicking_registry = CallbackRegistry::new();
    panicking_registry.register_collator(Box::new(|_, _| panic!("boom")));
    let mut panicking_db = make_books_db_with_registry_and_scheduler(
        books_fixture(),
        Arc::new(panicking_registry),
        Arc::clone(&scheduler) as Arc<dyn ReactiveScheduler>,
    );
    let panicking_watch = panicking_db
        .watch(
            "books",
            WatchQueryConfig {
                sort: vec![("title".into(), proseql_engine::query::SortOrder::Asc)],
                debounce_ms: Some(5),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();

    panicking_db
        .update("books", "1", json!({"year": 1966}))
        .unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(scheduler.pending_task_count(), 0);
    drop(panicking_watch);

    let mut healthy_db = make_books_db_with_arc_scheduler(
        books_fixture(),
        Arc::clone(&scheduler) as Arc<dyn ReactiveScheduler>,
    );
    let healthy_watch = healthy_db
        .watch(
            "books",
            WatchQueryConfig {
                debounce_ms: Some(5),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    assert_eq!(
        healthy_watch.try_recv().unwrap().as_array().unwrap().len(),
        3
    );

    healthy_db
        .update("books", "1", json!({"title": "Recovered"}))
        .unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(scheduler.pending_task_count(), 0);
    assert_eq!(scheduler.worker_spawn_count(), 1);
    assert_eq!(
        healthy_watch.try_recv().unwrap().as_array().unwrap()[0]["title"],
        json!("Recovered")
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn native_thread_scheduler_smoke_delivers_debounced_watch_updates() {
    use std::time::Duration;

    let registry = Arc::new(CallbackRegistry::new());
    let books = seed(
        Collection::new_with_clock(
            "books",
            books_descriptor(),
            Arc::clone(&registry),
            Box::new(SequentialGenerator::new("book")),
            Box::new(FixedClock::new("2024-01-01T00:00:00.000Z")),
        ),
        books_fixture(),
    );
    let mut collections = IndexMap::new();
    collections.insert("books".into(), books);
    let mut db = Database::new(collections, registry);
    let sub = db
        .watch(
            "books",
            WatchQueryConfig {
                debounce_ms: Some(5),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    sub.try_recv().unwrap();
    db.create(
        "books",
        json!({"id":"4","title":"Foundation","author":"Isaac Asimov","year":1951,"genre":"sci-fi"}),
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(sub.try_recv().unwrap().as_array().unwrap().len(), 4);
}
