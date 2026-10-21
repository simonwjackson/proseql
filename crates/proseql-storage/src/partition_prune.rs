//! Partition pruning: which partition keys a `where` clause can touch.
//!
//! [`PartitionFilter::from_where`] maps the conditions on the partition field
//! to intervals of partition keys (byte strings, compared like the engine
//! compares strings). It is conservative: a key outside the result cannot hold
//! a record that matches the clause, because every record lives in the file of
//! its own key (the loader rejects wrong-partition records). Any condition it
//! does not understand widens the result, never narrows it.
//!
//! Supported on the partition field: a direct value, `$eq`, `$in`, `$gt`,
//! `$gte`, `$lt`, `$lte` and `$startsWith` with string operands, combined with
//! top-level fields, `$and` and `$or`. `$not`, `$ne`, `$nin` and other
//! operators do not prune.
//!
//! Key mapping per [`PartitionKey`]:
//! - `Field`: the key is the value, so value intervals are key intervals.
//! - `TimeBucket`: the key is the first 4, 7 or 10 bytes of the timestamp.
//!   Truncation keeps byte order (`a <= b` implies `trunc(a) <= trunc(b)`), so
//!   a value interval maps to the interval of truncated bounds. An upper bound
//!   at or below the first possible timestamp of its bucket
//!   (`YYYY-01-01T00:00:00`, `YYYY-MM-01T00:00:00`, `YYYY-MM-DDT00:00:00`)
//!   excludes that bucket.
//! - `Prefix`: the key is the part before the first delimiter, which does not
//!   keep order, so only equality and `$in` prune.

use serde_json::Value;

use crate::source_config::{PartitionKey, PartitionedSourceConfig, TimeBucket};

/// Above this many intervals an intersection keeps one side unchanged, which
/// is still a superset of the exact result.
const MAX_RANGES: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Bound {
    key: Vec<u8>,
    inclusive: bool,
}

/// One interval of partition keys; `None` is unbounded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyRange {
    lo: Option<Bound>,
    hi: Option<Bound>,
}

impl KeyRange {
    fn eq(key: &[u8]) -> Self {
        Self {
            lo: Some(Bound {
                key: key.to_vec(),
                inclusive: true,
            }),
            hi: Some(Bound {
                key: key.to_vec(),
                inclusive: true,
            }),
        }
    }

    fn contains(&self, key: &[u8]) -> bool {
        let above = self.lo.as_ref().is_none_or(|lo| match key.cmp(&lo.key) {
            std::cmp::Ordering::Greater => true,
            std::cmp::Ordering::Equal => lo.inclusive,
            std::cmp::Ordering::Less => false,
        });
        let below = self.hi.as_ref().is_none_or(|hi| match key.cmp(&hi.key) {
            std::cmp::Ordering::Less => true,
            std::cmp::Ordering::Equal => hi.inclusive,
            std::cmp::Ordering::Greater => false,
        });
        above && below
    }

    fn is_empty(&self) -> bool {
        match (&self.lo, &self.hi) {
            (Some(lo), Some(hi)) => match lo.key.cmp(&hi.key) {
                std::cmp::Ordering::Greater => true,
                std::cmp::Ordering::Equal => !(lo.inclusive && hi.inclusive),
                std::cmp::Ordering::Less => false,
            },
            _ => false,
        }
    }

    fn intersect(&self, other: &Self) -> Self {
        let lo = match (&self.lo, &other.lo) {
            (None, bound) | (bound, None) => bound.clone(),
            (Some(a), Some(b)) => Some(match a.key.cmp(&b.key) {
                std::cmp::Ordering::Greater => a.clone(),
                std::cmp::Ordering::Less => b.clone(),
                std::cmp::Ordering::Equal => Bound {
                    key: a.key.clone(),
                    inclusive: a.inclusive && b.inclusive,
                },
            }),
        };
        let hi = match (&self.hi, &other.hi) {
            (None, bound) | (bound, None) => bound.clone(),
            (Some(a), Some(b)) => Some(match a.key.cmp(&b.key) {
                std::cmp::Ordering::Less => a.clone(),
                std::cmp::Ordering::Greater => b.clone(),
                std::cmp::Ordering::Equal => Bound {
                    key: a.key.clone(),
                    inclusive: a.inclusive && b.inclusive,
                },
            }),
        };
        Self { lo, hi }
    }
}

/// The partition keys a `where` clause can touch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PartitionFilter {
    /// No pruning: the clause does not constrain the partition field.
    All,
    /// Only keys inside one of these intervals (none: no key matches).
    Ranges(Vec<KeyRange>),
}

impl PartitionFilter {
    /// Map `where_clause` to partition keys for `key`. `None` or a clause
    /// without a usable partition-field condition gives [`Self::All`].
    pub fn from_where(where_clause: Option<&Value>, key: &PartitionKey) -> Self {
        match where_clause {
            Some(clause) => where_filter(clause, key),
            None => Self::All,
        }
    }

    /// `true` when the clause does not prune at all.
    pub fn is_all(&self) -> bool {
        matches!(self, Self::All)
    }

    /// `true` when a partition with `key` can hold a matching record.
    pub fn matches(&self, key: &str) -> bool {
        match self {
            Self::All => true,
            Self::Ranges(ranges) => ranges.iter().any(|range| range.contains(key.as_bytes())),
        }
    }

    fn intersect(self, other: Self) -> Self {
        match (self, other) {
            (Self::All, filter) | (filter, Self::All) => filter,
            (Self::Ranges(left), Self::Ranges(right)) => {
                if left.len().saturating_mul(right.len()) > MAX_RANGES {
                    return Self::Ranges(if left.len() <= right.len() {
                        left
                    } else {
                        right
                    });
                }
                Self::Ranges(
                    left.iter()
                        .flat_map(|a| right.iter().map(move |b| a.intersect(b)))
                        .filter(|range| !range.is_empty())
                        .collect(),
                )
            }
        }
    }

    fn union(self, other: Self) -> Self {
        match (self, other) {
            (Self::All, _) | (_, Self::All) => Self::All,
            (Self::Ranges(mut left), Self::Ranges(right)) => {
                left.extend(right);
                Self::Ranges(left)
            }
        }
    }
}

/// The partition key of a partition file path (`<root>/<key>.<format>`), or
/// `None` when the path is not a partition file of `source`.
pub fn partition_key_of_path(source: &PartitionedSourceConfig, path: &str) -> Option<String> {
    if !crate::partitioned::matches_partition_path(source, path) {
        return None;
    }
    let name = std::path::Path::new(path).file_name()?.to_str()?;
    name.strip_suffix(&format!(".{}", source.format))
        .map(str::to_owned)
}

fn where_filter(clause: &Value, key: &PartitionKey) -> PartitionFilter {
    let Some(object) = clause.as_object() else {
        return PartitionFilter::All;
    };
    let mut filter = PartitionFilter::All;
    for (name, value) in object {
        let part = match name.as_str() {
            "$and" => match value.as_array() {
                Some(children) => children
                    .iter()
                    .map(|child| where_filter(child, key))
                    .fold(PartitionFilter::All, PartitionFilter::intersect),
                None => PartitionFilter::All,
            },
            "$or" => match value.as_array() {
                // The engine matches nothing for an empty `$or`.
                Some(children) => children
                    .iter()
                    .map(|child| where_filter(child, key))
                    .fold(PartitionFilter::Ranges(vec![]), PartitionFilter::union),
                None => PartitionFilter::All,
            },
            field if field == key.field() => field_filter(value, key),
            _ => PartitionFilter::All,
        };
        filter = filter.intersect(part);
    }
    filter
}

/// One value interval on the partition field, before key mapping.
struct ValueRange {
    lo: Option<Bound>,
    hi: Option<Bound>,
    /// Both bounds are the same value (equality).
    exact: bool,
}

fn field_filter(condition: &Value, key: &PartitionKey) -> PartitionFilter {
    let Some(ops) = condition.as_object() else {
        return match condition.as_str() {
            Some(value) => map_range(&exact(value), key),
            None => PartitionFilter::All,
        };
    };
    if !ops.keys().any(|op| op.starts_with('$')) {
        // Shape-mirroring filter: never matches a string field.
        return PartitionFilter::All;
    }
    let mut filter = PartitionFilter::All;
    for (op, operand) in ops {
        let part = match (op.as_str(), operand) {
            ("$eq", Value::String(value)) => map_range(&exact(value), key),
            ("$in", Value::Array(values)) if values.iter().all(Value::is_string) => values
                .iter()
                .filter_map(Value::as_str)
                .map(|value| map_range(&exact(value), key))
                .fold(PartitionFilter::Ranges(vec![]), PartitionFilter::union),
            ("$gt" | "$gte", Value::String(value)) => map_range(
                &ValueRange {
                    lo: Some(Bound {
                        key: value.as_bytes().to_vec(),
                        inclusive: op == "$gte",
                    }),
                    hi: None,
                    exact: false,
                },
                key,
            ),
            ("$lt" | "$lte", Value::String(value)) => map_range(
                &ValueRange {
                    lo: None,
                    hi: Some(Bound {
                        key: value.as_bytes().to_vec(),
                        inclusive: op == "$lte",
                    }),
                    exact: false,
                },
                key,
            ),
            ("$startsWith", Value::String(prefix)) => {
                // Values starting with `prefix` lie in [prefix, prefix + 0xFF):
                // UTF-8 never contains the byte 0xFF.
                let mut upper = prefix.as_bytes().to_vec();
                upper.push(0xFF);
                map_range(
                    &ValueRange {
                        lo: Some(Bound {
                            key: prefix.as_bytes().to_vec(),
                            inclusive: true,
                        }),
                        hi: Some(Bound {
                            key: upper,
                            inclusive: false,
                        }),
                        exact: false,
                    },
                    key,
                )
            }
            _ => PartitionFilter::All,
        };
        filter = filter.intersect(part);
    }
    filter
}

fn exact(value: &str) -> ValueRange {
    let bound = Bound {
        key: value.as_bytes().to_vec(),
        inclusive: true,
    };
    ValueRange {
        lo: Some(bound.clone()),
        hi: Some(bound),
        exact: true,
    }
}

fn map_range(range: &ValueRange, key: &PartitionKey) -> PartitionFilter {
    match key {
        PartitionKey::Field { .. } => PartitionFilter::Ranges(vec![KeyRange {
            lo: range.lo.clone(),
            hi: range.hi.clone(),
        }]),
        PartitionKey::Prefix { delimiter, .. } => {
            let value = range.lo.as_ref().map(|bound| bound.key.as_slice());
            match value.filter(|_| range.exact).and_then(|value| {
                let text = std::str::from_utf8(value).ok()?;
                text.split_once(delimiter.as_str())
                    .map(|(prefix, _)| prefix)
            }) {
                Some(prefix) => PartitionFilter::Ranges(vec![KeyRange::eq(prefix.as_bytes())]),
                None => PartitionFilter::All,
            }
        }
        PartitionKey::TimeBucket { bucket, .. } => {
            let (len, first) = match bucket {
                TimeBucket::Year => (4, "-01-01T00:00:00"),
                TimeBucket::Month => (7, "-01T00:00:00"),
                TimeBucket::Day => (10, "T00:00:00"),
            };
            let truncate = |value: &[u8]| value[..value.len().min(len)].to_vec();
            let lo = range.lo.as_ref().map(|bound| Bound {
                key: truncate(&bound.key),
                inclusive: true,
            });
            let hi = range.hi.as_ref().map(|bound| {
                let key = truncate(&bound.key);
                // Every timestamp of bucket `key` is at least `key + first`.
                let excluded = key.len() == len && {
                    let mut start = key.clone();
                    start.extend_from_slice(first.as_bytes());
                    if bound.inclusive {
                        bound.key < start
                    } else {
                        bound.key <= start
                    }
                };
                Bound {
                    key,
                    inclusive: !excluded,
                }
            });
            PartitionFilter::Ranges(vec![KeyRange { lo, hi }])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn month() -> PartitionKey {
        PartitionKey::TimeBucket {
            field: "timestamp".into(),
            bucket: TimeBucket::Month,
        }
    }

    fn keys(filter: &PartitionFilter, candidates: &[&str]) -> Vec<String> {
        candidates
            .iter()
            .filter(|key| filter.matches(key))
            .map(|key| (*key).to_owned())
            .collect()
    }

    const MONTHS: [&str; 6] = [
        "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
    ];

    #[test]
    fn one_hour_range_touches_one_month() {
        let filter = PartitionFilter::from_where(
            Some(
                &json!({"timestamp": {"$gte": "2026-03-10T05:00:00.000Z", "$lt": "2026-03-10T06:00:00.000Z"}}),
            ),
            &month(),
        );
        assert_eq!(keys(&filter, &MONTHS), ["2026-03"]);
    }

    #[test]
    fn month_edges_stay_conservative() {
        // `2026-04-01T00:00:00.0000Z` is in April and sorts before this bound.
        let filter = PartitionFilter::from_where(
            Some(
                &json!({"timestamp": {"$gte": "2026-03-01T00:00:00.000Z", "$lt": "2026-04-01T00:00:00.000Z"}}),
            ),
            &month(),
        );
        assert_eq!(keys(&filter, &MONTHS), ["2026-03", "2026-04"]);
        // A bound at the start of a bucket's timestamps excludes the bucket.
        let filter = PartitionFilter::from_where(
            Some(&json!({"timestamp": {"$lt": "2026-04-01T00:00:00"}})),
            &month(),
        );
        assert_eq!(keys(&filter, &MONTHS), ["2026-01", "2026-02", "2026-03"]);
        let filter = PartitionFilter::from_where(
            Some(&json!({"timestamp": {"$lte": "2026-04-01T00:00:00"}})),
            &month(),
        );
        assert_eq!(
            keys(&filter, &MONTHS),
            ["2026-01", "2026-02", "2026-03", "2026-04"]
        );
    }

    #[test]
    fn open_ended_and_in() {
        let filter =
            PartitionFilter::from_where(Some(&json!({"timestamp": {"$gt": "2026-05"}})), &month());
        assert_eq!(keys(&filter, &MONTHS), ["2026-05", "2026-06"]);
        let filter = PartitionFilter::from_where(
            Some(
                &json!({"timestamp": {"$in": ["2026-02-03T00:00:00Z", "2026-06-30T23:59:59.999Z"]}}),
            ),
            &month(),
        );
        assert_eq!(keys(&filter, &MONTHS), ["2026-02", "2026-06"]);
        let filter = PartitionFilter::from_where(
            Some(
                &json!({"$or": [{"timestamp": "2026-01-01T00:00:00Z"}, {"timestamp": {"$startsWith": "2026-04"}}]}),
            ),
            &month(),
        );
        assert_eq!(keys(&filter, &MONTHS), ["2026-01", "2026-04"]);
    }

    #[test]
    fn unknown_conditions_do_not_prune() {
        for clause in [
            json!({}),
            json!({"bpm": 60}),
            json!({"timestamp": {"$ne": "2026-01-01T00:00:00Z"}}),
            json!({"$not": {"timestamp": "2026-01-01T00:00:00Z"}}),
            json!({"$or": [{"timestamp": "2026-01-01T00:00:00Z"}, {"bpm": 60}]}),
            json!({"timestamp": {"$gt": 5}}),
        ] {
            assert!(
                PartitionFilter::from_where(Some(&clause), &month()).is_all(),
                "{clause}"
            );
        }
        let filter = PartitionFilter::from_where(Some(&json!({"$or": []})), &month());
        assert!(keys(&filter, &MONTHS).is_empty());
    }

    #[test]
    fn field_and_prefix_keys() {
        let field = PartitionKey::Field {
            field: "month".into(),
        };
        let filter = PartitionFilter::from_where(
            Some(&json!({"month": {"$gt": "2026-02", "$lte": "2026-04"}})),
            &field,
        );
        assert_eq!(keys(&filter, &MONTHS), ["2026-03", "2026-04"]);
        let prefix = PartitionKey::Prefix {
            field: "id".into(),
            delimiter: ":".into(),
        };
        let filter =
            PartitionFilter::from_where(Some(&json!({"id": {"$in": ["a:1", "b:2"]}})), &prefix);
        assert_eq!(keys(&filter, &["a", "b", "c"]), ["a", "b"]);
        let filter = PartitionFilter::from_where(Some(&json!({"id": {"$gt": "a:1"}})), &prefix);
        assert!(filter.is_all());
    }
}
