//! Conformance: resident records (`Database::load_resident_records` and
//! `unload_resident_records`), the engine half of native lazy partitions.
//! A database that loads and drops record blocks must answer queries exactly
//! like a database that was loaded with the same records in the same order.

use std::sync::Arc;

use indexmap::IndexMap;
use proseql_engine::{
    callbacks::CallbackRegistry,
    clock::FixedClock,
    collection::Collection,
    descriptor::{
        CollectionDescriptor, IdStrategy, IndexDescriptor, SchemaNode, StructField, ValidationMode,
    },
    errors::EngineError,
    id_gen::SequentialGenerator,
    query::{IndexUsed, QueryInput, SortOrder},
    reactive::WatchQueryConfig,
    relationships::Database,
};
use serde_json::{json, Value};

fn descriptor() -> CollectionDescriptor {
    CollectionDescriptor {
        name: "samples".into(),
        schema: SchemaNode::Struct {
            fields: ["id", "at", "tag"]
                .into_iter()
                .map(|name| StructField {
                    name: name.into(),
                    schema: SchemaNode::Str,
                })
                .collect(),
        },
        id_strategy: IdStrategy::Provided,
        relationships: vec![],
        indexes: vec![IndexDescriptor::Single("tag".into())],
        ordered_indexes: vec!["at".into()],
        unique_fields: vec![],
        before_create_hooks: vec![],
        after_create_hooks: vec![],
        before_update_hooks: vec![],
        after_update_hooks: vec![],
        before_delete_hooks: vec![],
        after_delete_hooks: vec![],
        on_change_hooks: vec![],
        computed_fields: vec![],
        search_index: vec!["tag".into()],
        id_generator: None,
        version: None,
        migrations: vec![],
        append_only: true,
        duplicate_ids: Default::default(),
        validation_mode: ValidationMode::Strict,
    }
}

fn database() -> Database {
    let registry = Arc::new(CallbackRegistry::new());
    let collection = Collection::new_with_clock(
        "samples",
        descriptor(),
        Arc::clone(&registry),
        Box::new(SequentialGenerator::new("s")),
        Box::new(FixedClock::new("2026-01-01T00:00:00.000Z")),
    );
    Database::new(IndexMap::from([("samples".into(), collection)]), registry)
}

const TAGS: [&str; 3] = ["red", "blue", "green"];

fn block(prefix: &str, count: usize) -> Vec<Value> {
    (0..count)
        .map(|i| {
            json!({
                "id": format!("{prefix}-{i}"),
                "at": format!("{prefix}-{:02}", (i * 7) % count),
                "tag": TAGS[i % 3],
            })
        })
        .collect()
}

fn queries() -> Vec<QueryInput> {
    let filter = |value: Value| QueryInput {
        r#where: Some(value),
        ..QueryInput::default()
    };
    vec![
        QueryInput::default(),
        filter(json!({"at": {"$gte": "b-03", "$lt": "c-05"}})),
        filter(json!({"tag": "blue"})),
        filter(json!({"tag": {"$search": "gre"}})),
        QueryInput {
            sort: vec![("at".into(), SortOrder::Desc)],
            limit: Some(4),
            ..QueryInput::default()
        },
    ]
}

fn assert_same(left: &Database, right: &Database) {
    for input in queries() {
        assert_eq!(
            left.query("samples", input.clone(), None).unwrap(),
            right.query("samples", input.clone(), None).unwrap(),
            "{input:?}"
        );
        assert_eq!(
            left.explain_query("samples", &input).unwrap(),
            right.explain_query("samples", &input).unwrap(),
            "{input:?}"
        );
    }
}

fn loaded_with(blocks: &[&[Value]]) -> Database {
    let mut db = database();
    let records = blocks
        .iter()
        .flat_map(|block| block.iter().cloned())
        .collect();
    db.commit_snapshot_transaction(IndexMap::from([("samples".to_owned(), records)]))
        .unwrap();
    db.take_committed_changes();
    db
}

#[test]
fn blocks_loaded_out_of_order_keep_eager_order_and_indexes() {
    let (a, b, c) = (block("a", 9), block("b", 9), block("c", 9));
    let mut lazy = database();
    lazy.load_resident_records("samples", c.clone(), None, false)
        .unwrap();
    lazy.load_resident_records("samples", a.clone(), Some(0), false)
        .unwrap();
    // Before the first record of `c`, which now sits at position 9.
    lazy.load_resident_records("samples", b.clone(), Some(9), false)
        .unwrap();
    assert_same(&lazy, &loaded_with(&[&a, &b, &c]));
    assert_eq!(
        lazy.explain_query(
            "samples",
            &QueryInput {
                r#where: Some(json!({"at": {"$gte": "b-03", "$lt": "c-05"}})),
                ..QueryInput::default()
            }
        )
        .unwrap()
        .index_used,
        IndexUsed::Ordered
    );

    let ids = b
        .iter()
        .map(|record| record["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        lazy.unload_resident_records("samples", &ids, false)
            .unwrap(),
        9
    );
    assert_same(&lazy, &loaded_with(&[&a, &c]));
    // Loading again restores the same answers.
    lazy.load_resident_records("samples", b.clone(), Some(9), false)
        .unwrap();
    assert_same(&lazy, &loaded_with(&[&a, &b, &c]));
}

#[test]
fn duplicates_and_invalid_records_insert_nothing() {
    let a = block("a", 3);
    let mut db = database();
    db.load_resident_records("samples", a.clone(), None, false)
        .unwrap();
    let mut repeated = block("z", 2);
    repeated.push(a[1].clone());
    let error = db
        .load_resident_records("samples", repeated, None, false)
        .unwrap_err();
    assert!(matches!(error, EngineError::DuplicateKey(_)), "{error:?}");
    let error = db
        .load_resident_records(
            "samples",
            vec![json!({"id": "x", "at": 5, "tag": "red"})],
            None,
            false,
        )
        .unwrap_err();
    assert!(matches!(error, EngineError::Validation(_)), "{error:?}");
    assert_eq!(db.collection("samples").unwrap().len(), 3);
}

#[test]
fn unpublished_moves_are_invisible_and_published_ones_reach_watches_only() {
    let mut db = database();
    let events = db.subscribe_change_events();
    db.load_resident_records("samples", block("a", 3), None, false)
        .unwrap();
    db.unload_resident_records("samples", &["a-0".to_owned()], false)
        .unwrap();
    assert!(db.take_committed_changes().is_empty());
    assert!(events.try_recv().is_err());

    let watch = db
        .watch(
            "samples",
            WatchQueryConfig {
                r#where: Some(json!({"tag": "red"})),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    assert_eq!(watch.recv().unwrap(), json!([]));
    db.load_resident_records("samples", block("b", 3), None, true)
        .unwrap();
    // Published moves are not mutations: no committed changes, but an event.
    assert!(db.take_committed_changes().is_empty());
    assert!(events.try_recv().is_ok());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Ok(value) = watch.try_recv() {
            assert_eq!(value.as_array().unwrap().len(), 1);
            break;
        }
        assert!(std::time::Instant::now() < deadline, "watch did not update");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    // A silent unload followed by a snapshot refresh changes no watch result.
    db.unload_resident_records("samples", &["a-1".to_owned(), "a-2".to_owned()], false)
        .unwrap();
    db.refresh_reactive_snapshot("samples").unwrap();
    assert_eq!(db.reactive_snapshot_count(), 1);
}

fn wait_for(watch: &proseql_engine::reactive::ValueSubscription, expected: Value) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut last = None;
    while std::time::Instant::now() < deadline {
        if let Ok(value) = watch.try_recv() {
            if value == expected {
                return;
            }
            last = Some(value);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("watch never delivered {expected}; last {last:?}");
}

#[test]
fn published_moves_inside_a_transaction_stay_out_of_the_journal() {
    let mut db = database();
    let watch = db
        .watch(
            "samples",
            WatchQueryConfig {
                r#where: Some(json!({"tag": "red"})),
                ..WatchQueryConfig::default()
            },
        )
        .unwrap();
    assert_eq!(watch.recv().unwrap(), json!([]));
    let stored = block("a", 3);
    let created = json!({"id": "n-1", "at": "z-1", "tag": "red"});

    // Rollback: the loaded records stay, the create goes.
    let mut session = db.begin_owned_transaction().unwrap();
    db.transaction_step(&mut session, |db| {
        db.load_resident_records("samples", stored.clone(), None, true)?;
        db.create("samples", created.clone())
    })
    .unwrap();
    let journal = session
        .journal()
        .entities()
        .map(|c| c.id.clone())
        .collect::<Vec<_>>();
    assert_eq!(journal, ["n-1"], "loaded records entered the journal");
    // Watches see the stored record, never the uncommitted create.
    wait_for(&watch, json!([stored[0].clone()]));
    db.rollback_owned_transaction(session).unwrap();
    let collection = db.collection("samples").unwrap();
    assert_eq!(collection.len(), 3);
    assert!(collection.get("n-1").is_none());
    assert_eq!(
        db.query("samples", QueryInput::default(), None).unwrap(),
        stored
    );

    // Commit: only the create is committed.
    let more = block("b", 3);
    let mut session = db.begin_owned_transaction().unwrap();
    db.transaction_step(&mut session, |db| {
        db.load_resident_records("samples", more.clone(), None, true)?;
        db.create("samples", created.clone())
    })
    .unwrap();
    db.commit_owned_transaction(session).unwrap();
    let committed = db
        .take_committed_changes()
        .entities()
        .map(|c| c.id.clone())
        .collect::<Vec<_>>();
    assert_eq!(committed, ["n-1"]);
    wait_for(
        &watch,
        json!([stored[0].clone(), more[0].clone(), created.clone()]),
    );
}
