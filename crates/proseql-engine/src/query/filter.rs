//! Filter evaluation — ports `matchesFilter` and `filterData` from
//! `packages/core/src/types/operators.ts` and `operations/query/filter.ts`.
//!
//! # Operator coverage
//!
//! | Operator       | Types      | TS source                                        |
//! |----------------|-----------|--------------------------------------------------|
//! | `$eq`          | all       | `value === operand`                              |
//! | `$ne`          | all       | `value !== operand`                              |
//! | `$in`          | all       | `operand.includes(value)`                        |
//! | `$nin`         | all       | `!operand.includes(value)`                       |
//! | `$gt`          | num/str   | `value > operand`                                |
//! | `$gte`         | num/str   | `value >= operand`                               |
//! | `$lt`          | num/str   | `value < operand`                                |
//! | `$lte`         | num/str   | `value <= operand`                               |
//! | `$startsWith`  | string    | `value.startsWith(operand)`                      |
//! | `$endsWith`    | string    | `value.endsWith(operand)`                        |
//! | `$contains`    | string    | `value.includes(operand)`                        |
//! | `$contains`    | array     | `value.includes(operand)` (element membership)   |
//! | `$all`         | array     | every element in operand is in value             |
//! | `$size`        | array     | `value.length === operand`                       |
//! | `$search`      | string    | tokenized full-text prefix match                 |
//! | `$or`          | logical   | at least one sub-condition matches               |
//! | `$and`         | logical   | all sub-conditions match (vacuously true for []) |
//! | `$not`         | logical   | sub-condition does NOT match                     |
//! | `$search`      | top-level | multi-field tokenized search (`SearchConfig`)    |
//!
//! # Missing-field semantics (TS parity)
//! - `$eq: undefined` on a missing field → matches (field missing = undefined)
//! - `$ne: undefined` on a missing field → no match
//! - Operator objects on a missing field with other operators → no match
//! - Direct value (non-undefined) on a missing field → no match

use serde_json::Value;

use super::search::tokenize;
use crate::callbacks::{CallbackRegistry, CustomOperatorEvaluation};
use crate::validator::js_eq;

// ── Dot-notation helpers ─────────────────────────────────────────────────────────────

/// Resolve a dot-notation path (e.g. `"metadata.author.country"`) into a
/// `Value` reference by traversing nested objects.
///
/// Returns `None` if any segment is missing or a non-object is encountered
/// mid-path.
///
/// Mirrors `getNestedValue` from
/// `packages/core/src/utils/nested-path.ts`.
pub fn get_nested_value<'a>(entity: &'a Value, path: &str) -> Option<&'a Value> {
    if !path.contains('.') {
        return entity.get(path);
    }
    let mut current = entity;
    for part in path.split('.') {
        current = current.get(part)?;
    }
    Some(current)
}

/// Recursively collect all dot-notation paths whose leaf value is a JSON string.
///
/// Mirrors `collectStringPaths` from
/// `packages/core/src/utils/nested-path.ts`, used by the top-level `$search`
/// operator when no explicit `fields` are given.
///
/// # Example
/// Entity `{"title": "Dune", "meta": {"desc": "Classic"}, "year": 1965}`
/// → `["title", "meta.desc"]`
pub fn collect_string_paths(entity: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    collect_string_paths_rec(entity, "", &mut paths);
    paths
}

fn collect_string_paths_rec(value: &Value, prefix: &str, paths: &mut Vec<String>) {
    match value {
        Value::String(_) => {
            if !prefix.is_empty() {
                paths.push(prefix.to_string());
            }
        }
        Value::Object(m) => {
            for (key, child) in m {
                let next = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                collect_string_paths_rec(child, &next, paths);
            }
        }
        // Arrays and non-string primitives are not string paths.
        _ => {}
    }
}

/// Return `true` if `entity` matches the given `where` clause.
///
/// The `where` clause is a JSON object; each key is either a field name or a
/// logical/top-level operator (`$or`, `$and`, `$not`, `$search`).
///
/// Mirrors `filterData` from `packages/core/src/operations/query/filter.ts`.
pub fn matches_where(entity: &Value, where_clause: &Value) -> bool {
    matches_where_with_registry(entity, where_clause, None)
}

pub fn matches_where_with_registry(
    entity: &Value,
    where_clause: &Value,
    registry: Option<&CallbackRegistry>,
) -> bool {
    let where_obj = match where_clause.as_object() {
        Some(m) => m,
        None => return true, // null/non-object where → include all
    };
    if where_obj.is_empty() {
        return true;
    }

    for (key, value) in where_obj {
        match key.as_str() {
            "$or" => {
                // Array of sub-conditions; at least one must match.
                // Empty array → false (no conditions to satisfy)
                let arr = match value.as_array() {
                    Some(a) => a,
                    None => return false,
                };
                if arr.is_empty() {
                    return false;
                }
                if !arr
                    .iter()
                    .any(|cond| matches_where_with_registry(entity, cond, registry))
                {
                    return false;
                }
            }
            "$and" => {
                // Array of sub-conditions; all must match.
                // Empty array → true (vacuous truth)
                let arr = match value.as_array() {
                    Some(a) => a,
                    None => return false,
                };
                if !arr
                    .iter()
                    .all(|cond| matches_where_with_registry(entity, cond, registry))
                {
                    return false;
                }
            }
            "$not" => {
                // Sub-condition must NOT match.
                if matches_where_with_registry(entity, value, registry) {
                    return false;
                }
            }
            "$search" => {
                // Top-level multi-field search: value is a SearchConfig object.
                //
                // Mirrors the `$search` branch in `filterData`:
                // ```ts
                // const searchConfig = value as SearchConfig;
                // const query = searchConfig.query;
                // const queryTokens = tokenize(query);
                // // All query tokens must be found in at least one target field
                // ```
                let obj = match value.as_object() {
                    Some(m) => m,
                    None => return false,
                };
                let query = match obj.get("query").and_then(|v| v.as_str()) {
                    Some(q) => q,
                    None => return false,
                };
                // Empty query matches everything
                if query.trim().is_empty() {
                    continue;
                }
                let query_tokens = tokenize(query);
                if query_tokens.is_empty() {
                    continue;
                }
                // Check entity is an object (needed for fallback string path collection)
                if entity.as_object().is_none() {
                    return false;
                }
                let explicit_fields: Vec<String> = obj
                    .get("fields")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                let target_fields: Vec<String> = if !explicit_fields.is_empty() {
                    explicit_fields
                } else {
                    // Use collectStringPaths (recursive) to match filter-stream.ts
                    // which uses collectStringPaths for field discovery.
                    collect_string_paths(entity)
                };
                // All query tokens must match in at least one target field (exact or prefix)
                let all_tokens_match = query_tokens.iter().all(|qt| {
                    target_fields.iter().any(|field| {
                        // Support dot-notation paths in target fields
                        let fv = get_nested_value(entity, field);
                        if let Some(Value::String(s)) = fv {
                            let field_tokens = tokenize(s);
                            field_tokens
                                .iter()
                                .any(|ft| ft == qt || ft.starts_with(qt.as_str()))
                        } else {
                            false
                        }
                    })
                });
                if !all_tokens_match {
                    return false;
                }
            }
            field_key => {
                // Support dot-notation paths (e.g. "metadata.author.country").
                //
                // Mirrors `isDotPath` + `getNestedValue` fallback in filter-stream.ts:
                // ```ts
                // } else if (isDotPath(key)) {
                //   const resolvedValue = getNestedValue(item, key);
                //   if (!matchesFilter(resolvedValue, value)) return false;
                // }
                // ```
                let field_value = if field_key.contains('.') {
                    get_nested_value(entity, field_key)
                } else {
                    entity.as_object().and_then(|m| m.get(field_key))
                };

                match field_value {
                    Some(fv) => {
                        if !matches_field_filter(fv, value, registry) {
                            return false;
                        }
                    }
                    None => {
                        // Field does not exist in the entity.
                        // TS: `if (value !== undefined) { shouldInclude = false; break; }`
                        // BUT: operator objects with $eq: undefined OR direct-undefined pass.
                        if !missing_field_matches(value) {
                            return false;
                        }
                    }
                }
            }
        }
    }
    true
}

/// Check whether a filter value matches when the entity field is absent.
///
/// Mirrors the "else" branch in `filterData` for missing fields:
/// ```ts
/// if ("$eq" in ops && ops.$eq === undefined) {
///   continue; // matches
/// } else if ("$ne" in ops && ops.$ne === undefined) {
///   shouldInclude = false; break; // no match
/// }
/// // Any other operator on missing field → no match
/// // Direct value === undefined → match; anything else → no match
/// ```
fn missing_field_matches(filter: &Value) -> bool {
    match filter {
        Value::Null => false, // null ≠ undefined in JS
        Value::Object(ops) => {
            // $eq: undefined → matches (field missing = undefined)
            // Direct None representation: JSON can't express undefined, but we
            // treat absent $eq key differently.
            // In practice, $eq: null does NOT match a missing field (null ≠ undefined).
            // Only $eq with explicit undefined (which can't be JSON-serialized) would.
            // The TS check is: `ops.$eq === undefined` meaning the key exists but has undefined.
            // In JSON/Rust, we can't distinguish "key absent" from "$eq: null" at this level.
            // Conservative: any operator object on a missing field → no match.
            let _ = ops;
            false
        }
        // Direct value equality check on a missing field.
        // In TS: `if (value !== undefined) { shouldInclude = false; }` — undefined can't be JSON.
        _ => false,
    }
}

/// Match a single field value against a filter expression.
///
/// The filter can be:
/// - A plain value → direct equality (`===`)
/// - An operator object → evaluate all operators (AND semantics)
/// - An object without operators → nested shape-mirroring (sub-field filters)
///
/// Mirrors `matchesFilter` from `packages/core/src/types/operators.ts`.
pub fn matches_field_filter(
    value: &Value,
    filter: &Value,
    registry: Option<&CallbackRegistry>,
) -> bool {
    // Check if filter is an operator object
    if let Some(ops) = filter.as_object() {
        let has_operators = ops.keys().any(|k| {
            k.starts_with('$')
                && (is_builtin_operator(k) || registry.is_some_and(|r| r.has_custom_operator(k)))
        });

        if has_operators {
            return evaluate_operators(value, ops, registry);
        }

        // No operator keys → nested shape-mirroring.
        // Only valid when the field value is also an object.
        if let Value::Object(value_obj) = value {
            // Build a WhereClause-like value and recurse
            let entity_as_top = Value::Object(value_obj.clone());
            return matches_where_with_registry(&entity_as_top, filter, registry);
        }

        // Non-object value with a non-operator object filter → no match
        return false;
    }

    // Direct value: use JS === semantics
    js_eq(value, filter)
}

fn is_builtin_operator(key: &str) -> bool {
    matches!(
        key,
        "$eq"
            | "$ne"
            | "$in"
            | "$nin"
            | "$gt"
            | "$gte"
            | "$lt"
            | "$lte"
            | "$startsWith"
            | "$endsWith"
            | "$contains"
            | "$all"
            | "$size"
            | "$search"
    )
}

/// Evaluate all operators in an operator object against `value`.
///
/// All specified operators must match (AND semantics).
/// Operators that are type-incompatible with `value` cause a false result.
///
/// Mirrors the `matchesFilter` body for `isFilterOperatorObject(filter) === true`.
fn evaluate_operators(
    value: &Value,
    ops: &serde_json::Map<String, Value>,
    registry: Option<&CallbackRegistry>,
) -> bool {
    let mut results: Vec<bool> = Vec::new();

    // ── Universal operators ────────────────────────────────────────────────────
    if let Some(operand) = ops.get("$eq") {
        results.push(js_eq(value, operand));
    }
    if let Some(operand) = ops.get("$ne") {
        results.push(!js_eq(value, operand));
    }
    if let Some(operand) = ops.get("$in") {
        match operand.as_array() {
            Some(arr) => results.push(arr.iter().any(|el| js_eq(value, el))),
            None => results.push(false),
        }
    }
    if let Some(operand) = ops.get("$nin") {
        match operand.as_array() {
            Some(arr) => results.push(!arr.iter().any(|el| js_eq(value, el))),
            None => results.push(false),
        }
    }

    // ── String operators ───────────────────────────────────────────────────────
    if let Value::String(s) = value {
        if let Some(operand) = ops.get("$startsWith") {
            match operand.as_str() {
                Some(prefix) => results.push(s.starts_with(prefix)),
                None => results.push(false),
            }
        }
        if let Some(operand) = ops.get("$endsWith") {
            match operand.as_str() {
                Some(suffix) => results.push(s.ends_with(suffix)),
                None => results.push(false),
            }
        }
        if let Some(operand) = ops.get("$contains") {
            match operand.as_str() {
                Some(needle) => results.push(s.contains(needle)),
                None => results.push(false),
            }
        }
        if let Some(operand) = ops.get("$search") {
            match operand.as_str() {
                Some("") => results.push(true), // empty string matches everything
                Some(query) => {
                    let query_tokens = tokenize(query);
                    if query_tokens.is_empty() {
                        results.push(true);
                    } else {
                        let field_tokens = tokenize(s);
                        let all_match = query_tokens.iter().all(|qt| {
                            field_tokens
                                .iter()
                                .any(|ft| ft == qt || ft.starts_with(qt.as_str()))
                        });
                        results.push(all_match);
                    }
                }
                None => results.push(false),
            }
        }
        // Comparison operators on strings (for ISO date strings etc.)
        if let Some(operand) = ops.get("$gt") {
            if let Some(op_str) = operand.as_str() {
                results.push(s.as_str() > op_str);
            }
        }
        if let Some(operand) = ops.get("$gte") {
            if let Some(op_str) = operand.as_str() {
                results.push(s.as_str() >= op_str);
            }
        }
        if let Some(operand) = ops.get("$lt") {
            if let Some(op_str) = operand.as_str() {
                results.push(s.as_str() < op_str);
            }
        }
        if let Some(operand) = ops.get("$lte") {
            if let Some(op_str) = operand.as_str() {
                results.push(s.as_str() <= op_str);
            }
        }
    } else if matches!(value, Value::Null) || matches!(value, Value::Bool(_)) {
        // Non-string values: string operators fail
        if ops.contains_key("$startsWith")
            || ops.contains_key("$endsWith")
            || ops.contains_key("$contains")
            || ops.contains_key("$search")
        {
            return false;
        }
        // Comparison operators on non-number/non-string: fail
        if ops.contains_key("$gt")
            || ops.contains_key("$gte")
            || ops.contains_key("$lt")
            || ops.contains_key("$lte")
        {
            return false;
        }
    }

    // ── Number operators ───────────────────────────────────────────────────────
    if let Some(n) = value.as_f64() {
        if let Some(operand) = ops.get("$gt") {
            if let Some(op) = operand.as_f64() {
                results.push(n > op);
            }
        }
        if let Some(operand) = ops.get("$gte") {
            if let Some(op) = operand.as_f64() {
                results.push(n >= op);
            }
        }
        if let Some(operand) = ops.get("$lt") {
            if let Some(op) = operand.as_f64() {
                results.push(n < op);
            }
        }
        if let Some(operand) = ops.get("$lte") {
            if let Some(op) = operand.as_f64() {
                results.push(n <= op);
            }
        }
    } else if !matches!(value, Value::String(_)) {
        // Non-number, non-string value with numeric comparison operators → fail
        if ops.contains_key("$gt")
            || ops.contains_key("$gte")
            || ops.contains_key("$lt")
            || ops.contains_key("$lte")
        {
            return false;
        }
    }

    // ── Array operators ────────────────────────────────────────────────────────
    if let Value::Array(arr) = value {
        if let Some(operand) = ops.get("$contains") {
            // For arrays: $contains checks element membership
            results.push(arr.iter().any(|el| js_eq(el, operand)));
        }
        if let Some(operand) = ops.get("$all") {
            match operand.as_array() {
                Some(required) => {
                    let all_present = required
                        .iter()
                        .all(|req| arr.iter().any(|el| js_eq(el, req)));
                    results.push(all_present);
                }
                None => results.push(false),
            }
        }
        if let Some(operand) = ops.get("$size") {
            if let Some(size) = operand.as_u64() {
                results.push(arr.len() as u64 == size);
            } else {
                results.push(false);
            }
        }
    } else if matches!(value, Value::Null) {
        // null value with array operators → fail
        if ops.contains_key("$contains") || ops.contains_key("$all") || ops.contains_key("$size") {
            return false;
        }
    }

    if let Some(registry) = registry {
        for (key, operand) in ops {
            if !key.starts_with('$') || is_builtin_operator(key) {
                continue;
            }
            match registry.evaluate_custom_operator(key, value, operand) {
                CustomOperatorEvaluation::Unknown | CustomOperatorEvaluation::Ignored => {}
                CustomOperatorEvaluation::Matched(result) => results.push(result),
            }
        }
    }

    // All specified operators must match (AND)
    if results.is_empty() {
        true // filter object with only unrecognised keys → treat as match (safe default)
    } else {
        results.iter().all(|r| *r)
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn entity(v: serde_json::Value) -> Value {
        v
    }

    // ── $eq / $ne ─────────────────────────────────────────────────────────────

    #[test]
    fn eq_string_matches() {
        let e = entity(json!({"name": "Alice"}));
        assert!(matches_where(&e, &json!({"name": "Alice"})));
    }

    #[test]
    fn eq_string_no_match() {
        let e = entity(json!({"name": "Alice"}));
        assert!(!matches_where(&e, &json!({"name": "Bob"})));
    }

    #[test]
    fn ne_excludes_matching_value() {
        let e = entity(json!({"name": "Alice"}));
        assert!(!matches_where(&e, &json!({"name": {"$ne": "Alice"}})));
    }

    #[test]
    fn ne_passes_different_value() {
        let e = entity(json!({"name": "Bob"}));
        assert!(matches_where(&e, &json!({"name": {"$ne": "Alice"}})));
    }

    // ── $in / $nin ────────────────────────────────────────────────────────────

    #[test]
    fn in_matches_member() {
        let e = entity(json!({"cat": "electronics"}));
        assert!(matches_where(
            &e,
            &json!({"cat": {"$in": ["electronics", "books"]}})
        ));
    }

    #[test]
    fn nin_excludes_member() {
        let e = entity(json!({"cat": "electronics"}));
        assert!(!matches_where(
            &e,
            &json!({"cat": {"$nin": ["electronics", "books"]}})
        ));
    }

    // ── $gt / $gte / $lt / $lte (numbers) ────────────────────────────────────

    #[test]
    fn gt_number() {
        let e = entity(json!({"price": 100}));
        assert!(matches_where(&e, &json!({"price": {"$gt": 50}})));
        assert!(!matches_where(&e, &json!({"price": {"$gt": 100}})));
    }

    #[test]
    fn gte_number() {
        let e = entity(json!({"price": 100}));
        assert!(matches_where(&e, &json!({"price": {"$gte": 100}})));
    }

    #[test]
    fn lt_number() {
        let e = entity(json!({"age": 20}));
        assert!(matches_where(&e, &json!({"age": {"$lt": 30}})));
    }

    // ── $startsWith / $endsWith / $contains (string) ──────────────────────────

    #[test]
    fn starts_with() {
        let e = entity(json!({"name": "Alice Johnson"}));
        assert!(matches_where(
            &e,
            &json!({"name": {"$startsWith": "Alice"}})
        ));
        assert!(!matches_where(&e, &json!({"name": {"$startsWith": "Bob"}})));
    }

    #[test]
    fn ends_with() {
        let e = entity(json!({"email": "user@example.com"}));
        assert!(matches_where(
            &e,
            &json!({"email": {"$endsWith": "@example.com"}})
        ));
    }

    #[test]
    fn contains_string() {
        let e = entity(json!({"desc": "A high-end laptop"}));
        assert!(matches_where(
            &e,
            &json!({"desc": {"$contains": "high-end"}})
        ));
    }

    // ── $contains / $all / $size (arrays) ─────────────────────────────────────

    #[test]
    fn array_contains() {
        let e = entity(json!({"tags": ["tech", "computer"]}));
        assert!(matches_where(&e, &json!({"tags": {"$contains": "tech"}})));
        assert!(!matches_where(
            &e,
            &json!({"tags": {"$contains": "gaming"}})
        ));
    }

    #[test]
    fn array_all() {
        let e = entity(json!({"tags": ["tech", "computer", "portable"]}));
        assert!(matches_where(
            &e,
            &json!({"tags": {"$all": ["tech", "portable"]}})
        ));
        assert!(!matches_where(
            &e,
            &json!({"tags": {"$all": ["tech", "gaming"]}})
        ));
    }

    #[test]
    fn array_size() {
        let e = entity(json!({"tags": ["a", "b", "c"]}));
        assert!(matches_where(&e, &json!({"tags": {"$size": 3}})));
        assert!(!matches_where(&e, &json!({"tags": {"$size": 2}})));
    }

    // ── $search (field-level) ─────────────────────────────────────────────────

    #[test]
    fn field_search_exact_token() {
        let e = entity(json!({"title": "Dune"}));
        assert!(matches_where(&e, &json!({"title": {"$search": "dune"}})));
    }

    #[test]
    fn field_search_prefix_match() {
        let e = entity(json!({"title": "Neuromancer"}));
        assert!(matches_where(&e, &json!({"title": {"$search": "neuro"}})));
    }

    #[test]
    fn field_search_empty_string_matches_all() {
        let e = entity(json!({"title": "Anything"}));
        assert!(matches_where(&e, &json!({"title": {"$search": ""}})));
    }

    // ── Top-level $search ──────────────────────────────────────────────────────

    #[test]
    fn top_level_search_multi_field() {
        let e = entity(json!({"title": "Dune", "author": "Frank Herbert", "year": 1965}));
        assert!(matches_where(
            &e,
            &json!({"$search": {"query": "dune", "fields": ["title", "author"]}})
        ));
        // Token present in second field
        assert!(matches_where(
            &e,
            &json!({"$search": {"query": "frank", "fields": ["title", "author"]}})
        ));
        // Token not in any field
        assert!(!matches_where(
            &e,
            &json!({"$search": {"query": "xyz", "fields": ["title", "author"]}})
        ));
    }

    #[test]
    fn top_level_search_all_string_fields_when_no_fields_specified() {
        let e = entity(json!({"title": "Dune", "year": 1965}));
        assert!(matches_where(&e, &json!({"$search": {"query": "dune"}})));
    }

    // ── $or / $and / $not ─────────────────────────────────────────────────────

    #[test]
    fn or_passes_on_first_match() {
        let e = entity(json!({"cat": "electronics", "price": 100}));
        assert!(matches_where(
            &e,
            &json!({"$or": [{"cat": "electronics"}, {"price": 999}]})
        ));
    }

    #[test]
    fn or_fails_when_none_match() {
        let e = entity(json!({"cat": "electronics", "price": 100}));
        assert!(!matches_where(
            &e,
            &json!({"$or": [{"cat": "books"}, {"price": 999}]})
        ));
    }

    #[test]
    fn or_empty_array_returns_false() {
        let e = entity(json!({"x": 1}));
        assert!(!matches_where(&e, &json!({"$or": []})));
    }

    #[test]
    fn and_all_must_match() {
        let e = entity(json!({"price": 100, "inStock": true}));
        assert!(matches_where(
            &e,
            &json!({"$and": [{"price": {"$gte": 50}}, {"inStock": true}]})
        ));
        assert!(!matches_where(
            &e,
            &json!({"$and": [{"price": {"$gte": 50}}, {"inStock": false}]})
        ));
    }

    #[test]
    fn and_empty_array_is_vacuously_true() {
        let e = entity(json!({"x": 1}));
        assert!(matches_where(&e, &json!({"$and": []})));
    }

    #[test]
    fn not_inverts_condition() {
        let e = entity(json!({"cat": "electronics"}));
        assert!(matches_where(&e, &json!({"$not": {"cat": "books"}})));
        assert!(!matches_where(&e, &json!({"$not": {"cat": "electronics"}})));
    }

    // ── Nested shape-mirroring ─────────────────────────────────────────────────

    #[test]
    fn nested_object_filter_depth1() {
        let e = entity(json!({"metadata": {"views": 500, "rating": 4.5}}));
        assert!(matches_where(
            &e,
            &json!({"metadata": {"views": {"$gt": 100}}})
        ));
        assert!(!matches_where(
            &e,
            &json!({"metadata": {"views": {"$lt": 100}}})
        ));
    }

    #[test]
    fn nested_object_filter_depth2() {
        let e = entity(json!({"a": {"b": {"c": 42}}}));
        assert!(matches_where(&e, &json!({"a": {"b": {"c": 42}}})));
        assert!(!matches_where(&e, &json!({"a": {"b": {"c": 999}}})));
    }

    // ── Missing field semantics ────────────────────────────────────────────────

    #[test]
    fn missing_field_direct_value_no_match() {
        let e = entity(json!({"name": "Alice"}));
        // Field "age" not present, filter is a number value → no match
        assert!(!matches_where(&e, &json!({"age": 30})));
    }

    #[test]
    fn missing_field_with_operator_no_match() {
        let e = entity(json!({"name": "Alice"}));
        assert!(!matches_where(&e, &json!({"age": {"$gt": 0}})));
    }

    // ── Multiple conditions (AND implicit) ────────────────────────────────────

    #[test]
    fn multiple_fields_all_must_match() {
        let e = entity(json!({"name": "Alice", "age": 30, "active": true}));
        assert!(matches_where(
            &e,
            &json!({"name": "Alice", "age": {"$gte": 25}, "active": true})
        ));
        assert!(!matches_where(
            &e,
            &json!({"name": "Alice", "age": {"$gte": 31}})
        ));
    }

    // ── Comparison on strings ─────────────────────────────────────────────────

    #[test]
    fn string_gt_comparison() {
        let e = entity(json!({"createdAt": "2024-06-01"}));
        assert!(matches_where(
            &e,
            &json!({"createdAt": {"$gt": "2024-01-01"}})
        ));
        assert!(!matches_where(
            &e,
            &json!({"createdAt": {"$gt": "2024-12-31"}})
        ));
    }
}
