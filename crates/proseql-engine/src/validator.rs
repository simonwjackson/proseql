//! Schema validation against the descriptor's [`SchemaNode`] tree.
//!
//! `validate_value` is the engine's single point of entry for checking that a
//! [`Value`] conforms to a given [`SchemaNode`].  It mirrors the behaviour of
//! `validateEntity` in `packages/core/src/validators/schema-validator.ts`:
//!
//! - Missing required fields → [`ValidationError`] with a "Missing key" issue.
//! - Wrong field type → [`ValidationError`] with a type-mismatch issue.
//! - Optional absent field → valid.
//! - `NullOr` with `null` → valid.
//! - `NumberFromString` encoded form (numeric string) → valid.
//! - `Unknown` → always valid.
//! - `Unsupported` → loud rejection via [`ValidationError`].
//!
//! ## `optional` vs `null`  (Effect semantics)
//!
//! Effect's `Schema.optional(T)` expands to `T | undefined`
//! (source: `effect/packages/effect/src/Schema.ts`, `optional` function,
//!  line ~2542: `UndefinedOr(self).ast`).
//!
//! JSON has no `undefined`; an absent field represents `undefined`.  A field
//! explicitly set to JSON `null` is **not** the same as absent, so the engine
//! rejects `null` for an `Optional(T)` field — use `Optional(NullOr(T))` or
//! a bare `NullOr(T)` field when null is a valid value.
//!
//! The `field` path in each [`ValidationIssue`] mirrors the TS ArrayFormatter
//! style: `"(root)"` at the top level, `"name"` for a direct field, and
//! `"metadata.views"` for nested paths.

use crate::{
    descriptor::SchemaNode,
    errors::{EngineError, ValidationError, ValidationIssue},
    value::Value,
};

/// Validate `value` against `schema`, starting at the root path `"(root)"`.
pub fn validate_value(schema: &SchemaNode, value: &Value) -> Result<(), EngineError> {
    validate_at(schema, value, "(root)")
}

// ── internal recursive validator ──────────────────────────────────────────────

/// Recursive entry point that carries the current field path for issue messages.
fn validate_at(schema: &SchemaNode, value: &Value, path: &str) -> Result<(), EngineError> {
    match schema {
        // ── Unsupported: always loud rejection ───────────────────────────────
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

        // ── Primitives ────────────────────────────────────────────────────────
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

        // ── NumberFromString ──────────────────────────────────────────────────
        //
        // `Schema.NumberFromString` decodes a string like `"42"` to the number
        // `42`.  In the persisted (encoded) form the value is a string; in the
        // runtime (decoded) form it is a number.  The validator accepts both
        // because it is called against both encoded and decoded payloads.
        SchemaNode::NumFromStr => match value {
            Value::Number(_) => Ok(()), // decoded form
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

        // ── Unknown: pass-through ─────────────────────────────────────────────
        SchemaNode::Unknown => Ok(()),

        // ── Optional ──────────────────────────────────────────────────────────
        //
        // When validate_at is called with an Optional schema, a value IS present.
        // Validate it against the inner schema.  The "field may be absent"
        // rule is enforced by `validate_struct` when iterating Struct fields.
        //
        // Importantly: JSON `null` is NOT the same as absent/undefined in Effect.
        // Schema.optional(T) = T | undefined, not T | null.  Passing null here
        // will fail validation against the inner schema (unless inner is NullOr).
        SchemaNode::Optional(inner) => validate_at(inner, value, path),

        // ── OptionalWithDefault ───────────────────────────────────────────────
        //
        // Same presence rules as Optional: if a value IS present, it must conform
        // to the inner schema.  Null is not absent.
        // The "absent → invoke default callback" logic is at U2 runtime; here
        // we only validate the schema shape.
        SchemaNode::OptionalWithDefault { inner, .. } => validate_at(inner, value, path),

        // ── NullOr ────────────────────────────────────────────────────────────
        SchemaNode::NullOr(inner) => match value {
            Value::Null => Ok(()),
            _ => validate_at(inner, value, path),
        },

        // ── Array ─────────────────────────────────────────────────────────────
        SchemaNode::Array { item } => match value {
            Value::Array(arr) => {
                let mut issues: Vec<ValidationIssue> = vec![];
                for (i, elem) in arr.iter().enumerate() {
                    let elem_path = format!("{path}[{i}]");
                    if let Err(EngineError::Validation(v)) = validate_at(item, elem, &elem_path) {
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

        // ── Record ────────────────────────────────────────────────────────────
        SchemaNode::Record {
            value: val_schema, ..
        } => match value {
            Value::Object(map) => {
                let mut issues: Vec<ValidationIssue> = vec![];
                for (k, v) in map {
                    let field_path = format!("{path}.{k}");
                    if let Err(EngineError::Validation(ve)) =
                        validate_at(val_schema, v, &field_path)
                    {
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

        // ── Struct ────────────────────────────────────────────────────────────
        SchemaNode::Struct { fields } => validate_struct(fields, value, path),
    }
}

/// Validate a `Value::Object` against a list of [`StructField`]s.
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

        // Determine whether this field schema is optional-like.
        // Optional and OptionalWithDefault both allow the field to be absent.
        // When present, the value is validated against the inner schema.
        //
        // IMPORTANT: null is NOT treated as absent for optional fields.
        // Effect's optional(T) = T | undefined; null is a distinct value.
        // Grounded in: effect/packages/effect/src/Schema.ts optional() →
        //   UndefinedOr(self).ast  (not NullOr, not NullishOr)
        let optional_inner: Option<&SchemaNode> = match &field.schema {
            SchemaNode::Optional(inner) => Some(inner.as_ref()),
            SchemaNode::OptionalWithDefault { inner, .. } => Some(inner.as_ref()),
            _ => None,
        };

        if let Some(inner_schema) = optional_inner {
            // Optional-like field: field may be absent.
            // If present (including null), validate against inner schema.
            // null will fail unless inner_schema is NullOr or Unknown.
            if let Some(v) = obj.get(&field.name) {
                if let Err(EngineError::Validation(ve)) = validate_at(inner_schema, v, &field_path)
                {
                    issues.extend(ve.issues);
                }
            }
            // absent → OK (default applied at U2 runtime for OptionalWithDefault)
        } else {
            // All other schemas: field is required.
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

// ── helpers ───────────────────────────────────────────────────────────────────

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
