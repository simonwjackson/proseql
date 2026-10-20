//! `duplicate_ids` policy conformance.
//!
//! Contract (native time-series, section 2): with `ignore_identical`, a create
//! that repeats an existing ID with the same payload succeeds, writes nothing
//! and returns the stored record. The comparison runs after schema decode and
//! defaults, uses JS number semantics and ignores the engine-filled
//! `createdAt`/`updatedAt`. A different payload is the existing
//! `DuplicateKeyError`. One conflict in a batch writes nothing.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use indexmap::IndexMap;
use proseql_engine::callbacks::CallbackRegistry;
use proseql_engine::clock::Clock;
use proseql_engine::collection::Collection;
use proseql_engine::descriptor::{
    CollectionDescriptor, DuplicateIdPolicy, IdStrategy, SchemaNode, StructField, ValidationMode,
};
use proseql_engine::id_gen::SequentialGenerator;
use proseql_engine::relationships::Database;
use serde_json::{json, Value};

/// A real clock whose reading advances one second per call, so every create
/// gets different engine-filled timestamps.
struct SteppingClock {
    seconds: AtomicU64,
}

impl Clock for SteppingClock {
    fn now_iso(&self) -> String {
        let second = self.seconds.fetch_add(1, Ordering::Relaxed);
        format!("2026-01-01T00:{:02}:{:02}.000Z", second / 60, second % 60)
    }
}

fn schema() -> SchemaNode {
    let field = |name: &str, schema: SchemaNode| StructField {
        name: name.into(),
        schema,
    };
    SchemaNode::Struct {
        fields: vec![
            field("id", SchemaNode::Str),
            field("timestamp", SchemaNode::Str),
            field("bpm", SchemaNode::Num),
            field(
                "source",
                SchemaNode::OptionalWithDefault {
                    inner: Box::new(SchemaNode::Str),
                    default_callback_id: "source_default".into(),
                },
            ),
            field(
                "tags",
                SchemaNode::Optional(Box::new(SchemaNode::Array {
                    item: Box::new(SchemaNode::Unknown),
                })),
            ),
            field("createdAt", SchemaNode::Optional(Box::new(SchemaNode::Str))),
            field("updatedAt", SchemaNode::Optional(Box::new(SchemaNode::Str))),
        ],
    }
}

fn descriptor(policy: DuplicateIdPolicy, append_only: bool) -> CollectionDescriptor {
    CollectionDescriptor {
        name: "heartrate".into(),
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
        append_only,
        duplicate_ids: policy,
        validation_mode: ValidationMode::Strict,
    }
}

fn registry() -> Arc<CallbackRegistry> {
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_default("source_default", Box::new(|| json!("live")));
    Arc::new(callbacks)
}

fn collection(policy: DuplicateIdPolicy) -> Collection {
    Collection::new_with_clock(
        "heartrate",
        descriptor(policy, true),
        registry(),
        Box::new(SequentialGenerator::new("hr")),
        Box::new(SteppingClock {
            seconds: AtomicU64::new(0),
        }),
    )
}

fn database(policy: DuplicateIdPolicy) -> Database {
    let registry = registry();
    let mut collections = IndexMap::new();
    collections.insert(
        "heartrate".to_owned(),
        Collection::new_with_clock(
            "heartrate",
            descriptor(policy, true),
            Arc::clone(&registry),
            Box::new(SequentialGenerator::new("hr")),
            Box::new(SteppingClock {
                seconds: AtomicU64::new(0),
            }),
        ),
    );
    Database::new(collections, registry)
}

fn sample(id: &str, bpm: Value) -> Value {
    json!({"id": id, "timestamp": "2026-04-01T08:15:00.123Z", "bpm": bpm})
}

#[test]
fn default_policy_is_error_and_is_omitted_from_json() {
    let descriptor = descriptor(DuplicateIdPolicy::default(), false);
    assert_eq!(descriptor.duplicate_ids, DuplicateIdPolicy::Error);
    let json = serde_json::to_value(&descriptor).unwrap();
    assert!(json.get("duplicate_ids").is_none());

    // Old descriptor JSON, without the field, parses and serializes unchanged.
    let text = serde_json::to_string(&descriptor).unwrap();
    let parsed: CollectionDescriptor = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed.duplicate_ids, DuplicateIdPolicy::Error);
    assert_eq!(serde_json::to_string(&parsed).unwrap(), text);
}

#[test]
fn ignore_identical_serializes_as_snake_case() {
    let descriptor = descriptor(DuplicateIdPolicy::IgnoreIdentical, true);
    let json = serde_json::to_value(&descriptor).unwrap();
    assert_eq!(json["duplicate_ids"], json!("ignore_identical"));
    let parsed: CollectionDescriptor = serde_json::from_value(json).unwrap();
    assert_eq!(parsed.duplicate_ids, DuplicateIdPolicy::IgnoreIdentical);
}

#[test]
fn identical_re_create_returns_the_stored_record_and_writes_nothing() {
    let mut collection = collection(DuplicateIdPolicy::IgnoreIdentical);
    let stored = collection.create(sample("hr:1", json!(81))).unwrap();
    collection.take_changes();
    let revision = collection.revision();

    // `81.0` is the same JS number; `source` gets the same default; the
    // stepping clock gives the retry different engine-filled timestamps.
    let again = collection.create(sample("hr:1", json!(81.0))).unwrap();
    assert_eq!(again, stored);
    assert_eq!(collection.len(), 1);
    assert_eq!(collection.revision(), revision);
    assert!(collection.take_changes().is_empty());

    // An explicit value equal to the default is the same decoded payload.
    let explicit = collection
        .create(json!({
            "id": "hr:1", "timestamp": "2026-04-01T08:15:00.123Z", "bpm": 81, "source": "live"
        }))
        .unwrap();
    assert_eq!(explicit, stored);
}

#[test]
fn different_payload_is_the_existing_duplicate_key_error() {
    for policy in [DuplicateIdPolicy::Error, DuplicateIdPolicy::IgnoreIdentical] {
        let mut collection = collection(policy);
        collection.create(sample("hr:1", json!(81))).unwrap();
        let error = collection.create(sample("hr:1", json!(82))).unwrap_err();
        assert_eq!(error.tag(), "DuplicateKeyError", "{policy:?}");
        let payload = serde_json::to_value(&error).unwrap();
        assert_eq!(payload["field"], json!("id"));
        assert_eq!(payload["value"], json!("hr:1"));
        assert_eq!(payload["existingId"], json!("hr:1"));
        assert_eq!(collection.get("hr:1").unwrap()["bpm"], json!(81));
    }
}

#[test]
fn added_or_nested_differences_conflict() {
    let mut collection = collection(DuplicateIdPolicy::IgnoreIdentical);
    collection
        .create(json!({
            "id": "hr:1", "timestamp": "2026-04-01T08:15:00.123Z", "bpm": 81, "tags": [1, {"a": 2}]
        }))
        .unwrap();
    collection
        .create(json!({
            "id": "hr:1", "timestamp": "2026-04-01T08:15:00.123Z", "bpm": 81, "tags": [1.0, {"a": 2.0}]
        }))
        .expect("nested numbers compare with JS semantics");
    for conflicting in [
        json!({"id": "hr:1", "timestamp": "2026-04-01T08:15:00.123Z", "bpm": 81}),
        json!({"id": "hr:1", "timestamp": "2026-04-01T08:15:00.123Z", "bpm": 81, "tags": [1, {"a": 3}]}),
        json!({"id": "hr:1", "timestamp": "2026-04-01T08:15:00.123Z", "bpm": 81, "tags": [1]}),
    ] {
        let error = collection.create(conflicting).unwrap_err();
        assert_eq!(error.tag(), "DuplicateKeyError");
    }
}

#[test]
fn error_policy_keeps_rejecting_identical_payloads() {
    let mut collection = collection(DuplicateIdPolicy::Error);
    collection.create(sample("hr:1", json!(81))).unwrap();
    let error = collection.create(sample("hr:1", json!(81))).unwrap_err();
    assert_eq!(error.tag(), "DuplicateKeyError");
}

#[test]
fn create_many_returns_stored_and_new_records_in_input_order() {
    let mut collection = collection(DuplicateIdPolicy::IgnoreIdentical);
    let stored = collection.create(sample("hr:1", json!(81))).unwrap();
    collection.take_changes();

    let result = collection
        .create_many(
            vec![
                sample("hr:0", json!(70)),
                sample("hr:1", json!(81)),
                sample("hr:2", json!(90)),
                sample("hr:2", json!(90)),
            ],
            false,
        )
        .unwrap();
    let ids = result
        .created
        .iter()
        .map(|record| record["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids, ["hr:0", "hr:1", "hr:2", "hr:2"]);
    assert_eq!(result.created[1], stored);
    assert!(result.skipped.is_empty());
    assert_eq!(collection.len(), 3);
    // Only the two new records were written.
    assert_eq!(collection.take_changes().len(), 2);
}

#[test]
fn one_conflict_in_a_batch_writes_nothing() {
    for in_batch in [false, true] {
        let mut collection = collection(DuplicateIdPolicy::IgnoreIdentical);
        collection.create(sample("hr:1", json!(81))).unwrap();
        collection.take_changes();
        let revision = collection.revision();
        let batch = if in_batch {
            vec![
                sample("hr:1", json!(81)),
                sample("hr:2", json!(90)),
                sample("hr:2", json!(91)),
            ]
        } else {
            vec![
                sample("hr:2", json!(90)),
                sample("hr:1", json!(82)),
                sample("hr:3", json!(95)),
            ]
        };
        let error = collection.create_many(batch, false).unwrap_err();
        assert_eq!(error.tag(), "DuplicateKeyError");
        assert_eq!(collection.len(), 1);
        assert_eq!(collection.revision(), revision);
        assert!(collection.take_changes().is_empty());
    }
}

#[test]
fn database_create_and_create_many_publish_only_new_records() {
    let mut database = database(DuplicateIdPolicy::IgnoreIdentical);
    let stored = database
        .create("heartrate", sample("hr:1", json!(81)))
        .unwrap();
    database.take_committed_changes();

    let again = database
        .create("heartrate", sample("hr:1", json!(81)))
        .unwrap();
    assert_eq!(again, stored);
    assert!(database.take_committed_changes().is_empty());

    let result = database
        .create_many(
            "heartrate",
            vec![
                sample("hr:1", json!(81)),
                sample("hr:2", json!(90)),
                sample("hr:2", json!(90)),
            ],
            false,
        )
        .unwrap();
    let ids = result
        .created
        .iter()
        .map(|record| record["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids, ["hr:1", "hr:2", "hr:2"]);
    assert_eq!(result.created[0], stored);
    let changes = database.take_committed_changes();
    let ids = changes
        .entities()
        .map(|change| change.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(ids, ["hr:2"]);

    let error = database
        .create("heartrate", sample("hr:2", json!(91)))
        .unwrap_err();
    assert_eq!(error.tag(), "DuplicateKeyError");
    assert_eq!(
        database
            .collection("heartrate")
            .unwrap()
            .get("hr:2")
            .unwrap()["bpm"],
        json!(90)
    );
}
