//! Update operator application for the proseQL engine.
//!
//! Ports `deepMergeUpdates` and `applyOperator` from
//! `packages/core/src/operations/crud/update.ts`.
//!
//! ## Supported operators (exact TS parity)
//!
//! | Operator        | Applicable to        | Behaviour                                         |
//! |-----------------|----------------------|---------------------------------------------------|
//! | `$set`          | any type             | Replace with the operand value                    |
//! | `$increment`    | Number               | `current + operand`                               |
//! | `$decrement`    | Number               | `current - operand`                               |
//! | `$multiply`     | Number               | `current * operand`                               |
//! | `$append`       | String / Array       | Concat to end                                     |
//! | `$prepend`      | String / Array       | Concat to front                                   |
//! | `$remove`       | Array                | Remove all elements **equal** to value (by-value) |
//! | `$removeBy`     | Array                | Remove all elements for which predicate returns `true` (by callback id) |
//! | `$toggle`       | Boolean              | `!current`                                        |
//!
//! ## TS behavioural decisions reproduced here
//!
//! - **Wrong-type operator**: if the operator doesn't match the current value's type
//!   (e.g., `$increment` on a String), it is silently ignored and the current value
//!   is returned unchanged — *except* for `$set` which always applies.
//!   This matches the TS `applyOperator` fall-through.
//!
//! - **Absent field + operator**: if the field is absent from the current entity,
//!   `$set` adds it; all other operators are a no-op (field stays absent).
//!   This matches TS: `applyOperator(undefined, { $increment: 1 })` → `undefined`,
//!   which JSON-serializes as absent.
//!
//! - **Nested deep merge**: a plain object with no `$` keys and a plain object
//!   current value → recurse.  A `$`-keyed object → apply operator.
//!
//! - **`$remove` (by value) vs `$removeBy` (by predicate callback)**: TS accepts
//!   a function predicate as `$remove: (item) => boolean`. In Rust, a JS closure
//!   cannot be serialized across the JSON boundary, so the Rust API splits this
//!   into two operators:
//!   - `$remove: Value` — remove all elements strictly equal to `value` (no registry).
//!   - `$removeBy: String` — remove all elements for which the registered predicate
//!     callback (keyed by the string) returns `true` (requires `CallbackRegistry`).
//!
//! - **Immutable fields**: `id` and `createdAt` are rejected before `deep_merge_updates`
//!   is called.  If they appear in updates, the caller must return a `ValidationError`
//!   before applying operators.

use serde_json::{Map, Value};

use crate::callbacks::CallbackRegistry;
use crate::errors::{EngineError, OperationError, ValidationError, ValidationIssue};
use crate::validator::js_eq;

// ── Immutability guard ────────────────────────────────────────────────────────

/// Reject updates that attempt to change `id` or `createdAt`.
///
/// Mirrors `validateImmutableFields` from `update.ts`.
pub fn validate_immutable_fields(updates: &Value) -> Result<(), EngineError> {
    let obj = match updates.as_object() {
        Some(m) => m,
        None => return Ok(()),
    };

    for field in &["id", "createdAt"] {
        if obj.contains_key(*field) {
            return Err(EngineError::Validation(ValidationError {
                message: format!("Cannot update immutable field: {field}"),
                issues: vec![ValidationIssue {
                    field: (*field).to_string(),
                    message: format!("Cannot update immutable field: {field}"),
                    value: None,
                    expected: None,
                    received: None,
                }],
            }));
        }
    }

    Ok(())
}

// ── Operator application ──────────────────────────────────────────────────────

/// Apply a single operator object (`{ $increment: 5 }`, etc.) to a current value.
///
/// `registry` is consulted for `$removeBy`.  If the callback id is not registered,
/// an `OperationError` is returned — this is a host-contract violation, not a
/// silent no-op.  All other operators that don't match the current value's type
/// are silently ignored (TS `applyOperator` fall-through semantics).
///
/// Returns `Ok(new_value)` or `Err(EngineError)` for `$removeBy` with an
/// unregistered callback id.
fn apply_operator(
    current: &Value,
    op: &Map<String, Value>,
    registry: &CallbackRegistry,
) -> Result<Value, EngineError> {
    // $set always wins regardless of current type
    if let Some(v) = op.get("$set") {
        return Ok(v.clone());
    }

    match current {
        // ── Number operators ──────────────────────────────────────────────────
        Value::Number(n) => {
            let cur = n.as_f64().unwrap_or(0.0);
            if let Some(v) = op.get("$increment").and_then(|v| v.as_f64()) {
                return Ok(json_f64(cur + v));
            }
            if let Some(v) = op.get("$decrement").and_then(|v| v.as_f64()) {
                return Ok(json_f64(cur - v));
            }
            if let Some(v) = op.get("$multiply").and_then(|v| v.as_f64()) {
                return Ok(json_f64(cur * v));
            }
            Ok(current.clone())
        }

        // ── String operators ──────────────────────────────────────────────────
        Value::String(s) => {
            if let Some(Value::String(suffix)) = op.get("$append") {
                return Ok(Value::String(format!("{s}{suffix}")));
            }
            if let Some(Value::String(prefix)) = op.get("$prepend") {
                return Ok(Value::String(format!("{prefix}{s}")));
            }
            Ok(current.clone())
        }

        // ── Array operators ───────────────────────────────────────────────────
        Value::Array(arr) => {
            if let Some(to_append) = op.get("$append") {
                let mut result = arr.clone();
                match to_append {
                    Value::Array(elems) => result.extend(elems.iter().cloned()),
                    v => result.push(v.clone()),
                }
                return Ok(Value::Array(result));
            }
            if let Some(to_prepend) = op.get("$prepend") {
                let mut prefix = match to_prepend {
                    Value::Array(elems) => elems.clone(),
                    v => vec![v.clone()],
                };
                prefix.extend(arr.iter().cloned());
                return Ok(Value::Array(prefix));
            }
            if let Some(to_remove) = op.get("$remove") {
                // By-value removal using JS `===` semantics (via `js_eq`).
                //
                // Primitive operands (string, number, bool): value equality —
                // identical to JS `item !== scalar`.
                //
                // Object/array operands: `js_eq` returns false for all object
                // comparisons across the JSON boundary (identity semantics).
                // `$remove: { … }` therefore never removes anything.  Use
                // `$removeBy` with a registered predicate callback for object
                // removal.
                //
                // TS source: `update.ts` → `arr.filter(item => item !== op.$remove)`
                let result: Vec<Value> = arr
                    .iter()
                    .filter(|elem| !js_eq(elem, to_remove))
                    .cloned()
                    .collect();
                return Ok(Value::Array(result));
            }
            if let Some(Value::String(callback_id)) = op.get("$removeBy") {
                // By-predicate removal: call the registered predicate for each element.
                // Elements for which the predicate returns `true` are removed.
                //
                // An unregistered callback id is a host-contract violation and fails
                // loudly — it means the JS/native side forgot to register the function
                // before issuing the update.  Silent no-op would mask bugs silently.
                if registry.has_predicate(callback_id) {
                    let result: Vec<Value> = arr
                        .iter()
                        .filter(|elem| {
                            !registry
                                .invoke_predicate(callback_id, elem)
                                .unwrap_or(false)
                        })
                        .cloned()
                        .collect();
                    return Ok(Value::Array(result));
                }
                // Unregistered → OperationError (not a silent no-op)
                return Err(EngineError::Operation(OperationError {
                    operation: "$removeBy".to_string(),
                    reason: format!("predicate callback '{}' is not registered", callback_id),
                    message: format!(
                        "$removeBy: predicate callback '{}' is not registered. \
                         Register it via CallbackRegistry before using this operator.",
                        callback_id
                    ),
                }));
            }
            Ok(current.clone())
        }

        // ── Boolean operators ─────────────────────────────────────────────────
        Value::Bool(b) => {
            if op.get("$toggle").and_then(|v| v.as_bool()) == Some(true) {
                return Ok(Value::Bool(!b));
            }
            Ok(current.clone())
        }

        // Null / missing: only $set applies (handled above); all others no-op.
        _ => Ok(current.clone()),
    }
}

/// Convert `f64` to a `serde_json::Value::Number`.
///
/// If the value is an integer that fits in `i64`, use the integer representation
/// to match JS `Number` behaviour (`30 + 5 === 35`, not `35.0`).
fn json_f64(v: f64) -> Value {
    use serde_json::Number;
    if v.fract() == 0.0 && v.abs() < (i64::MAX as f64) {
        Value::Number(Number::from(v as i64))
    } else {
        Value::Number(Number::from_f64(v).unwrap_or(Number::from(0)))
    }
}

// ── Deep merge ────────────────────────────────────────────────────────────────

/// Apply update fields (possibly with operators) onto a current entity.
///
/// Mirrors `deepMergeUpdates` from `update.ts`:
///
/// 1. If `update_value` is a plain object with `$`-prefixed keys → apply operator
/// 2. If `update_value` is a plain object with no `$`-keys AND `current_value`
///    is also a plain object → recurse
/// 3. Otherwise → direct assignment (replace)
///
/// `updatedAt` is NOT added here; the caller (`Collection::update`) sets it.
///
/// Returns `Err` when an operator application fails (e.g. unregistered `$removeBy`).
pub fn deep_merge_updates(
    current: &Value,
    updates: &Value,
    registry: &CallbackRegistry,
) -> Result<Value, EngineError> {
    let current_obj = match current.as_object() {
        Some(m) => m,
        None => return Ok(updates.clone()),
    };
    let updates_obj = match updates.as_object() {
        Some(m) => m,
        None => return Ok(updates.clone()),
    };

    let mut result = current_obj.clone();

    for (key, update_value) in updates_obj {
        if update_value.is_null() {
            // Treat explicit null as direct assignment (preserve field as null)
            result.insert(key.clone(), Value::Null);
            continue;
        }

        let current_value = current_obj.get(key).cloned();

        if let Some(update_obj) = update_value.as_object() {
            let has_operators = update_obj.keys().any(|k| k.starts_with('$'));
            if has_operators {
                // Operator object: apply to current value (or Null if absent)
                let cur = current_value.unwrap_or(Value::Null);
                let new_val = apply_operator(&cur, update_obj, registry)?;
                // If field was absent and operator produced Null (no-op), skip
                if current_obj.contains_key(key) || !matches!(new_val, Value::Null) {
                    result.insert(key.clone(), new_val);
                }
            } else if let Some(Value::Object(_)) = current_value {
                // Both are plain objects without operators → recurse
                let cur = current_value.unwrap();
                result.insert(
                    key.clone(),
                    deep_merge_updates(&cur, update_value, registry)?,
                );
            } else {
                // current isn't an object → direct replace
                result.insert(key.clone(), update_value.clone());
            }
        } else {
            // Primitive or array → direct assignment
            result.insert(key.clone(), update_value.clone());
        }
    }

    Ok(Value::Object(result))
}

/// Check whether the update payload touches any of the given unique fields.
///
/// Used to skip the unique-constraint check when no unique field is being changed.
/// Mirrors `updateTouchesUniqueFields` from `unique-check.ts`.
pub fn update_touches_unique_fields(
    updates: &Value,
    unique_fields: &[crate::descriptor::UniqueConstraintDescriptor],
) -> bool {
    if unique_fields.is_empty() {
        return false;
    }

    let update_keys: std::collections::HashSet<&str> = match updates.as_object() {
        Some(m) => m.keys().map(|k| k.as_str()).collect(),
        None => return false,
    };

    for constraint in unique_fields {
        let fields: Vec<String> = match constraint {
            crate::descriptor::UniqueConstraintDescriptor::Single(f) => vec![f.clone()],
            crate::descriptor::UniqueConstraintDescriptor::Compound(fs) => fs.clone(),
        };
        if fields.iter().any(|f| update_keys.contains(f.as_str())) {
            return true;
        }
    }

    false
}

// ── Unit tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn empty_registry() -> CallbackRegistry {
        CallbackRegistry::new()
    }

    // ── validate_immutable_fields ──────────────────────────────────────────────

    #[test]
    fn immutable_id_field_rejected() {
        let updates = json!({ "id": "new-id", "name": "Alice" });
        let err = validate_immutable_fields(&updates).unwrap_err();
        match err {
            EngineError::Validation(v) => {
                assert!(v.message.contains("immutable"));
                assert_eq!(v.issues[0].field, "id");
            }
            other => panic!("expected ValidationError, got {other:?}"),
        }
    }

    #[test]
    fn immutable_created_at_field_rejected() {
        let updates = json!({ "createdAt": "2025-01-01" });
        let err = validate_immutable_fields(&updates).unwrap_err();
        match err {
            EngineError::Validation(v) => {
                assert!(v.message.contains("immutable"));
                assert_eq!(v.issues[0].field, "createdAt");
            }
            other => panic!("expected ValidationError, got {other:?}"),
        }
    }

    #[test]
    fn mutable_fields_pass_immutability_check() {
        let updates = json!({ "name": "Alice", "age": 30, "updatedAt": "now" });
        assert!(validate_immutable_fields(&updates).is_ok());
    }

    // ── Number operators ───────────────────────────────────────────────────────

    #[test]
    fn increment_number_field() {
        let cur = json!({ "age": 30 });
        let upd = json!({ "age": { "$increment": 5 } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["age"], json!(35));
    }

    #[test]
    fn decrement_number_field() {
        let cur = json!({ "age": 30 });
        let upd = json!({ "age": { "$decrement": 10 } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["age"], json!(20));
    }

    #[test]
    fn multiply_number_field() {
        let cur = json!({ "age": 30 });
        let upd = json!({ "age": { "$multiply": 2 } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["age"], json!(60));
    }

    #[test]
    fn set_number_field() {
        let cur = json!({ "age": 30 });
        let upd = json!({ "age": { "$set": 99 } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["age"], json!(99));
    }

    // ── String operators ───────────────────────────────────────────────────────

    #[test]
    fn append_to_string() {
        let cur = json!({ "name": "John Doe" });
        let upd = json!({ "name": { "$append": " Jr." } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["name"], json!("John Doe Jr."));
    }

    #[test]
    fn prepend_to_string() {
        let cur = json!({ "name": "John Doe" });
        let upd = json!({ "name": { "$prepend": "Dr. " } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["name"], json!("Dr. John Doe"));
    }

    #[test]
    fn set_string_field() {
        let cur = json!({ "name": "Old" });
        let upd = json!({ "name": { "$set": "New" } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["name"], json!("New"));
    }

    // ── Array operators ────────────────────────────────────────────────────────

    #[test]
    fn append_single_element_to_array() {
        let cur = json!({ "tags": ["admin", "dev"] });
        let upd = json!({ "tags": { "$append": "qa" } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["tags"], json!(["admin", "dev", "qa"]));
    }

    #[test]
    fn append_array_to_array() {
        let cur = json!({ "tags": ["admin"] });
        let upd = json!({ "tags": { "$append": ["dev", "qa"] } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["tags"], json!(["admin", "dev", "qa"]));
    }

    #[test]
    fn prepend_single_element_to_array() {
        let cur = json!({ "tags": ["admin", "dev"] });
        let upd = json!({ "tags": { "$prepend": "lead" } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["tags"], json!(["lead", "admin", "dev"]));
    }

    #[test]
    fn remove_element_from_array_by_value() {
        let cur = json!({ "tags": ["admin", "dev"] });
        let upd = json!({ "tags": { "$remove": "admin" } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["tags"], json!(["dev"]));
    }

    #[test]
    fn remove_element_not_in_array_leaves_array_unchanged() {
        let cur = json!({ "tags": ["admin", "dev"] });
        let upd = json!({ "tags": { "$remove": "missing" } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["tags"], json!(["admin", "dev"]));
    }

    /// JS identity semantics: `$remove` with an object operand never matches
    /// any array element across the JSON boundary.
    ///
    /// In TS: `arr.filter(item => item !== obj)` — object identity is never
    /// satisfied across serialised boundary values.  `js_eq` models this.
    #[test]
    fn remove_with_object_operand_never_matches_js_identity_semantics() {
        let cur = json!({ "items": [{ "id": 1 }, { "id": 2 }] });
        let upd = json!({ "items": { "$remove": { "id": 1 } } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        // Object operand: js_eq(object, object) == false across boundary.
        // Nothing is removed.  Use `$removeBy` for object removal.
        assert_eq!(
            result["items"],
            json!([{ "id": 1 }, { "id": 2 }]),
            "$remove with object operand must leave array unchanged (JS identity semantics)"
        );
    }

    /// Scalar $remove still works correctly (primitive value equality).
    #[test]
    fn remove_scalar_still_works_with_value_equality() {
        let cur = json!({ "scores": [1, 2, 3, 2] });
        let upd = json!({ "scores": { "$remove": 2 } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["scores"], json!([1, 3]));
    }

    #[test]
    fn set_array_field() {
        let cur = json!({ "tags": ["admin"] });
        let upd = json!({ "tags": { "$set": ["new"] } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["tags"], json!(["new"]));
    }

    #[test]
    fn remove_by_predicate_removes_matching_elements() {
        let mut registry = CallbackRegistry::new();
        // Remove numbers greater than 3
        registry.register_predicate(
            "gt3",
            Box::new(|v| v.as_f64().map(|n| n > 3.0).unwrap_or(false)),
        );

        let cur = json!({ "scores": [1, 2, 3, 4, 5] });
        let upd = json!({ "scores": { "$removeBy": "gt3" } });
        let result = deep_merge_updates(&cur, &upd, &registry).unwrap();
        assert_eq!(result["scores"], json!([1, 2, 3]));
    }

    /// Unregistered `$removeBy` must fail loudly (OperationError), not silently no-op.
    #[test]
    fn remove_by_unregistered_predicate_fails_with_operation_error() {
        let registry = CallbackRegistry::new();
        let cur = json!({ "scores": [1, 2, 3] });
        let upd = json!({ "scores": { "$removeBy": "nonexistent" } });
        let err = deep_merge_updates(&cur, &upd, &registry).unwrap_err();
        match err {
            EngineError::Operation(e) => {
                assert_eq!(e.operation, "$removeBy");
                assert!(
                    e.reason.contains("nonexistent"),
                    "reason must name the callback id"
                );
            }
            other => panic!("expected OperationError, got {other:?}"),
        }
    }

    // ── Boolean operators ──────────────────────────────────────────────────────

    #[test]
    fn toggle_boolean_field_true_to_false() {
        let cur = json!({ "active": true });
        let upd = json!({ "active": { "$toggle": true } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["active"], json!(false));
    }

    #[test]
    fn toggle_boolean_field_false_to_true() {
        let cur = json!({ "active": false });
        let upd = json!({ "active": { "$toggle": true } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["active"], json!(true));
    }

    #[test]
    fn set_boolean_field() {
        let cur = json!({ "active": true });
        let upd = json!({ "active": { "$set": false } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["active"], json!(false));
    }

    // ── Nested deep merge ──────────────────────────────────────────────────────

    #[test]
    fn nested_object_deep_merge_preserves_siblings() {
        let cur = json!({
            "metadata": { "views": 100, "rating": 4.5 }
        });
        let upd = json!({
            "metadata": { "views": 500 }
        });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["metadata"]["views"], json!(500));
        assert_eq!(result["metadata"]["rating"], json!(4.5));
    }

    #[test]
    fn nested_operator_applied_to_inner_field() {
        let cur = json!({
            "metadata": { "views": 100, "rating": 4.5 }
        });
        let upd = json!({
            "metadata": { "views": { "$increment": 1 } }
        });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["metadata"]["views"], json!(101));
        assert_eq!(result["metadata"]["rating"], json!(4.5));
    }

    #[test]
    fn top_level_set_replaces_nested_object() {
        let cur = json!({
            "metadata": { "views": 100 }
        });
        let upd = json!({
            "metadata": { "$set": { "views": 0 } }
        });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["metadata"], json!({ "views": 0 }));
    }

    // ── Direct assignment ──────────────────────────────────────────────────────

    #[test]
    fn direct_string_assignment_replaces_field() {
        let cur = json!({ "name": "Old", "email": "old@example.com" });
        let upd = json!({ "name": "New" });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["name"], json!("New"));
        assert_eq!(result["email"], json!("old@example.com"));
    }

    #[test]
    fn operator_on_absent_non_set_is_noop_leaves_field_absent() {
        let cur = json!({});
        let upd = json!({ "score": { "$increment": 1 } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert!(result.get("score").is_none());
    }

    #[test]
    fn set_on_absent_field_adds_it() {
        let cur = json!({});
        let upd = json!({ "score": { "$set": 42 } });
        let result = deep_merge_updates(&cur, &upd, &empty_registry()).unwrap();
        assert_eq!(result["score"], json!(42));
    }
}
