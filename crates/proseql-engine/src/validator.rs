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
//!   Invalid `Record` keys are dropped, as Effect Schema drops them, not rejected.
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

use crate::callbacks::CallbackRegistry;

use crate::{
    descriptor::SchemaNode,
    errors::{EngineError, ValidationError, ValidationIssue},
    value::{is_boundary_undefined, Value},
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
    if is_boundary_undefined(a) || is_boundary_undefined(b) {
        return is_boundary_undefined(a) && is_boundary_undefined(b);
    }
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
    validate_value_with_callbacks(schema, value, None)
}

pub fn validate_value_with_callbacks(
    schema: &SchemaNode,
    value: &Value,
    callbacks: Option<&CallbackRegistry>,
) -> Result<(), EngineError> {
    validate_at(schema, value, "(root)", callbacks).map_err(normalize_check_error)
}

fn validate_at(
    schema: &SchemaNode,
    value: &Value,
    path: &str,
    callbacks: Option<&CallbackRegistry>,
) -> Result<(), EngineError> {
    match schema {
        SchemaNode::Checked { inner, checks } => {
            validate_at(inner, value, path, callbacks)?;
            crate::schema_checks::validate_checks(checks, value, callbacks)
        }
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

        SchemaNode::Literal { value: expected } => {
            if js_eq(value, expected) {
                Ok(())
            } else {
                Err(literal_mismatch(path, expected, value))
            }
        }

        SchemaNode::LiteralUnion { values } => {
            if values.iter().any(|expected| js_eq(value, expected)) {
                Ok(())
            } else {
                Err(literal_union_mismatch(path, values, value))
            }
        }

        // When validate_at is called with Optional, a value IS present.
        // null is NOT the same as absent: Schema.optional(T) = T | undefined
        // (source: effect/packages/effect/src/Schema.ts, `optional` fn → UndefinedOr(self).ast)
        SchemaNode::Optional(inner) => validate_at(inner, value, path, callbacks),
        SchemaNode::OptionalWithDefault { inner, .. } => validate_at(inner, value, path, callbacks),

        SchemaNode::NullOr(inner) => match value {
            Value::Null => Ok(()),
            _ => validate_at(inner, value, path, callbacks),
        },

        SchemaNode::Array { item } => match value {
            Value::Array(arr) => {
                let mut issues: Vec<ValidationIssue> = vec![];
                for (i, elem) in arr.iter().enumerate() {
                    let ep = format!("{path}[{i}]");
                    if let Err(EngineError::Validation(v)) = validate_at(item, elem, &ep, callbacks)
                    {
                        append_issues(&mut issues, v.issues, CheckPathPart::Index(i));
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
            key: key_schema,
            value: val_schema,
        } => match value {
            Value::Object(map) => {
                let mut issues: Vec<ValidationIssue> = vec![];
                for (k, v) in map {
                    if !record_key_matches(key_schema, k, callbacks)? {
                        continue;
                    }
                    let fp = format!("{path}.{k}");
                    if let Err(EngineError::Validation(ve)) =
                        validate_at(val_schema, v, &fp, callbacks)
                    {
                        append_issues(&mut issues, ve.issues, CheckPathPart::Field(k));
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

        SchemaNode::Struct { fields } => validate_struct(fields, value, path, callbacks),
    }
}

#[inline(never)]
fn record_key_matches(
    schema: &SchemaNode,
    key: &str,
    callbacks: Option<&CallbackRegistry>,
) -> Result<bool, EngineError> {
    if matches!(schema, SchemaNode::Str | SchemaNode::Unknown) {
        return Ok(true);
    }
    // A missing host predicate or unsupported check is a configuration error,
    // not an ordinary nonmatching key. Do not silently filter these failures.
    crate::schema_checks::validate_schema_checks_with_callbacks(schema, callbacks)?;
    // After preflight, this validator can only return ordinary validation
    // failures. Host predicate panics/defects unwind past this call.
    Ok(validate_at(schema, &Value::String(key.to_owned()), "(root)", callbacks).is_ok())
}

fn validate_struct(
    fields: &[crate::descriptor::StructField],
    value: &Value,
    path: &str,
    callbacks: Option<&CallbackRegistry>,
) -> Result<(), EngineError> {
    let obj = match value {
        Value::Object(m) => m,
        _ => return Err(type_mismatch(path, "object", value)),
    };

    let mut issues: Vec<ValidationIssue> = vec![];

    for field in fields {
        let nested_path = (path != "(root)").then(|| format!("{path}.{}", field.name));
        let field_path = nested_path.as_deref().unwrap_or(&field.name);

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
                if is_boundary_undefined(v) {
                    continue;
                }
                if let Err(EngineError::Validation(ve)) =
                    validate_at(inner_schema, v, field_path, callbacks)
                {
                    append_issues(&mut issues, ve.issues, CheckPathPart::Field(&field.name));
                }
            }
        } else {
            match obj.get(&field.name) {
                None => {
                    issues.push(ValidationIssue {
                        field: field_path.to_owned(),
                        message: format!("Missing key or index \"{}\"", field.name),
                        value: None,
                        expected: None,
                        received: Some("missing".into()),
                    });
                }
                Some(v) => {
                    if let Err(EngineError::Validation(ve)) =
                        validate_at(&field.schema, v, field_path, callbacks)
                    {
                        append_issues(&mut issues, ve.issues, CheckPathPart::Field(&field.name));
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
    decode_value_with_callbacks(schema, value, None)
}

pub fn decode_value_with_callbacks(
    schema: &SchemaNode,
    value: &Value,
    callbacks: Option<&CallbackRegistry>,
) -> Result<Value, EngineError> {
    decode_at(schema, value, "(root)", callbacks).map_err(normalize_check_error)
}

/// Decode an owned boundary value while reusing its strings, arrays and object
/// fields. Batch creation has no caller-visible copy of the decoded input, so
/// moving the payload avoids a complete clone per entity without changing
/// schema decode semantics.
pub fn decode_owned_value(schema: &SchemaNode, value: Value) -> Result<Value, EngineError> {
    decode_owned_value_with_callbacks(schema, value, None)
}

pub fn decode_owned_value_with_callbacks(
    schema: &SchemaNode,
    value: Value,
    callbacks: Option<&CallbackRegistry>,
) -> Result<Value, EngineError> {
    decode_owned_at(schema, value, "(root)", callbacks).map_err(normalize_check_error)
}

fn struct_capacity(
    fields: &[crate::descriptor::StructField],
    object: &JsonMap<String, Value>,
) -> usize {
    // Successful all-required structs contain every declared field. Sparse
    // optional schemas must not reserve slots for fields that are absent.
    if fields.iter().all(|field| {
        !matches!(
            field.schema,
            SchemaNode::Optional(_) | SchemaNode::OptionalWithDefault { .. }
        )
    }) {
        fields.len()
    } else {
        fields
            .iter()
            .filter(|field| object.contains_key(&field.name))
            .count()
    }
}

fn decode_owned_at(
    schema: &SchemaNode,
    value: Value,
    path: &str,
    callbacks: Option<&CallbackRegistry>,
) -> Result<Value, EngineError> {
    match schema {
        SchemaNode::Checked { inner, checks } => {
            let value = decode_owned_at(inner, value, path, callbacks)?;
            crate::schema_checks::validate_checks(checks, &value, callbacks)?;
            Ok(value)
        }
        SchemaNode::Struct { fields } => {
            let Value::Object(mut object) = value else {
                return Err(type_mismatch(path, "object", &value));
            };
            let mut decoded = JsonMap::with_capacity(struct_capacity(fields, &object));
            let mut issues = Vec::new();
            for field in fields {
                let nested_field_path =
                    (path != "(root)").then(|| format!("{path}.{}", field.name));
                let field_path = nested_field_path.as_deref().unwrap_or(field.name.as_str());
                let optional = matches!(
                    field.schema,
                    SchemaNode::Optional(_) | SchemaNode::OptionalWithDefault { .. }
                );
                let Some(field_value) = object.remove(&field.name) else {
                    if !optional {
                        issues.push(ValidationIssue {
                            field: field_path.to_owned(),
                            message: format!("Missing key or index \"{}\"", field.name),
                            value: None,
                            expected: None,
                            received: Some("missing".into()),
                        });
                    }
                    continue;
                };
                let field_schema = match &field.schema {
                    SchemaNode::Optional(inner) | SchemaNode::OptionalWithDefault { inner, .. } => {
                        inner.as_ref()
                    }
                    other => other,
                };
                if optional && is_boundary_undefined(&field_value) {
                    decoded.insert(field.name.clone(), field_value);
                    continue;
                }
                match decode_owned_at(field_schema, field_value, field_path, callbacks) {
                    Ok(value) => {
                        decoded.insert(field.name.clone(), value);
                    }
                    Err(EngineError::Validation(error)) => {
                        append_issues(&mut issues, error.issues, CheckPathPart::Field(&field.name))
                    }
                    Err(error) => return Err(error),
                }
            }
            if issues.is_empty() {
                Ok(Value::Object(decoded))
            } else {
                Err(EngineError::Validation(ValidationError {
                    message: format!("{} decoding issue(s)", issues.len()),
                    issues,
                }))
            }
        }
        SchemaNode::Array { item } => {
            let Value::Array(values) = value else {
                return Err(type_mismatch(path, "array", &value));
            };
            let mut decoded = Vec::with_capacity(values.len());
            let mut issues = Vec::new();
            for (index, value) in values.into_iter().enumerate() {
                match decode_owned_at(item, value, &format!("{path}[{index}]"), callbacks) {
                    Ok(value) => decoded.push(value),
                    Err(EngineError::Validation(error)) => {
                        append_issues(&mut issues, error.issues, CheckPathPart::Index(index))
                    }
                    Err(error) => return Err(error),
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
        SchemaNode::Record {
            key: key_schema,
            value: schema,
        } => {
            let Value::Object(values) = value else {
                return Err(type_mismatch(path, "object", &value));
            };
            let original_len = values.len();
            let mut decoded = JsonMap::with_capacity(original_len);
            let mut issues = Vec::new();
            for (key, value) in values {
                if !record_key_matches(key_schema, &key, callbacks)? {
                    continue;
                }
                match decode_owned_at(schema, value, &format!("{path}.{key}"), callbacks) {
                    Ok(value) => {
                        decoded.insert(key, value);
                    }
                    Err(EngineError::Validation(error)) => {
                        append_issues(&mut issues, error.issues, CheckPathPart::Field(&key))
                    }
                    Err(error) => return Err(error),
                }
            }
            if issues.is_empty() {
                // Key predicates can discard almost the whole input. Move the
                // kept entries into an exact-size map; do not retain raw width.
                if decoded.len() < original_len {
                    let mut compact = JsonMap::with_capacity(decoded.len());
                    for (key, value) in decoded {
                        compact.insert(key, value);
                    }
                    decoded = compact;
                }
                Ok(Value::Object(decoded))
            } else {
                Err(EngineError::Validation(ValidationError {
                    message: format!("{} record value(s) failed decoding", issues.len()),
                    issues,
                }))
            }
        }
        SchemaNode::NumFromStr => match value {
            Value::String(string) => string.parse::<f64>().map(num_from_f64).map_err(|_| {
                EngineError::Validation(ValidationError {
                    message: format!("Expected a numeric string at \"{path}\""),
                    issues: vec![ValidationIssue {
                        field: path.into(),
                        message: format!(
                            "Expected a string containing a number, received \"{string}\""
                        ),
                        value: Some(Value::String(string)),
                        expected: Some("numeric string (encoded form for NumberFromString)".into()),
                        received: Some("non-numeric string".into()),
                    }],
                })
            }),
            other => Err(type_mismatch(
                path,
                "string (encoded form for NumberFromString)",
                &other,
            )),
        },
        SchemaNode::Optional(inner) | SchemaNode::OptionalWithDefault { inner, .. } => {
            decode_owned_at(inner, value, path, callbacks)
        }
        SchemaNode::NullOr(inner) if value.is_null() => Ok(value),
        SchemaNode::NullOr(inner) => decode_owned_at(inner, value, path, callbacks),
        SchemaNode::Unsupported { .. } => decode_at(schema, &value, path, callbacks),
        _ => {
            validate_at(schema, &value, path, callbacks)?;
            Ok(value)
        }
    }
}

fn decode_at(
    schema: &SchemaNode,
    value: &Value,
    path: &str,
    callbacks: Option<&CallbackRegistry>,
) -> Result<Value, EngineError> {
    match schema {
        SchemaNode::Checked { inner, checks } => {
            let value = decode_at(inner, value, path, callbacks)?;
            crate::schema_checks::validate_checks(checks, &value, callbacks)?;
            Ok(value)
        }
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

        SchemaNode::Literal { value: expected } => {
            if js_eq(value, expected) {
                Ok(value.clone())
            } else {
                Err(literal_mismatch(path, expected, value))
            }
        }

        SchemaNode::LiteralUnion { values } => {
            if values.iter().any(|expected| js_eq(value, expected)) {
                Ok(value.clone())
            } else {
                Err(literal_union_mismatch(path, values, value))
            }
        }

        // Optional: if value is present, decode against inner.
        // Absence is handled by decode_struct; here a value IS present.
        SchemaNode::Optional(inner) => decode_at(inner, value, path, callbacks),
        SchemaNode::OptionalWithDefault { inner, .. } => decode_at(inner, value, path, callbacks),

        SchemaNode::NullOr(inner) => match value {
            Value::Null => Ok(Value::Null),
            _ => decode_at(inner, value, path, callbacks),
        },

        SchemaNode::Array { item } => match value {
            Value::Array(arr) => {
                let mut decoded = Vec::with_capacity(arr.len());
                let mut issues: Vec<ValidationIssue> = vec![];
                for (i, elem) in arr.iter().enumerate() {
                    let ep = format!("{path}[{i}]");
                    match decode_at(item, elem, &ep, callbacks) {
                        Ok(v) => decoded.push(v),
                        Err(EngineError::Validation(v)) => {
                            append_issues(&mut issues, v.issues, CheckPathPart::Index(i))
                        }
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
            key: key_schema,
            value: val_schema,
        } => match value {
            Value::Object(map) => {
                let mut decoded_map = JsonMap::new();
                let mut issues: Vec<ValidationIssue> = vec![];
                for (k, v) in map {
                    if !record_key_matches(key_schema, k, callbacks)? {
                        continue;
                    }
                    let fp = format!("{path}.{k}");
                    match decode_at(val_schema, v, &fp, callbacks) {
                        Ok(dv) => {
                            decoded_map.insert(k.clone(), dv);
                        }
                        Err(EngineError::Validation(ve)) => {
                            append_issues(&mut issues, ve.issues, CheckPathPart::Field(k))
                        }
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

        SchemaNode::Struct { fields } => decode_struct(fields, value, path, callbacks),
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
    callbacks: Option<&CallbackRegistry>,
) -> Result<Value, EngineError> {
    let obj = match value {
        Value::Object(m) => m,
        _ => return Err(type_mismatch(path, "object", value)),
    };

    let mut decoded_map = JsonMap::with_capacity(struct_capacity(fields, obj));
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
                    if is_boundary_undefined(v) {
                        decoded_map.insert(field.name.clone(), v.clone());
                        continue;
                    }
                    match decode_at(inner, v, &field_path, callbacks) {
                        Ok(decoded) => {
                            decoded_map.insert(field.name.clone(), decoded);
                        }
                        Err(EngineError::Validation(ve)) => {
                            append_issues(&mut issues, ve.issues, CheckPathPart::Field(&field.name))
                        }
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
                Some(v) => match decode_at(schema, v, &field_path, callbacks) {
                    Ok(decoded) => {
                        decoded_map.insert(field.name.clone(), decoded);
                    }
                    Err(EngineError::Validation(ve)) => {
                        append_issues(&mut issues, ve.issues, CheckPathPart::Field(&field.name))
                    }
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

fn literal_mismatch(path: &str, expected: &Value, actual: &Value) -> EngineError {
    let expected_json = serde_json::to_string(expected).unwrap_or_else(|_| "null".to_owned());
    let actual_json = serde_json::to_string(actual).unwrap_or_else(|_| "null".to_owned());
    EngineError::Validation(ValidationError {
        message: format!("Expected literal {expected_json} at \"{path}\", received {actual_json}"),
        issues: vec![ValidationIssue {
            field: path.into(),
            message: format!("Expected literal {expected_json}, received {actual_json}"),
            value: Some(actual.clone()),
            expected: Some(expected_json),
            received: Some(actual_json),
        }],
    })
}

fn literal_union_mismatch(path: &str, expected: &[Value], actual: &Value) -> EngineError {
    let expected_json = format!(
        "one of [{}]",
        expected
            .iter()
            .map(|value| serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned()))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let actual_json = serde_json::to_string(actual).unwrap_or_else(|_| "null".to_owned());
    EngineError::Validation(ValidationError {
        message: format!("Expected {expected_json} at \"{path}\", received {actual_json}"),
        issues: vec![ValidationIssue {
            field: path.into(),
            message: format!("Expected {expected_json}, received {actual_json}"),
            value: Some(actual.clone()),
            expected: Some(expected_json),
            received: Some(actual_json),
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

enum CheckPathPart<'a> {
    Field(&'a str),
    Index(usize),
}

fn append_issues(
    issues: &mut Vec<ValidationIssue>,
    mut incoming: Vec<ValidationIssue>,
    part: CheckPathPart<'_>,
) {
    for issue in &mut incoming {
        if issue.field == "(root)" && issue.expected.is_none() && issue.received.is_none() {
            let segment = match part {
                CheckPathPart::Field(name) => format!("[{}]", serde_json::to_string(name).unwrap()),
                CheckPathPart::Index(index) => format!("[{index}]"),
            };
            if issue.message.contains("\n  at ") {
                issue.message = issue
                    .message
                    .replace("\n  at ", &format!("\n  at {segment}"));
            } else {
                issue.message.push_str("\n  at ");
                issue.message.push_str(&segment);
            }
        }
    }
    issues.extend(incoming);
}

// Core exposes the first SchemaIssue as one root issue, including its path.
fn normalize_check_error(error: EngineError) -> EngineError {
    if let EngineError::Validation(ref validation) = error {
        if let Some(issue) = validation.issues.iter().find(|issue| {
            issue.field == "(root)" && issue.expected.is_none() && issue.received.is_none()
        }) {
            return EngineError::Validation(ValidationError {
                message: issue.message.clone(),
                issues: vec![issue.clone()],
            });
        }
    }
    error
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::descriptor::StructField;

    #[test]
    fn owned_struct_decode_preserves_borrowed_tagged_validation_error() {
        let schema = SchemaNode::Struct {
            fields: vec![
                StructField {
                    name: "id".into(),
                    schema: SchemaNode::Str,
                },
                StructField {
                    name: "count".into(),
                    schema: SchemaNode::Num,
                },
            ],
        };
        let input = json!({"id": 42, "count": "nope"});
        let borrowed = decode_value(&schema, &input).expect_err("borrowed decode must fail");
        let owned = decode_owned_value(&schema, input).expect_err("owned decode must fail");

        assert_eq!(
            serde_json::to_value(&owned).unwrap(),
            serde_json::to_value(&borrowed).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&owned).unwrap()["message"],
            "2 decoding issue(s)"
        );
    }
    fn assert_record_key_filter(key: SchemaNode, callbacks: Option<&CallbackRegistry>) {
        let schema = SchemaNode::Record {
            key: Box::new(key),
            value: Box::new(SchemaNode::Num),
        };
        // A rejected key's value must not be decoded or validated.
        let input = json!({"bad":"ignored", "okay":2, "ok_two":3});
        let expected = json!({"okay":2, "ok_two":3});
        assert_eq!(
            decode_value_with_callbacks(&schema, &input, callbacks).unwrap(),
            expected
        );
        let owned = decode_owned_value_with_callbacks(&schema, input.clone(), callbacks).unwrap();
        assert_eq!(owned, expected);
        assert_eq!(
            owned
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["okay", "ok_two"]
        );
        validate_value_with_callbacks(&schema, &input, callbacks).unwrap();
        assert!(decode_value_with_callbacks(&schema, &json!({"okay":"wrong"}), callbacks).is_err());
        assert!(
            decode_owned_value_with_callbacks(&schema, json!({"okay":"wrong"}), callbacks).is_err()
        );
        assert!(
            validate_value_with_callbacks(&schema, &json!({"okay":"wrong"}), callbacks).is_err()
        );
    }

    #[cfg(feature = "native-checks")]
    #[test]
    fn record_keys_apply_builtin_checks_and_drop_nonmatching_entries() {
        assert_record_key_filter(
            SchemaNode::Checked {
                inner: Box::new(SchemaNode::Str),
                checks: vec![crate::descriptor::SchemaCheck::new(
                    "effect/schema/isMinLength",
                    json!({"minLength":4}),
                    "a value with a length of at least 4",
                    None,
                )],
            },
            None,
        );
    }

    #[test]
    fn record_keys_apply_host_predicates_and_drop_nonmatching_entries() {
        let mut callbacks = CallbackRegistry::new();
        callbacks.register_predicate(
            "key",
            Box::new(|value| value.as_str().is_some_and(|key| key.starts_with("ok"))),
        );
        assert_record_key_filter(
            SchemaNode::Checked {
                inner: Box::new(SchemaNode::Str),
                checks: vec![crate::descriptor::SchemaCheck::new(
                    "custom",
                    Value::Null,
                    "an allowed key",
                    Some("key".into()),
                )],
            },
            Some(&callbacks),
        );
    }

    #[test]
    fn record_keys_apply_the_key_type() {
        let schema = SchemaNode::Record {
            key: Box::new(SchemaNode::Literal {
                value: json!("okay"),
            }),
            value: Box::new(SchemaNode::Num),
        };
        let input = json!({"bad":"ignored", "okay":2});
        assert_eq!(decode_value(&schema, &input).unwrap(), json!({"okay":2}));
        assert_eq!(
            decode_owned_value(&schema, input.clone()).unwrap(),
            json!({"okay":2})
        );
        validate_value(&schema, &input).unwrap();
    }
    #[test]
    fn record_key_predicates_must_be_registered_instead_of_silently_dropping_keys() {
        let schema = SchemaNode::Record {
            key: Box::new(SchemaNode::Checked {
                inner: Box::new(SchemaNode::Str),
                checks: vec![crate::descriptor::SchemaCheck::new(
                    "custom",
                    Value::Null,
                    "an allowed key",
                    Some("missing".into()),
                )],
            }),
            value: Box::new(SchemaNode::Num),
        };
        assert!(decode_value(&schema, &json!({"okay":1})).is_err());
        assert!(decode_owned_value(&schema, json!({"okay":1})).is_err());
        assert!(validate_value(&schema, &json!({"okay":1})).is_err());
    }
    #[test]
    fn record_key_predicate_aborts_are_not_filtered_as_validation_failures() {
        let mut callbacks = CallbackRegistry::new();
        callbacks.register_predicate(
            "abort",
            Box::new(|_| panic!("record key predicate aborted")),
        );
        let schema = SchemaNode::Record {
            key: Box::new(SchemaNode::Checked {
                inner: Box::new(SchemaNode::Str),
                checks: vec![crate::descriptor::SchemaCheck::new(
                    "custom",
                    Value::Null,
                    "an allowed key",
                    Some("abort".into()),
                )],
            }),
            value: Box::new(SchemaNode::Num),
        };
        let input = json!({"okay":1});
        use std::panic::{catch_unwind, AssertUnwindSafe};
        assert!(
            catch_unwind(AssertUnwindSafe(|| decode_value_with_callbacks(
                &schema,
                &input,
                Some(&callbacks)
            )))
            .is_err()
        );
        assert!(
            catch_unwind(AssertUnwindSafe(|| decode_owned_value_with_callbacks(
                &schema,
                input.clone(),
                Some(&callbacks)
            )))
            .is_err()
        );
        assert!(
            catch_unwind(AssertUnwindSafe(|| validate_value_with_callbacks(
                &schema,
                &input,
                Some(&callbacks)
            )))
            .is_err()
        );
    }
}
