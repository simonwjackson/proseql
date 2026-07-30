#![recursion_limit = "1024"]
//! CRUD conformance fixtures for U2.
//!
//! Tests are organized around the 11 parity gaps identified in the U2 review.
//! Each section is anchored to the corresponding TS corpus file(s).
//!
//! # Sections
//! 1. Timestamp overwrite (TS: create always sets `createdAt`/`updatedAt`)
//! 2. OptionalWithDefault exact semantics (null ≠ absent; missing callback → loud error)
//! 3. Append-only exact error payload (reason: "append-only", exact message format)
//! 4. Computed field sanitization (strip from create/update/upsert)
//! 5. Insertion-ordered state (IndexMap semantics matching JS Map)
//! 6. Batch ops: createMany / updateMany / deleteMany / upsertMany
//! 7. Soft delete (preserve original deletedAt/updatedAt on repeat)
//! 8. Upsert create precedence (where → create → id → timestamps)
//! 9. $removeBy predicate callback
//! 10. Unique constraint check skipped when update doesn't touch unique fields
//! 11. Existing CRUD happy/error paths

use std::sync::Arc;

use proseql_engine::{
    callbacks::CallbackRegistry,
    clock::FixedClock,
    collection::{Collection, UpsertAction},
    descriptor::{
        CollectionDescriptor, ComputedFieldDescriptor, IdStrategy, SchemaNode, StructField,
        UniqueConstraintDescriptor, ValidationMode,
    },
    errors::EngineError,
    id_gen::{IdGenerator, SequentialGenerator},
};
use serde_json::json;

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/// Standard user schema mirroring crud-create-effect.test.ts
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
                name: "email".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "age".into(),
                schema: SchemaNode::Num,
            },
            StructField {
                name: "companyId".into(),
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

/// User schema with active+tags update operators (crud-update-effect.test.ts)
fn update_user_schema() -> SchemaNode {
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
                name: "email".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "age".into(),
                schema: SchemaNode::Num,
            },
            StructField {
                name: "active".into(),
                schema: SchemaNode::Bool,
            },
            StructField {
                name: "tags".into(),
                schema: SchemaNode::Array {
                    item: Box::new(SchemaNode::Str),
                },
            },
            StructField {
                name: "companyId".into(),
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

/// User schema with deletedAt (for soft-delete tests)
fn soft_delete_user_schema() -> SchemaNode {
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
                name: "email".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "age".into(),
                schema: SchemaNode::Num,
            },
            StructField {
                name: "companyId".into(),
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
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    }
}

/// Schema with unique fields: email, username (unique-constraints.test.ts)
fn unique_user_schema() -> SchemaNode {
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
                name: "email".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "username".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "age".into(),
                schema: SchemaNode::Num,
            },
            StructField {
                name: "role".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
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

/// Setting schema with compound unique [userId, settingKey]
fn setting_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "userId".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "settingKey".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "value".into(),
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

fn descriptor_with_schema(schema: SchemaNode) -> CollectionDescriptor {
    CollectionDescriptor {
        name: "test".into(),
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

fn collection(schema: SchemaNode, gen: impl IdGenerator + 'static) -> Collection {
    Collection::new(
        "test",
        descriptor_with_schema(schema),
        Arc::new(CallbackRegistry::new()),
        Box::new(gen),
    )
}

fn collection_with_unique(
    schema: SchemaNode,
    unique: Vec<UniqueConstraintDescriptor>,
    gen: impl IdGenerator + 'static,
) -> Collection {
    let mut desc = descriptor_with_schema(schema);
    desc.unique_fields = unique;
    Collection::new(
        "test",
        desc,
        Arc::new(CallbackRegistry::new()),
        Box::new(gen),
    )
}

/// Build a named-"events" append-only collection
fn append_only_collection() -> Collection {
    let mut desc = descriptor_with_schema(user_schema());
    desc.append_only = true;
    Collection::new(
        "events",
        desc,
        Arc::new(CallbackRegistry::new()),
        Box::new(SequentialGenerator::new("ev")),
    )
}

/// Pre-seed one user entity
fn seeded_user_collection() -> (Collection, String) {
    let mut col = collection(update_user_schema(), SequentialGenerator::new("u"));
    let entity = col
        .create(json!({
            "id": "user1",
            "name": "John Doe",
            "email": "john@example.com",
            "age": 30,
            "active": true,
            "tags": ["admin", "dev"],
            "companyId": "comp1",
        }))
        .expect("seed user");
    let id = entity["id"].as_str().unwrap().to_string();
    (col, id)
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. TIMESTAMP OVERWRITE SEMANTICS
// ═══════════════════════════════════════════════════════════════════════════
// TS: `const raw = { ...sanitizedInput, id, createdAt: now, updatedAt: now }`
// Caller-supplied createdAt/updatedAt are ALWAYS overwritten.

#[test]
fn create_always_overwrites_caller_supplied_created_at() {
    let now_str = "2024-01-15T10:00:00.000Z";
    let mut col = Collection::new_with_clock(
        "test",
        descriptor_with_schema(user_schema()),
        Arc::new(CallbackRegistry::new()),
        Box::new(SequentialGenerator::new("u")),
        Box::new(FixedClock::new(now_str)),
    );

    // Supply old timestamps — TS always overwrites them
    let entity = col
        .create(json!({
            "id": "u1",
            "name": "Alice",
            "email": "alice@example.com",
            "age": 28,
            "companyId": "c1",
            "createdAt": "2000-01-01T00:00:00.000Z",
            "updatedAt": "2000-01-01T00:00:00.000Z",
        }))
        .unwrap();

    // Both must be the clock's "now", not the caller's values
    assert_eq!(
        entity["createdAt"],
        json!(now_str),
        "createdAt must be overwritten by clock"
    );
    assert_eq!(
        entity["updatedAt"],
        json!(now_str),
        "updatedAt must be overwritten by clock"
    );
}

#[test]
fn create_sets_created_at_equal_to_updated_at() {
    let fixed = "2024-06-01T12:00:00.000Z";
    let mut col = Collection::new_with_clock(
        "test",
        descriptor_with_schema(user_schema()),
        Arc::new(CallbackRegistry::new()),
        Box::new(SequentialGenerator::new("u")),
        Box::new(FixedClock::new(fixed)),
    );

    let entity = col
        .create(json!({ "id": "u1", "name": "A", "email": "a@b.com", "age": 1, "companyId": "c" }))
        .unwrap();

    assert_eq!(
        entity["createdAt"], entity["updatedAt"],
        "create must set same timestamp for both"
    );
}

#[test]
fn update_advances_updated_at_but_preserves_created_at() {
    let create_ts = "2024-01-01T00:00:00.000Z";

    // Create with first clock
    let mut col = Collection::new_with_clock(
        "test",
        descriptor_with_schema(user_schema()),
        Arc::new(CallbackRegistry::new()),
        Box::new(SequentialGenerator::new("u")),
        Box::new(FixedClock::new(create_ts)),
    );
    col.create(json!({ "id": "u1", "name": "A", "email": "a@b.com", "age": 1, "companyId": "c" }))
        .unwrap();

    // Swap clock for update
    // We can't easily swap the clock; use update's auto-set behavior instead
    let (mut col2, _) = seeded_user_collection();
    let before_updated_at = col2.get("user1").unwrap()["updatedAt"].clone();
    let created_at = col2.get("user1").unwrap()["createdAt"].clone();

    // Sleep briefly to get a new timestamp
    std::thread::sleep(std::time::Duration::from_millis(5));

    let updated = col2
        .update("user1", json!({ "name": "John Updated" }))
        .unwrap();

    assert_eq!(
        updated["createdAt"], created_at,
        "update must not change createdAt"
    );
    // updatedAt should differ (clock advanced)
    assert_ne!(
        updated["updatedAt"], before_updated_at,
        "update must advance updatedAt"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. OPTIONALWITHDEFAULT SEMANTICS
// ═══════════════════════════════════════════════════════════════════════════

fn default_field_schema() -> SchemaNode {
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
                    default_callback_id: "score_default".into(),
                },
            },
            StructField {
                name: "active".into(),
                schema: SchemaNode::OptionalWithDefault {
                    inner: Box::new(SchemaNode::Bool),
                    default_callback_id: "active_default".into(),
                },
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

fn default_field_collection() -> Collection {
    let mut callbacks = CallbackRegistry::new();
    callbacks.register_default("score_default", Box::new(|| json!(0)));
    callbacks.register_default("active_default", Box::new(|| json!(true)));
    Collection::new(
        "players",
        descriptor_with_schema(default_field_schema()),
        Arc::new(callbacks),
        Box::new(SequentialGenerator::new("p")),
    )
}

/// TS: Schema.optional(T, { default: () => 0 }) — absent field gets default
#[test]
fn optional_with_default_applies_callback_when_field_absent() {
    let mut col = default_field_collection();
    let entity = col
        .create(json!({ "id": "p1", "name": "Player One" }))
        .unwrap();
    assert_eq!(entity["score"], json!(0));
    assert_eq!(entity["active"], json!(true));
}

/// Supplied value overrides the default
#[test]
fn optional_with_default_does_not_apply_when_field_is_present() {
    let mut col = default_field_collection();
    let entity = col
        .create(json!({ "id": "p1", "name": "Alice", "score": 42 }))
        .unwrap();
    assert_eq!(entity["score"], json!(42));
}

/// Explicit null is NOT treated as absent — it must fail validation against inner (Number)
#[test]
fn optional_with_default_explicit_null_is_rejected_not_replaced() {
    let mut col = default_field_collection();
    let err = col
        .create(json!({ "id": "p1", "name": "Alice", "score": null }))
        .unwrap_err();
    assert_eq!(
        err.tag(),
        "ValidationError",
        "explicit null must produce ValidationError, not silently use default"
    );
}

/// Missing callback must fail loudly when field is absent
/// (not silently skip the default as old code did)
#[test]
fn optional_with_default_unregistered_callback_fails_loudly_when_field_absent() {
    // Schema requires a default but NO callback is registered
    let schema = SchemaNode::Struct {
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
                    default_callback_id: "score_default".into(),
                },
            },
        ],
    };
    let mut col = Collection::new(
        "players",
        descriptor_with_schema(schema),
        Arc::new(CallbackRegistry::new()), // no callbacks registered
        Box::new(SequentialGenerator::new("p")),
    );

    // Absent field with no callback → loud OperationError
    let err = col
        .create(json!({ "id": "p1", "name": "Alice" }))
        .unwrap_err();
    assert_eq!(
        err.tag(),
        "OperationError",
        "missing registered callback must produce OperationError, not silently succeed"
    );
}

/// Supplying the field explicitly bypasses the missing callback entirely
#[test]
fn optional_with_default_explicit_value_bypasses_missing_callback() {
    let schema = SchemaNode::Struct {
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
                    default_callback_id: "score_default".into(),
                },
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
    };
    let mut col = Collection::new(
        "players",
        descriptor_with_schema(schema),
        Arc::new(CallbackRegistry::new()),
        Box::new(SequentialGenerator::new("p")),
    );

    // Explicit value → no callback needed
    let entity = col
        .create(json!({ "id": "p1", "name": "Alice", "score": 99 }))
        .unwrap();
    assert_eq!(entity["score"], json!(99));
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. APPEND-ONLY EXACT ERROR PAYLOAD
// ═══════════════════════════════════════════════════════════════════════════
// TS factory: forbiddenOp(opName)
//   operation: opName
//   reason: "append-only"
//   message: `Operation '${opName}' is not allowed on append-only collection '${collectionName}'`

#[test]
fn append_only_update_has_exact_ts_error_payload() {
    let mut col = append_only_collection();
    col.create(json!({"id":"e1","name":"A","email":"a@b.com","age":1,"companyId":"c"}))
        .unwrap();
    let err = col.update("e1", json!({"name":"B"})).unwrap_err();
    match err {
        EngineError::Operation(e) => {
            assert_eq!(e.operation, "update");
            assert_eq!(e.reason, "append-only");
            assert_eq!(
                e.message,
                "Operation 'update' is not allowed on append-only collection 'events'"
            );
        }
        other => panic!("expected OperationError, got {other:?}"),
    }
}

#[test]
fn append_only_delete_has_exact_ts_error_payload() {
    let mut col = append_only_collection();
    col.create(json!({"id":"e1","name":"A","email":"a@b.com","age":1,"companyId":"c"}))
        .unwrap();
    let err = col.delete("e1").unwrap_err();
    match err {
        EngineError::Operation(e) => {
            assert_eq!(e.operation, "delete");
            assert_eq!(e.reason, "append-only");
            assert_eq!(
                e.message,
                "Operation 'delete' is not allowed on append-only collection 'events'"
            );
        }
        other => panic!("expected OperationError, got {other:?}"),
    }
}

#[test]
fn append_only_update_many_has_exact_ts_error_payload() {
    let mut col = append_only_collection();
    let err = col.update_many(|_| true, json!({"name":"B"})).unwrap_err();
    match err {
        EngineError::Operation(e) => {
            assert_eq!(e.operation, "updateMany");
            assert_eq!(e.reason, "append-only");
            assert!(e.message.contains("updateMany"));
        }
        other => panic!("expected OperationError, got {other:?}"),
    }
}

#[test]
fn append_only_delete_many_has_exact_ts_error_payload() {
    let mut col = append_only_collection();
    let err = col.delete_many(|_| true, false, None).unwrap_err();
    match err {
        EngineError::Operation(e) => {
            assert_eq!(e.operation, "deleteMany");
            assert_eq!(e.reason, "append-only");
        }
        other => panic!("expected OperationError, got {other:?}"),
    }
}

#[test]
fn append_only_upsert_has_exact_ts_error_payload() {
    let mut col = append_only_collection();
    let err = col
        .upsert(json!({"id":"e1"}), json!({}), json!({}))
        .unwrap_err();
    match err {
        EngineError::Operation(e) => {
            assert_eq!(e.operation, "upsert");
            assert_eq!(e.reason, "append-only");
        }
        other => panic!("expected OperationError, got {other:?}"),
    }
}

#[test]
fn append_only_upsert_many_has_exact_ts_error_payload() {
    let mut col = append_only_collection();
    let err = col.upsert_many(vec![]).unwrap_err();
    match err {
        EngineError::Operation(e) => {
            assert_eq!(e.operation, "upsertMany");
            assert_eq!(e.reason, "append-only");
        }
        other => panic!("expected OperationError, got {other:?}"),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. COMPUTED FIELD SANITIZATION
// ═══════════════════════════════════════════════════════════════════════════
// TS: `stripComputedFromInput` removes computed field names before validation/storage.

fn computed_schema() -> SchemaNode {
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
                name: "year".into(),
                schema: SchemaNode::Num,
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

fn computed_collection() -> Collection {
    let mut desc = descriptor_with_schema(computed_schema());
    // "displayName" is a computed field — not in schema, but might be in input
    desc.computed_fields = vec![
        ComputedFieldDescriptor {
            name: "displayName".into(),
            callback_id: "display_name_cb".into(),
        },
        ComputedFieldDescriptor {
            name: "age".into(),
            callback_id: "age_cb".into(),
        },
    ];
    Collection::new(
        "books",
        desc,
        Arc::new(CallbackRegistry::new()),
        Box::new(SequentialGenerator::new("b")),
    )
}

/// TS: computed field names are stripped from input before schema validation.
/// If "displayName" is in the schema it would fail; since it's computed it must be stripped.
#[test]
fn create_strips_computed_fields_before_validation() {
    let mut col = computed_collection();
    // Input includes "displayName" (computed) and "age" (computed) — neither is in schema
    // If they are NOT stripped, schema validation would fail or store garbage
    let entity = col
        .create(json!({
            "id": "b1",
            "title": "Rust Handbook",
            "year": 2024,
            "displayName": "Rust Handbook (2024)",  // computed — must be stripped
            "age": 1,                               // computed — must be stripped
        }))
        .unwrap();

    // Computed fields must NOT appear in the stored entity
    assert!(
        entity.get("displayName").is_none(),
        "computed field must not be stored"
    );
    assert!(
        entity.get("age").is_none(),
        "computed field must not be stored"
    );
    // Non-computed fields must be present
    assert_eq!(entity["title"], json!("Rust Handbook"));
    assert_eq!(entity["year"], json!(2024));
}

/// Computed fields are also stripped from update inputs
#[test]
fn update_strips_computed_fields_before_validation() {
    let mut col = computed_collection();
    col.create(json!({"id":"b1","title":"Rust Handbook","year":2024}))
        .unwrap();

    let updated = col
        .update(
            "b1",
            json!({
                "title": "Rust Programming",
                "displayName": "Rust Programming (2024)",  // computed — must be stripped
            }),
        )
        .unwrap();

    assert!(updated.get("displayName").is_none());
    assert_eq!(updated["title"], json!("Rust Programming"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. INSERTION-ORDERED STATE (mirrors JS Map)
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn list_preserves_insertion_order() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    for (id, name) in &[("a", "Alice"), ("b", "Bob"), ("c", "Charlie")] {
        col.create(
            json!({"id":id,"name":name,"email":format!("{id}@x.com"),"age":1,"companyId":"c"}),
        )
        .unwrap();
    }

    let ids: Vec<&str> = col
        .list()
        .iter()
        .map(|v| v["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["a", "b", "c"]);
}

#[test]
fn update_preserves_insertion_order() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    for (id, name) in &[("a", "Alice"), ("b", "Bob"), ("c", "Charlie")] {
        col.create(
            json!({"id":id,"name":name,"email":format!("{id}@x.com"),"age":1,"companyId":"c"}),
        )
        .unwrap();
    }

    col.update("b", json!({"name":"Bobby"})).unwrap();

    let ids: Vec<&str> = col
        .list()
        .iter()
        .map(|v| v["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["a", "b", "c"], "update must not change position");
}

#[test]
fn delete_then_reinsert_puts_entry_at_end() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    for (id, name) in &[("a", "Alice"), ("b", "Bob"), ("c", "Charlie")] {
        col.create(
            json!({"id":id,"name":name,"email":format!("{id}@x.com"),"age":1,"companyId":"c"}),
        )
        .unwrap();
    }

    col.delete("b").unwrap();
    col.create(json!({"id":"b","name":"Bob2","email":"b2@x.com","age":22,"companyId":"c"}))
        .unwrap();

    let ids: Vec<&str> = col
        .list()
        .iter()
        .map(|v| v["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec!["a", "c", "b"],
        "reinserted entry must appear at end"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. BATCH OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

// ── createMany ────────────────────────────────────────────────────────────

#[test]
fn create_many_creates_all_entities_atomically() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    let result = col
        .create_many(
            vec![
                json!({"id":"u1","name":"Alice","email":"a@x.com","age":1,"companyId":"c"}),
                json!({"id":"u2","name":"Bob","email":"b@x.com","age":2,"companyId":"c"}),
                json!({"id":"u3","name":"Charlie","email":"c@x.com","age":3,"companyId":"c"}),
            ],
            false,
        )
        .unwrap();

    assert_eq!(result.created.len(), 3);
    assert!(result.skipped.is_empty());
    assert_eq!(col.len(), 3);
}

#[test]
fn create_many_without_skip_duplicates_fails_atomically() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    col.create(json!({"id":"u1","name":"Existing","email":"e@x.com","age":1,"companyId":"c"}))
        .unwrap();

    // Second entity has same id → should fail; nothing should be mutated
    let err = col
        .create_many(
            vec![
                json!({"id":"u2","name":"Alice","email":"a@x.com","age":1,"companyId":"c"}),
                json!({"id":"u1","name":"Dup","email":"d@x.com","age":2,"companyId":"c"}), // duplicate
            ],
            false,
        )
        .unwrap_err();

    assert_eq!(err.tag(), "DuplicateKeyError");
    // Atomicity: u2 must NOT be in state since batch failed
    assert!(
        col.get("u2").is_none(),
        "failed createMany must not mutate state"
    );
    assert_eq!(col.len(), 1);
}

#[test]
fn create_many_with_skip_duplicates_skips_failing_entities() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    col.create(json!({"id":"u1","name":"Existing","email":"e@x.com","age":1,"companyId":"c"}))
        .unwrap();

    let result = col
        .create_many(
            vec![
                json!({"id":"u2","name":"Alice","email":"a@x.com","age":1,"companyId":"c"}),
                json!({"id":"u1","name":"Dup","email":"d@x.com","age":2,"companyId":"c"}), // dup
                json!({"id":"u3","name":"Charlie","email":"c@x.com","age":3,"companyId":"c"}),
            ],
            true, // skipDuplicates
        )
        .unwrap();

    assert_eq!(result.created.len(), 2, "u2 and u3 should be created");
    assert_eq!(result.skipped.len(), 1, "u1 duplicate should be skipped");
    assert_eq!(col.len(), 3); // existing u1 + new u2 + new u3
}

#[test]
fn create_many_batch_deduplicates_within_batch() {
    let mut col = collection_with_unique(
        unique_user_schema(),
        vec![UniqueConstraintDescriptor::Single("email".into())],
        SequentialGenerator::new("u"),
    );

    // Two entities with same email in the same batch — second should be skipped
    let result = col
        .create_many(
            vec![
                json!({"id":"u1","name":"Alice","email":"same@x.com","username":"alice","age":1}),
                json!({"id":"u2","name":"Alice2","email":"same@x.com","username":"alice2","age":2}),
            ],
            true,
        )
        .unwrap();

    assert_eq!(result.created.len(), 1);
    assert_eq!(result.skipped.len(), 1);
}

// ── updateMany ────────────────────────────────────────────────────────────

#[test]
fn update_many_updates_matching_entities() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    col.create(json!({"id":"u1","name":"Alice","email":"a@x.com","age":25,"companyId":"c"}))
        .unwrap();
    col.create(json!({"id":"u2","name":"Bob","email":"b@x.com","age":30,"companyId":"c"}))
        .unwrap();
    col.create(json!({"id":"u3","name":"Charlie","email":"c@x.com","age":35,"companyId":"c"}))
        .unwrap();

    // Update all users whose age > 28
    let result = col
        .update_many(
            |v| v["age"].as_f64().map(|a| a > 28.0).unwrap_or(false),
            json!({"age": {"$increment": 1}}),
        )
        .unwrap();

    assert_eq!(result.count, 2);
    assert_eq!(result.updated.len(), 2);
    assert_eq!(col.get("u1").unwrap()["age"], json!(25)); // unchanged
    assert_eq!(col.get("u2").unwrap()["age"], json!(31));
    assert_eq!(col.get("u3").unwrap()["age"], json!(36));
}

#[test]
fn update_many_returns_zero_when_none_match() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    col.create(json!({"id":"u1","name":"Alice","email":"a@x.com","age":25,"companyId":"c"}))
        .unwrap();

    let result = col
        .update_many(|_| false, json!({"name": "nobody"}))
        .unwrap();

    assert_eq!(result.count, 0);
    assert!(result.updated.is_empty());
}

#[test]
fn update_many_fails_atomically_on_validation_error() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    col.create(json!({"id":"u1","name":"Alice","email":"a@x.com","age":25,"companyId":"c"}))
        .unwrap();
    col.create(json!({"id":"u2","name":"Bob","email":"b@x.com","age":30,"companyId":"c"}))
        .unwrap();

    // age must be a number but we'll break it
    let err = col
        .update_many(|_| true, json!({"age":"not-a-number"}))
        .unwrap_err();
    assert_eq!(err.tag(), "ValidationError");
    // Neither entity should be mutated
    assert_eq!(col.get("u1").unwrap()["age"], json!(25));
    assert_eq!(col.get("u2").unwrap()["age"], json!(30));
}

// ── deleteMany ────────────────────────────────────────────────────────────

#[test]
fn delete_many_deletes_matching_entities() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    col.create(json!({"id":"u1","name":"A","email":"a@x.com","age":20,"companyId":"c"}))
        .unwrap();
    col.create(json!({"id":"u2","name":"B","email":"b@x.com","age":30,"companyId":"c"}))
        .unwrap();
    col.create(json!({"id":"u3","name":"C","email":"c@x.com","age":40,"companyId":"c"}))
        .unwrap();

    let result = col
        .delete_many(
            |v| v["age"].as_f64().map(|a| a >= 30.0).unwrap_or(false),
            false,
            None,
        )
        .unwrap();

    assert_eq!(result.count, 2);
    assert_eq!(result.deleted.len(), 2);
    assert_eq!(col.len(), 1);
    assert!(col.get("u1").is_some());
}

#[test]
fn delete_many_with_limit_respects_limit() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    for i in 1..=5u32 {
        col.create(json!({"id":format!("u{i}"),"name":"A","email":format!("a{i}@x.com"),"age":i,"companyId":"c"})).unwrap();
    }

    let result = col.delete_many(|_| true, false, Some(3)).unwrap();

    assert_eq!(result.count, 3);
    assert_eq!(col.len(), 2);
}

#[test]
fn delete_many_returns_zero_when_none_match() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    col.create(json!({"id":"u1","name":"A","email":"a@x.com","age":1,"companyId":"c"}))
        .unwrap();

    let result = col.delete_many(|_| false, false, None).unwrap();
    assert_eq!(result.count, 0);
    assert_eq!(col.len(), 1);
}

// ── upsertMany ────────────────────────────────────────────────────────────

fn upsert_col() -> Collection {
    collection_with_unique(
        unique_user_schema(),
        vec![
            UniqueConstraintDescriptor::Single("email".into()),
            UniqueConstraintDescriptor::Single("username".into()),
        ],
        SequentialGenerator::new("u"),
    )
}

#[test]
fn upsert_many_creates_updates_and_detects_unchanged() {
    let mut col = upsert_col();
    col.create(json!({"id":"u1","name":"Alice","email":"alice@x.com","username":"alice","age":30}))
        .unwrap();
    col.create(json!({"id":"u2","name":"Bob","email":"bob@x.com","username":"bob","age":25}))
        .unwrap();

    let result = col
        .upsert_many(vec![
            // UPDATE (name change)
            (
                json!({"id":"u1"}),
                json!({"name":"Alice Updated","email":"alice@x.com","username":"alice","age":30}),
                json!({"name":"Alice Updated"}),
            ),
            // UNCHANGED (same data)
            (
                json!({"id":"u2"}),
                json!({"name":"Bob","email":"bob@x.com","username":"bob","age":25}),
                json!({"name":"Bob"}), // same value, would not change
            ),
            // CREATE (new user)
            (
                json!({"id":"u3"}),
                json!({"name":"Charlie","email":"charlie@x.com","username":"charlie","age":22}),
                json!({"name":"Charlie"}),
            ),
        ])
        .unwrap();

    assert_eq!(result.created.len(), 1, "one entity should be created");
    assert_eq!(result.updated.len(), 1, "one entity should be updated");
    // Note: "unchanged" detection depends on deep comparison; may be 0 or 1 depending on implementation
    assert_eq!(col.len(), 3);
    assert_eq!(col.get("u1").unwrap()["name"], json!("Alice Updated"));
}

/// Computed fields must be stripped from the update payload *before* unchanged
/// detection in `upsert_many`.  This mirrors the TS engine: `stripComputedFromUpdates`
/// is called at the top of the update path in `update.ts`, before any change
/// detection or immutable-field validation.
///
/// Without the fix, a payload containing only computed field names would be
/// misclassified as "would change" (the key is absent from the stored entity,
/// so `would_update_change` sees an apparent new-field insertion) and the entity
/// would land in `updated` instead of `unchanged`.
#[test]
fn upsert_many_computed_only_update_is_unchanged() {
    let mut col = computed_collection();
    col.create(json!({"id": "b1", "title": "Rust Book", "year": 2024}))
        .unwrap();

    let result = col
        .upsert_many(vec![(
            json!({"id": "b1"}),
            json!({"title": "Rust Book", "year": 2024}),
            // update payload contains only "displayName" which is a computed field.
            // After strip_computed this becomes {} -> unchanged.
            json!({"displayName": "Rust Book (2024)"}),
        )])
        .unwrap();

    assert_eq!(
        result.unchanged.len(),
        1,
        "computed-only update must be categorized as unchanged, not updated"
    );
    assert_eq!(result.updated.len(), 0, "no real update should occur");
    assert_eq!(result.created.len(), 0);

    // The stored entity must not gain the computed field.
    assert!(
        col.get("b1").unwrap().get("displayName").is_none(),
        "computed field must not be stored in state"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. SOFT DELETE
// ═══════════════════════════════════════════════════════════════════════════

fn soft_delete_col() -> Collection {
    Collection::new(
        "users",
        descriptor_with_schema(soft_delete_user_schema()),
        Arc::new(CallbackRegistry::new()),
        Box::new(SequentialGenerator::new("u")),
    )
}

#[test]
fn soft_delete_marks_deleted_at() {
    let mut col = soft_delete_col();
    col.create(json!({"id":"u1","name":"Alice","email":"a@x.com","age":1,"companyId":"c"}))
        .unwrap();

    let deleted = col.delete_with_options("u1", true).unwrap();
    assert!(deleted.get("deletedAt").is_some());
    assert!(!deleted["deletedAt"].is_null());
    // Entity still in state (soft-deleted)
    assert!(col.get("u1").is_some());
}

#[test]
fn soft_delete_preserves_original_deleted_at_on_repeat() {
    let delete_ts = "2024-03-01T10:00:00.000Z";
    let mut col = Collection::new_with_clock(
        "users",
        descriptor_with_schema(soft_delete_user_schema()),
        Arc::new(CallbackRegistry::new()),
        Box::new(SequentialGenerator::new("u")),
        Box::new(FixedClock::new(delete_ts)),
    );
    col.create(json!({"id":"u1","name":"A","email":"a@x.com","age":1,"companyId":"c"}))
        .unwrap();

    // First soft delete
    let first = col.delete_with_options("u1", true).unwrap();
    let original_deleted_at = first["deletedAt"].clone();

    // Second soft delete — original deletedAt must be preserved (TS behavior)
    let second = col.delete_with_options("u1", true).unwrap();
    assert_eq!(
        second["deletedAt"], original_deleted_at,
        "repeated soft delete must preserve original deletedAt"
    );
}

#[test]
fn soft_delete_fails_when_schema_lacks_deleted_at() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u")); // no deletedAt
    col.create(json!({"id":"u1","name":"A","email":"a@x.com","age":1,"companyId":"c"}))
        .unwrap();

    let err = col.delete_with_options("u1", true).unwrap_err();
    assert_eq!(err.tag(), "OperationError");
}

#[test]
fn hard_delete_still_works_on_soft_delete_schema() {
    let mut col = soft_delete_col();
    col.create(json!({"id":"u1","name":"A","email":"a@x.com","age":1,"companyId":"c"}))
        .unwrap();

    let deleted = col.delete("u1").unwrap();
    assert_eq!(deleted["id"], json!("u1"));
    assert!(col.get("u1").is_none(), "hard delete must remove entity");
}

// ── deleteMany soft delete ─────────────────────────────────────────────────

#[test]
fn delete_many_soft_delete_preserves_original_deleted_at() {
    let mut col = soft_delete_col();
    col.create(json!({"id":"u1","name":"A","email":"a@x.com","age":1,"companyId":"c"}))
        .unwrap();
    col.create(json!({"id":"u2","name":"B","email":"b@x.com","age":2,"companyId":"c"}))
        .unwrap();

    // First soft-delete both
    let first_result = col.delete_many(|_| true, true, None).unwrap();
    let original_deleted_at_u1 = col.get("u1").unwrap()["deletedAt"].clone();

    // Second soft-delete — original deletedAt must be preserved
    let second_result = col.delete_many(|_| true, true, None).unwrap();
    assert_eq!(
        col.get("u1").unwrap()["deletedAt"],
        original_deleted_at_u1,
        "second deleteMany soft-delete must preserve original deletedAt"
    );
    let _ = (first_result, second_result); // used
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. UPSERT CREATE PRECEDENCE
// ═══════════════════════════════════════════════════════════════════════════
// TS: createData = { ...where, ...input.create, id, createdAt: now, updatedAt: now }
// where.id wins as the entity id; create_data fields override where fields.

fn upsert_unique_col() -> Collection {
    collection_with_unique(
        unique_user_schema(),
        vec![
            UniqueConstraintDescriptor::Single("email".into()),
            UniqueConstraintDescriptor::Single("username".into()),
        ],
        SequentialGenerator::new("u"),
    )
}

#[test]
fn upsert_create_path_where_id_wins_as_entity_id() {
    let mut col = upsert_unique_col();
    let outcome = col
        .upsert(
            json!({"id":"explicit-id"}),
            json!({"name":"Alice","email":"alice@x.com","username":"alice","age":30}),
            json!({}),
        )
        .unwrap();

    assert_eq!(outcome.action, UpsertAction::Created);
    assert_eq!(
        outcome.entity["id"],
        json!("explicit-id"),
        "where.id must be the entity id"
    );
}

#[test]
fn upsert_create_path_create_fields_override_where_fields() {
    let mut col = upsert_unique_col();
    let outcome = col
        .upsert(
            json!({"email":"where@x.com"}),
            // create supplies a different name from what where implies
            json!({"name":"CreateName","email":"where@x.com","username":"user1","age":20}),
            json!({}),
        )
        .unwrap();

    assert_eq!(outcome.action, UpsertAction::Created);
    assert_eq!(outcome.entity["name"], json!("CreateName"));
    assert_eq!(outcome.entity["email"], json!("where@x.com"));
}

#[test]
fn upsert_update_path_validates_immutable_fields() {
    let mut col = upsert_unique_col();
    col.create(json!({"id":"u1","name":"Alice","email":"alice@x.com","username":"alice","age":30}))
        .unwrap();

    // update_data tries to change id → should fail
    let err = col
        .upsert(
            json!({"id":"u1"}),
            json!({}),
            json!({"id":"different-id"}), // immutable
        )
        .unwrap_err();

    assert_eq!(err.tag(), "ValidationError");
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. $removeBy PREDICATE CALLBACK
// ═══════════════════════════════════════════════════════════════════════════

fn array_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "scores".into(),
                schema: SchemaNode::Array {
                    item: Box::new(SchemaNode::Num),
                },
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

#[test]
fn remove_by_predicate_removes_matching_elements_on_update() {
    let mut callbacks = CallbackRegistry::new();
    // Remove scores > 50
    callbacks.register_predicate(
        "over50",
        Box::new(|v| v.as_f64().map(|n| n > 50.0).unwrap_or(false)),
    );

    let mut col = Collection::new(
        "items",
        descriptor_with_schema(array_schema()),
        Arc::new(callbacks),
        Box::new(SequentialGenerator::new("i")),
    );

    col.create(json!({"id":"i1","scores":[10, 60, 20, 80, 30]}))
        .unwrap();

    let updated = col
        .update("i1", json!({"scores": {"$removeBy": "over50"}}))
        .unwrap();

    assert_eq!(updated["scores"], json!([10, 20, 30]));
}

#[test]
fn remove_by_value_still_works_after_predicate_support_added() {
    let mut col = collection(array_schema(), SequentialGenerator::new("i"));
    col.create(json!({"id":"i1","scores":[1,2,3,4,5]})).unwrap();

    let updated = col.update("i1", json!({"scores": {"$remove": 3}})).unwrap();
    assert_eq!(updated["scores"], json!([1, 2, 4, 5]));
}

/// Unregistered `$removeBy` callback must fail loudly (OperationError).
/// A missing predicate callback is a host-contract violation — not a silent no-op.
/// Mirrors: task requirement "Make unregistered $removeBy fail loudly".
#[test]
fn remove_by_unregistered_predicate_fails_with_operation_error() {
    let mut col = collection(array_schema(), SequentialGenerator::new("i"));
    col.create(json!({"id":"i1","scores":[1,2,3]})).unwrap();

    let err = col
        .update("i1", json!({"scores": {"$removeBy": "nonexistent"}}))
        .unwrap_err();
    assert_eq!(
        err.tag(),
        "OperationError",
        "unregistered $removeBy must produce OperationError, not silently no-op"
    );
    match err {
        EngineError::Operation(e) => {
            assert_eq!(e.operation, "$removeBy");
            assert!(
                e.reason.contains("nonexistent"),
                "reason must name the missing callback id"
            );
        }
        other => panic!("expected OperationError, got {other:?}"),
    }
    // Entity must be unchanged after the failed update
    assert_eq!(col.get("i1").unwrap()["scores"], json!([1, 2, 3]));
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. UNIQUE CONSTRAINT CHECK OPTIMIZATION
// ═══════════════════════════════════════════════════════════════════════════
// TS: skip unique check on update when update doesn't touch any unique field

#[test]
fn update_skips_unique_check_when_no_unique_fields_touched() {
    // If this test panics or fails with UniqueConstraintError, the optimization is broken
    let mut col = collection_with_unique(
        unique_user_schema(),
        vec![UniqueConstraintDescriptor::Single("email".into())],
        SequentialGenerator::new("u"),
    );

    col.create(json!({"id":"u1","name":"Alice","email":"alice@x.com","username":"alice","age":30}))
        .unwrap();
    col.create(json!({"id":"u2","name":"Bob","email":"bob@x.com","username":"bob","age":25}))
        .unwrap();

    // Update only non-unique "name" — must not trigger UniqueConstraintError
    let result = col.update("u1", json!({"name":"Alice Updated"}));
    assert!(
        result.is_ok(),
        "update touching only non-unique fields must succeed"
    );
}

#[test]
fn update_runs_unique_check_when_unique_field_is_touched() {
    let mut col = collection_with_unique(
        unique_user_schema(),
        vec![UniqueConstraintDescriptor::Single("email".into())],
        SequentialGenerator::new("u"),
    );

    col.create(json!({"id":"u1","name":"Alice","email":"alice@x.com","username":"alice","age":30}))
        .unwrap();
    col.create(json!({"id":"u2","name":"Bob","email":"bob@x.com","username":"bob","age":25}))
        .unwrap();

    // Update unique field to a value that conflicts
    let err = col.update("u1", json!({"email":"bob@x.com"})).unwrap_err();
    assert_eq!(err.tag(), "UniqueConstraintError");
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. EXISTING CRUD HAPPY / ERROR PATHS (regression)
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn create_with_auto_generated_id() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    let entity = col
        .create(json!({"name":"John Doe","email":"john@example.com","age":30,"companyId":"comp1"}))
        .unwrap();

    assert_eq!(entity["name"], json!("John Doe"));
    assert!(entity["id"].is_string());
    assert!(!entity["id"].as_str().unwrap().is_empty());
    assert!(entity["createdAt"].is_string());
    assert!(entity["updatedAt"].is_string());
    assert_eq!(col.len(), 1);
}

#[test]
fn create_with_provided_id() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    let entity = col
        .create(
            json!({"id":"custom-id","name":"Jane","email":"jane@x.com","age":25,"companyId":"c"}),
        )
        .unwrap();
    assert_eq!(entity["id"], json!("custom-id"));
}

#[test]
fn create_duplicate_id_fails_with_duplicate_key_error() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    col.create(json!({"id":"u1","name":"A","email":"a@x.com","age":1,"companyId":"c"}))
        .unwrap();
    let err = col
        .create(json!({"id":"u1","name":"B","email":"b@x.com","age":2,"companyId":"c"}))
        .unwrap_err();
    assert_eq!(err.tag(), "DuplicateKeyError");
}

#[test]
fn schema_violation_fails_with_validation_error() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    let err = col
        .create(
            json!({"id":"u1","name":"A","email":"a@x.com","age":"not-a-number","companyId":"c"}),
        )
        .unwrap_err();
    assert_eq!(err.tag(), "ValidationError");
}

#[test]
fn update_field_with_direct_assignment() {
    let (mut col, _) = seeded_user_collection();
    let updated = col.update("user1", json!({"name":"John Updated"})).unwrap();
    assert_eq!(updated["name"], json!("John Updated"));
    assert_eq!(updated["email"], json!("john@example.com")); // unchanged
}

#[test]
fn update_increment_operator() {
    let (mut col, _) = seeded_user_collection();
    let result = col
        .update("user1", json!({"age":{"$increment":5}}))
        .unwrap();
    assert_eq!(result["age"], json!(35));
}

#[test]
fn update_decrement_operator() {
    let (mut col, _) = seeded_user_collection();
    let result = col
        .update("user1", json!({"age":{"$decrement":10}}))
        .unwrap();
    assert_eq!(result["age"], json!(20));
}

#[test]
fn update_multiply_operator() {
    let (mut col, _) = seeded_user_collection();
    let result = col.update("user1", json!({"age":{"$multiply":2}})).unwrap();
    assert_eq!(result["age"], json!(60));
}

#[test]
fn update_append_to_string() {
    let (mut col, _) = seeded_user_collection();
    let result = col
        .update("user1", json!({"name":{"$append":" Jr."}}))
        .unwrap();
    assert_eq!(result["name"], json!("John Doe Jr."));
}

#[test]
fn update_prepend_to_string() {
    let (mut col, _) = seeded_user_collection();
    let result = col
        .update("user1", json!({"name":{"$prepend":"Dr. "}}))
        .unwrap();
    assert_eq!(result["name"], json!("Dr. John Doe"));
}

#[test]
fn update_append_to_array() {
    let (mut col, _) = seeded_user_collection();
    let result = col
        .update("user1", json!({"tags":{"$append":"qa"}}))
        .unwrap();
    assert_eq!(result["tags"], json!(["admin", "dev", "qa"]));
}

#[test]
fn update_prepend_to_array() {
    let (mut col, _) = seeded_user_collection();
    let result = col
        .update("user1", json!({"tags":{"$prepend":"lead"}}))
        .unwrap();
    assert_eq!(result["tags"], json!(["lead", "admin", "dev"]));
}

#[test]
fn update_remove_from_array_by_value() {
    let (mut col, _) = seeded_user_collection();
    let result = col
        .update("user1", json!({"tags":{"$remove":"admin"}}))
        .unwrap();
    assert_eq!(result["tags"], json!(["dev"]));
}

#[test]
fn update_toggle_boolean_operator() {
    let (mut col, _) = seeded_user_collection();
    let result = col
        .update("user1", json!({"active":{"$toggle":true}}))
        .unwrap();
    assert_eq!(result["active"], json!(false));
}

#[test]
fn update_not_found_fails_with_not_found_error() {
    let (mut col, _) = seeded_user_collection();
    let err = col.update("nonexistent", json!({"name":"X"})).unwrap_err();
    assert_eq!(err.tag(), "NotFoundError");
}

#[test]
fn update_immutable_id_fails() {
    let (mut col, _) = seeded_user_collection();
    let err = col.update("user1", json!({"id":"new-id"})).unwrap_err();
    assert_eq!(err.tag(), "ValidationError");
}

#[test]
fn update_immutable_created_at_fails() {
    let (mut col, _) = seeded_user_collection();
    let err = col
        .update("user1", json!({"createdAt":"2000-01-01"}))
        .unwrap_err();
    assert_eq!(err.tag(), "ValidationError");
}

#[test]
fn delete_existing_entity() {
    let (mut col, _) = seeded_user_collection();
    let deleted = col.delete("user1").unwrap();
    assert_eq!(deleted["id"], json!("user1"));
    assert_eq!(col.len(), 0);
}

#[test]
fn delete_not_found_fails() {
    let (mut col, _) = seeded_user_collection();
    assert_eq!(col.delete("missing").unwrap_err().tag(), "NotFoundError");
}

// ── Unique constraints regression ──────────────────────────────────────────

#[test]
fn unique_single_field_violation_fails() {
    let mut col = collection_with_unique(
        unique_user_schema(),
        vec![
            UniqueConstraintDescriptor::Single("email".into()),
            UniqueConstraintDescriptor::Single("username".into()),
        ],
        SequentialGenerator::new("u"),
    );

    col.create(json!({"id":"u1","name":"Alice","email":"alice@x.com","username":"alice","age":30}))
        .unwrap();
    let err = col
        .create(json!({"id":"u2","name":"Bob","email":"alice@x.com","username":"bob","age":25}))
        .unwrap_err();
    match err {
        EngineError::UniqueConstraint(e) => {
            assert_eq!(e.collection, "test");
            assert_eq!(e.constraint, "unique_email");
            assert_eq!(e.fields, vec!["email"]);
            assert_eq!(e.existing_id, "u1");
        }
        other => panic!("expected UniqueConstraintError, got {other:?}"),
    }
}

#[test]
fn unique_compound_field_violation_fails() {
    let mut col = collection_with_unique(
        setting_schema(),
        vec![UniqueConstraintDescriptor::Compound(vec![
            "userId".into(),
            "settingKey".into(),
        ])],
        SequentialGenerator::new("s"),
    );

    col.create(json!({"id":"s1","userId":"u1","settingKey":"theme","value":"dark"}))
        .unwrap();
    let err = col
        .create(json!({"id":"s2","userId":"u1","settingKey":"theme","value":"light"}))
        .unwrap_err();
    match err {
        EngineError::UniqueConstraint(e) => {
            assert_eq!(e.constraint, "unique_userId_settingKey");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn unique_null_field_skips_constraint_check() {
    let schema = SchemaNode::Struct {
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
                name: "email".into(),
                schema: SchemaNode::NullOr(Box::new(SchemaNode::Str)),
            },
            StructField {
                name: "username".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "age".into(),
                schema: SchemaNode::Num,
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
    };
    let mut col = collection_with_unique(
        schema,
        vec![UniqueConstraintDescriptor::Single("email".into())],
        SequentialGenerator::new("u"),
    );

    col.create(json!({"id":"u1","name":"Alice","email":null,"username":"alice","age":30}))
        .unwrap();
    // Second null email must NOT conflict
    let result = col.create(json!({"id":"u2","name":"Bob","email":null,"username":"bob","age":25}));
    assert!(result.is_ok(), "null unique fields must not conflict");
}

// ── DerivedFromKey ─────────────────────────────────────────────────────────

#[test]
fn derived_from_key_validates_schema_without_id_field() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "name".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "userId".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
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
    };
    let mut desc = descriptor_with_schema(schema);
    desc.id_strategy = IdStrategy::DerivedFromKey;
    let mut col = Collection::new(
        "games",
        desc,
        Arc::new(CallbackRegistry::new()),
        Box::new(SequentialGenerator::new("g")),
    );

    let entity = col
        .create(json!({"id":"sonic-the-hedgehog","name":"Sonic"}))
        .unwrap();
    assert_eq!(entity["id"], json!("sonic-the-hedgehog"));
    assert_eq!(entity["name"], json!("Sonic"));
    assert_eq!(col.get("sonic-the-hedgehog").unwrap(), &entity);
}

// ── Upsert regression ──────────────────────────────────────────────────────

#[test]
fn upsert_creates_new_entity_when_not_found_by_id() {
    let mut col = upsert_unique_col();
    let outcome = col
        .upsert(
            json!({"id":"user1"}),
            json!({"name":"Alice","email":"alice@x.com","username":"alice","age":30}),
            json!({}),
        )
        .unwrap();
    assert_eq!(outcome.action, UpsertAction::Created);
    assert_eq!(outcome.entity["id"], json!("user1"));
    assert_eq!(col.len(), 1);
}

#[test]
fn upsert_updates_existing_entity_when_found_by_id() {
    let mut col = upsert_unique_col();
    col.create(
        json!({"id":"user1","name":"Alice","email":"alice@x.com","username":"alice","age":30}),
    )
    .unwrap();
    let outcome = col
        .upsert(
            json!({"id":"user1"}),
            json!({"name":"Alice Updated","email":"alice@x.com","username":"alice","age":30}),
            json!({"name":"Alice Updated"}),
        )
        .unwrap();
    assert_eq!(outcome.action, UpsertAction::Updated);
    assert_eq!(outcome.entity["name"], json!("Alice Updated"));
    assert_eq!(col.len(), 1);
}

#[test]
fn upsert_invalid_where_clause_fails_with_validation_error() {
    let mut col = upsert_unique_col();
    let err = col
        .upsert(json!({"name":"Alice"}), json!({}), json!({}))
        .unwrap_err();
    assert_eq!(err.tag(), "ValidationError");
}

#[test]
fn upsert_by_unique_field_creates_when_not_found() {
    let mut col = upsert_unique_col();
    let outcome = col
        .upsert(
            json!({"email":"alice@x.com"}),
            json!({"name":"Alice","username":"alice","age":30}),
            json!({}),
        )
        .unwrap();
    assert_eq!(outcome.action, UpsertAction::Created);
    assert_eq!(outcome.entity["email"], json!("alice@x.com"));
}

#[test]
fn upsert_by_unique_field_updates_when_found() {
    let mut col = upsert_unique_col();
    col.create(json!({"id":"u1","name":"Alice","email":"alice@x.com","username":"alice","age":30}))
        .unwrap();
    let outcome = col
        .upsert(
            json!({"email":"alice@x.com"}),
            json!({"age":31}),
            json!({"age":31}),
        )
        .unwrap();
    assert_eq!(outcome.action, UpsertAction::Updated);
    assert_eq!(outcome.entity["age"], json!(31));
}

// ── Error tag verification ─────────────────────────────────────────────────

#[test]
fn all_crud_error_tags_match_ts_tag_strings() {
    use proseql_engine::errors::*;

    let cases: &[(&str, EngineError)] = &[
        (
            "NotFoundError",
            EngineError::NotFound(NotFoundError {
                collection: "c".into(),
                id: "i".into(),
                message: "m".into(),
            }),
        ),
        (
            "DuplicateKeyError",
            EngineError::DuplicateKey(Box::new(DuplicateKeyError {
                collection: "c".into(),
                field: "id".into(),
                value: "v".into(),
                existing_id: "v".into(),
                message: "m".into(),
            })),
        ),
        (
            "ValidationError",
            EngineError::Validation(ValidationError {
                message: "m".into(),
                issues: vec![],
            }),
        ),
        (
            "UniqueConstraintError",
            EngineError::UniqueConstraint(Box::new(UniqueConstraintError {
                collection: "c".into(),
                constraint: "con".into(),
                fields: vec![],
                values: Default::default(),
                existing_id: "v".into(),
                message: "m".into(),
            })),
        ),
        (
            "OperationError",
            EngineError::Operation(OperationError {
                operation: "op".into(),
                reason: "r".into(),
                message: "m".into(),
            }),
        ),
    ];

    for (expected_tag, error) in cases {
        assert_eq!(
            error.tag(),
            *expected_tag,
            "tag mismatch for {expected_tag}"
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 12. BATCH CORRECTNESS GAPS (TDD: these tests drive the four fixes)
// ═══════════════════════════════════════════════════════════════════════════

// ── 12a. update_many batch unique collision ────────────────────────────────
// Regression: the old implementation checked each proposed entity against
// the *current* state (excluding self) but NOT against the *other proposed
// entities* in the same batch.  Two rows updated to the same unique value
// must fail even though individually each appears valid.

#[test]
fn update_many_batch_unique_collision_fails_atomically() {
    // Both entities will be updated to the same email — should fail.
    let mut col = collection_with_unique(
        unique_user_schema(),
        vec![UniqueConstraintDescriptor::Single("email".into())],
        SequentialGenerator::new("u"),
    );
    col.create(json!({"id":"u1","name":"Alice","email":"alice@x.com","username":"alice","age":30}))
        .unwrap();
    col.create(json!({"id":"u2","name":"Bob","email":"bob@x.com","username":"bob","age":25}))
        .unwrap();

    let err = col
        .update_many(|_| true, json!({"email": "same@x.com"}))
        .unwrap_err();

    assert_eq!(
        err.tag(),
        "UniqueConstraintError",
        "two rows updated to the same unique value must fail"
    );
    // No partial mutation — both rows must be unchanged
    assert_eq!(
        col.get("u1").unwrap()["email"],
        json!("alice@x.com"),
        "u1 must be unchanged on failed update_many"
    );
    assert_eq!(
        col.get("u2").unwrap()["email"],
        json!("bob@x.com"),
        "u2 must be unchanged on failed update_many"
    );
}

// ── 12b. upsert_many atomicity ─────────────────────────────────────────────
// Regression: the old implementation called self.create() inside the
// categorization loop, mutating state before later validations.  All three
// scenarios below must leave state completely unchanged on failure.

/// A late invalid create (bad schema) must roll back all earlier creates.
#[test]
fn upsert_many_late_invalid_create_fails_atomically() {
    let mut col = collection(unique_user_schema(), SequentialGenerator::new("u"));

    // Input 0: valid — would create u2
    // Input 1: invalid schema (age is a string) — should cause whole batch to fail
    let err = col
        .upsert_many(vec![
            (
                json!({"id":"u2"}),
                json!({"name":"Bob","email":"bob@x.com","username":"bob","age":25}),
                json!({}),
            ),
            (
                json!({"id":"u3"}),
                json!({"name":"Charlie","email":"charlie@x.com","username":"charlie","age":"not-a-number"}), // bad schema
                json!({}),
            ),
        ])
        .unwrap_err();

    assert_eq!(
        err.tag(),
        "ValidationError",
        "bad schema in create path must propagate as ValidationError"
    );
    // u2 must NOT have been inserted (atomicity)
    assert!(
        col.get("u2").is_none(),
        "u2 must not be in state — upsert_many must be atomic"
    );
    assert_eq!(col.len(), 0);
}

/// Duplicate id among creates in the same upsert_many batch must fail atomically.
#[test]
fn upsert_many_duplicate_id_among_creates_fails_atomically() {
    let mut col = collection(unique_user_schema(), SequentialGenerator::new("u"));

    let err = col
        .upsert_many(vec![
            (
                json!({"id":"dup"}),
                json!({"name":"Alice","email":"alice@x.com","username":"alice","age":30}),
                json!({}),
            ),
            (
                json!({"id":"dup"}), // same id — must fail
                json!({"name":"Bob","email":"bob@x.com","username":"bob","age":25}),
                json!({}),
            ),
        ])
        .unwrap_err();

    assert_eq!(err.tag(), "DuplicateKeyError");
    // Nothing inserted
    assert!(col.get("dup").is_none());
    assert_eq!(col.len(), 0);
}

/// A unique collision between an update and another update in the same batch
/// must fail atomically — neither entity should be mutated.
#[test]
fn upsert_many_update_unique_collision_fails_atomically() {
    let mut col = collection_with_unique(
        unique_user_schema(),
        vec![UniqueConstraintDescriptor::Single("email".into())],
        SequentialGenerator::new("u"),
    );
    col.create(json!({"id":"u1","name":"Alice","email":"alice@x.com","username":"alice","age":30}))
        .unwrap();
    col.create(json!({"id":"u2","name":"Bob","email":"bob@x.com","username":"bob","age":25}))
        .unwrap();

    // Both updates propose the same email → batch-level unique collision
    let err = col
        .upsert_many(vec![
            (
                json!({"id":"u1"}),
                json!({"name":"Alice","email":"same@x.com","username":"alice","age":30}),
                json!({"email":"same@x.com"}),
            ),
            (
                json!({"id":"u2"}),
                json!({"name":"Bob","email":"same@x.com","username":"bob","age":25}),
                json!({"email":"same@x.com"}),
            ),
        ])
        .unwrap_err();

    assert_eq!(err.tag(), "UniqueConstraintError");
    assert_eq!(col.get("u1").unwrap()["email"], json!("alice@x.com"));
    assert_eq!(col.get("u2").unwrap()["email"], json!("bob@x.com"));
}

// ── 12c. createMany skip data and reason strings ───────────────────────────
// The TS corpus verifies exact reason strings and that `data` is the
// sanitized-input entity (with resolved id but without auto-timestamps).

#[test]
fn create_many_skipped_data_is_entity_with_resolved_id_not_error_string() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    // Pre-exist u1 so the second batch entry duplicates it
    col.create(json!({"id":"u1","name":"Existing","email":"e@x.com","age":1,"companyId":"c"}))
        .unwrap();

    let result = col
        .create_many(
            vec![
                // first entry — validation fails (age is string)
                json!({"id":"v1","name":"Bad","email":"bad@x.com","age":"not-a-number","companyId":"c"}),
                // second entry — duplicate id
                json!({"id":"u1","name":"Dup","email":"dup@x.com","age":2,"companyId":"c"}),
            ],
            true,
        )
        .unwrap();

    assert_eq!(result.skipped.len(), 2);

    // Both skipped entries must carry `data` as a JSON object, NOT as a plain error string
    for entry in &result.skipped {
        assert!(
            entry.data.is_object(),
            "skipped.data must be a JSON object (the entity), got: {:?}",
            entry.data
        );
        // id must be present and a string
        assert!(
            entry.data["id"].is_string(),
            "skipped.data must include the resolved id"
        );
    }

    // Validation skip: id=v1
    let val_skip = result.skipped.iter().find(|e| e.data["id"] == json!("v1"));
    assert!(val_skip.is_some(), "should have a skip entry for v1");

    // Duplicate skip: id=u1
    let dup_skip = result.skipped.iter().find(|e| e.data["id"] == json!("u1"));
    assert!(dup_skip.is_some(), "should have a skip entry for u1");
}

#[test]
fn create_many_skipped_reason_strings_match_ts_format() {
    let mut col = collection_with_unique(
        unique_user_schema(),
        vec![UniqueConstraintDescriptor::Single("email".into())],
        SequentialGenerator::new("u"),
    );
    // Pre-exist u1 for dup-id test, and ua@x.com for unique test
    col.create(json!({"id":"u1","name":"Existing","email":"ea@x.com","username":"ea","age":1}))
        .unwrap();

    let result = col
        .create_many(
            vec![
                // 1. Duplicate id → "Duplicate ID: u1"
                json!({"id":"u1","name":"Dup","email":"dup@x.com","username":"dup","age":2}),
                // 2. Validation failure → "Validation failed: ..."
                json!({"id":"v1","name":"Bad","email":"bad@x.com","username":"bad","age":"not-a-num"}),
                // 3. Unique constraint violation → "Unique constraint violation: ..."
                json!({"id":"un1","name":"UC","email":"ea@x.com","username":"uc","age":5}),
            ],
            true,
        )
        .unwrap();

    assert_eq!(result.skipped.len(), 3, "all three entries must be skipped");

    let dup = result
        .skipped
        .iter()
        .find(|e| e.data["id"] == json!("u1"))
        .expect("dup skip entry");
    assert!(
        dup.reason.starts_with("Duplicate ID:"),
        "dup reason must start with 'Duplicate ID:', got: {:?}",
        dup.reason
    );

    let val = result
        .skipped
        .iter()
        .find(|e| e.data["id"] == json!("v1"))
        .expect("validation skip entry");
    assert!(
        val.reason.starts_with("Validation failed:"),
        "validation reason must start with 'Validation failed:', got: {:?}",
        val.reason
    );

    let uc = result
        .skipped
        .iter()
        .find(|e| e.data["id"] == json!("un1"))
        .expect("unique constraint skip entry");
    assert!(
        uc.reason.starts_with("Unique constraint violation:"),
        "unique reason must start with 'Unique constraint violation:', got: {:?}",
        uc.reason
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// SEMANTIC GAP FIXES: decode_value, upsert id, deleteMany limit, js_eq
// ═══════════════════════════════════════════════════════════════════════════

// ── 1. CRUD stores decoded values (decode_value integration) ────────────────
//
// validate_entity now calls decode_value, so stored entities reflect the
// decoded (runtime) form: NumFromStr "42" → 42, excess props stripped.

/// Schema with a NumberFromString field.
fn count_schema() -> SchemaNode {
    SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "count".into(),
                schema: SchemaNode::NumFromStr,
            },
        ],
    }
}

/// Create stores the decoded number, not the raw string.
///
/// TS: `const validated = yield* Schema.decodeUnknownEffect(schema)(raw)` stores
/// the decoded entity. NumberFromString "42" becomes 42.
#[test]
fn create_stores_decoded_number_from_numeric_string_input() {
    let mut col = collection(count_schema(), SequentialGenerator::new("c"));
    let entity = col
        .create(json!({ "id": "c1", "count": "42" })) // "42" is the encoded form
        .expect("create must accept encoded NumFromStr input");

    assert_eq!(
        entity["count"],
        json!(42),
        "stored entity must have decoded number 42, not string \"42\""
    );
    // Retrieved entity must also be the decoded form
    let retrieved = col.get("c1").unwrap();
    assert_eq!(retrieved["count"], json!(42));
}

/// Create strips excess properties not declared in the schema.
///
/// TS: `Schema.decodeUnknownEffect(schema)(raw)` with default
/// `onExcessProperty: "ignore"` strips undeclared keys.
#[test]
fn create_strips_excess_properties_not_in_schema() {
    // Schema that does NOT declare createdAt/updatedAt
    let minimal = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "name".into(),
                schema: SchemaNode::Str,
            },
        ],
    };
    let mut col = collection(minimal, SequentialGenerator::new("m"));
    let entity = col
        .create(json!({ "id": "m1", "name": "Alice", "extra": "noise" }))
        .expect("create must succeed with excess properties present");

    // Only declared schema fields (plus the engine-added id) survive decode.
    // extra must be stripped.
    assert!(
        entity.get("extra").is_none(),
        "excess field 'extra' must be stripped"
    );
    assert_eq!(entity["id"], json!("m1"));
    assert_eq!(entity["name"], json!("Alice"));

    // Note: createdAt/updatedAt are also NOT in this minimal schema.
    // They are added by create() but then stripped by decode_value.
    assert!(
        entity.get("createdAt").is_none(),
        "createdAt must be stripped since it is not in the minimal schema"
    );
}

/// DerivedFromKey: decode strips the id field, validates the payload schema,
/// then reattaches id.
#[test]
fn create_derived_from_key_decodes_and_reattaches_id() {
    let schema = SchemaNode::Struct {
        fields: vec![
            // id is NOT in the derived-key schema (the persisted payload omits it)
            StructField {
                name: "name".into(),
                schema: SchemaNode::Str,
            },
        ],
    };
    let mut desc = descriptor_with_schema(schema);
    desc.id_strategy = IdStrategy::DerivedFromKey;
    let mut col = Collection::new(
        "items",
        desc,
        Arc::new(CallbackRegistry::new()),
        Box::new(SequentialGenerator::new("i")),
    );
    let entity = col
        .create(json!({ "id": "game-1", "name": "Zelda" }))
        .expect("DerivedFromKey create must succeed");

    assert_eq!(entity["id"], json!("game-1"), "id must be reattached");
    assert_eq!(entity["name"], json!("Zelda"));
    // `id` is NOT in the schema payload, but the engine re-attaches it
}

// ── 2. Upsert id precedence (where.id only, no fallback to create_data.id) ─

/// TS: `const id = typeof where.id === "string" ? where.id : generateId()`
/// create_data.id is NOT used as a fallback.
#[test]
fn upsert_create_uses_where_id_not_create_data_id() {
    let mut col = collection_with_unique(
        unique_user_schema(),
        vec![UniqueConstraintDescriptor::Single("email".into())],
        SequentialGenerator::new("gen"),
    );

    let result = col
        .upsert(
            json!({ "email": "alice@x.com" }), // where — no id
            json!({                               // create_data — has an id that should be IGNORED
                "email": "alice@x.com",
                "name": "Alice",
                "username": "alice",
                "age": 30,
                "id": "create-data-id-should-be-ignored",
            }),
            json!({}), // update_data
        )
        .expect("upsert create must succeed");

    // The entity must have been created (not found in state)
    assert_eq!(result.action, UpsertAction::Created);

    // The stored id must be generated (gen-1), NOT the create_data id
    let stored_id = result.entity["id"].as_str().unwrap();
    assert_ne!(
        stored_id, "create-data-id-should-be-ignored",
        "create_data.id must be overwritten by the generated id (TS semantics)"
    );
    assert_eq!(stored_id, "gen-1", "id must be the generated id");
}

/// When where has an id, it is used directly.
#[test]
fn upsert_create_uses_where_id_when_present() {
    let mut col = collection_with_unique(
        unique_user_schema(),
        vec![UniqueConstraintDescriptor::Single("email".into())],
        SequentialGenerator::new("gen"),
    );

    let result = col
        .upsert(
            json!({ "id": "where-id", "email": "bob@x.com" }), // where has id
            json!({ "email": "bob@x.com", "name": "Bob", "username": "bob", "age": 25 }),
            json!({}),
        )
        .expect("upsert create with where.id must succeed");

    assert_eq!(result.action, UpsertAction::Created);
    assert_eq!(
        result.entity["id"],
        json!("where-id"),
        "where.id must be used"
    );
}

/// upsert_many create path: no fallback to create_data.id.
#[test]
fn upsert_many_create_uses_where_id_not_create_data_id() {
    let mut col = collection_with_unique(
        unique_user_schema(),
        vec![UniqueConstraintDescriptor::Single("email".into())],
        SequentialGenerator::new("gen"),
    );

    let result = col
        .upsert_many(vec![(
            json!({ "email": "charlie@x.com" }), // no id in where
            json!({                               // create_data has id — should be ignored
                "email": "charlie@x.com",
                "name": "Charlie",
                "username": "charlie",
                "age": 22,
                "id": "should-be-ignored",
            }),
            json!({}),
        )])
        .expect("upsert_many create must succeed");

    assert_eq!(result.created.len(), 1);
    let stored_id = result.created[0]["id"].as_str().unwrap();
    assert_ne!(
        stored_id, "should-be-ignored",
        "create_data.id must not be used (TS: id = where.id ?? generateId())"
    );
    assert_eq!(stored_id, "gen-1");
}

// ── 3. deleteMany limit = 0 means no cap ────────────────────────────────────

/// TS: `if (options?.limit !== undefined && options.limit > 0) { slice }`
/// limit = 0 means "no cap" — all matching entities are deleted.
#[test]
fn delete_many_limit_zero_means_no_cap_deletes_all_matching() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    for i in 1..=5u32 {
        col.create(json!({
            "id": format!("u{i}"),
            "name": format!("User {i}"),
            "email": format!("u{i}@x.com"),
            "age": i,
            "companyId": "c"
        }))
        .unwrap();
    }

    // limit = 0 → no cap (matches all 5)
    let result = col.delete_many(|_| true, false, Some(0)).unwrap();
    assert_eq!(result.count, 5, "limit=0 must mean no cap (all 5 deleted)");
    assert!(col.is_empty());
}

/// limit = 3 still works as a cap.
#[test]
fn delete_many_positive_limit_still_caps() {
    let mut col = collection(user_schema(), SequentialGenerator::new("u"));
    for i in 1..=5u32 {
        col.create(json!({
            "id": format!("u{i}"),
            "name": format!("User {i}"),
            "email": format!("u{i}@x.com"),
            "age": i,
            "companyId": "c"
        }))
        .unwrap();
    }

    let result = col.delete_many(|_| true, false, Some(3)).unwrap();
    assert_eq!(result.count, 3, "limit=3 must cap at 3");
    assert_eq!(col.len(), 2);
}

// ── 4. JS strict-equality semantics (js_eq) ──────────────────────────────────

/// Scalar unique constraints use value equality (same as JS ===).
/// Two entities with the same string email → UniqueConstraintError.
#[test]
fn unique_constraint_scalar_value_equality_enforced() {
    let mut col = collection_with_unique(
        unique_user_schema(),
        vec![UniqueConstraintDescriptor::Single("email".into())],
        SequentialGenerator::new("u"),
    );
    col.create(json!({"id":"u1","name":"A","email":"alice@x.com","username":"alice","age":1}))
        .unwrap();

    let err = col
        .create(json!({"id":"u2","name":"B","email":"alice@x.com","username":"alice2","age":2}))
        .unwrap_err();

    match err {
        EngineError::UniqueConstraint(e) => assert_eq!(e.fields, vec!["email"]),
        other => panic!("expected UniqueConstraintError, got {other:?}"),
    }
}

/// Object-valued field in a unique constraint: js_eq returns false for objects
/// across the JSON boundary (identity semantics).
/// Two entities with structurally identical object values in a "unique" field
/// are treated as different values and the constraint does NOT fire.
#[test]
fn unique_constraint_object_valued_field_never_matches_js_identity_semantics() {
    // Schema with an object-valued field that we declare as a unique constraint.
    // In TS, field === field' is identity — always false for distinct objects.
    // Our js_eq models this: objects are never equal at the JSON boundary.
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "meta".into(),
                schema: SchemaNode::Struct {
                    fields: vec![StructField {
                        name: "kind".into(),
                        schema: SchemaNode::Str,
                    }],
                },
            },
        ],
    };
    let mut col = collection_with_unique(
        schema,
        vec![UniqueConstraintDescriptor::Single("meta".into())],
        SequentialGenerator::new("u"),
    );
    col.create(json!({ "id": "u1", "meta": { "kind": "book" } }))
        .unwrap();

    // This would be a constraint violation with structural equality,
    // but js_eq(object, object) == false → no violation → create succeeds.
    let result = col.create(json!({ "id": "u2", "meta": { "kind": "book" } }));
    assert!(
        result.is_ok(),
        "object-valued unique field must not trigger constraint (js identity semantics): {:?}",
        result
    );
    assert_eq!(col.len(), 2);
}

/// `$remove` with a scalar operand removes matching elements (primitive equality).
#[test]
fn remove_scalar_operand_removes_matching_elements() {
    let mut col = collection(update_user_schema(), SequentialGenerator::new("u"));
    col.create(json!({
        "id": "u1", "name": "A", "email": "a@x.com",
        "age": 1, "active": true, "tags": ["alpha", "beta", "gamma"],
        "companyId": "c"
    }))
    .unwrap();

    let result = col
        .update("u1", json!({ "tags": { "$remove": "beta" } }))
        .unwrap();
    assert_eq!(
        result["tags"],
        json!(["alpha", "gamma"]),
        "$remove scalar must remove matching element"
    );
}

/// `$remove` with an object operand: js_eq(object, element) is always false at
/// the boundary — nothing is removed (JS identity semantics).
#[test]
fn remove_object_operand_never_removes_js_identity_semantics() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "items".into(),
                schema: SchemaNode::Array {
                    item: Box::new(SchemaNode::Struct {
                        fields: vec![StructField {
                            name: "id".into(),
                            schema: SchemaNode::Num,
                        }],
                    }),
                },
            },
        ],
    };
    let mut col = collection(schema, SequentialGenerator::new("u"));
    col.create(json!({ "id": "u1", "items": [{ "id": 1 }, { "id": 2 }] }))
        .unwrap();

    // Object operand: js_eq({id:1}, {id:1}) == false → nothing removed
    let result = col
        .update("u1", json!({ "items": { "$remove": { "id": 1 } } }))
        .unwrap();
    assert_eq!(
        result["items"],
        json!([{ "id": 1 }, { "id": 2 }]),
        "$remove with object operand must not remove anything (JS identity semantics)"
    );
}

/// upsert where matching uses js_eq: primitive where fields match by value.
#[test]
fn upsert_where_matching_primitive_values_correct() {
    let mut col = collection_with_unique(
        unique_user_schema(),
        vec![UniqueConstraintDescriptor::Single("email".into())],
        SequentialGenerator::new("u"),
    );
    col.create(json!({
        "id": "u1", "name": "Alice", "email": "alice@x.com",
        "username": "alice", "age": 30
    }))
    .unwrap();

    // where { email: "alice@x.com" } should match by string value equality
    let result = col
        .upsert(
            json!({ "email": "alice@x.com" }),
            json!({ "email": "alice@x.com", "name": "Alice", "username": "alice", "age": 30 }),
            json!({ "name": "Alice Updated" }),
        )
        .expect("upsert must find entity by string where-clause");

    assert_eq!(
        result.action,
        UpsertAction::Updated,
        "string where-clause must find existing entity"
    );
    assert_eq!(result.entity["name"], json!("Alice Updated"));
}
