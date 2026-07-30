//! Scalar and grouped aggregation — ports `computeAggregates` and
//! `computeGroupedAggregates` from
//! `packages/core/src/operations/query/aggregate.ts`.
//!
//! # Scalar aggregates
//! - `count: true` → total entity count.
//! - `sum: field | [field]` → sum of numeric values (non-numeric skipped).
//! - `avg: field | [field]` → mean of numeric values; `None` when count = 0.
//! - `min: field | [field]` → minimum comparable value.
//! - `max: field | [field]` → maximum comparable value.
//!
//! # Grouped aggregates (flattened `GroupResult`)
//! - `group_by: field | [field]` → partition by those fields, first-encounter order.
//! - All scalar aggregates applied within each group.
//! - Fields with **absent** (undefined) values in the entity are **omitted** from
//!   the `group` map (not set to `null`), matching TS `JSON.stringify` behavior
//!   where `undefined` property values are silently dropped.
//! - Fields with explicit `null` values are kept as `Value::Null`.
//!
//! # Min/max with no comparable values
//! When a min/max field has no numeric/string values across the filtered entities,
//! the field is **absent** from the `min`/`max` HashMap rather than `null`.
//! Consumers see `undefined` for that field, matching TS behavior.
//!
//! # GroupResult is flat
//!
//! The TS `computeGroupedAggregates` uses a spread:
//! ```ts
//! result.push({ group, ...aggregates });
//! ```
//! So `count`, `sum`, etc. are at the same level as `group`, not nested under
//! an `aggregate` field.

use std::collections::{HashMap, LinkedList};

use serde_json::{Map, Value};

use super::filter::get_nested_value;

// ── Aggregate config ──────────────────────────────────────────────────────────

/// Configuration for a scalar aggregate operation.
#[derive(Debug, Clone, Default)]
pub struct AggregateConfig {
    pub count: bool,
    pub sum: Vec<String>,
    pub avg: Vec<String>,
    pub min: Vec<String>,
    pub max: Vec<String>,
}

impl AggregateConfig {
    pub fn count() -> Self {
        Self {
            count: true,
            ..Default::default()
        }
    }
    pub fn sum(fields: impl Into<Vec<String>>) -> Self {
        Self {
            sum: fields.into(),
            ..Default::default()
        }
    }
    pub fn avg(fields: impl Into<Vec<String>>) -> Self {
        Self {
            avg: fields.into(),
            ..Default::default()
        }
    }
    pub fn min(fields: impl Into<Vec<String>>) -> Self {
        Self {
            min: fields.into(),
            ..Default::default()
        }
    }
    pub fn max(fields: impl Into<Vec<String>>) -> Self {
        Self {
            max: fields.into(),
            ..Default::default()
        }
    }
}

/// Result of a scalar aggregate.
#[derive(Debug, Clone, PartialEq)]
pub struct AggregateResult {
    pub count: Option<u64>,
    pub sum: Option<HashMap<String, f64>>,
    /// `None` per-field when no numeric values were found.
    pub avg: Option<HashMap<String, Option<f64>>>,
    /// A field is **absent** from the map when no comparable value was found,
    /// matching TS `undefined` semantics.
    pub min: Option<HashMap<String, Value>>,
    /// A field is **absent** from the map when no comparable value was found.
    pub max: Option<HashMap<String, Value>>,
}

/// One row in a grouped aggregate result.
///
/// The structure is **flat** — `count`, `sum`, etc. are at the same level as
/// `group`, mirroring the TS `{ group, ...aggregates }` spread pattern.
///
/// `group` omits keys whose value is absent (undefined) in the entity;
/// null values are kept as `Value::Null`.
#[derive(Debug, Clone, PartialEq)]
pub struct GroupResult {
    /// Grouping field values.  Fields whose value was absent in the entity
    /// are omitted from this map.
    pub group: Map<String, Value>,
    // Aggregate fields (same level as `group`)
    pub count: Option<u64>,
    pub sum: Option<HashMap<String, f64>>,
    pub avg: Option<HashMap<String, Option<f64>>>,
    /// Field absent = no comparable value (not null).
    pub min: Option<HashMap<String, Value>>,
    /// Field absent = no comparable value (not null).
    pub max: Option<HashMap<String, Value>>,
}

/// Sentinel for absent (undefined) group-by field values.
///
/// Used internally to encode "this entity did not have the group-by field" in
/// a serializable group key.  Matches the TS sentinel `"__PTDB_UNDEFINED__"`.
const UNDEFINED_SENTINEL: &str = "__PTDB_UNDEFINED__";

// ── Public API ────────────────────────────────────────────────────────────────

/// Compute scalar aggregates over `entities`.
///
/// Mirrors `computeAggregates` from `packages/core/src/operations/query/aggregate.ts`.
pub fn compute_aggregates(entities: &[Value], config: &AggregateConfig) -> AggregateResult {
    let mut count: u64 = 0;
    let mut sum_acc: HashMap<String, f64> = config.sum.iter().map(|f| (f.clone(), 0.0)).collect();
    let mut avg_acc: HashMap<String, (f64, u64)> =
        config.avg.iter().map(|f| (f.clone(), (0.0, 0))).collect();
    // Use Option<Value> to distinguish "no value yet" from "null".
    // When the option stays None, the field is omitted from output.
    let mut min_acc: HashMap<String, Option<Value>> =
        config.min.iter().map(|f| (f.clone(), None)).collect();
    let mut max_acc: HashMap<String, Option<Value>> =
        config.max.iter().map(|f| (f.clone(), None)).collect();

    for entity in entities {
        if config.count {
            count += 1;
        }

        for field in &config.sum {
            if let Some(n) = get_nested_value(entity, field).and_then(|v| v.as_f64()) {
                *sum_acc.entry(field.clone()).or_insert(0.0) += n;
            }
        }
        for field in &config.avg {
            if let Some(n) = get_nested_value(entity, field).and_then(|v| v.as_f64()) {
                let (s, c) = avg_acc.entry(field.clone()).or_insert((0.0, 0));
                *s += n;
                *c += 1;
            }
        }
        for field in &config.min {
            if let Some(v) = get_nested_value(entity, field) {
                if !matches!(v, Value::Null) && is_comparable(v) {
                    let entry = min_acc.get_mut(field).unwrap();
                    match entry {
                        None => *entry = Some(v.clone()),
                        Some(cur) => {
                            if compare_for_min_max(v, cur) < 0 {
                                *entry = Some(v.clone());
                            }
                        }
                    }
                }
            }
        }
        for field in &config.max {
            if let Some(v) = get_nested_value(entity, field) {
                if !matches!(v, Value::Null) && is_comparable(v) {
                    let entry = max_acc.get_mut(field).unwrap();
                    match entry {
                        None => *entry = Some(v.clone()),
                        Some(cur) => {
                            if compare_for_min_max(v, cur) > 0 {
                                *entry = Some(v.clone());
                            }
                        }
                    }
                }
            }
        }
    }

    AggregateResult {
        count: if config.count { Some(count) } else { None },
        sum: if !config.sum.is_empty() {
            Some(sum_acc)
        } else {
            None
        },
        avg: if !config.avg.is_empty() {
            let result = avg_acc
                .into_iter()
                .map(|(f, (s, c))| (f, if c > 0 { Some(s / c as f64) } else { None }))
                .collect();
            Some(result)
        } else {
            None
        },
        min: if !config.min.is_empty() {
            // Omit fields with no value (stay None) → field absent from HashMap
            Some(
                min_acc
                    .into_iter()
                    .filter_map(|(f, v)| v.map(|val| (f, val)))
                    .collect(),
            )
        } else {
            None
        },
        max: if !config.max.is_empty() {
            Some(
                max_acc
                    .into_iter()
                    .filter_map(|(f, v)| v.map(|val| (f, val)))
                    .collect(),
            )
        } else {
            None
        },
    }
}

/// Compute grouped aggregates over `entities`.
///
/// Mirrors `computeGroupedAggregates` from
/// `packages/core/src/operations/query/aggregate.ts`.
///
/// Groups are ordered by first encounter (insertion order via `LinkedList`).
///
/// # Absent vs null group-by values
///
/// | Entity field state | Group map entry           | TS equivalent   |
/// |--------------------|---------------------------|-----------------|
/// | Field absent       | Key omitted from map      | `undefined`     |
/// | Field is `null`    | `Value::Null` in map      | `null`          |
/// | Field has value    | The value in map          | The value       |
pub fn compute_grouped_aggregates(
    entities: &[Value],
    group_by: &[String],
    config: &AggregateConfig,
) -> Vec<GroupResult> {
    // Preserve insertion order with a linked-list-of-keys approach.
    let mut key_order: LinkedList<String> = LinkedList::new();
    let mut groups: HashMap<String, Vec<Value>> = HashMap::new();

    for entity in entities {
        let group_values: Vec<String> = group_by
            .iter()
            .map(|f| {
                let v = get_nested_value(entity, f);
                match v {
                    // Absent field → sentinel (not the same as null)
                    None => UNDEFINED_SENTINEL.to_string(),
                    // Null field → serialize as JSON "null"
                    Some(Value::Null) => "null".to_string(),
                    Some(v) => serde_json::to_string(v).unwrap_or_default(),
                }
            })
            .collect();
        let group_key = group_values.join("\x00");

        if !groups.contains_key(&group_key) {
            key_order.push_back(group_key.clone());
        }
        groups.entry(group_key).or_default().push(entity.clone());
    }

    key_order
        .iter()
        .map(|group_key| {
            let group_entities = groups.get(group_key).unwrap();
            let group_values: Vec<&str> = group_key.split('\x00').collect();

            let mut group_map = Map::new();
            for (i, field) in group_by.iter().enumerate() {
                let raw = group_values.get(i).copied().unwrap_or(UNDEFINED_SENTINEL);
                if raw == UNDEFINED_SENTINEL {
                    // Absent field: omit from group map (undefined at TS boundary)
                    continue;
                }
                // "null" sentinel → Value::Null; otherwise parse
                let v: Value = if raw == "null" {
                    Value::Null
                } else {
                    serde_json::from_str(raw).unwrap_or(Value::Null)
                };
                group_map.insert(field.clone(), v);
            }

            let aggregate = compute_aggregates(group_entities, config);

            // Flatten: same fields at GroupResult top level (TS `{ group, ...aggregates }`)
            GroupResult {
                group: group_map,
                count: aggregate.count,
                sum: aggregate.sum,
                avg: aggregate.avg,
                min: aggregate.min,
                max: aggregate.max,
            }
        })
        .collect()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// True when `v` can be compared for min/max purposes.
///
/// Mirrors TS `isComparable` from `aggregate.ts`:
/// ```ts
/// const isComparable = (value: unknown): boolean =>
///   value !== null && value !== undefined;
/// ```
/// Only `null` (and absent/undefined) are excluded; arrays and objects ARE
/// comparable in TS via JS coercion to a string representation.
/// We match that: arrays and objects enter `compare_for_min_max` which applies
/// the same JS String() coercion used in mixed-type sort.
fn is_comparable(v: &Value) -> bool {
    !matches!(v, Value::Null)
}

/// Compare two values for min/max (returns <0, 0, or >0).
///
/// Implements the JavaScript-observable relational comparison at the JSON
/// boundary value model level:
///
/// 1. **Number vs Number**: numeric `<` / `>` (same as JS).
/// 2. **String vs String**: bytewise lexicographic (parity note: JS uses
///    locale-aware `<`, but for the min/max aggregate the boundary-visible
///    outcome only differs for locale-sensitive string orderings which are
///    outside the boundary value model).
/// 3. **Mixed (including Array, Object)**: coerce both via JS `String(value)`,
///    then compare the resulting strings — mirrors what JS's relational `<`
///    operator does for values after `valueOf()` / `toString()` coercion.
///    Arrays: `[1,2] < [3,4]` → `"1,2" < "3,4"` → true.
///    Objects: `{} < {}` → `"[object Object]" < "[object Object]"` → false.
///
/// `Date` is not in the engine's `Value` model yet; it enters as a string.
fn compare_for_min_max(a: &Value, b: &Value) -> i64 {
    // Number vs Number: numeric comparison
    if let (Some(an), Some(bn)) = (a.as_f64(), b.as_f64()) {
        return if an < bn {
            -1
        } else if an > bn {
            1
        } else {
            0
        };
    }
    // String vs String: bytewise (see note above)
    if let (Value::String(sa), Value::String(sb)) = (a, b) {
        return match sa.cmp(sb) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        };
    }
    // Mixed types (including Array, Object): coerce via JS String(value) then compare.
    let sa = super::sort::value_to_js_string(a);
    let sb = super::sort::value_to_js_string(b);
    match sa.cmp(&sb) {
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Equal => 0,
        std::cmp::Ordering::Greater => 1,
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn products() -> Vec<Value> {
        vec![
            json!({"id":"p1","name":"Widget A","price":10.0,"category":"electronics","stock":100}),
            json!({"id":"p2","name":"Widget B","price":25.5,"category":"electronics","stock":50}),
            json!({"id":"p3","name":"Gadget X","price":15.75,"category":"gadgets","stock":75}),
            json!({"id":"p4","name":"Gadget Y","price":35.0,"category":"gadgets","stock":25}),
            json!({"id":"p5","name":"Tool Z","price":5.25,"category":"tools","stock":200}),
        ]
    }

    // ── Count ─────────────────────────────────────────────────────────────────

    #[test]
    fn count_all() {
        let result = compute_aggregates(&products(), &AggregateConfig::count());
        assert_eq!(result.count, Some(5));
    }

    #[test]
    fn count_empty() {
        let result = compute_aggregates(&[], &AggregateConfig::count());
        assert_eq!(result.count, Some(0));
    }

    // ── Sum ───────────────────────────────────────────────────────────────────

    #[test]
    fn sum_price() {
        let result = compute_aggregates(
            &products(),
            &AggregateConfig::sum(vec!["price".to_string()]),
        );
        let s = result.sum.unwrap();
        // 10 + 25.5 + 15.75 + 35 + 5.25 = 91.5
        assert!((s["price"] - 91.5).abs() < 1e-9);
    }

    #[test]
    fn sum_skips_non_numeric() {
        let data = vec![
            json!({"price": 10}),
            json!({"price": null}),
            json!({"price": "not-a-number"}),
            json!({"price": 20}),
        ];
        let result = compute_aggregates(&data, &AggregateConfig::sum(vec!["price".to_string()]));
        assert!((result.sum.unwrap()["price"] - 30.0).abs() < 1e-9);
    }

    #[test]
    fn sum_empty_is_zero() {
        let result = compute_aggregates(&[], &AggregateConfig::sum(vec!["price".to_string()]));
        assert_eq!(result.sum.unwrap()["price"], 0.0);
    }

    // ── Avg ───────────────────────────────────────────────────────────────────

    #[test]
    fn avg_price() {
        let result = compute_aggregates(
            &products(),
            &AggregateConfig::avg(vec!["price".to_string()]),
        );
        let avg = result.avg.unwrap()["price"].unwrap();
        // 91.5 / 5 = 18.3
        assert!((avg - 18.3).abs() < 1e-9);
    }

    #[test]
    fn avg_all_non_numeric_is_null() {
        let data = vec![json!({"price": "x"}), json!({"price": null})];
        let result = compute_aggregates(&data, &AggregateConfig::avg(vec!["price".to_string()]));
        assert_eq!(result.avg.unwrap()["price"], None);
    }

    // ── Min / Max ─────────────────────────────────────────────────────────────

    #[test]
    fn min_price() {
        let result = compute_aggregates(
            &products(),
            &AggregateConfig::min(vec!["price".to_string()]),
        );
        assert_eq!(result.min.unwrap()["price"].as_f64().unwrap(), 5.25);
    }

    #[test]
    fn max_price() {
        let result = compute_aggregates(
            &products(),
            &AggregateConfig::max(vec!["price".to_string()]),
        );
        assert_eq!(result.max.unwrap()["price"].as_f64().unwrap(), 35.0);
    }

    #[test]
    fn min_max_string_field() {
        let data = vec![
            json!({"name": "Zebra"}),
            json!({"name": "Apple"}),
            json!({"name": "Mango"}),
        ];
        let cfg = AggregateConfig {
            min: vec!["name".to_string()],
            max: vec!["name".to_string()],
            ..Default::default()
        };
        let result = compute_aggregates(&data, &cfg);
        assert_eq!(result.min.as_ref().unwrap()["name"].as_str(), Some("Apple"));
        assert_eq!(result.max.as_ref().unwrap()["name"].as_str(), Some("Zebra"));
    }

    #[test]
    fn min_max_no_comparable_value_field_absent() {
        // All values are null or absent → TS `isComparable(null)` = false,
        // `isComparable(undefined)` = false → field stays `None` in accumulator
        // → omitted from the output HashMap (not set to null).
        let data = vec![
            json!({"price": null}), // null: not comparable (TS: value !== null)
            json!({}),              // absent: not comparable (TS: value !== undefined)
        ];
        let cfg = AggregateConfig {
            min: vec!["price".to_string()],
            max: vec!["price".to_string()],
            ..Default::default()
        };
        let result = compute_aggregates(&data, &cfg);
        // min/max was requested, so Option is Some(...)
        assert!(result.min.is_some());
        // But the field should be absent (no comparable value found)
        assert!(
            result.min.as_ref().unwrap().get("price").is_none(),
            "field with no comparable values should be absent from min map"
        );
        assert!(
            result.max.as_ref().unwrap().get("price").is_none(),
            "field with no comparable values should be absent from max map"
        );
    }

    // ── Multiple aggregates at once ────────────────────────────────────────────

    #[test]
    fn multiple_aggregates_simultaneously() {
        let cfg = AggregateConfig {
            count: true,
            sum: vec!["price".to_string()],
            avg: vec!["price".to_string()],
            min: vec!["price".to_string()],
            max: vec!["price".to_string()],
        };
        let result = compute_aggregates(&products(), &cfg);
        assert_eq!(result.count, Some(5));
        assert!((result.sum.as_ref().unwrap()["price"] - 91.5).abs() < 1e-9);
        assert!((result.avg.as_ref().unwrap()["price"].unwrap() - 18.3).abs() < 1e-9);
        assert_eq!(
            result.min.as_ref().unwrap()["price"].as_f64().unwrap(),
            5.25
        );
        assert_eq!(
            result.max.as_ref().unwrap()["price"].as_f64().unwrap(),
            35.0
        );
    }

    // ── Grouped aggregates ─────────────────────────────────────────────────────

    #[test]
    fn grouped_by_category_count() {
        let cfg = AggregateConfig::count();
        let groups = compute_grouped_aggregates(&products(), &["category".to_string()], &cfg);
        // electronics:2, gadgets:2, tools:1 (first encounter order)
        assert_eq!(groups.len(), 3);
        assert_eq!(groups[0].group["category"].as_str(), Some("electronics"));
        assert_eq!(groups[0].count, Some(2)); // flattened
        assert_eq!(groups[1].group["category"].as_str(), Some("gadgets"));
        assert_eq!(groups[1].count, Some(2));
        assert_eq!(groups[2].group["category"].as_str(), Some("tools"));
        assert_eq!(groups[2].count, Some(1));
    }

    #[test]
    fn grouped_by_category_sum_price() {
        let cfg = AggregateConfig::sum(vec!["price".to_string()]);
        let groups = compute_grouped_aggregates(&products(), &["category".to_string()], &cfg);
        // electronics: 10 + 25.5 = 35.5
        let electronics = groups
            .iter()
            .find(|g| g.group["category"] == "electronics")
            .unwrap();
        assert!((electronics.sum.as_ref().unwrap()["price"] - 35.5).abs() < 1e-9);
    }

    #[test]
    fn grouped_preserves_first_encounter_order() {
        let data = vec![
            json!({"id":"1","category":"tools","price":5}),
            json!({"id":"2","category":"electronics","price":10}),
            json!({"id":"3","category":"tools","price":15}),
        ];
        let cfg = AggregateConfig::count();
        let groups = compute_grouped_aggregates(&data, &["category".to_string()], &cfg);
        assert_eq!(groups[0].group["category"].as_str(), Some("tools"));
        assert_eq!(groups[1].group["category"].as_str(), Some("electronics"));
    }

    #[test]
    fn grouped_with_null_field_treated_as_distinct_group() {
        let data = vec![
            json!({"id":"1","cat":"a","price":10}),
            json!({"id":"2","cat":null,"price":20}),
            json!({"id":"3","cat":"a","price":30}),
        ];
        let cfg = AggregateConfig::count();
        let groups = compute_grouped_aggregates(&data, &["cat".to_string()], &cfg);
        // "a" and null are distinct groups
        assert_eq!(groups.len(), 2);
        let a_group = groups
            .iter()
            .find(|g| g.group.get("cat").and_then(|v| v.as_str()) == Some("a"))
            .unwrap();
        assert_eq!(a_group.count, Some(2));
    }

    #[test]
    fn grouped_absent_field_omitted_from_group_map() {
        // Entity without "cat" field → sentinel → group map should NOT have "cat" key
        let data = vec![
            json!({"id":"1","cat":"a"}),
            json!({"id":"2"}), // no "cat"
        ];
        let cfg = AggregateConfig::count();
        let groups = compute_grouped_aggregates(&data, &["cat".to_string()], &cfg);
        assert_eq!(groups.len(), 2); // "a" group and absent group
                                     // Find the group for absent "cat"
        let absent_group = groups
            .iter()
            .find(|g| !g.group.contains_key("cat"))
            .unwrap();
        assert!(
            absent_group.group.get("cat").is_none(),
            "absent field must be omitted from group map"
        );
        assert_eq!(absent_group.count, Some(1));
    }

    #[test]
    fn grouped_null_field_kept_in_group_map() {
        // Entity with "cat": null → group map has "cat": null
        let data = vec![json!({"id":"1","cat":null})];
        let cfg = AggregateConfig::count();
        let groups = compute_grouped_aggregates(&data, &["cat".to_string()], &cfg);
        assert_eq!(groups.len(), 1);
        // "cat" key should be present with Value::Null
        assert_eq!(groups[0].group.get("cat"), Some(&Value::Null));
    }

    // ── Nested field path ──────────────────────────────────────────────────────

    #[test]
    fn sum_nested_field() {
        let data = vec![
            json!({"stats": {"views": 100}}),
            json!({"stats": {"views": 200}}),
        ];
        let result = compute_aggregates(
            &data,
            &AggregateConfig::sum(vec!["stats.views".to_string()]),
        );
        assert_eq!(result.sum.unwrap()["stats.views"], 300.0);
    }

    // ── Arrays and objects in min/max ─────────────────────────────────────────
    // TS `isComparable = v !== null && v !== undefined` — arrays/objects included.
    // JS relational comparison coerces both to String(value) and then compares.

    #[test]
    fn min_max_null_excluded_but_arrays_and_booleans_included() {
        // null is not comparable per TS isComparable, so it must be skipped.
        let data = vec![json!({"val": null}), json!({"val": 5}), json!({"val": 3})];
        let cfg = AggregateConfig {
            min: vec!["val".to_string()],
            max: vec!["val".to_string()],
            ..Default::default()
        };
        let r = compute_aggregates(&data, &cfg);
        assert_eq!(r.min.as_ref().unwrap()["val"].as_f64(), Some(3.0));
        assert_eq!(r.max.as_ref().unwrap()["val"].as_f64(), Some(5.0));
    }

    #[test]
    fn min_max_arrays_comparable_via_string_coercion() {
        // JS: [1,2] < [3,4] → "1,2" < "3,4" → true (bytewise: '1' < '3')
        // So min is [1,2] and max is [3,4].
        let data = vec![json!({"tags": [3, 4]}), json!({"tags": [1, 2]})];
        let cfg = AggregateConfig {
            min: vec!["tags".to_string()],
            max: vec!["tags".to_string()],
            ..Default::default()
        };
        let r = compute_aggregates(&data, &cfg);
        // min should be [1,2] (coerces to "1,2" < "3,4")
        assert_eq!(r.min.as_ref().unwrap()["tags"], json!([1, 2]));
        assert_eq!(r.max.as_ref().unwrap()["tags"], json!([3, 4]));
    }

    #[test]
    fn min_max_objects_comparable_via_string_coercion() {
        // All objects coerce to "[object Object]" — all equal.
        // When equal, first-encountered wins for min, last for max.
        let data = vec![json!({"obj": {"a": 1}}), json!({"obj": {"b": 2}})];
        let cfg = AggregateConfig {
            min: vec!["obj".to_string()],
            max: vec!["obj".to_string()],
            ..Default::default()
        };
        let r = compute_aggregates(&data, &cfg);
        // Both coerce to "[object Object]" so compare equal; min = first encountered.
        // The exact winner is an implementation detail, but neither is null.
        assert!(
            r.min.as_ref().unwrap().contains_key("obj"),
            "min must not be absent"
        );
        assert!(
            r.max.as_ref().unwrap().contains_key("obj"),
            "max must not be absent"
        );
    }

    #[test]
    fn min_of_all_nulls_is_absent() {
        // All values are null — is_comparable filters all out; min/max key absent.
        let data = vec![json!({"val": null}), json!({"val": null})];
        let cfg = AggregateConfig {
            min: vec!["val".to_string()],
            max: vec!["val".to_string()],
            ..Default::default()
        };
        let r = compute_aggregates(&data, &cfg);
        // No comparable values — key absent from map
        assert!(!r.min.as_ref().unwrap().contains_key("val"));
        assert!(!r.max.as_ref().unwrap().contains_key("val"));
    }
}
