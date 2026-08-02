//! Field selection — ports `applyObjectSelect` / `applySelectToArray` from
//! `packages/core/src/operations/query/select-stream.ts`.
//!
//! # Selection forms
//!
//! Mirrors the active `select-stream.ts` behaviour exactly:
//!
//! | Input                     | Behaviour                                         |
//! |---------------------------|---------------------------------------------------|
//! | `None` / `Some(null)`     | No change — all fields included                   |
//! | `Some([])`  (empty array) | No change — all fields included                   |
//! | `Some({})` (empty object) | No change — all fields included                   |
//! | `Some(["f1","f2"])`       | Convert to `{f1:true,f2:true}` then apply         |
//! | `Some({"f": true, ...})`  | Include only listed fields                        |
//! | Nested: `{"f": {...}}`    | Nested selection on populated objects/arrays      |
//! | Dot-notation key          | Resolve via nested path; emit under literal key   |
//!
//! # Dot-notation
//!
//! A key containing `.` (e.g. `"meta.views"`) is resolved via `get_nested_value`
//! and emitted in the result under the literal key `"meta.views"`.
//!
//! Mirrors `isDotPath` + `getNestedValue` in `select-stream.ts`:
//! ```ts
//! if (isDotPath(key)) {
//!   if (value === true) {
//!     const nestedVal = getNestedValue(item, key);
//!     if (nestedVal !== undefined) result[key] = nestedVal;
//!   }
//!   continue;
//! }
//! ```

use serde_json::{Map, Value};

use super::filter::get_nested_value;

/// Apply a field selection to a single entity.
///
/// `selection` is:
/// - `None` or `Some(Null)` → entity unchanged
/// - `Some(Array([]))` → entity unchanged (empty array = all fields)
/// - `Some(Object({}))` → entity unchanged (empty object = all fields)
/// - `Some(Array([...]))` → convert to object form then apply
/// - `Some(Object({...}))` → object selection
///
/// When `selection` is `None`, the entity is returned unchanged.
pub fn apply_selection(entity: &Value, selection: Option<&Value>) -> Value {
    match selection {
        // No selection → unchanged
        None | Some(Value::Null) => entity.clone(),

        Some(Value::Array(arr)) => {
            if arr.is_empty() {
                // Empty array → unchanged (same as no selection)
                entity.clone()
            } else {
                // Convert array to object form: ["f1","f2"] → {f1: true, f2: true}
                let mut obj = Map::new();
                for item in arr {
                    if let Some(field) = item.as_str() {
                        obj.insert(field.to_string(), Value::Bool(true));
                    }
                }
                apply_object_selection(entity, &obj)
            }
        }

        Some(Value::Object(sel_map)) => {
            if sel_map.is_empty() {
                // Empty object → unchanged (same as no selection)
                entity.clone()
            } else {
                apply_object_selection(entity, sel_map)
            }
        }

        // Any other value (number, bool, string) → unchanged for safety
        Some(_) => entity.clone(),
    }
}

fn apply_object_selection(entity: &Value, sel: &Map<String, Value>) -> Value {
    let obj = match entity.as_object() {
        Some(m) => m,
        None => return Value::Object(Map::new()),
    };
    let mut result = Map::new();
    for (key, sel_value) in sel {
        // Dot-notation key: resolve via nested path, emit under literal key name.
        // Mirrors select-stream.ts:
        //   if (isDotPath(key)) { if (value === true) result[key] = getNestedValue(item, key); }
        if key.contains('.') {
            if sel_value == &Value::Bool(true) {
                if let Some(nested) = get_nested_value(entity, key) {
                    result.insert(key.clone(), nested.clone());
                }
            }
            // Dot-notation keys with non-true values are skipped (no nested sub-selection)
            continue;
        }

        match sel_value {
            Value::Bool(true) => {
                if let Some(v) = obj.get(key) {
                    result.insert(key.clone(), v.clone());
                }
            }
            Value::Object(nested_sel) => {
                if let Some(field_value) = obj.get(key) {
                    match field_value {
                        Value::Array(arr) => {
                            // TypeScript filters non-record array members before nested
                            // selection (`nestedData.filter(isRecord).map(...)`).
                            let selected: Vec<Value> = arr
                                .iter()
                                .filter(|element| element.is_object())
                                .map(|element| apply_object_selection(element, nested_sel))
                                .collect();
                            result.insert(key.clone(), Value::Array(selected));
                        }
                        Value::Object(_) => {
                            result.insert(
                                key.clone(),
                                apply_object_selection(field_value, nested_sel),
                            );
                        }
                        _ => {
                            // Non-object field with nested selection → skip
                        }
                    }
                }
            }
            // false or other value → exclude
            _ => {}
        }
    }
    Value::Object(result)
}

// ── Unit tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn no_selection_returns_unchanged() {
        let e = json!({"id": "1", "name": "Alice", "age": 30});
        assert_eq!(apply_selection(&e, None), e);
    }

    #[test]
    fn null_selection_returns_unchanged() {
        let e = json!({"id": "1", "name": "Alice"});
        assert_eq!(apply_selection(&e, Some(&Value::Null)), e);
    }

    #[test]
    fn empty_object_selection_returns_unchanged() {
        let e = json!({"id": "1", "name": "Alice"});
        assert_eq!(apply_selection(&e, Some(&json!({}))), e);
    }

    #[test]
    fn empty_array_selection_returns_unchanged() {
        let e = json!({"id": "1", "name": "Alice"});
        assert_eq!(apply_selection(&e, Some(&json!([]))), e);
    }

    #[test]
    fn array_selection_picks_named_fields() {
        let e = json!({"id": "1", "name": "Alice", "age": 30});
        let result = apply_selection(&e, Some(&json!(["id", "name"])));
        assert_eq!(result["id"], "1");
        assert_eq!(result["name"], "Alice");
        assert!(result.get("age").is_none());
    }

    #[test]
    fn select_single_field_excludes_others() {
        let e = json!({"id": "1", "name": "Alice", "age": 30});
        let sel = json!({"id": true});
        let result = apply_selection(&e, Some(&sel));
        assert_eq!(result, json!({"id": "1"}));
        assert!(result.get("name").is_none());
    }

    #[test]
    fn select_multiple_fields() {
        let e = json!({"id": "1", "name": "Alice", "age": 30});
        let sel = json!({"id": true, "name": true});
        let result = apply_selection(&e, Some(&sel));
        assert_eq!(result["id"], "1");
        assert_eq!(result["name"], "Alice");
        assert!(result.get("age").is_none());
    }

    #[test]
    fn false_value_excludes_field() {
        let e = json!({"id": "1", "name": "Alice"});
        let sel = json!({"id": true, "name": false});
        let result = apply_selection(&e, Some(&sel));
        assert_eq!(result, json!({"id": "1"}));
    }

    #[test]
    fn missing_field_silently_excluded() {
        let e = json!({"id": "1"});
        let sel = json!({"id": true, "nonexistent": true});
        let result = apply_selection(&e, Some(&sel));
        assert_eq!(result, json!({"id": "1"}));
    }

    #[test]
    fn nested_object_selection() {
        let e = json!({"id": "1", "metadata": {"views": 100, "rating": 4.5}});
        let sel = json!({"id": true, "metadata": {"views": true}});
        let result = apply_selection(&e, Some(&sel));
        assert_eq!(result, json!({"id": "1", "metadata": {"views": 100}}));
        assert!(result["metadata"].get("rating").is_none());
    }

    #[test]
    fn nested_array_of_objects_selection() {
        let e = json!({
            "id": "1",
            "tags": [{"name": "sci-fi", "count": 5}, {"name": "classic", "count": 3}]
        });
        let sel = json!({"id": true, "tags": {"name": true}});
        let result = apply_selection(&e, Some(&sel));
        assert_eq!(
            result,
            json!({"id": "1", "tags": [{"name": "sci-fi"}, {"name": "classic"}]})
        );
    }

    #[test]
    fn dot_notation_key_resolves_nested_value() {
        let e = json!({"id": "1", "metadata": {"views": 100, "rating": 4.5}});
        // Dot-notation key: resolve nested, emit under literal key
        let sel = json!({"id": true, "metadata.views": true});
        let result = apply_selection(&e, Some(&sel));
        assert_eq!(result["id"], "1");
        // Emitted under the literal key "metadata.views"
        assert_eq!(result["metadata.views"], 100);
        // Neither "metadata" object nor "metadata.rating" should be present
        assert!(result.get("metadata").is_none());
    }

    #[test]
    fn dot_notation_missing_path_skipped() {
        let e = json!({"id": "1"});
        let sel = json!({"id": true, "a.b.c": true});
        let result = apply_selection(&e, Some(&sel));
        assert_eq!(result["id"], "1");
        assert!(result.get("a.b.c").is_none());
    }
}
