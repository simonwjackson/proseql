//! Schema validation and decoding against the descriptor's [`SchemaNode`] tree.
//!
//! Two public entry points:
//!
//! ## `validate_value` — validation-only
//! Checks that a [`Value`] conforms to the schema *without transforming it*.
//! Useful for checking stored (already-decoded) payloads.  Accepts both the
//! encoded and decoded form of transform schemas (e.g. `NumFromStr` accepts
//! both `"42"` and `42`).
//!
//! ## `decode_value` — decode (transform + validate)
//! Mirrors `Schema.decodeUnknownEffect(schema)(value)` from
//! `packages/core/src/validators/schema-validator.ts`.  The input is the
//! **encoded** (wire) form; the output is the **decoded** (runtime) form.
//!
//! Key behaviours:
//! - `NumFromStr`: accepts the string `"42"` (encoded form) and returns the
//!   number `42` (decoded form).  A bare number is **rejected** — it is not
//!   the encoded form.  This is the real Effect behaviour (verified against
//!   `effect/packages/effect/src/Schema.ts`, `parseNumber` function).
//! - `Struct`: strips excess properties (matching Effect's default
//!   `onExcessProperty: "ignore"`) and recursively decodes declared fields.
//! - `Array` / `Record`: recursively decode elements / values.
//! - `Optional` / `OptionalWithDefault`: absent fields remain absent; present
//!   values are decoded against the inner schema.
//! - `NullOr`: `null` is preserved; non-null values are decoded.
//! - Primitives (`Str`, `Num`, `Bool`, `Unknown`): identity (pass through if valid).
//!
//! ## `js_eq` — JS `===` semantics at the JSON boundary
//! Implements JavaScript strict-equality (`===`) for values that arrive over a
//! JSON / WASM serialisation boundary.  Two independently parsed JSON objects
//! can never share reference identity in JavaScript, so:
//! - Primitives (`null`, `boolean`, `number`, `string`): value equality — same
//!   as JS `===` for primitive types.
//! - Objects and arrays: always `false` — reference identity cannot be
//!   established across a serialisation boundary.
//!
//! Use wherever the TS source code uses `===` or `!==` on potentially
//! non-primitive values (unique constraint matching, upsert where-clause
//! matching, `$remove` by-value, unchanged detection).

use serde_json::Map as JsonMap;

use crate::{
    descriptor::SchemaNode,
    errors::{EngineError, ValidationError, ValidationIssue},
    value::Value,
};

// ── JS strict-equality semantics ─────────────────────────────────────────────

/// Implements JavaScript `===` semantics for JSON boundary values.
///
/// At the JSON / WASM boundary every value is (de)serialised, so reference
/// identity for objects and arrays **can never** be established.  This function
/// models that constraint:
///
/// - Primitives (`null`, `boolean`, `number`, `string`): value equality —
///   identical to JS `===` for primitive types.
/// - Objects (`{}`, `[]`): always `false` — different references across the
///   serialisation boundary, even if structurally identical.
///
/// # TS reference
/// Used in `packages/core/src/operations/crud/unique-check.ts`:
/// `if (existingRecord[field] !== constraintValues[field]) { … }`
/// and in `packages/core/src/operations/crud/upsert.ts` `findByWhere`.
pub fn js_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => {
            // JSON `1` and `1.0` are the same JS Number and must compare equal.
            // serde_json stores integers and floats in distinct internal variants,
            // so `Number` PartialEq would return false for 1 vs 1.0.  Use f64
            // comparison instead — matches JS `1 === 1.0` (true).
            x.as_f64() == y.as_f64()
        }
        (Value::String(x), Value::String(y)) => x == y,
        // Objects and arrays: reference identity cannot be established across
        // a JSON serialisation boundary — model as always inequal.
        //
        // Practical impact:
        // - Unique constraints on object-valued fields never fire at the
        //   boundary (use primitive-valued fields for unique constraints).
        // - `$remove: { … }` never matches array elements (use `$removeBy`
        //   with a registered predicate callback for object removal).
        // This matches the observable TS `===` behaviour.
        (Value::Array(_), Value::Array(_)) | (Value::Object(_), Value::Object(_)) => false,
        _ => false, // different types are never ===
    }
}

// ── Validate (accept-only, no transformation) ─────────────────────────────────

/// Validate `value` against `schema`, starting at the root path `"(root)"`.
///
/// Accepts both encoded and decoded forms of transform schemas (e.g.
/// `NumFromStr` accepts `"42"` *and* `42`).  Does **not** transform the value.
/// Use `decode_value` when the input is the wire (encoded) form.
pub fn validate_value(schema: &SchemaNode, value: &Value) -> Result<(), EngineError> {
    validate_at(schema, value, "(root)")
}

fn validate_at(schema: &SchemaNode, value: &Value, path: &str) -> Result<(), EngineError> {
    match schema {
        SchemaNode::Unsupported { reason } => Err(EngineError::Validation(ValidationError {
            message: format!("Unsupported schema combinator: {reason}"),
            issues: vec![ValidationIssue {
                field: path.into(),
                message: format!("Unsupported schema combinator: {reason}"),
                value: None,
                expected: Some("supported schema combinator".into()),
                received: Some("unsupported".into()),
            }],
        })),

        SchemaNode::Str => match value {
            Value::String(_) => Ok(()),
            _ => Err(type_mismatch(path, "string", value)),
        },

        SchemaNode::Num => match value {
            Value::Number(_) => Ok(()),
            _ => Err(type_mismatch(path, "number", value)),
        },

        SchemaNode::Bool => match value {
            Value::Bool(_) => Ok(()),
            _ => Err(type_mismatch(path, "boolean", value)),
        },

        // `validate_value` accepts both encoded (string "42") and decoded (number 42)
        // forms for `NumFromStr`, because it is called against both stored and wire
        // payloads.  This is intentionally permissive — use `decode_value` when
        // the input MUST be the encoded string form.
        SchemaNode::NumFromStr => match value {
            Value::Number(_) => Ok(()), // decoded form: OK
            Value::String(s) => {
                if s.parse::<f64>().is_ok() {
                    Ok(()) // valid encoded form
                } else {
                    Err(EngineError::Validation(ValidationError {
                        message: format!("Expected a numeric string at \"{path}\""),
                        issues: vec![ValidationIssue {
                            field: path.into(),
                            message: format!(
                                "Expected a string containing a number, received \"{s}\""
                            ),
                            value: Some(Value::String(s.clone())),
                            expected: Some("numeric string".into()),
                            received: Some("non-numeric string".into()),
                        }],
                    }))
                }
            }
            _ => Err(type_mismatch(path, "number or numeric string", value)),
        },

        SchemaNode::Unknown => Ok(()),

        // When validate_at is called with Optional, a value IS present.
        // null is NOT the same as absent: Schema.optional(T) = T | undefined
        // (source: effect/packages/effect/src/Schema.ts, `optional` fn → UndefinedOr(self).ast)
        SchemaNode::Optional(inner) => validate_at(inner, value, path),
        SchemaNode::OptionalWithDefault { inner, .. } => validate_at(inner, value, path),

        SchemaNode::NullOr(inner) => match value {
            Value::Null => Ok(()),
            _ => validate_at(inner, value, path),
        },

        SchemaNode::Array { item } => match value {
            Value::Array(arr) => {
                let mut issues: Vec<ValidationIssue> = vec![];
                for (i, elem) in arr.iter().enumerate() {
                    let ep = format!("{path}[{i}]");
                    if let Err(EngineError::Validation(v)) = validate_at(item, elem, &ep) {
                        issues.extend(v.issues);
                    }
                }
                if issues.is_empty() {
                    Ok(())
                } else {
                    Err(EngineError::Validation(ValidationError {
                        message: format!("{} array element(s) failed validation", issues.len()),
                        issues,
                    }))
                }
            }
            _ => Err(type_mismatch(path, "array", value)),
        },

        SchemaNode::Record {
            value: val_schema, ..
        } => match value {
            Value::Object(map) => {
                let mut issues: Vec<ValidationIssue> = vec![];
                for (k, v) in map {
                    let fp = format!("{path}.{k}");
                    if let Err(EngineError::Validation(ve)) = validate_at(val_schema, v, &fp) {
                        issues.extend(ve.issues);
                    }
                }
                if issues.is_empty() {
                    Ok(())
                } else {
                    Err(EngineError::Validation(ValidationError {
                        message: format!("{} record value(s) failed validation", issues.len()),
                        issues,
                    }))
                }
            }
            _ => Err(type_mismatch(path, "object", value)),
        },

        SchemaNode::Struct { fields } => validate_struct(fields, value, path),
    }
}

fn validate_struct(
    fields: &[crate::descriptor::StructField],
    value: &Value,
    path: &str,
) -> Result<(), EngineError> {
    let obj = match value {
        Value::Object(m) => m,
        _ => return Err(type_mismatch(path, "object", value)),
    };

    let mut issues: Vec<ValidationIssue> = vec![];

    for field in fields {
        let field_path = if path == "(root)" {
            field.name.clone()
        } else {
            format!("{}.{}", path, field.name)
        };

        // Optional and OptionalWithDefault: field may be absent.
        // If present (including null), validate against inner schema.
        // null is rejected unless inner is NullOr — grounded in Effect:
        // Schema.optional(T) = UndefinedOr(T), NOT NullishOr(T).
        let optional_inner: Option<&SchemaNode> = match &field.schema {
            SchemaNode::Optional(inner) => Some(inner.as_ref()),
            SchemaNode::OptionalWithDefault { inner, .. } => Some(inner.as_ref()),
            _ => None,
        };

        if let Some(inner_schema) = optional_inner {
            if let Some(v) = obj.get(&field.name) {
                if let Err(EngineError::Validation(ve)) = validate_at(inner_schema, v, &field_path)
                {
                    issues.extend(ve.issues);
                }
            }
        } else {
            match obj.get(&field.name) {
                None => {
                    issues.push(ValidationIssue {
                        field: field_path,
                        message: format!("Missing key or index \"{}\"", field.name),
                        value: None,
                        expected: None,
                        received: Some("missing".into()),
                    });
                }
                Some(v) => {
                    if let Err(EngineError::Validation(ve)) =
                        validate_at(&field.schema, v, &field_path)
                    {
                        issues.extend(ve.issues);
                    }
                }
            }
        }
    }

    if issues.is_empty() {
        Ok(())
    } else {
        Err(EngineError::Validation(ValidationError {
            message: format!("{} validation issue(s)", issues.len()),
            issues,
        }))
    }
}

// ── Decode (transform + validate) ─────────────────────────────────────────────

/// Decode `value` (encoded / wire form) according to `schema`, returning the
/// decoded (runtime) form.
///
/// Mirrors `Schema.decodeUnknownEffect(schema)(value)` from
/// `packages/core/src/validators/schema-validator.ts`.
///
/// # Differences from `validate_value`
///
/// | Schema        | `validate_value` input        | `decode_value` input (encoded) | `decode_value` output (decoded) |
/// |---------------|-------------------------------|---------------------------------|---------------------------------|
/// | `NumFromStr`  | `"42"` or `42`                | `"42"` only                     | `42` (number)                   |
/// | `Struct`      | any extra fields ignored      | extra fields stripped           | only declared fields            |
/// | other         | same                          | same as validate                | same value                      |
///
/// # TS reference
/// `NumberFromString` is `transformOrFail(String, Number, …)` (Schema.ts ~5342).
/// Its encoded form is `String`; its decoded form is `Number`.
/// `Schema.decodeUnknownEffect(NumberFromString)("42")` → `42`
/// `Schema.decodeUnknownEffect(NumberFromString)(42)`   → ParseError (wrong encoded type)
pub fn decode_value(schema: &SchemaNode, value: &Value) -> Result<Value, EngineError> {
    decode_at(schema, value, "(root)")
}

fn decode_at(schema: &SchemaNode, value: &Value, path: &str) -> Result<Value, EngineError> {
    match schema {
        SchemaNode::Unsupported { reason } => Err(EngineError::Validation(ValidationError {
            message: format!("Unsupported schema combinator: {reason}"),
            issues: vec![ValidationIssue {
                field: path.into(),
                message: format!("Unsupported schema combinator: {reason}"),
                value: None,
                expected: Some("supported schema combinator".into()),
                received: Some("unsupported".into()),
            }],
        })),

        SchemaNode::Str => match value {
            Value::String(_) => Ok(value.clone()),
            _ => Err(type_mismatch(path, "string", value)),
        },

        SchemaNode::Num => match value {
            Value::Number(_) => Ok(value.clone()),
            _ => Err(type_mismatch(path, "number", value)),
        },

        SchemaNode::Bool => match value {
            Value::Bool(_) => Ok(value.clone()),
            _ => Err(type_mismatch(path, "boolean", value)),
        },

        // `decode_value` for `NumFromStr`: ONLY accepts the encoded form (a string).
        // A bare JSON number is NOT valid input for decode — it is the decoded
        // (output) form, not the encoded (input) form.
        //
        // Effect source: Schema.ts ~5314 `parseNumber` / ~5342 `NumberFromString`
        //   → transformOrFail(String, Number, decode: s => parseFloat(s))
        // The "from" (encoded) side is String; the "to" (decoded) side is Number.
        SchemaNode::NumFromStr => match value {
            Value::String(s) => {
                if let Ok(n) = s.parse::<f64>() {
                    Ok(num_from_f64(n))
                } else {
                    Err(EngineError::Validation(ValidationError {
                        message: format!("Expected a numeric string at \"{path}\""),
                        issues: vec![ValidationIssue {
                            field: path.into(),
                            message: format!(
                                "Expected a string containing a number, received \"{s}\""
                            ),
                            value: Some(value.clone()),
                            expected: Some(
                                "numeric string (encoded form for NumberFromString)".into(),
                            ),
                            received: Some("non-numeric string".into()),
                        }],
                    }))
                }
            }
            // A bare number is the DECODED form, not the encoded form.
            // decodeUnknown expects the encoded (String) form.
            other => Err(type_mismatch(
                path,
                "string (encoded form for NumberFromString)",
                other,
            )),
        },

        SchemaNode::Unknown => Ok(value.clone()),

        // Optional: if value is present, decode against inner.
        // Absence is handled by decode_struct; here a value IS present.
        SchemaNode::Optional(inner) => decode_at(inner, value, path),
        SchemaNode::OptionalWithDefault { inner, .. } => decode_at(inner, value, path),

        SchemaNode::NullOr(inner) => match value {
            Value::Null => Ok(Value::Null),
            _ => decode_at(inner, value, path),
        },

        SchemaNode::Array { item } => match value {
            Value::Array(arr) => {
                let mut decoded = Vec::with_capacity(arr.len());
                let mut issues: Vec<ValidationIssue> = vec![];
                for (i, elem) in arr.iter().enumerate() {
                    let ep = format!("{path}[{i}]");
                    match decode_at(item, elem, &ep) {
                        Ok(v) => decoded.push(v),
                        Err(EngineError::Validation(v)) => issues.extend(v.issues),
                        Err(e) => return Err(e),
                    }
                }
                if issues.is_empty() {
                    Ok(Value::Array(decoded))
                } else {
                    Err(EngineError::Validation(ValidationError {
                        message: format!("{} array element(s) failed decoding", issues.len()),
                        issues,
                    }))
                }
            }
            _ => Err(type_mismatch(path, "array", value)),
        },

        SchemaNode::Record {
            value: val_schema, ..
        } => match value {
            Value::Object(map) => {
                let mut decoded_map = JsonMap::new();
                let mut issues: Vec<ValidationIssue> = vec![];
                for (k, v) in map {
                    let fp = format!("{path}.{k}");
                    match decode_at(val_schema, v, &fp) {
                        Ok(dv) => {
                            decoded_map.insert(k.clone(), dv);
                        }
                        Err(EngineError::Validation(ve)) => issues.extend(ve.issues),
                        Err(e) => return Err(e),
                    }
                }
                if issues.is_empty() {
                    Ok(Value::Object(decoded_map))
                } else {
                    Err(EngineError::Validation(ValidationError {
                        message: format!("{} record value(s) failed decoding", issues.len()),
                        issues,
                    }))
                }
            }
            _ => Err(type_mismatch(path, "object", value)),
        },

        SchemaNode::Struct { fields } => decode_struct(fields, value, path),
    }
}

/// Decode a `Value::Object` against a list of [`StructField`]s.
///
/// Effect's default is `onExcessProperty: "ignore"`: unknown keys are stripped
/// from the output.  Only declared fields are included in the decoded result.
///
/// TS reference: `Schema.decodeUnknownEffect(Schema.Struct({…}))(input)` with
/// default parse options strips all keys not mentioned in the struct's fields.
fn decode_struct(
    fields: &[crate::descriptor::StructField],
    value: &Value,
    path: &str,
) -> Result<Value, EngineError> {
    let obj = match value {
        Value::Object(m) => m,
        _ => return Err(type_mismatch(path, "object", value)),
    };

    let mut decoded_map = JsonMap::new();
    let mut issues: Vec<ValidationIssue> = vec![];

    for field in fields {
        let field_path = if path == "(root)" {
            field.name.clone()
        } else {
            format!("{}.{}", path, field.name)
        };

        match &field.schema {
            // Optional-like: field may be absent; absent stays absent.
            SchemaNode::Optional(inner) | SchemaNode::OptionalWithDefault { inner, .. } => {
                if let Some(v) = obj.get(&field.name) {
                    match decode_at(inner, v, &field_path) {
                        Ok(decoded) => {
                            decoded_map.insert(field.name.clone(), decoded);
                        }
                        Err(EngineError::Validation(ve)) => issues.extend(ve.issues),
                        Err(e) => return Err(e),
                    }
                }
                // absent → omit from output (correct Effect behaviour)
            }
            // Required field: must be present.
            schema => match obj.get(&field.name) {
                None => {
                    issues.push(ValidationIssue {
                        field: field_path,
                        message: format!("Missing key or index \"{}\"", field.name),
                        value: None,
                        expected: None,
                        received: Some("missing".into()),
                    });
                }
                Some(v) => match decode_at(schema, v, &field_path) {
                    Ok(decoded) => {
                        decoded_map.insert(field.name.clone(), decoded);
                    }
                    Err(EngineError::Validation(ve)) => issues.extend(ve.issues),
                    Err(e) => return Err(e),
                },
            },
        }
    }

    if issues.is_empty() {
        Ok(Value::Object(decoded_map))
    } else {
        Err(EngineError::Validation(ValidationError {
            message: format!("{} decoding issue(s)", issues.len()),
            issues,
        }))
    }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/// Convert `f64` to the most compact `serde_json::Value::Number`.
///
/// Uses integer representation when the value is a whole number,
/// matching JS behaviour: `Number("42")` → `42` (integer, not `42.0`).
fn num_from_f64(v: f64) -> Value {
    use serde_json::Number;
    if v.fract() == 0.0 && v.abs() < (i64::MAX as f64) {
        Value::Number(Number::from(v as i64))
    } else {
        Value::Number(Number::from_f64(v).unwrap_or(Number::from(0)))
    }
}

/// Produce a `ValidationError` for a type mismatch at the given path.
fn type_mismatch(path: &str, expected: &str, actual: &Value) -> EngineError {
    let received = value_kind_name(actual);
    EngineError::Validation(ValidationError {
        message: format!("Expected {expected} at \"{path}\", received {received}"),
        issues: vec![ValidationIssue {
            field: path.into(),
            message: format!("Expected {expected}, received {received}"),
            value: Some(actual.clone()),
            expected: Some(expected.into()),
            received: Some(received.into()),
        }],
    })
}

/// Human-readable name for the kind of a [`Value`], used in error messages.
fn value_kind_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
