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
//! # Storage
//!
//! Entries live in a `BTreeSet<(u64, String)>`, the same type the equality
//! index already uses, so the WASM build carries one B-tree instantiation
//! (each extra key type costs several KB of gzipped code). An entry is
//! `(region, key ++ ordinal ++ id)`:
//!
//! - `region` is 0 for numbers, 1 for strings and 2 for missing/null rows.
//! - `key` is an order-preserving encoding of the value: 16 hex digits of the
//!   `f64` bit pattern mapped to a total order (`-0` stored as `0`), or the
//!   string with `\0` escaped as `\0\x01` and terminated by `\0\0`, or empty.
//!   Byte order of encoded keys equals `f64::total_cmp` / `str::cmp` order of
//!   the values, which are the comparisons the filter and the sort use.
//! - `ordinal` is the row's insertion ordinal as 16 hex digits, so ties
//!   iterate in insertion order.
//! - `id` is the row id.

use std::collections::{btree_set, BTreeSet};
use std::iter::Peekable;
use std::ops::Bound;

use serde_json::Value;

use super::filter::get_nested_value;
use super::sort::SortOrder;
use crate::value::is_boundary_undefined;

// ── Keys ──────────────────────────────────────────────────────────────────────

const NUMBERS: u64 = 0;
const STRINGS: u64 = 1;
const ABSENT: u64 = 2;
/// Hex digits of an encoded number or ordinal.
const WIDTH: usize = 16;

type Entry = (u64, String);

/// Encode a number so that byte order equals `f64::total_cmp` order, with
/// `-0` and `0` equal (the filter and the sort treat them as equal).
fn number_key(value: f64) -> String {
    let bits = if value == 0.0 { 0.0f64 } else { value }.to_bits();
    let ordered = if bits >> 63 == 1 {
        !bits
    } else {
        bits | (1 << 63)
    };
    format!("{ordered:016x}")
}

/// Encode a string so that byte order equals `str::cmp` order and no encoded
/// key is a prefix of another.
fn string_key(value: &str) -> String {
    let mut key = String::with_capacity(value.len() + 2);
    for part in value.split('\0').enumerate() {
        if part.0 > 0 {
            key.push_str("\0\u{1}");
        }
        key.push_str(part.1);
    }
    key.push_str("\0\0");
    key
}

/// `(region, encoded key)` of one row's value; `None` for booleans, arrays
/// and objects, which never match a range and block index sorts.
fn classify(value: Option<&Value>) -> Option<(u64, String)> {
    match value {
        None | Some(Value::Null) => Some((ABSENT, String::new())),
        Some(value) if is_boundary_undefined(value) => Some((ABSENT, String::new())),
        Some(Value::String(text)) => Some((STRINGS, string_key(text))),
        Some(Value::Number(number)) => number.as_f64().map(|n| (NUMBERS, number_key(n))),
        Some(_) => None,
    }
}

/// Length of the encoded key at the start of an entry.
fn key_len(entry: &Entry) -> usize {
    match entry.0 {
        NUMBERS => WIDTH,
        STRINGS => entry.1.find("\0\0").map_or(0, |end| end + 2),
        _ => 0,
    }
}

/// Insertion ordinal and id of an entry.
fn ordinal_and_id(entry: &Entry) -> (u64, &str) {
    let rest = &entry.1[key_len(entry)..];
    let ordinal = u64::from_str_radix(&rest[..WIDTH], 16).unwrap_or(u64::MAX);
    (ordinal, &rest[WIDTH..])
}

fn id_of(entry: &Entry) -> &str {
    ordinal_and_id(entry).1
}

// ── Range specification ───────────────────────────────────────────────────────

/// Lower and upper bound on the encoded keys of one region.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Interval {
    region: u64,
    lower: Bound<String>,
    upper: Bound<String>,
}

impl Interval {
    fn unbounded(region: u64) -> Self {
        Self {
            region,
            lower: Bound::Unbounded,
            upper: Bound::Unbounded,
        }
    }

    /// Intersect with one `$gt`/`$gte`/`$lt`/`$lte` condition.
    fn tighten(&mut self, operator: &str, key: String) {
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

    /// Set bounds that select every entry whose key is inside the interval.
    /// `key ++ "g"` sorts after every `key ++ ordinal ++ id` (hex digits are
    /// below `g`) and before every larger key (no key is a prefix of another).
    fn entry_bounds(&self) -> (Bound<Entry>, Bound<Entry>) {
        let region = self.region;
        let after = |key: &String| (region, format!("{key}g"));
        let lower = match &self.lower {
            Bound::Included(key) => Bound::Included((region, key.clone())),
            Bound::Excluded(key) => Bound::Included(after(key)),
            Bound::Unbounded => Bound::Included((region, String::new())),
        };
        let upper = match &self.upper {
            Bound::Included(key) => Bound::Excluded(after(key)),
            Bound::Excluded(key) => Bound::Excluded((region, key.clone())),
            Bound::Unbounded => Bound::Excluded((region + 1, String::new())),
        };
        (lower, upper)
    }
}

/// The comparison conditions a where clause puts on one field, split by
/// operand type. A row can match only if it is a string inside `strings` or a
/// number inside `numbers`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RangeSpec {
    strings: Interval,
    numbers: Interval,
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
            strings: Interval::unbounded(STRINGS),
            numbers: Interval::unbounded(NUMBERS),
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
                    Some(Value::String(bound)) => self.strings.tighten(operator, string_key(bound)),
                    Some(Value::Number(bound)) => {
                        if let Some(bound) = bound.as_f64() {
                            self.numbers.tighten(operator, number_key(bound));
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

    /// The non-empty intervals, strings first.
    fn intervals(&self) -> impl Iterator<Item = &Interval> {
        [&self.strings, &self.numbers]
            .into_iter()
            .filter(|interval| !interval.is_empty())
    }
}

const RANGE_OPERATORS: [&str; 4] = ["$gt", "$gte", "$lt", "$lte"];

// ── Index ─────────────────────────────────────────────────────────────────────

/// Ordered index over one field path.
///
/// Like the equality index, maintenance relies on callers passing the row
/// value that is currently indexed when they remove or replace a row.
pub(crate) struct OrderedIndex {
    field: String,
    /// See "Storage" in the module docs.
    entries: BTreeSet<Entry>,
    strings: usize,
    numbers: usize,
    /// Rows whose value is a boolean, array or object (not in `entries`).
    other: usize,
}

impl std::fmt::Debug for OrderedIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OrderedIndex")
            .field("field", &self.field)
            .field("len", &(self.entries.len() + self.other))
            .finish()
    }
}

impl OrderedIndex {
    pub(crate) fn new(field: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            entries: BTreeSet::new(),
            strings: 0,
            numbers: 0,
            other: 0,
        }
    }

    pub(crate) fn field(&self) -> &str {
        &self.field
    }

    /// The entry for a row, or `None` for a boolean, array or object value.
    fn entry(&self, id: &str, ordinal: u64, entity: &Value) -> Option<Entry> {
        classify(get_nested_value(entity, &self.field))
            .map(|(region, key)| (region, format!("{key}{ordinal:016x}{id}")))
    }

    fn counter(&mut self, region: Option<u64>) -> Option<&mut usize> {
        match region {
            Some(STRINGS) => Some(&mut self.strings),
            Some(NUMBERS) => Some(&mut self.numbers),
            Some(_) => None,
            None => Some(&mut self.other),
        }
    }

    /// Add the row `id` with insertion `ordinal`.
    pub(crate) fn insert(&mut self, id: &str, ordinal: u64, entity: &Value) {
        let entry = self.entry(id, ordinal, entity);
        if let Some(counter) = self.counter(entry.as_ref().map(|entry| entry.0)) {
            *counter += 1;
        }
        if let Some(entry) = entry {
            self.entries.insert(entry);
        }
    }

    /// Remove the row `id` indexed with `ordinal` and value `entity`.
    pub(crate) fn remove(&mut self, id: &str, ordinal: u64, entity: &Value) {
        let entry = self.entry(id, ordinal, entity);
        let region = entry.as_ref().map(|entry| entry.0);
        let removed = match &entry {
            Some(entry) => self.entries.remove(entry),
            None => self.other > 0,
        };
        if removed {
            if let Some(counter) = self.counter(region) {
                *counter -= 1;
            }
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len() + self.other
    }

    /// Ids of rows that can satisfy `spec`, in insertion order.
    pub(crate) fn range_ids(&self, spec: &RangeSpec) -> Vec<String> {
        // Reorder by ordinal through the same set type, inserting one by one:
        // a sort or `collect` into the set would add generic sort code.
        let mut hits: BTreeSet<Entry> = BTreeSet::new();
        for interval in spec.intervals() {
            for entry in self.entries.range(interval.entry_bounds()) {
                let (ordinal, id) = ordinal_and_id(entry);
                hits.insert((ordinal, id.to_owned()));
            }
        }
        hits.into_iter().map(|(_, id)| id).collect()
    }

    /// Whether [`Self::sorted_ids`] reproduces the stable sort on this field.
    /// `strings_bytewise` is false when a string collator is registered.
    pub(crate) fn can_sort(&self, strings_bytewise: bool) -> bool {
        self.other == 0
            && (self.strings == 0 || self.numbers == 0)
            && (self.strings == 0 || strings_bytewise)
    }

    /// Row ids in the order a stable sort on the field produces: present
    /// values by key (ties in insertion order, in both directions), then
    /// missing/null rows in insertion order. With `spec`, only rows that can
    /// satisfy it are returned (rows without a value never can).
    ///
    /// Callers must check [`Self::can_sort`] first, which guarantees that the
    /// present values are all numbers or all strings.
    pub(crate) fn sorted_ids<'a>(
        &'a self,
        order: &SortOrder,
        spec: Option<&RangeSpec>,
    ) -> Box<dyn Iterator<Item = &'a str> + 'a> {
        let ranges: Vec<btree_set::Range<'a, Entry>> = match spec {
            Some(spec) => spec
                .intervals()
                .map(|interval| self.entries.range(interval.entry_bounds()))
                .collect(),
            None => vec![self
                .entries
                .range((Bound::Unbounded, Bound::Excluded((ABSENT, String::new()))))],
        };
        let present = ranges.into_iter().flatten();
        let absent = spec
            .is_none()
            .then(|| {
                self.entries
                    .range((Bound::Included((ABSENT, String::new())), Bound::Unbounded))
                    .map(id_of)
            })
            .into_iter()
            .flatten();
        match order {
            SortOrder::Asc => Box::new(present.map(id_of).chain(absent)),
            SortOrder::Desc => Box::new(DescendingStable::new(present.rev()).chain(absent)),
        }
    }
}

/// Walks entries in reverse order but emits rows with equal keys in ascending
/// ordinal order, as a stable descending sort does.
struct DescendingStable<'a, I: Iterator<Item = &'a Entry>> {
    inner: Peekable<I>,
    run: Vec<&'a str>,
}

impl<'a, I: Iterator<Item = &'a Entry>> DescendingStable<'a, I> {
    fn new(inner: I) -> Self {
        Self {
            inner: inner.peekable(),
            run: Vec::new(),
        }
    }
}

impl<'a, I: Iterator<Item = &'a Entry>> Iterator for DescendingStable<'a, I> {
    type Item = &'a str;

    fn next(&mut self) -> Option<Self::Item> {
        if let Some(id) = self.run.pop() {
            return Some(id);
        }
        // Entries with equal keys arrive with descending ordinals. Collect the
        // run and pop it from the end to emit ascending ordinals.
        let entry = self.inner.next()?;
        let key = &entry.1[..key_len(entry)];
        self.run.push(id_of(entry));
        while let Some(next) = self.inner.peek() {
            if next.0 != entry.0 || &next.1[..key_len(next)] != key {
                break;
            }
            self.run.push(id_of(next));
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
        let num = number_key;
        let mut interval = Interval::unbounded(NUMBERS);
        interval.tighten("$gte", num(3.0));
        interval.tighten("$gt", num(3.0));
        interval.tighten("$gte", num(1.0));
        interval.tighten("$lte", num(9.0));
        interval.tighten("$lt", num(9.0));
        interval.tighten("$lte", num(12.0));
        assert_eq!(interval.lower, Bound::Excluded(num(3.0)));
        assert_eq!(interval.upper, Bound::Excluded(num(9.0)));
        assert!(!interval.is_empty());
        interval.tighten("$lt", num(3.0));
        assert!(interval.is_empty());
    }

    #[test]
    fn point_interval_is_empty_unless_both_bounds_include_it() {
        let text = string_key;
        let mut interval = Interval::unbounded(STRINGS);
        interval.tighten("$gte", text("m"));
        interval.tighten("$lte", text("m"));
        assert!(!interval.is_empty());
        interval.tighten("$lt", text("m"));
        assert!(interval.is_empty());
    }

    #[test]
    fn extract_reads_top_level_and_nested_and() {
        let spec = spec(json!({
            "at": {"$gte": "2020"},
            "$and": [{"at": {"$lt": "2021"}}, {"$and": [{"at": {"$gt": 4}}]}],
            "$or": [{"at": {"$lt": "1999"}}],
        }));
        assert_eq!(spec.strings.lower, Bound::Included(string_key("2020")));
        assert_eq!(spec.strings.upper, Bound::Excluded(string_key("2021")));
        assert_eq!(spec.numbers.lower, Bound::Excluded(number_key(4.0)));
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
        other.remove("b", 1, &json!({"at": false}));
        assert!(other.can_sort(false), "numbers ignore the collator");
    }

    #[test]
    fn remove_and_insert_move_a_row_to_its_new_key() {
        let mut index = index(&[("x", json!({"at": 1})), ("y", json!({"at": 2}))]);
        index.remove("x", 0, &json!({"at": 1}));
        index.insert("x", 0, &json!({"at": 3}));
        assert_eq!(
            index.sorted_ids(&SortOrder::Asc, None).collect::<Vec<_>>(),
            vec!["y", "x"]
        );
        index.remove("y", 1, &json!({"at": 2}));
        index.remove("y", 1, &json!({"at": 2}));
        assert_eq!(index.len(), 1);
        assert_eq!(
            index.range_ids(&spec(json!({"at": {"$lt": 10}}))),
            vec!["x"]
        );
    }

    #[test]
    fn encoded_keys_preserve_value_order() {
        let numbers = [
            f64::NEG_INFINITY,
            -1e300,
            -2.5,
            -1.0,
            -f64::MIN_POSITIVE,
            0.0,
            f64::MIN_POSITIVE,
            0.5,
            1.0,
            2.0,
            1e300,
            f64::INFINITY,
        ];
        for pair in numbers.windows(2) {
            assert!(number_key(pair[0]) < number_key(pair[1]), "{pair:?}");
        }
        assert_eq!(number_key(-0.0), number_key(0.0));
        let strings = [
            "",
            "\0",
            "\0\0",
            "\0\u{1}",
            "\u{1}",
            "a",
            "a\0",
            "a\0b",
            "a\u{1}",
            "aa",
            "b",
            "é",
            "\u{10000}",
        ];
        for pair in strings.windows(2) {
            assert!(pair[0] < pair[1], "fixture order {pair:?}");
            assert!(string_key(pair[0]) < string_key(pair[1]), "{pair:?}");
            // `key ++ "g"` stays below the next key, so exclusive bounds hold.
            assert!(format!("{}g", string_key(pair[0])) < string_key(pair[1]));
        }
    }

    #[test]
    fn ids_and_ordinals_round_trip_through_entries_with_nul_bytes() {
        let index = index(&[
            ("id-with-\0", json!({"at": "x\0y"})),
            ("plain", json!({"at": "x"})),
            ("n", json!({"at": 3})),
            ("gone", json!({})),
        ]);
        assert_eq!(
            index.sorted_ids(&SortOrder::Desc, None).collect::<Vec<_>>(),
            vec!["id-with-\0", "plain", "n", "gone"]
        );
        assert_eq!(
            index.range_ids(&spec(json!({"at": {"$gt": "x"}}))),
            vec!["id-with-\0", "n"]
        );
    }
}
