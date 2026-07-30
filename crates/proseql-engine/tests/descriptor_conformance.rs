#![recursion_limit = "1024"]
//! Conformance fixtures for U1: config descriptor, value model, and error taxonomy.
//!
//! These tests are ported from the TS test corpus. Each test has a comment
//! naming the corresponding TS test file / describe block so diffs are traceable.
//!
//! All assertions match the observable TS engine behavior for the same input.

use proseql_engine::{
    descriptor::{
        CollectionDescriptor, DatabaseDescriptor, IdStrategy, SchemaNode, StructField,
        ValidationMode,
    },
    errors::EngineError,
    validator::{decode_value, validate_value},
    value::Value,
};
use serde_json::{json, Map as JsonMap, Number};

// ── helpers ──────────────────────────────────────────────────────────────────

/// Mirrors the TS fixture: Schema.Struct({ id: Schema.String, name: Schema.String, age: Schema.Number })
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
                name: "age".into(),
                schema: SchemaNode::Num,
            },
        ],
    }
}

/// Build a valid user Value from primitives.
fn user_value(id: &str, name: &str, age: f64) -> Value {
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String(id.into()));
    m.insert("name".into(), Value::String(name.into()));
    m.insert("age".into(), Value::Number(Number::from_f64(age).unwrap()));
    Value::Object(m)
}

fn base_collection() -> CollectionDescriptor {
    CollectionDescriptor {
        name: "users".into(),
        schema: user_schema(),
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

// ── descriptor round-trip serialization ──────────────────────────────────────
// Mirrors: packages/core/tests/schema-validation.test.ts ("round-trip encode/decode")

#[test]
fn schema_node_round_trips_json() {
    let schema = user_schema();
    let json = serde_json::to_string(&schema).expect("serialize SchemaNode");
    let back: SchemaNode = serde_json::from_str(&json).expect("deserialize SchemaNode");
    assert_eq!(schema, back, "SchemaNode must survive a JSON round-trip");
}

#[test]
fn literal_schema_nodes_round_trip_json() {
    let schema = SchemaNode::LiteralUnion {
        values: vec![json!("admin"), json!("user"), Value::Null],
    };
    let json = serde_json::to_string(&schema).expect("serialize literal schema");
    let back: SchemaNode = serde_json::from_str(&json).expect("deserialize literal schema");
    assert_eq!(schema, back);
}

#[test]
fn collection_descriptor_round_trips_json() {
    let desc = base_collection();
    let json = serde_json::to_string(&desc).expect("serialize CollectionDescriptor");
    let back: CollectionDescriptor =
        serde_json::from_str(&json).expect("deserialize CollectionDescriptor");
    assert_eq!(desc.name, back.name);
    assert_eq!(desc.schema, back.schema);
    assert_eq!(desc.id_strategy, back.id_strategy);
    assert_eq!(desc.append_only, back.append_only);
}

#[test]
fn database_descriptor_round_trips_json() {
    let desc = DatabaseDescriptor {
        collections: vec![base_collection()],
        sources: vec![],
    };
    let json = serde_json::to_string(&desc).expect("serialize DatabaseDescriptor");
    let back: DatabaseDescriptor =
        serde_json::from_str(&json).expect("deserialize DatabaseDescriptor");
    assert_eq!(desc.collections.len(), back.collections.len());
    assert_eq!(desc.collections[0].name, back.collections[0].name);
}

// ── validate conforming record ────────────────────────────────────────────────
// Mirrors: packages/core/tests/schema-validation.test.ts ("decodes valid data")

#[test]
fn validates_conforming_record() {
    let schema = user_schema();
    let record = user_value("1", "Alice", 30.0);
    assert!(
        validate_value(&schema, &record).is_ok(),
        "a valid record must pass validation"
    );
}

// ── unsupported schema combinator ─────────────────────────────────────────────
// Mirrors: U1 spec "Error path: unsupported schema combinator → loud, specific rejection"

#[test]
fn unsupported_combinator_produces_validation_error() {
    let schema = SchemaNode::Unsupported {
        reason: "Schema.Literal is not supported by the Rust engine descriptor".into(),
    };
    let record = Value::String("anything".into());
    let err =
        validate_value(&schema, &record).expect_err("unsupported combinator must fail validation");
    match err {
        EngineError::Validation(v) => {
            assert!(
                v.message.to_lowercase().contains("unsupported"),
                "message must mention 'unsupported', got: {:?}",
                v.message
            );
            assert!(
                !v.issues.is_empty(),
                "ValidationError for unsupported combinator must carry issues"
            );
        }
        other => panic!("expected ValidationError, got: {other:?}"),
    }
}

// ── schema violation ──────────────────────────────────────────────────────────
// Mirrors: packages/core/tests/schema-validation.test.ts ("fails with ValidationError for invalid data")

#[test]
fn wrong_field_types_produce_validation_error_with_issues() {
    let schema = user_schema();
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("name".into(), Value::Number(Number::from(123))); // wrong: should be String
    m.insert("age".into(), Value::String("not-a-number".into())); // wrong: should be Number
    let record = Value::Object(m);
    let err = validate_value(&schema, &record).expect_err("wrong field types must fail validation");
    match err {
        EngineError::Validation(v) => {
            assert!(
                !v.issues.is_empty(),
                "ValidationError must carry at least one issue for type mismatches"
            );
        }
        other => panic!("expected ValidationError, got: {other:?}"),
    }
}

// ── missing required field ────────────────────────────────────────────────────
// Mirrors: packages/core/tests/schema-validation.test.ts ("fails with ValidationError for missing required fields")

#[test]
fn missing_required_field_produces_validation_error() {
    let schema = user_schema(); // requires id, name, age
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    // name and age are missing
    let record = Value::Object(m);
    let err =
        validate_value(&schema, &record).expect_err("missing required fields must fail validation");
    match err {
        EngineError::Validation(v) => {
            let has_missing = v
                .issues
                .iter()
                .any(|i| i.message.to_lowercase().contains("missing"));
            assert!(
                has_missing,
                "ValidationError issues must describe missing fields, got: {v:?}"
            );
        }
        other => panic!("expected ValidationError, got: {other:?}"),
    }
}

// ── optional field ────────────────────────────────────────────────────────────
// Mirrors: packages/core/tests/schema-validation.test.ts ("preserves data for schema with optional fields")

#[test]
fn optional_field_can_be_absent() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "bio".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    };
    // bio absent → valid
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    let record = Value::Object(m);
    assert!(
        validate_value(&schema, &record).is_ok(),
        "absent optional field must be valid"
    );
}

#[test]
fn optional_field_accepts_correct_type_when_present() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "bio".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("bio".into(), Value::String("A developer".into()));
    let record = Value::Object(m);
    assert!(
        validate_value(&schema, &record).is_ok(),
        "optional field with correct type must be valid"
    );
}

#[test]
fn optional_field_rejects_wrong_type_when_present() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "bio".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("bio".into(), Value::Number(Number::from(42))); // wrong type
    let record = Value::Object(m);
    assert!(
        validate_value(&schema, &record).is_err(),
        "optional field with wrong type must fail validation"
    );
}

/// Negative null fixture grounded in the real Effect source.
///
/// `Schema.optional(T)` is implemented in
/// `effect/packages/effect/src/Schema.ts` (function `optional`, line ~2542) as:
///
/// ```typescript
/// const ast = ... : UndefinedOr(self).ast
/// ```
///
/// `UndefinedOr(String)` = `String | undefined`.  JSON `null` is NOT
/// `undefined`; it is a distinct value.  The engine must reject null for an
/// `Optional(String)` field — use `Optional(NullOr(String))` or a required
/// `NullOr(String)` field when null is intentional.
#[test]
fn optional_field_rejects_null_value_null_is_not_absent() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "bio".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    // null is NOT the same as absent; Schema.optional(String) does not include null
    m.insert("bio".into(), Value::Null);
    let record = Value::Object(m);
    assert!(
        validate_value(&schema, &record).is_err(),
        "Schema.optional(String) MUST reject null — null is not undefined; \
         use Schema.NullOr(String) for fields that accept null"
    );
}

/// Confirm Optional(NullOr(String)) accepts all three: absent, null, or string.
/// This is the correct shape for a truly nullable-and-optional field.
#[test]
fn optional_null_or_accepts_absent_null_and_string() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "role".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::NullOr(Box::new(
                    SchemaNode::Str,
                )))),
            },
        ],
    };

    // absent → OK
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    assert!(
        validate_value(&schema, &Value::Object(m.clone())).is_ok(),
        "absent must be valid"
    );

    // null → OK (NullOr accepts null)
    m.insert("role".into(), Value::Null);
    assert!(
        validate_value(&schema, &Value::Object(m.clone())).is_ok(),
        "null must be valid"
    );

    // string → OK
    m.insert("role".into(), Value::String("admin".into()));
    assert!(
        validate_value(&schema, &Value::Object(m)).is_ok(),
        "string must be valid"
    );
}

// ── NullOr field ──────────────────────────────────────────────────────────────
// Mirrors: packages/core/tests/unique-constraints.test.ts (NullOr usage)

#[test]
fn null_or_field_accepts_null() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "email".into(),
                schema: SchemaNode::NullOr(Box::new(SchemaNode::Str)),
            },
        ],
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("email".into(), Value::Null);
    let record = Value::Object(m);
    assert!(
        validate_value(&schema, &record).is_ok(),
        "NullOr field with null value must be valid"
    );
}

#[test]
fn null_or_field_accepts_correct_type() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "email".into(),
                schema: SchemaNode::NullOr(Box::new(SchemaNode::Str)),
            },
        ],
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("email".into(), Value::String("user@example.com".into()));
    let record = Value::Object(m);
    assert!(
        validate_value(&schema, &record).is_ok(),
        "NullOr field with a string value must be valid"
    );
}

#[test]
fn null_or_field_rejects_wrong_type() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "email".into(),
                schema: SchemaNode::NullOr(Box::new(SchemaNode::Str)),
            },
        ],
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("email".into(), Value::Number(Number::from(42))); // wrong type
    let record = Value::Object(m);
    assert!(
        validate_value(&schema, &record).is_err(),
        "NullOr field with wrong type must fail validation"
    );
}

// ── NumberFromString ──────────────────────────────────────────────────────────
// Mirrors: packages/core/tests/schema-validation.test.ts (WithTransform fixture)

#[test]
fn num_from_str_accepts_numeric_string_encoded_form() {
    let schema = SchemaNode::Struct {
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
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("count".into(), Value::String("42".into())); // encoded form: string
    let record = Value::Object(m);
    assert!(
        validate_value(&schema, &record).is_ok(),
        "NumberFromString accepts numeric string (encoded form)"
    );
}

/// `validate_value` accepts the already-decoded (number) form because it is
/// called against both wire and runtime values.
///
/// NOTE: `decode_value` does NOT accept a number as input for `NumFromStr`
/// (a number is the output of decoding, not the input).  See the
/// `decode_value_*` tests below for the `decode_value` contract.
#[test]
fn validate_value_num_from_str_accepts_number_decoded_form() {
    let schema = SchemaNode::Struct {
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
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("count".into(), Value::Number(Number::from(42))); // decoded form: number
    let record = Value::Object(m);
    // validate_value is deliberately permissive: it accepts both encoded (string)
    // and decoded (number) forms.  This is intentional — it validates stored
    // (already-decoded) values.  Use decode_value for wire-to-runtime decoding.
    assert!(
        validate_value(&schema, &record).is_ok(),
        "validate_value: NumberFromString accepts number (the decoded/runtime form)"
    );
}

#[test]
fn literal_and_literal_union_validate_exact_values() {
    let literal = SchemaNode::Literal {
        value: json!("admin"),
    };
    assert!(validate_value(&literal, &json!("admin")).is_ok());
    assert!(validate_value(&literal, &json!("user")).is_err());

    let union = SchemaNode::LiteralUnion {
        values: vec![json!("admin"), json!("user"), Value::Null],
    };
    assert!(validate_value(&union, &json!("user")).is_ok());
    assert!(validate_value(&union, &Value::Null).is_ok());
    assert!(validate_value(&union, &json!("guest")).is_err());
    assert!(decode_value(&union, &json!("admin")).is_ok());
    assert!(decode_value(&SchemaNode::Literal { value: Value::Null }, &Value::Null).is_ok());
    assert!(decode_value(&SchemaNode::Literal { value: Value::Null }, &json!(false)).is_err());
}

#[test]
fn num_from_str_rejects_non_numeric_string() {
    let schema = SchemaNode::Struct {
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
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("count".into(), Value::String("not-a-number".into()));
    let record = Value::Object(m);
    assert!(
        validate_value(&schema, &record).is_err(),
        "NumberFromString must reject non-numeric strings"
    );
}

// ── decode_value fixtures ──────────────────────────────────────────────────────
//
// Verify `decode_value` semantics (mirrors `Schema.decodeUnknownEffect`),
// distinct from the permissive `validate_value` path.

/// `decode_value` for `NumFromStr`: accepts the encoded (string) form and
/// returns the decoded (number) form.
///
/// TS: `Schema.decodeUnknownEffect(NumberFromString)("42")` → `42`
/// Grounded in Schema.ts `parseNumber`/`NumberFromString` → `transformOrFail(String, Number)`.
#[test]
fn decode_value_num_from_str_decodes_string_to_number() {
    let schema = SchemaNode::Struct {
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
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("count".into(), Value::String("42".into())); // encoded form
    let record = Value::Object(m);
    let decoded = decode_value(&schema, &record)
        .expect("decode_value must accept numeric string (encoded form)");
    assert_eq!(
        decoded["count"],
        Value::Number(Number::from(42)),
        "NumFromStr: string \"42\" must decode to number 42"
    );
    assert_eq!(decoded["id"], Value::String("1".into()));
}

/// `decode_value` for `NumFromStr`: rejects a bare number as input.
///
/// A number is the DECODED (output) form, NOT the encoded (input) form.
/// `Schema.decodeUnknownEffect(NumberFromString)(42)` → ParseError.
/// This is the correction of the wrong assumption that \"decoded number is
/// valid decode input\". The permissive path is `validate_value`.
#[test]
fn decode_value_num_from_str_rejects_number_input() {
    let schema = SchemaNode::NumFromStr;
    let err = decode_value(&schema, &Value::Number(Number::from(42)))
        .expect_err("decode_value must reject number input for NumFromStr");
    match err {
        EngineError::Validation(v) => {
            assert!(
                v.message.to_lowercase().contains("string"),
                "error must mention 'string' (expected encoded form), got: {:?}",
                v.message
            );
        }
        other => panic!("expected ValidationError, got: {other:?}"),
    }
}

/// `decode_value` for `Struct`: strips excess properties (TS `onExcessProperty: "ignore"`).
/// `Schema.decodeUnknownEffect(Struct({id: S.String}))({id:"1",extra:"foo"})` → `{id:"1"}`
#[test]
fn decode_value_struct_strips_excess_properties() {
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
        ],
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("name".into(), Value::String("Alice".into()));
    m.insert("extra".into(), Value::String("should be stripped".into()));
    m.insert("createdAt".into(), Value::String("2024-01-01".into()));
    let record = Value::Object(m);
    let decoded =
        decode_value(&schema, &record).expect("decode must succeed with excess properties present");
    let obj = decoded.as_object().unwrap();
    assert_eq!(
        obj.len(),
        2,
        "decoded struct must have only 2 declared fields"
    );
    assert!(obj.contains_key("id"));
    assert!(obj.contains_key("name"));
    assert!(
        !obj.contains_key("extra"),
        "excess field 'extra' must be stripped"
    );
    assert!(
        !obj.contains_key("createdAt"),
        "excess field 'createdAt' must be stripped"
    );
}

/// `decode_value` for absent optional field: stays absent (not set to null).
#[test]
fn decode_value_struct_absent_optional_stays_absent() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "bio".into(),
                schema: SchemaNode::Optional(Box::new(SchemaNode::Str)),
            },
        ],
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    // bio is absent
    let decoded = decode_value(&schema, &Value::Object(m))
        .expect("absent optional field must not cause decode failure");
    let obj = decoded.as_object().unwrap();
    assert!(
        !obj.contains_key("bio"),
        "absent optional must remain absent after decode"
    );
    assert!(obj.contains_key("id"));
}

/// `decode_value` for Struct: combines transform (NumFromStr) + excess-property stripping.
#[test]
fn decode_value_struct_transforms_and_strips_combined() {
    let schema = SchemaNode::Struct {
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
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("count".into(), Value::String("99".into())); // encoded form
    m.insert("extra".into(), Value::String("noise".into())); // excess prop
    let decoded = decode_value(&schema, &Value::Object(m))
        .expect("decode must succeed with transform + excess prop");
    assert_eq!(
        decoded["count"],
        Value::Number(Number::from(99)),
        "NumFromStr must be decoded"
    );
    assert!(
        decoded.get("extra").is_none(),
        "excess prop must be stripped"
    );
}

// ── nested Struct ──────────────────────────────────────────────────────────────
// Mirrors: examples/04-nested-data (Schema.Struct with nested Schema.Struct)

#[test]
fn nested_struct_validates_correctly() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "metadata".into(),
                schema: SchemaNode::Struct {
                    fields: vec![
                        StructField {
                            name: "views".into(),
                            schema: SchemaNode::Num,
                        },
                        StructField {
                            name: "rating".into(),
                            schema: SchemaNode::Num,
                        },
                    ],
                },
            },
        ],
    };

    let mut meta = JsonMap::new();
    meta.insert("views".into(), Value::Number(Number::from(100)));
    meta.insert(
        "rating".into(),
        Value::Number(Number::from_f64(4.5).unwrap()),
    );

    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("metadata".into(), Value::Object(meta));
    let record = Value::Object(m);
    assert!(validate_value(&schema, &record).is_ok());
}

#[test]
fn nested_struct_rejects_wrong_inner_type() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "metadata".into(),
                schema: SchemaNode::Struct {
                    fields: vec![StructField {
                        name: "views".into(),
                        schema: SchemaNode::Num,
                    }],
                },
            },
        ],
    };

    let mut meta = JsonMap::new();
    meta.insert("views".into(), Value::String("not-a-number".into())); // wrong type

    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("metadata".into(), Value::Object(meta));
    let record = Value::Object(m);
    assert!(validate_value(&schema, &record).is_err());
}

// ── Array ──────────────────────────────────────────────────────────────────────
// Mirrors: examples/02-filtering-and-selection (tags: Schema.Array(Schema.String))

#[test]
fn array_of_strings_validates_correctly() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "tags".into(),
                schema: SchemaNode::Array {
                    item: Box::new(SchemaNode::Str),
                },
            },
        ],
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert(
        "tags".into(),
        Value::Array(vec![
            Value::String("fiction".into()),
            Value::String("thriller".into()),
        ]),
    );
    assert!(validate_value(&schema, &Value::Object(m)).is_ok());
}

#[test]
fn array_rejects_wrong_element_type() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "tags".into(),
                schema: SchemaNode::Array {
                    item: Box::new(SchemaNode::Str),
                },
            },
        ],
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert(
        "tags".into(),
        Value::Array(vec![
            Value::String("ok".into()),
            Value::Number(Number::from(42)), // wrong element type
        ]),
    );
    assert!(validate_value(&schema, &Value::Object(m)).is_err());
}

// ── Record: positive and negative conformance ─────────────────────────────────
// Schema.Record(Schema.String, Schema.Number) — audited from
// examples/16-advanced-features and packages/core/tests/

#[test]
fn record_validates_correct_value_types() {
    // Mirrors: Schema.Record({ key: Schema.String, value: Schema.Number })
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "scores".into(),
                schema: SchemaNode::Record {
                    key: Box::new(SchemaNode::Str),
                    value: Box::new(SchemaNode::Num),
                },
            },
        ],
    };
    let mut scores = JsonMap::new();
    scores.insert("math".into(), Value::Number(Number::from(95)));
    scores.insert("science".into(), Value::Number(Number::from(88)));
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("scores".into(), Value::Object(scores));
    assert!(
        validate_value(&schema, &Value::Object(m)).is_ok(),
        "Record with correct value types must be valid"
    );
}

#[test]
fn record_rejects_wrong_value_types() {
    // A record whose values should be numbers but receives a string value.
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "scores".into(),
                schema: SchemaNode::Record {
                    key: Box::new(SchemaNode::Str),
                    value: Box::new(SchemaNode::Num),
                },
            },
        ],
    };
    let mut scores = JsonMap::new();
    scores.insert("math".into(), Value::String("ninety-five".into())); // wrong: should be number
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("scores".into(), Value::Object(scores));
    assert!(
        validate_value(&schema, &Value::Object(m)).is_err(),
        "Record with wrong value types must fail validation"
    );
}

#[test]
fn record_empty_object_is_valid() {
    let schema = SchemaNode::Record {
        key: Box::new(SchemaNode::Str),
        value: Box::new(SchemaNode::Num),
    };
    // An empty record is valid — there are no values to validate
    assert!(validate_value(&schema, &Value::Object(JsonMap::new())).is_ok());
}

// ── OptionalWithDefault ───────────────────────────────────────────────────────
// Schema.optional(T, { default: () => V }) / Schema.optionalWith
// Audited from:
//   packages/core/tests/crud/upsert.test.ts (loginCount, tags)
//   packages/core/tests/crud/update.test.ts (score, isActive, soldCount)
//   packages/core/tests/crud/batch-operations.test.ts (employeeCount, revenue)

#[test]
fn optional_with_default_schema_node_round_trips_json() {
    let schema = SchemaNode::OptionalWithDefault {
        inner: Box::new(SchemaNode::Num),
        default_callback_id: "defaultLoginCount".into(),
    };
    let json = serde_json::to_string(&schema).expect("serialize OptionalWithDefault");
    let back: SchemaNode = serde_json::from_str(&json).expect("deserialize OptionalWithDefault");
    assert_eq!(
        schema, back,
        "OptionalWithDefault must survive JSON round-trip"
    );
}

#[test]
fn optional_with_default_json_shape_has_callback_id() {
    // Verify the wire format carries defaultCallbackId (camelCase)
    let schema = SchemaNode::OptionalWithDefault {
        inner: Box::new(SchemaNode::Bool),
        default_callback_id: "defaultIsActive".into(),
    };
    let v = serde_json::to_value(&schema).expect("to_value");
    assert_eq!(v["kind"], "optionalWithDefault");
    assert_eq!(v["defaultCallbackId"], "defaultIsActive");
    assert!(
        v.get("default_callback_id").is_none(),
        "snake_case must not appear"
    );
}

#[test]
fn optional_with_default_accepts_absent_field() {
    // loginCount: Schema.optional(Schema.Number, { default: () => 0 })
    // → descriptor: OptionalWithDefault { inner: Num, default_callback_id: "defaultLoginCount" }
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "loginCount".into(),
                schema: SchemaNode::OptionalWithDefault {
                    inner: Box::new(SchemaNode::Num),
                    default_callback_id: "defaultLoginCount".into(),
                },
            },
        ],
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    // loginCount absent — valid; default callback will be invoked at U2 runtime
    assert!(
        validate_value(&schema, &Value::Object(m)).is_ok(),
        "OptionalWithDefault: absent field must be valid (default applied at U2 runtime)"
    );
}

#[test]
fn optional_with_default_accepts_correct_type_when_present() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "loginCount".into(),
                schema: SchemaNode::OptionalWithDefault {
                    inner: Box::new(SchemaNode::Num),
                    default_callback_id: "defaultLoginCount".into(),
                },
            },
        ],
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("loginCount".into(), Value::Number(Number::from(5)));
    assert!(
        validate_value(&schema, &Value::Object(m)).is_ok(),
        "OptionalWithDefault: correct type when present must be valid"
    );
}

#[test]
fn optional_with_default_rejects_wrong_type_when_present() {
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "loginCount".into(),
                schema: SchemaNode::OptionalWithDefault {
                    inner: Box::new(SchemaNode::Num),
                    default_callback_id: "defaultLoginCount".into(),
                },
            },
        ],
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("loginCount".into(), Value::String("not-a-number".into())); // wrong type
    assert!(
        validate_value(&schema, &Value::Object(m)).is_err(),
        "OptionalWithDefault: wrong type when present must fail"
    );
}

#[test]
fn optional_with_default_rejects_null_value() {
    // Same as optional: null is not absent, default callback handles absent only
    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".into(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "loginCount".into(),
                schema: SchemaNode::OptionalWithDefault {
                    inner: Box::new(SchemaNode::Num),
                    default_callback_id: "defaultLoginCount".into(),
                },
            },
        ],
    };
    let mut m = JsonMap::new();
    m.insert("id".into(), Value::String("1".into()));
    m.insert("loginCount".into(), Value::Null);
    assert!(
        validate_value(&schema, &Value::Object(m)).is_err(),
        "OptionalWithDefault: null must fail (null is not absent)"
    );
}

// ── EngineError serialization: _tag + camelCase payload fields ────────────────
// The adapter layer reconstructs TaggedError classes from the serialized form.
// Every serialized EngineError must carry:
//   _tag  — exact TS TaggedError _tag string
//   payload fields — camelCase to match the TS class field names

#[test]
fn engine_error_serializes_with_underscore_tag_and_camel_case_fields() {
    use proseql_engine::errors::*;

    // NotFoundError — all fields single-word, just verify _tag
    let err = EngineError::NotFound(NotFoundError {
        collection: "users".into(),
        id: "u1".into(),
        message: "not found".into(),
    });
    let v = serde_json::to_value(&err).expect("serialize NotFoundError");
    assert_eq!(v["_tag"], "NotFoundError", "_tag must be 'NotFoundError'");
    assert_eq!(v["collection"], "users");
    assert_eq!(v["id"], "u1");
    assert!(v.get("tag").is_none(), "must NOT have plain 'tag' field");

    // DuplicateKeyError — existingId (snake: existing_id)
    let err = EngineError::DuplicateKey(Box::new(DuplicateKeyError {
        collection: "users".into(),
        field: "email".into(),
        value: "a@b.com".into(),
        existing_id: "u2".into(),
        message: "dup".into(),
    }));
    let v = serde_json::to_value(&err).expect("serialize DuplicateKeyError");
    assert_eq!(v["_tag"], "DuplicateKeyError");
    assert_eq!(v["existingId"], "u2", "existingId must be camelCase");
    assert!(v.get("existing_id").is_none(), "snake_case must NOT appear");

    // ForeignKeyError — targetCollection (snake: target_collection)
    let err = EngineError::ForeignKey(Box::new(ForeignKeyError {
        collection: "posts".into(),
        field: "authorId".into(),
        value: "missing".into(),
        target_collection: "users".into(),
        message: "fk".into(),
    }));
    let v = serde_json::to_value(&err).expect("serialize ForeignKeyError");
    assert_eq!(v["_tag"], "ForeignKeyError");
    assert_eq!(
        v["targetCollection"], "users",
        "targetCollection must be camelCase"
    );
    assert!(
        v.get("target_collection").is_none(),
        "snake_case must NOT appear"
    );

    // DanglingReferenceError — targetId (snake: target_id)
    let err = EngineError::DanglingReference(DanglingReferenceError {
        collection: "posts".into(),
        field: "authorId".into(),
        target_id: "missing".into(),
        message: "dangling".into(),
    });
    let v = serde_json::to_value(&err).expect("serialize DanglingReferenceError");
    assert_eq!(v["_tag"], "DanglingReferenceError");
    assert_eq!(v["targetId"], "missing", "targetId must be camelCase");
    assert!(v.get("target_id").is_none(), "snake_case must NOT appear");

    // UniqueConstraintError — existingId (snake: existing_id)
    let err = EngineError::UniqueConstraint(Box::new(UniqueConstraintError {
        collection: "users".into(),
        constraint: "email".into(),
        fields: vec!["email".into()],
        values: serde_json::Map::new(),
        existing_id: "u3".into(),
        message: "unique".into(),
    }));
    let v = serde_json::to_value(&err).expect("serialize UniqueConstraintError");
    assert_eq!(v["_tag"], "UniqueConstraintError");
    assert_eq!(v["existingId"], "u3");
    assert!(v.get("existing_id").is_none(), "snake_case must NOT appear");

    // MigrationError — fromVersion / toVersion
    let err = EngineError::Migration(Box::new(MigrationError {
        collection: "users".into(),
        from_version: 1,
        to_version: 2,
        step: 0,
        reason: "transform failed".into(),
        message: "migration".into(),
    }));
    let v = serde_json::to_value(&err).expect("serialize MigrationError");
    assert_eq!(v["_tag"], "MigrationError");
    assert_eq!(v["fromVersion"], 1, "fromVersion must be camelCase");
    assert_eq!(v["toVersion"], 2, "toVersion must be camelCase");
    assert!(
        v.get("from_version").is_none(),
        "snake_case must NOT appear"
    );
    assert!(v.get("to_version").is_none(), "snake_case must NOT appear");

    // DocumentGraphSourceError — sourceId, recordId, contributingPaths
    let err = EngineError::DocumentGraphSource(Box::new(DocumentGraphSourceError {
        source_id: "s1".into(),
        path: "/p.yaml".into(),
        message: "err".into(),
        kind: DocumentGraphErrorKind::MissingRoot,
        collection: None,
        record_id: Some("r1".into()),
        contributing_paths: Some(vec!["/a".into(), "/b".into()]),
        cause: None,
    }));
    let v = serde_json::to_value(&err).expect("serialize DocumentGraphSourceError");
    assert_eq!(v["_tag"], "DocumentGraphSourceError");
    assert_eq!(v["sourceId"], "s1", "sourceId must be camelCase");
    assert_eq!(v["recordId"], "r1", "recordId must be camelCase");
    assert!(v.get("source_id").is_none(), "snake_case must NOT appear");
    assert!(v.get("record_id").is_none(), "snake_case must NOT appear");
    assert!(
        v.get("contributing_paths").is_none(),
        "snake_case must NOT appear"
    );

    // SourceConfigError — sourceId
    let err = EngineError::SourceConfig(Box::new(SourceConfigError {
        message: "bad config".into(),
        source_id: Some("s2".into()),
        collection: None,
        path: None,
    }));
    let v = serde_json::to_value(&err).expect("serialize SourceConfigError");
    assert_eq!(v["_tag"], "SourceConfigError");
    assert_eq!(v["sourceId"], "s2", "sourceId must be camelCase");
    assert!(v.get("source_id").is_none(), "snake_case must NOT appear");

    // DuplicatePhysicalFileError — sourceId
    let err = EngineError::DuplicatePhysicalFile(Box::new(DuplicatePhysicalFileError {
        source_id: "s3".into(),
        path: "/p.yaml".into(),
        message: "dup".into(),
    }));
    let v = serde_json::to_value(&err).expect("serialize DuplicatePhysicalFileError");
    assert_eq!(v["_tag"], "DuplicatePhysicalFileError");
    assert_eq!(v["sourceId"], "s3");
    assert!(v.get("source_id").is_none());
}

#[test]
fn engine_error_serialization_round_trips() {
    use proseql_engine::errors::*;

    // Verify that deserializing from the serialized form produces the original value.
    let original = EngineError::Migration(Box::new(MigrationError {
        collection: "users".into(),
        from_version: 1,
        to_version: 2,
        step: 0,
        reason: "transform failed".into(),
        message: "migration".into(),
    }));
    let json = serde_json::to_string(&original).expect("serialize");
    let back: EngineError = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(original, back, "EngineError must survive JSON round-trip");
}

// ── cause fields use lossless serde_json::Value, not Option<String> ───────────
// TS error classes have `cause?: unknown` — serde_json::Value preserves
// structured payloads without coercing them to strings.

#[test]
fn engine_error_cause_is_lossless_json_value() {
    use proseql_engine::errors::*;

    // StorageError with a structured cause object
    let cause_val = serde_json::json!({"code": 404, "detail": "file not found"});
    let err = EngineError::Storage(Box::new(StorageError {
        path: "/db.yaml".into(),
        operation: StorageOperation::Read,
        message: "io error".into(),
        cause: Some(cause_val.clone()),
    }));
    let v = serde_json::to_value(&err).expect("serialize StorageError");
    assert_eq!(
        v["cause"], cause_val,
        "cause must round-trip as a JSON Value"
    );

    // PopulationError with a string cause (also valid as Value::String)
    let err = EngineError::Population(Box::new(PopulationError {
        collection: "users".into(),
        relationship: "company".into(),
        message: "population failed".into(),
        cause: Some(serde_json::json!("inner error text")),
    }));
    let v = serde_json::to_value(&err).expect("serialize PopulationError");
    assert_eq!(v["cause"], serde_json::json!("inner error text"));

    // DocumentGraphSourceError with nested cause object
    let err = EngineError::DocumentGraphSource(Box::new(DocumentGraphSourceError {
        source_id: "s1".into(),
        path: "/p.yaml".into(),
        message: "transform defect".into(),
        kind: DocumentGraphErrorKind::TransformDefect,
        collection: None,
        record_id: None,
        contributing_paths: None,
        cause: Some(serde_json::json!({"stack": "Error: at transform.ts:42"})),
    }));
    let v = serde_json::to_value(&err).expect("serialize DocumentGraphSourceError with cause");
    assert_eq!(v["cause"]["stack"], "Error: at transform.ts:42");

    // When cause is None, the field must be omitted (skip_serializing_if)
    let err_no_cause = EngineError::Storage(Box::new(StorageError {
        path: "/db.yaml".into(),
        operation: StorageOperation::Write,
        message: "write failed".into(),
        cause: None,
    }));
    let v_no_cause = serde_json::to_value(&err_no_cause).expect("serialize no-cause StorageError");
    assert!(
        v_no_cause.get("cause").is_none(),
        "cause:None must be omitted from JSON"
    );
}

// ── error taxonomy: tag() matches serde _tag and TS _tag strings ──────────────
// Verifies three-way consistency: tag() == serde rename == TS _tag.

#[test]
fn engine_error_tags_match_ts_tag_names() {
    use proseql_engine::errors::*;

    // Helper: check that tag() == the value serde puts in _tag
    fn check(err: EngineError) {
        let expected_tag = err.tag();
        let v = serde_json::to_value(&err).expect("serialize");
        assert_eq!(
            v["_tag"].as_str().unwrap(),
            expected_tag,
            "serde _tag must match tag() for variant with tag = {expected_tag:?}"
        );
    }

    check(EngineError::NotFound(NotFoundError {
        collection: "users".into(),
        id: "x".into(),
        message: "not found".into(),
    }));
    check(EngineError::DuplicateKey(Box::new(DuplicateKeyError {
        collection: "users".into(),
        field: "email".into(),
        value: "a@b.com".into(),
        existing_id: "1".into(),
        message: "duplicate".into(),
    })));

    check(EngineError::Validation(ValidationError {
        message: "bad".into(),
        issues: vec![],
    }));
    check(EngineError::ForeignKey(Box::new(ForeignKeyError {
        collection: "posts".into(),
        field: "authorId".into(),
        value: "missing".into(),
        target_collection: "users".into(),
        message: "fk".into(),
    })));

    check(EngineError::UniqueConstraint(Box::new(
        UniqueConstraintError {
            collection: "users".into(),
            constraint: "email".into(),
            fields: vec!["email".into()],
            values: serde_json::Map::new(),
            existing_id: "1".into(),
            message: "unique".into(),
        },
    )));
    check(EngineError::Concurrency(ConcurrencyError {
        collection: "users".into(),
        id: "1".into(),
        message: "conflict".into(),
    }));
    check(EngineError::Operation(OperationError {
        operation: "delete".into(),
        reason: "append-only".into(),
        message: "op".into(),
    }));
    check(EngineError::Transaction(TransactionError {
        operation: TransactionOperation::Commit,
        reason: "conflict".into(),
        message: "tx".into(),
    }));
    check(EngineError::Hook(HookError {
        hook: "beforeCreate".into(),
        collection: "users".into(),
        operation: HookOperation::Create,
        reason: "rejected".into(),
        message: "hook".into(),
    }));
    check(EngineError::DanglingReference(DanglingReferenceError {
        collection: "posts".into(),
        field: "authorId".into(),
        target_id: "missing".into(),
        message: "dangling".into(),
    }));
    check(EngineError::CollectionNotFound(CollectionNotFoundError {
        collection: "missing".into(),
        message: "not found".into(),
    }));
    check(EngineError::Population(Box::new(PopulationError {
        collection: "users".into(),
        relationship: "company".into(),
        message: "pop".into(),
        cause: None,
    })));
    check(EngineError::Storage(Box::new(StorageError {
        path: "/tmp/db.yaml".into(),
        operation: StorageOperation::Read,
        message: "io".into(),
        cause: None,
    })));
    check(EngineError::Serialization(Box::new(SerializationError {
        format: "yaml".into(),
        message: "parse".into(),
        cause: None,
    })));
    check(EngineError::UnsupportedFormat(Box::new(
        UnsupportedFormatError {
            format: "pdf".into(),
            message: "not supported".into(),
        },
    )));
    check(EngineError::SourceConfig(Box::new(SourceConfigError {
        message: "bad config".into(),
        source_id: None,
        collection: None,
        path: None,
    })));
    check(EngineError::UnknownCollection(Box::new(
        UnknownCollectionError {
            source_id: "s1".into(),
            path: "/p".into(),
            collection: "unknown".into(),
            message: "no such collection".into(),
        },
    )));

    check(EngineError::DuplicateRecord(Box::new(
        DuplicateRecordError {
            collection: "users".into(),
            id: "1".into(),
            first: SourceRecordOrigin {
                source_id: "s1".into(),
                path: "/a.yaml".into(),
                collection: "users".into(),
                id: "1".into(),
            },
            duplicate: SourceRecordOrigin {
                source_id: "s2".into(),
                path: "/b.yaml".into(),
                collection: "users".into(),
                id: "1".into(),
            },
            message: "dup".into(),
        },
    )));
    check(EngineError::DuplicatePhysicalFile(Box::new(
        DuplicatePhysicalFileError {
            source_id: "s1".into(),
            path: "/p.yaml".into(),
            message: "dup".into(),
        },
    )));
    check(EngineError::InvalidDocumentSource(Box::new(
        InvalidDocumentSourceError {
            source_id: "s1".into(),
            path: "/p.yaml".into(),
            message: "invalid".into(),
            collection: None,
            id: None,
        },
    )));
    check(EngineError::DocumentGraphSource(Box::new(
        DocumentGraphSourceError {
            source_id: "s1".into(),
            path: "/p.yaml".into(),
            message: "err".into(),
            kind: DocumentGraphErrorKind::MissingRoot,
            collection: None,
            record_id: None,
            contributing_paths: None,
            cause: None,
        },
    )));
    check(EngineError::Migration(Box::new(MigrationError {
        collection: "users".into(),
        from_version: 1,
        to_version: 2,
        step: 0,
        reason: "transform failed".into(),
        message: "migration".into(),
    })));
    check(EngineError::Plugin(Box::new(PluginError {
        plugin: "snowflake".into(),
        reason: "bad config".into(),
        message: "plugin".into(),
    })));
}
