//! Resolving IDs for nonresident duplicate checks must not consume an ID twice.
use proseql_engine::callbacks::CallbackRegistry;
use proseql_engine::clock::FixedClock;
use proseql_engine::collection::Collection;
use proseql_engine::descriptor::{
    CollectionDescriptor, IdStrategy, SchemaNode, StructField, ValidationMode,
};
use proseql_engine::id_gen::{IdGenerator, SequentialGenerator};
use serde_json::{json, Value};
use std::sync::Arc;

fn collection(strategy: IdStrategy) -> Collection {
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_id_generator(
        "sequence",
        Box::new(|| Box::new(SequentialGenerator::new("named")) as Box<dyn IdGenerator>),
    );
    let mut fields = vec![StructField {
        name: "value".into(),
        schema: SchemaNode::Num,
    }];
    if strategy != IdStrategy::DerivedFromKey {
        fields.insert(
            0,
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
        );
    }
    let descriptor = CollectionDescriptor {
        name: "rows".into(),
        schema: SchemaNode::Struct { fields },
        id_strategy: strategy,
        relationships: vec![],
        indexes: vec![],
        ordered_indexes: vec![],
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
        append_only: true,
        duplicate_ids: Default::default(),
        validation_mode: ValidationMode::Strict,
    };
    Collection::new_with_clock(
        "rows",
        descriptor,
        Arc::new(callbacks),
        Box::new(SequentialGenerator::new("row")),
        Box::new(FixedClock::new("2025-01-01T00:00:00.000Z")),
    )
}

#[test]
fn resolving_then_creating_preserves_every_strategy_and_generator_state() {
    for strategy in [
        IdStrategy::Provided,
        IdStrategy::DerivedFromKey,
        IdStrategy::NamedGenerator {
            name: "sequence".into(),
        },
    ] {
        let mut direct = collection(strategy.clone());
        let mut resolved = collection(strategy);
        for input in [
            json!({"value": 1}),
            json!({"id": "provided", "value": 2}),
            json!({"value": 3}),
            json!({"id": "", "value": 4}),
            json!({"id": 42, "value": 5}),
        ] {
            let expected = direct.create(input.clone()).unwrap();
            let mut staged = input;
            let id = resolved.resolve_create_id(&staged).unwrap();
            staged["id"] = Value::String(id);
            assert_eq!(resolved.create(staged).unwrap(), expected);
        }
        // The next record proves that resolving did not advance twice.
        assert_eq!(
            resolved.create(json!({"value": 6})).unwrap(),
            direct.create(json!({"value": 6})).unwrap()
        );
    }
}

#[test]
fn resolving_keeps_nonobject_and_missing_named_generator_errors() {
    let mut rows = collection(IdStrategy::Provided);
    assert_eq!(
        rows.resolve_create_id(&Value::Null).unwrap_err(),
        rows.create(Value::Null).unwrap_err()
    );
    let mut rows = collection(IdStrategy::NamedGenerator {
        name: "not-registered".into(),
    });
    assert_eq!(
        rows.resolve_create_id(&json!({"value": 1})).unwrap_err(),
        rows.create(json!({"value": 1})).unwrap_err()
    );
    assert_eq!(
        rows.resolve_create_id(&json!({"id": "provided", "value": 1}))
            .unwrap(),
        "provided"
    );
}
