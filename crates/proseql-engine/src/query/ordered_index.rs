//! Ordered (range) index for one field (`CollectionDescriptor.ordered_indexes`).
//!
//! The index answers two questions without a full scan:
//!
//! 1. Which rows can satisfy the `$gt`/`$gte`/`$lt`/`$lte` conditions on the
//!    field ([`OrderedIndex::range_ids`])?
//! 2. In which order does a stable single-field sort on the field put the rows
//!    ([`OrderedIndex::sorted_ids`])?
//!
//! The answers must equal what the unindexed path computes, so the index
//! copies the engine's semantics exactly rather than JavaScript's:
//!
//! - **Range filter** (`filter.rs`, `evaluate_operators`): a string value is
//!   compared bytewise with string operands and ignores number operands; a
//!   number value is compared as `f64` with number operands and ignores string
//!   operands. Null, booleans, arrays and objects never match a comparison
//!   operator, and neither does a missing field (unless `$eq` is the boundary
//!   `undefined`, which this index refuses to plan). The candidates for a range
//!   are therefore "strings inside the string bounds" plus "numbers inside the
//!   number bounds". The caller still runs the full predicate on them.
//! - **Sort** (`sort.rs`, `compare_entities`): null, missing and boundary
//!   `undefined` sort last in both directions; strings compare bytewise when no
//!   collator is registered; numbers compare as `f64` (`-0 == 0`); mixed types
//!   compare by their JS string form, which is not a total order. The index
//!   only orders a sort when every present value has one type (all strings or
//!   all numbers) and, for strings, no collator is registered. Ties keep
//!   insertion order, as Rust's stable sort does.
//!
//! Each entry is keyed by `(value, insertion ordinal)`, so iteration order is
//! the stable-sort order and range results can be put back into insertion
//! order cheaply.

use std::collections::{BTreeMap, HashMap};
use std::iter::Peekable;
use std::ops::Bound;
use std::sync::Arc;

use serde_json::Value;

use super::filter::get_nested_value;
use super::sort::SortOrder;
use crate::value::is_boundary_undefined;

// ── Keys ──────────────────────────────────────────────────────────────────────

/// An `f64` with a total order. `-0.0` is stored as `0.0` because the filter
/// and the sort treat them as equal. JSON values cannot hold NaN.
#[derive(Debug, Clone, Copy)]
pub(crate) struct NumberKey(f64);

impl NumberKey {
    pub(crate) fn new(value: f64) -> Self {
        Self(if value == 0.0 { 0.0 } else { value })
    }
}

impl PartialEq for NumberKey {
    fn eq(&self, other: &Self) -> bool {
        self.0.total_cmp(&other.0).is_eq()
    }
}
impl Eq for NumberKey {}
impl PartialOrd for NumberKey {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for NumberKey {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}

/// How one row's field value takes part in ranges and sorts.
#[derive(Debug, Clone, PartialEq)]
enum OrderedKey {
    Str(String),
    Num(NumberKey),
    /// Missing, `null` or boundary `undefined`: never in a range, sorts last.
    Absent,
    /// Booleans, arrays and objects: never in a range, blocks index sorts.
    Other,
}

impl OrderedKey {
    fn classify(value: Option<&Value>) -> Self {
        match value {
            None | Some(Value::Null) => Self::Absent,
            Some(value) if is_boundary_undefined(value) => Self::Absent,
            Some(Value::String(text)) => Self::Str(text.clone()),
            Some(Value::Number(number)) => match number.as_f64() {
                Some(value) => Self::Num(NumberKey::new(value)),
                None => Self::Other,
            },
            Some(_) => Self::Other,
        }
    }
}

// ── Range specification ───────────────────────────────────────────────────────

/// Lower and upper bound on one value type.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Interval<K> {
    lower: Bound<K>,
    upper: Bound<K>,
}

impl<K: Ord + Clone> Interval<K> {
    fn unbounded() -> Self {
        Self {
            lower: Bound::Unbounded,
            upper: Bound::Unbounded,
        }
    }

    /// Intersect with one `$gt`/`$gte`/`$lt`/`$lte` condition.
    fn tighten(&mut self, operator: &str, key: K) {
        let (current, candidate, is_lower) = match operator {
            "$gt" => (&mut self.lower, Bound::Excluded(key), true),
            "$gte" => (&mut self.lower, Bound::Included(key), true),
            "$lt" => (&mut self.upper, Bound::Excluded(key), false),
            "$lte" => (&mut self.upper, Bound::Included(key), false),
            _ => return,
        };
        let stricter = match (&*current, &candidate) {
            (Bound::Unbounded, _) => true,
            (_, Bound::Unbounded) => false,
            (Bound::Included(old) | Bound::Excluded(old), Bound::Included(new))
            | (Bound::Excluded(old), Bound::Excluded(new)) => {
                if is_lower {
                    new > old
                } else {
                    new < old
                }
            }
            // An exclusive bound at the same key is stricter than an inclusive one.
            (Bound::Included(old), Bound::Excluded(new)) => {
                if is_lower {
                    new >= old
                } else {
                    new <= old
                }
            }
        };
        if stricter {
            *current = candidate;
        }
    }

    /// No key satisfies both bounds.
    fn is_empty(&self) -> bool {
        match (&self.lower, &self.upper) {
            (Bound::Included(low), Bound::Included(high)) => low > high,
            (
                Bound::Included(low) | Bound::Excluded(low),
                Bound::Included(high) | Bound::Excluded(high),
            ) => low >= high,
            _ => false,
        }
    }

    /// Bounds over `(key, ordinal)` tuples that select every ordinal of the
    /// keys inside the interval. Only valid when `!self.is_empty()`.
    fn tuple_bounds(&self) -> (Bound<(K, u64)>, Bound<(K, u64)>) {
        let lower = match &self.lower {
            Bound::Included(key) => Bound::Included((key.clone(), 0)),
            Bound::Excluded(key) => Bound::Excluded((key.clone(), u64::MAX)),
            Bound::Unbounded => Bound::Unbounded,
        };
        let upper = match &self.upper {
            Bound::Included(key) => Bound::Included((key.clone(), u64::MAX)),
            Bound::Excluded(key) => Bound::Excluded((key.clone(), 0)),
            Bound::Unbounded => Bound::Unbounded,
        };
        (lower, upper)
    }
}

/// The comparison conditions a where clause puts on one field, split by
/// operand type. A row can match only if it is a string inside `strings` or a
/// number inside `numbers`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RangeSpec {
    strings: Interval<String>,
    numbers: Interval<NumberKey>,
}

impl RangeSpec {
    /// Collect the comparison conditions on `field` that every matching row
    /// must satisfy: the field's own operator object at the top level and in
    /// every `$and` element, recursively. `$or` and `$not` branches are not
    /// used (their siblings still constrain the row).
    ///
    /// Returns `None` when the clause has no comparison on `field`, or when a
    /// condition could let a row with a missing field match (`$eq` set to the
    /// boundary `undefined`).
    pub(crate) fn extract(where_clause: &Value, field: &str) -> Option<Self> {
        let mut spec = Self {
            strings: Interval::unbounded(),
            numbers: Interval::unbounded(),
        };
        let mut found = false;
        if !spec.collect(where_clause, field, &mut found) || !found {
            return None;
        }
        Some(spec)
    }

    /// Returns `false` to veto index use.
    fn collect(&mut self, where_clause: &Value, field: &str, found: &mut bool) -> bool {
        let Some(object) = where_clause.as_object() else {
            return true;
        };
        for (key, condition) in object {
            if key == "$and" {
                if let Some(parts) = condition.as_array() {
                    for part in parts {
                        if !self.collect(part, field, found) {
                            return false;
                        }
                    }
                }
                continue;
            }
            if key != field {
                continue;
            }
            let Some(operators) = condition.as_object() else {
                continue;
            };
            if !RANGE_OPERATORS
                .iter()
                .any(|operator| operators.contains_key(*operator))
            {
                continue;
            }
            if operators.get("$eq").is_some_and(is_boundary_undefined) {
                return false;
            }
            *found = true;
            for operator in RANGE_OPERATORS {
                match operators.get(operator) {
                    Some(Value::String(bound)) => self.strings.tighten(operator, bound.clone()),
                    Some(Value::Number(bound)) => {
                        if let Some(bound) = bound.as_f64() {
                            self.numbers.tighten(operator, NumberKey::new(bound));
                        }
                    }
                    // Other operand types only require a string or number value,
                    // which every candidate already is.
                    _ => {}
                }
            }
        }
        true
    }
}

const RANGE_OPERATORS: [&str; 4] = ["$gt", "$gte", "$lt", "$lte"];

// ── Index ─────────────────────────────────────────────────────────────────────

/// Ordered index over one field path.
#[derive(Debug)]
pub(crate) struct OrderedIndex {
    field: String,
    strings: BTreeMap<(String, u64), Arc<str>>,
    numbers: BTreeMap<(NumberKey, u64), Arc<str>>,
    absent: BTreeMap<u64, Arc<str>>,
    other: usize,
    /// Current key and insertion ordinal of every indexed row, so removal does
    /// not depend on the caller passing the previous value.
    entries: HashMap<Arc<str>, (OrderedKey, u64)>,
}

impl OrderedIndex {
    pub(crate) fn new(field: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            strings: BTreeMap::new(),
            numbers: BTreeMap::new(),
            absent: BTreeMap::new(),
            other: 0,
            entries: HashMap::new(),
        }
    }

    pub(crate) fn field(&self) -> &str {
        &self.field
    }

    /// Add or replace the entry for `id`.
    pub(crate) fn insert(&mut self, id: &str, ordinal: u64, entity: &Value) {
        let key = OrderedKey::classify(get_nested_value(entity, &self.field));
        if let Some((current, current_ordinal)) = self.entries.get(id) {
            if *current == key && *current_ordinal == ordinal {
                return;
            }
            self.remove(id);
        }
        let id: Arc<str> = Arc::from(id);
        match &key {
            OrderedKey::Str(text) => {
                self.strings
                    .insert((text.clone(), ordinal), Arc::clone(&id));
            }
            OrderedKey::Num(number) => {
                self.numbers.insert((*number, ordinal), Arc::clone(&id));
            }
            OrderedKey::Absent => {
                self.absent.insert(ordinal, Arc::clone(&id));
            }
            OrderedKey::Other => self.other += 1,
        }
        self.entries.insert(id, (key, ordinal));
    }

    pub(crate) fn remove(&mut self, id: &str) {
        let Some((key, ordinal)) = self.entries.remove(id) else {
            return;
        };
        match key {
            OrderedKey::Str(text) => {
                self.strings.remove(&(text, ordinal));
            }
            OrderedKey::Num(number) => {
                self.numbers.remove(&(number, ordinal));
            }
            OrderedKey::Absent => {
                self.absent.remove(&ordinal);
            }
            OrderedKey::Other => self.other -= 1,
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }

    /// Ids of rows that can satisfy `spec`, in insertion order.
    pub(crate) fn range_ids(&self, spec: &RangeSpec) -> Vec<String> {
        let mut hits: Vec<(u64, &Arc<str>)> = Vec::new();
        if !spec.strings.is_empty() {
            hits.extend(
                self.strings
                    .range(spec.strings.tuple_bounds())
                    .map(|((_, ordinal), id)| (*ordinal, id)),
            );
        }
        if !spec.numbers.is_empty() {
            hits.extend(
                self.numbers
                    .range(spec.numbers.tuple_bounds())
                    .map(|((_, ordinal), id)| (*ordinal, id)),
            );
        }
        hits.sort_unstable_by_key(|(ordinal, _)| *ordinal);
        hits.into_iter().map(|(_, id)| id.to_string()).collect()
    }

    /// Whether [`Self::sorted_ids`] reproduces the stable sort on this field.
    /// `strings_bytewise` is false when a string collator is registered.
    pub(crate) fn can_sort(&self, strings_bytewise: bool) -> bool {
        self.other == 0
            && (self.strings.is_empty() || self.numbers.is_empty())
            && (self.strings.is_empty() || strings_bytewise)
    }

    /// Row ids in the order a stable sort on the field produces: present
    /// values by key (ties in insertion order, in both directions), then
    /// missing/null rows in insertion order. With `spec`, only rows that can
    /// satisfy it are returned (rows without a value never can).
    ///
    /// Callers must check [`Self::can_sort`] first.
    pub(crate) fn sorted_ids<'a>(
        &'a self,
        order: &SortOrder,
        spec: Option<&RangeSpec>,
    ) -> Box<dyn Iterator<Item = &'a str> + 'a> {
        let strings = match spec {
            Some(spec) if spec.strings.is_empty() => None,
            Some(spec) => Some(self.strings.range(spec.strings.tuple_bounds())),
            None => Some(self.strings.range::<(String, u64), _>(..)),
        };
        let numbers = match spec {
            Some(spec) if spec.numbers.is_empty() => None,
            Some(spec) => Some(self.numbers.range(spec.numbers.tuple_bounds())),
            None => Some(self.numbers.range::<(NumberKey, u64), _>(..)),
        };
        let absent = spec
            .is_none()
            .then(|| self.absent.values().map(|id| &**id))
            .into_iter()
            .flatten();
        // `can_sort` guarantees that at most one of strings/numbers is non-empty.
        let present: Box<dyn Iterator<Item = &'a str> + 'a> = match order {
            SortOrder::Asc => Box::new(
                strings
                    .into_iter()
                    .flatten()
                    .map(|(_, id)| &**id)
                    .chain(numbers.into_iter().flatten().map(|(_, id)| &**id)),
            ),
            SortOrder::Desc => Box::new(
                DescendingStable::new(strings.into_iter().flatten().rev())
                    .chain(DescendingStable::new(numbers.into_iter().flatten().rev())),
            ),
        };
        Box::new(present.chain(absent))
    }
}

/// Walks `(key, ordinal)` entries in reverse order but emits rows with equal
/// keys in ascending ordinal order, as a stable descending sort does.
struct DescendingStable<'a, K: 'a, I: Iterator<Item = (&'a (K, u64), &'a Arc<str>)>> {
    inner: Peekable<I>,
    run: Vec<&'a str>,
}

impl<'a, K: 'a, I: Iterator<Item = (&'a (K, u64), &'a Arc<str>)>> DescendingStable<'a, K, I> {
    fn new(inner: I) -> Self {
        Self {
            inner: inner.peekable(),
            run: Vec::new(),
        }
    }
}

impl<'a, K, I> Iterator for DescendingStable<'a, K, I>
where
    K: PartialEq + 'a,
    I: Iterator<Item = (&'a (K, u64), &'a Arc<str>)>,
{
    type Item = &'a str;

    fn next(&mut self) -> Option<Self::Item> {
        if let Some(id) = self.run.pop() {
            return Some(id);
        }
        // Entries with equal keys arrive with descending ordinals. Collect the
        // run and pop it from the end to emit ascending ordinals.
        let ((key, _), id) = self.inner.next()?;
        self.run.push(id);
        while let Some(((next_key, _), next_id)) = self.inner.peek() {
            if next_key != key {
                break;
            }
            self.run.push(next_id);
            self.inner.next();
        }
        self.run.pop()
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn index(rows: &[(&str, Value)]) -> OrderedIndex {
        let mut index = OrderedIndex::new("at");
        for (ordinal, (id, row)) in rows.iter().enumerate() {
            index.insert(id, ordinal as u64, row);
        }
        index
    }

    fn spec(where_clause: Value) -> RangeSpec {
        RangeSpec::extract(&where_clause, "at").expect("range spec")
    }

    #[test]
    fn tighten_keeps_the_strictest_bounds() {
        let mut interval = Interval::<i32>::unbounded();
        interval.tighten("$gte", 3);
        interval.tighten("$gt", 3);
        interval.tighten("$gte", 1);
        interval.tighten("$lte", 9);
        interval.tighten("$lt", 9);
        interval.tighten("$lte", 12);
        assert_eq!(interval.lower, Bound::Excluded(3));
        assert_eq!(interval.upper, Bound::Excluded(9));
        assert!(!interval.is_empty());
        interval.tighten("$lt", 3);
        assert!(interval.is_empty());
    }

    #[test]
    fn point_interval_is_empty_unless_both_bounds_include_it() {
        let mut interval = Interval::<i32>::unbounded();
        interval.tighten("$gte", 5);
        interval.tighten("$lte", 5);
        assert!(!interval.is_empty());
        interval.tighten("$lt", 5);
        assert!(interval.is_empty());
    }

    #[test]
    fn extract_reads_top_level_and_nested_and() {
        let spec = spec(json!({
            "at": {"$gte": "2020"},
            "$and": [{"at": {"$lt": "2021"}}, {"$and": [{"at": {"$gt": 4}}]}],
            "$or": [{"at": {"$lt": "1999"}}],
        }));
        assert_eq!(spec.strings.lower, Bound::Included("2020".to_owned()));
        assert_eq!(spec.strings.upper, Bound::Excluded("2021".to_owned()));
        assert_eq!(spec.numbers.lower, Bound::Excluded(NumberKey::new(4.0)));
        assert_eq!(spec.numbers.upper, Bound::Unbounded);
    }

    #[test]
    fn extract_ignores_other_shapes_and_vetoes_eq_undefined() {
        assert!(RangeSpec::extract(&json!({"at": "2020"}), "at").is_none());
        assert!(RangeSpec::extract(&json!({"other": {"$gt": 1}}), "at").is_none());
        assert!(RangeSpec::extract(&json!({"$or": [{"at": {"$gt": 1}}]}), "at").is_none());
        assert!(RangeSpec::extract(
            &json!({"at": {"$gt": 1, "$eq": {"__proseqlUndefined__": 1}}}),
            "at"
        )
        .is_none());
    }

    #[test]
    fn range_ids_follow_filter_type_rules_in_insertion_order() {
        let index = index(&[
            ("n5", json!({"at": 5})),
            ("s-b", json!({"at": "b"})),
            ("missing", json!({})),
            ("null", json!({"at": null})),
            ("bool", json!({"at": true})),
            ("s-a", json!({"at": "a"})),
            ("n1", json!({"at": 1})),
            ("s-c", json!({"at": "c"})),
        ]);
        // String bounds: strings inside the bounds plus every number.
        assert_eq!(
            index.range_ids(&spec(json!({"at": {"$gte": "b"}}))),
            vec!["n5", "s-b", "n1", "s-c"]
        );
        // Number bounds: numbers inside the bounds plus every string.
        assert_eq!(
            index.range_ids(&spec(json!({"at": {"$lt": 3}}))),
            vec!["s-b", "s-a", "n1", "s-c"]
        );
        // Both: each type uses its own bounds.
        assert_eq!(
            index.range_ids(&spec(json!({"at": {"$gt": "a", "$lt": 3}}))),
            vec!["s-b", "n1", "s-c"]
        );
        // Empty string interval: numbers only.
        assert_eq!(
            index.range_ids(&spec(json!({"at": {"$gt": "c", "$lt": "a"}}))),
            vec!["n5", "n1"]
        );
    }

    #[test]
    fn negative_zero_equals_zero() {
        let index = index(&[("neg", json!({"at": -0.0})), ("pos", json!({"at": 0}))]);
        assert_eq!(
            index.range_ids(&spec(json!({"at": {"$gte": 0, "$lte": 0}}))),
            vec!["neg", "pos"]
        );
        assert!(index
            .range_ids(&spec(json!({"at": {"$gt": -0.0}})))
            .is_empty());
    }

    #[test]
    fn sorted_ids_are_stable_in_both_directions_with_absent_last() {
        let index = index(&[
            ("b1", json!({"at": "b"})),
            ("missing", json!({})),
            ("a1", json!({"at": "a"})),
            ("b2", json!({"at": "b"})),
            ("null", json!({"at": null})),
            ("c1", json!({"at": "c"})),
            ("a2", json!({"at": "a"})),
        ]);
        assert!(index.can_sort(true));
        assert!(!index.can_sort(false));
        assert_eq!(
            index.sorted_ids(&SortOrder::Asc, None).collect::<Vec<_>>(),
            vec!["a1", "a2", "b1", "b2", "c1", "missing", "null"]
        );
        assert_eq!(
            index.sorted_ids(&SortOrder::Desc, None).collect::<Vec<_>>(),
            vec!["c1", "b1", "b2", "a1", "a2", "missing", "null"]
        );
        let range = spec(json!({"at": {"$gte": "b"}}));
        assert_eq!(
            index
                .sorted_ids(&SortOrder::Desc, Some(&range))
                .collect::<Vec<_>>(),
            vec!["c1", "b1", "b2"]
        );
    }

    #[test]
    fn mixed_or_other_types_block_index_sorts() {
        let mixed = index(&[("s", json!({"at": "1"})), ("n", json!({"at": 2}))]);
        assert!(!mixed.can_sort(true));
        let mut other = index(&[("n", json!({"at": 2})), ("b", json!({"at": false}))]);
        assert!(!other.can_sort(true));
        other.remove("b");
        assert!(other.can_sort(false), "numbers ignore the collator");
    }

    #[test]
    fn insert_replaces_and_remove_forgets_the_previous_key() {
        let mut index = index(&[("x", json!({"at": 1})), ("y", json!({"at": 2}))]);
        index.insert("x", 0, &json!({"at": 3}));
        assert_eq!(
            index.sorted_ids(&SortOrder::Asc, None).collect::<Vec<_>>(),
            vec!["y", "x"]
        );
        index.remove("y");
        index.remove("y");
        assert_eq!(index.len(), 1);
        assert_eq!(
            index.range_ids(&spec(json!({"at": {"$lt": 10}}))),
            vec!["x"]
        );
    }
}
