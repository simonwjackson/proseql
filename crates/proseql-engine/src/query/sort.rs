//! Sort pipeline — ports `sortData` from
//! `packages/core/src/operations/query/sort.ts`.
//!
//! # JS comparator semantics (from TS source)
//!
//! For each sort field (applied in declaration order):
//! - `null` or `undefined` (absent in JSON) → always sort to the **end**
//!   regardless of direction.
//! - Two null/undefined values → equal (continue to next field).
//! - `string` vs `string` → `localeCompare` (JS semantics).  A registered
//!   collation callback is used when available; bytewise ASCII fallback otherwise.
//! - `number` vs `number` → `a - b`.
//! - `boolean` vs `boolean` → `(a ? 1 : 0) - (b ? 1 : 0)` (false < true).
//! - Mixed types → convert both to `String()` and compare.
//!
//! # JS `String(value)` for arrays
//!
//! JS `String([1,2])` returns `"1,2"` — a recursive comma-join where null/undefined
//! slots produce empty string.  `String([object Object])` returns `"[object Object]"`.
//! This is the behaviour used for mixed-type sort comparisons.
//!
//! # Collation seam
//!
//! The `CallbackRegistry` optionally holds a `StringCollator` callback registered
//! by the host (U8 registers JS `localeCompare`; native consumers register their
//! chosen ICU comparator).  When present it controls string comparisons.  When
//! absent, bytewise ASCII ordering is used — this is a **documented fallback, not
//! parity**.
//!
//! If all compared fields are equal, original insertion order is preserved
//! (stable sort — Rust `sort_by` is stable).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::callbacks::CallbackRegistry;

use super::filter::get_nested_value;

/// Sort direction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortOrder {
    Asc,
    Desc,
}

impl SortOrder {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "asc" => Some(SortOrder::Asc),
            "desc" => Some(SortOrder::Desc),
            _ => None,
        }
    }
}

/// One sort entry: (dot-notation field path, direction).
pub type SortEntry = (String, SortOrder);

/// Sort `entities` by `sort_fields` in place (stable).
///
/// Uses bytewise string comparison (no registered collator).
/// For locale-aware sort, use [`sort_entities_with_registry`].
///
/// Mirrors `sortData` from `packages/core/src/operations/query/sort.ts`.
pub fn sort_entities(entities: &mut [Value], sort_fields: &[SortEntry]) {
    sort_entities_with_registry(entities, sort_fields, None);
}

/// Sort with an optional [`CallbackRegistry`] for registered collation.
///
/// When `registry` is `Some` and a string collator is registered, string
/// comparisons (and mixed-type coerced-string comparisons) go through the
/// collator.  When `None` or no collator is registered, bytewise ASCII
/// ordering is used as a fallback.
pub fn sort_entities_with_registry(
    entities: &mut [Value],
    sort_fields: &[SortEntry],
    registry: Option<&CallbackRegistry>,
) {
    if sort_fields.is_empty() {
        return;
    }
    entities.sort_by(|a, b| compare_entities(a, b, sort_fields, registry));
}

/// Compare two entities according to the sort field sequence.
///
/// TS source (`sort.ts`) returns hard-coded `1` / `-1` for null/absent without
/// applying the direction — nulls always sort to the **end** regardless of `asc`/`desc`.
fn compare_entities(
    a: &Value,
    b: &Value,
    sort_fields: &[SortEntry],
    registry: Option<&CallbackRegistry>,
) -> std::cmp::Ordering {
    for (field, order) in sort_fields {
        let av = get_nested_value(a, field);
        let bv = get_nested_value(b, field);

        let a_null = is_null_or_absent(av);
        let b_null = is_null_or_absent(bv);

        // Null/absent: always sort to end — direction is NOT applied here.
        // Mirrors TS:
        //   if (aValue === null) return 1;   // a after b
        //   if (bValue === null) return -1;  // a before b
        if a_null && b_null {
            continue;
        }
        if a_null {
            return std::cmp::Ordering::Greater; // a (null) goes after b regardless of order
        }
        if b_null {
            return std::cmp::Ordering::Less; // b (null) goes after a regardless of order
        }

        // Both values are present: compare and apply direction.
        let cmp = compare_non_null_values(av.unwrap(), bv.unwrap(), registry);
        if cmp != std::cmp::Ordering::Equal {
            return if *order == SortOrder::Desc {
                cmp.reverse()
            } else {
                cmp
            };
        }
    }
    std::cmp::Ordering::Equal
}

/// Compare two non-null values (both already confirmed non-null/non-absent).
///
/// String vs string goes through the registered collator when available, or
/// bytewise ASCII ordering when not (documented fallback — not parity).
pub fn compare_non_null_values(
    av: &Value,
    bv: &Value,
    registry: Option<&CallbackRegistry>,
) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    // String vs String
    if let (Value::String(sa), Value::String(sb)) = (av, bv) {
        return compare_strings_via_registry(sa, sb, registry);
    }

    // Number vs Number: numeric
    if let (Some(na), Some(nb)) = (av.as_f64(), bv.as_f64()) {
        return na.partial_cmp(&nb).unwrap_or(Ordering::Equal);
    }

    // Boolean vs Boolean: false < true
    if let (Value::Bool(ba), Value::Bool(bb)) = (av, bv) {
        let ia = if *ba { 1i32 } else { 0i32 };
        let ib = if *bb { 1i32 } else { 0i32 };
        return ia.cmp(&ib);
    }

    // Mixed types: coerce to JS `String(value)` then compare.
    // Mirrors TS `String(aValue).localeCompare(String(bValue))`.
    let sa = value_to_js_string(av);
    let sb = value_to_js_string(bv);
    compare_strings_via_registry(&sa, &sb, registry)
}

/// Compare two strings using the registered collator or bytewise fallback.
fn compare_strings_via_registry(
    a: &str,
    b: &str,
    registry: Option<&CallbackRegistry>,
) -> std::cmp::Ordering {
    match registry.and_then(|r| r.collate_strings(a, b)) {
        Some(ord) => ord,
        // Bytewise fallback — NOT locale parity.  Register a collator via
        // `CallbackRegistry::register_collator` to get locale-aware behaviour.
        None => a.cmp(b),
    }
}

/// Is the value null/absent?
fn is_null_or_absent(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

/// Convert a value to its JavaScript `String(value)` representation.
///
/// This is used for mixed-type sort comparisons and cursor key extraction.
///
/// Key JS behaviours reproduced here:
/// - `String([1,2])` → `"1,2"` (recursive comma-join; null/undefined slots → `""`)
/// - `String({})` → `"[object Object]"`
/// - `String(null)` → `"null"`
/// - `String(true)` → `"true"`, `String(false)` → `"false"`
/// - Numbers: `String(1)` → `"1"`, `String(1.5)` → `"1.5"`
pub fn value_to_js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        Value::Array(arr) => {
            // JS: String([1,2]) === "1,2"
            // Null and absent (undefined) slots produce empty string in JS.
            arr.iter()
                .map(|elem| match elem {
                    Value::Null => String::new(), // null/undefined slot → ""
                    _ => value_to_js_string(elem),
                })
                .collect::<Vec<_>>()
                .join(",")
        }
        Value::Object(_) => "[object Object]".to_string(),
    }
}

// ── Unit tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn ids(entities: &[Value]) -> Vec<&str> {
        entities.iter().filter_map(|e| e["id"].as_str()).collect()
    }

    fn sort(mut data: Vec<Value>, field: &str, order: &str) -> Vec<Value> {
        sort_entities(
            &mut data,
            &[(field.to_string(), SortOrder::parse(order).unwrap())],
        );
        data
    }

    // ── String sort ──────────────────────────────────────────────────────────

    #[test]
    fn string_asc() {
        let mut data = vec![
            json!({"id": "b", "name": "Charlie"}),
            json!({"id": "a", "name": "Alice"}),
            json!({"id": "c", "name": "Bob"}),
        ];
        sort_entities(&mut data, &[("name".to_string(), SortOrder::Asc)]);
        assert_eq!(ids(&data), ["a", "c", "b"]); // Alice, Bob, Charlie
    }

    #[test]
    fn string_desc() {
        let result = sort(
            vec![
                json!({"id": "a", "name": "Alice"}),
                json!({"id": "b", "name": "Charlie"}),
                json!({"id": "c", "name": "Bob"}),
            ],
            "name",
            "desc",
        );
        assert_eq!(ids(&result), ["b", "c", "a"]); // Charlie, Bob, Alice
    }

    // ── Number sort ──────────────────────────────────────────────────────────

    #[test]
    fn number_asc() {
        let result = sort(
            vec![
                json!({"id": "a", "age": 30}),
                json!({"id": "b", "age": 25}),
                json!({"id": "c", "age": 35}),
            ],
            "age",
            "asc",
        );
        assert_eq!(ids(&result), ["b", "a", "c"]);
    }

    #[test]
    fn number_desc() {
        let result = sort(
            vec![
                json!({"id": "a", "age": 30}),
                json!({"id": "b", "age": 25}),
                json!({"id": "c", "age": 35}),
            ],
            "age",
            "desc",
        );
        assert_eq!(ids(&result), ["c", "a", "b"]);
    }

    // ── Null / absent sort to end ─────────────────────────────────────────────

    #[test]
    fn null_sorts_to_end_asc() {
        let result = sort(
            vec![
                json!({"id": "a", "score": null}),
                json!({"id": "b", "score": 80}),
                json!({"id": "c", "score": 90}),
            ],
            "score",
            "asc",
        );
        assert_eq!(ids(&result), ["b", "c", "a"]);
    }

    #[test]
    fn absent_field_sorts_to_end_asc() {
        let result = sort(
            vec![
                json!({"id": "a"}),
                json!({"id": "b", "score": 80}),
                json!({"id": "c", "score": 90}),
            ],
            "score",
            "asc",
        );
        assert_eq!(ids(&result), ["b", "c", "a"]);
    }

    #[test]
    fn null_sorts_to_end_desc() {
        let result = sort(
            vec![
                json!({"id": "a", "score": null}),
                json!({"id": "b", "score": 90}),
                json!({"id": "c", "score": 80}),
            ],
            "score",
            "desc",
        );
        assert_eq!(ids(&result), ["b", "c", "a"]);
    }

    // ── Boolean sort ──────────────────────────────────────────────────────────

    #[test]
    fn boolean_asc_false_before_true() {
        let result = sort(
            vec![
                json!({"id": "a", "active": true}),
                json!({"id": "b", "active": false}),
                json!({"id": "c", "active": true}),
            ],
            "active",
            "asc",
        );
        assert_eq!(ids(&result), ["b", "a", "c"]);
    }

    // ── Multi-field sort ──────────────────────────────────────────────────────

    #[test]
    fn multi_field_sort() {
        let mut data = vec![
            json!({"id": "a", "cat": "electronics", "price": 100}),
            json!({"id": "b", "cat": "books", "price": 50}),
            json!({"id": "c", "cat": "electronics", "price": 50}),
            json!({"id": "d", "cat": "books", "price": 100}),
        ];
        sort_entities(
            &mut data,
            &[
                ("cat".to_string(), SortOrder::Asc),
                ("price".to_string(), SortOrder::Asc),
            ],
        );
        assert_eq!(ids(&data), ["b", "d", "c", "a"]);
    }

    // ── Nested field sort ─────────────────────────────────────────────────────

    #[test]
    fn nested_field_sort() {
        let result = sort(
            vec![
                json!({"id": "a", "meta": {"views": 300}}),
                json!({"id": "b", "meta": {"views": 100}}),
                json!({"id": "c", "meta": {"views": 200}}),
            ],
            "meta.views",
            "asc",
        );
        assert_eq!(ids(&result), ["b", "c", "a"]);
    }

    // ── Stable sort ───────────────────────────────────────────────────────────

    #[test]
    fn equal_values_preserve_insertion_order() {
        let mut data = vec![
            json!({"id": "first", "score": 50}),
            json!({"id": "second", "score": 50}),
            json!({"id": "third", "score": 50}),
        ];
        sort_entities(&mut data, &[("score".to_string(), SortOrder::Asc)]);
        assert_eq!(ids(&data), ["first", "second", "third"]);
    }

    // ── JS String(value) for mixed-type sort ──────────────────────────────────
    // These verify that array-to-string coercion matches JS `String([...])`.

    #[test]
    fn value_to_js_string_array_comma_join() {
        // JS: String([1,2,3]) === "1,2,3"
        assert_eq!(value_to_js_string(&json!([1, 2, 3])), "1,2,3");
    }

    #[test]
    fn value_to_js_string_nested_array() {
        // JS: String([[1,2],3]) === "1,2,3"
        assert_eq!(value_to_js_string(&json!([[1, 2], 3])), "1,2,3");
    }

    #[test]
    fn value_to_js_string_array_with_null_slot() {
        // JS: String([1,null,3]) === "1,,3" — null → ""
        assert_eq!(value_to_js_string(&json!([1, null, 3])), "1,,3");
    }

    #[test]
    fn value_to_js_string_empty_array() {
        // JS: String([]) === ""
        assert_eq!(value_to_js_string(&json!([])), "");
    }

    #[test]
    fn value_to_js_string_single_element_array() {
        // JS: String([42]) === "42"
        assert_eq!(value_to_js_string(&json!([42])), "42");
    }

    #[test]
    fn value_to_js_string_object() {
        // JS: String({}) === "[object Object]"
        assert_eq!(value_to_js_string(&json!({"x": 1})), "[object Object]");
    }

    #[test]
    fn mixed_type_sort_array_before_object_by_string_coercion() {
        // [1,2] → "1,2"; {} → "[object Object]"
        // "1,2" < "[object Object]" bytewise ('1' < '[')
        // So arrays with numeric string repr come before objects.
        let mut data = vec![
            json!({"id": "obj", "val": {"x": 1}}),
            json!({"id": "arr", "val": [1, 2]}),
        ];
        sort_entities(&mut data, &[("val".to_string(), SortOrder::Asc)]);
        assert_eq!(ids(&data), ["arr", "obj"]);
    }

    // ── Collation seam ────────────────────────────────────────────────────────

    #[test]
    fn registered_collator_controls_string_sort() {
        // Register a reverse-alphabet collator: z < a for this test.
        let mut registry = CallbackRegistry::new();
        registry.register_collator(Box::new(|a: &str, b: &str| {
            // Reverse the natural order
            b.cmp(a)
        }));

        let mut data = vec![
            json!({"id": "a", "name": "Alpha"}),
            json!({"id": "b", "name": "Zeta"}),
            json!({"id": "c", "name": "Gamma"}),
        ];
        sort_entities_with_registry(
            &mut data,
            &[("name".to_string(), SortOrder::Asc)],
            Some(&registry),
        );
        // With reverse collator, ascending puts Z first
        assert_eq!(ids(&data), ["b", "c", "a"]); // Zeta, Gamma, Alpha
    }

    #[test]
    fn no_registered_collator_uses_bytewise_fallback() {
        // Without collator: standard bytewise cmp
        let mut data = vec![
            json!({"id": "a", "name": "Zeta"}),
            json!({"id": "b", "name": "Alpha"}),
        ];
        sort_entities_with_registry(&mut data, &[("name".to_string(), SortOrder::Asc)], None);
        assert_eq!(ids(&data), ["b", "a"]); // Alpha, Zeta
    }

    #[test]
    fn registered_collator_controls_mixed_type_sort_via_string_coercion() {
        // Mixed sort where coercion lands both into strings: collator is consulted.
        let mut registry = CallbackRegistry::new();
        // Collator that reverses the comparison
        registry.register_collator(Box::new(|a: &str, b: &str| b.cmp(a)));

        // numbers sort normally (collator only used for string branch)
        // arrays → "1,2" vs "3,4" — both coerced to string, collator called
        let mut data = vec![
            json!({"id": "x", "v": [1, 2]}),
            json!({"id": "y", "v": [3, 4]}),
        ];
        sort_entities_with_registry(
            &mut data,
            &[("v".to_string(), SortOrder::Asc)],
            Some(&registry),
        );
        // With reverse collator: "3,4" < "1,2" so y comes first
        assert_eq!(ids(&data), ["y", "x"]);
    }
}
