//! Query-time acceleration indexes for the proseQL engine (U3 — R1).
//!
//! Maintains two kinds of indexes derived from [`CollectionDescriptor`]:
//!
//! ## Equality indexes (`descriptor.indexes`)
//!
//! For each `IndexDescriptor::Single(field)` and
//! `IndexDescriptor::Compound(fields)`, an inverted map:
//!
//! ```text
//! index_key_str → Vec<entity_id>   (insertion-ordered per group)
//! ```
//!
//! Candidate narrowing extracts equality conditions from the where clause
//! (`{field: value}` or `{field: {"$eq": value}}`) and returns the intersection
//! of candidate sets.
//!
//! ## Full-text search index (`descriptor.search_index`)
//!
//! Inverted index: `token → HashSet<entity_id>`.
//!
//! Candidate narrowing is used only when the where clause contains `$search`
//! and **all** queried fields are covered by the search index (mirrors
//! `resolveWithSearchIndex` in `packages/core/src/indexes/search-index.ts`).
//!
//! ## Insertion order
//!
//! The narrowed candidate set is returned as an ordered `Vec<String>` whose
//! order matches the collection's insertion order.  The pipeline always applies
//! the full where-clause filter on the candidate set afterward.
//!
//! ## Maintenance
//!
//! Indexes are rebuilt from scratch after every successful atomic mutation.
//! This is O(n) per mutation and correct for all collection sizes at U3 scope.
//! A per-mutation incremental approach (O(delta)) can replace this later.
//!
//! ## TS references
//! - `packages/core/src/indexes/index-manager.ts` — equality index shape
//! - `packages/core/src/indexes/search-index.ts` — full-text inverted index
//! - `packages/core/src/factories/database-effect.ts` — candidate narrowing
//!   (`resolveWithIndex`, `resolveWithSearchIndex`)

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::descriptor::IndexDescriptor;

use super::filter::get_nested_value;
use super::search::tokenize;

// ── Index structures ──────────────────────────────────────────────────────────

/// Acceleration indexes for query candidate narrowing.
///
/// Rebuilt after every atomic mutation via [`QueryIndexes::rebuild`].
#[derive(Debug, Default)]
pub struct QueryIndexes {
    /// Equality index entries, one per `IndexDescriptor`.
    ///
    /// Each entry: `(fields_key, { serialized_value_key → Vec<entity_id> })`.
    /// `fields_key` = field names joined by `"\0"` (unique per descriptor entry).
    equality: Vec<EqualityIndex>,
    /// Full-text inverted index: token → set of entity ids.
    search: HashMap<String, HashSet<String>>,
    /// Fields covered by the search index.
    search_fields: Vec<String>,
}

struct EqualityIndex {
    /// Single-element for `Single`, multiple for `Compound`.
    fields: Vec<String>,
    /// Serialized value key → entity ids (in insertion order).
    map: HashMap<String, Vec<String>>,
}

impl std::fmt::Debug for EqualityIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EqualityIndex")
            .field("fields", &self.fields)
            .field("map_len", &self.map.len())
            .finish()
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

impl QueryIndexes {
    /// Create empty indexes.
    pub fn new() -> Self {
        Self::default()
    }

    /// Rebuild all indexes from the current entity snapshot.
    ///
    /// `entities` is an ordered slice of `(id, entity_ref)` pairs in insertion order.
    pub fn rebuild(
        &mut self,
        entities: &[(String, &Value)],
        index_descriptors: &[IndexDescriptor],
        search_fields: &[String],
    ) {
        // ── Equality indexes ──────────────────────────────────────────────────
        self.equality = index_descriptors
            .iter()
            .map(|desc| {
                let fields = match desc {
                    IndexDescriptor::Single(f) => vec![f.clone()],
                    IndexDescriptor::Compound(fs) => fs.clone(),
                };
                let mut map: HashMap<String, Vec<String>> = HashMap::new();
                for (id, entity) in entities {
                    if let Some(key) = equality_key(entity, &fields) {
                        map.entry(key).or_default().push(id.clone());
                    }
                }
                EqualityIndex { fields, map }
            })
            .collect();

        // ── Search index ──────────────────────────────────────────────────────
        self.search_fields = search_fields.to_vec();
        self.search.clear();
        if !search_fields.is_empty() {
            for (id, entity) in entities {
                for field in search_fields {
                    if let Some(Value::String(s)) = get_nested_value(entity, field) {
                        for token in tokenize(s) {
                            self.search.entry(token).or_default().insert(id.clone());
                        }
                    }
                }
            }
        }
    }

    /// Try to narrow entity ids using equality conditions from the where clause.
    ///
    /// Returns `Some(ordered_ids)` when at least one index matches all its
    /// fields with equality conditions.  Returns `None` when no index is
    /// applicable (caller falls through to full scan).
    ///
    /// When multiple indexes are applicable, the index covering the most fields
    /// is used. `$in` candidates preserve condition-value order and then the
    /// insertion order within each index bucket, matching JavaScript `Set` union
    /// semantics in `packages/core/src/indexes/index-lookup.ts`.
    pub fn narrow_by_equality(
        &self,
        where_clause: &Value,
        _insertion_order: &[String],
    ) -> Option<Vec<String>> {
        let where_obj = where_clause.as_object()?;
        if where_obj.contains_key("$or")
            || where_obj.contains_key("$and")
            || where_obj.contains_key("$not")
        {
            return None;
        }

        let mut best: Option<(usize, Vec<String>)> = None;
        for idx in &self.equality {
            let conditions: Option<Vec<Vec<&Value>>> = idx
                .fields
                .iter()
                .map(|field| extract_equality_values(where_obj, field))
                .collect();
            let Some(conditions) = conditions else {
                continue;
            };

            if best
                .as_ref()
                .is_some_and(|(field_count, _)| *field_count >= idx.fields.len())
            {
                continue;
            }

            let mut combinations: Vec<Vec<&Value>> = vec![Vec::new()];
            for values in conditions {
                let mut next = Vec::new();
                for combination in &combinations {
                    for value in &values {
                        let mut extended = combination.clone();
                        extended.push(*value);
                        next.push(extended);
                    }
                }
                combinations = next;
            }

            let mut candidates = Vec::new();
            let mut seen = HashSet::new();
            for combination in combinations {
                let lookup_key = combination
                    .into_iter()
                    .map(canonical_index_part)
                    .collect::<Vec<_>>()
                    .join("\x00");
                if let Some(ids) = idx.map.get(&lookup_key) {
                    for id in ids {
                        if seen.insert(id.clone()) {
                            candidates.push(id.clone());
                        }
                    }
                }
            }
            best = Some((idx.fields.len(), candidates));
        }

        best.map(|(_, candidates)| candidates)
    }

    /// Try to narrow entity ids using the full-text search index.
    ///
    /// Returns `Some(ordered_ids)` when:
    /// - The where clause contains a `$search` condition (top-level or field-level)
    /// - All searched fields are covered by the search index
    /// - The query tokenizes to at least one token
    ///
    /// Returns `None` when the search index cannot be applied.
    ///
    /// Mirrors `resolveWithSearchIndex` from
    /// `packages/core/src/indexes/search-index.ts`.
    pub fn narrow_by_search(
        &self,
        where_clause: &Value,
        insertion_order: &[String],
    ) -> Option<Vec<String>> {
        if self.search_fields.is_empty() || self.search.is_empty() {
            return None;
        }

        let (query, queried_fields) = extract_search_condition(where_clause)?;
        let tokens = tokenize(&query);
        if tokens.is_empty() {
            return None; // empty query matches all — no index help
        }

        // Check all queried fields are covered by the index
        let covered = queried_fields
            .iter()
            .all(|f| self.search_fields.contains(f));
        if !covered {
            return None;
        }

        // Intersect candidate sets across all tokens
        let mut candidate_ids: Option<HashSet<String>> = None;
        for token in &tokens {
            // Exact + prefix matches
            let mut token_matches: HashSet<String> = HashSet::new();
            for (idx_token, ids) in &self.search {
                if idx_token == token || idx_token.starts_with(token.as_str()) {
                    token_matches.extend(ids.iter().cloned());
                }
            }

            candidate_ids = Some(match candidate_ids {
                None => token_matches,
                Some(prev) => prev.intersection(&token_matches).cloned().collect(),
            });
        }

        let id_set = candidate_ids.unwrap_or_default();
        let ordered: Vec<String> = insertion_order
            .iter()
            .filter(|id| id_set.contains(id.as_str()))
            .cloned()
            .collect();

        Some(ordered)
    }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// Build a composite key from an entity's field values for an equality index.
///
/// Returns `None` if any field is absent.
///
/// Numeric values are canonicalized via f64 so that `1` and `1.0` produce the
/// same key — JSON integers and floats have the same JS identity (`1 === 1.0`).
fn equality_key(entity: &Value, fields: &[String]) -> Option<String> {
    let parts: Option<Vec<String>> = fields
        .iter()
        .map(|f| {
            let v = get_nested_value(entity, f)?;
            Some(canonical_index_part(v))
        })
        .collect();
    Some(parts?.join("\x00"))
}

/// Produce a canonical string representation of a value for use in index keys.
///
/// Numbers are canonicalized via `f64` so that the integer serde representation
/// `1` and the float representation `1.0` collapse to the same string, matching
/// JS `1 === 1.0`.  All other types use `serde_json::to_string`.
fn canonical_index_part(v: &Value) -> String {
    if let Some(n) = v.as_f64() {
        // Use the same repr regardless of whether serde parsed `1` or `1.0`.
        // Format without trailing zeros when the value is integral.
        if n.fract() == 0.0 && n.is_finite() {
            return format!("{}", n as i64);
        }
        return format!("{}", n);
    }
    serde_json::to_string(v).unwrap_or_default()
}

/// Extract direct, `$eq`, or `$in` values from a where-clause field.
fn extract_equality_values<'a>(
    where_obj: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Option<Vec<&'a Value>> {
    let value = where_obj.get(field)?;
    let Value::Object(operators) = value else {
        return Some(vec![value]);
    };

    if !operators.keys().any(|key| key.starts_with('$')) {
        return Some(vec![value]);
    }
    if operators.len() != 1 {
        return None;
    }
    if let Some(equal) = operators.get("$eq") {
        return Some(vec![equal]);
    }
    operators
        .get("$in")?
        .as_array()
        .map(|values| values.iter().collect())
}

/// Extract a `(query_string, fields)` pair from a where clause if it contains
/// a `$search` condition.
///
/// Looks for:
/// 1. Top-level `$search: { query: "...", fields?: [...] }` — uses explicit fields or
///    falls back to the search index fields (passed via `self.search_fields`).
/// 2. Field-level `fieldName: { $search: "..." }` — `fields = [fieldName]`.
///
/// Returns `None` if no valid `$search` is found.
fn extract_search_condition(where_clause: &Value) -> Option<(String, Vec<String>)> {
    let where_obj = where_clause.as_object()?;

    // Top-level $search
    if let Some(sv) = where_obj.get("$search") {
        if let Some(obj) = sv.as_object() {
            let query = obj.get("query")?.as_str()?.to_string();
            let fields: Vec<String> = obj
                .get("fields")
                .and_then(|f| f.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            return Some((query, fields));
        }
    }

    // Field-level $search
    for (field, value) in where_obj {
        if field.starts_with('$') {
            continue;
        }
        if let Some(ops) = value.as_object() {
            if let Some(sq) = ops.get("$search").and_then(|v| v.as_str()) {
                return Some((sq.to_string(), vec![field.clone()]));
            }
        }
    }

    None
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::descriptor::IndexDescriptor;

    // ── Equality index ────────────────────────────────────────────────────────

    #[test]
    fn single_field_equality_narrow() {
        let data: Vec<(String, Value)> = vec![
            ("e1".to_string(), json!({"genre":"sci-fi","title":"Dune"})),
            (
                "e2".to_string(),
                json!({"genre":"fantasy","title":"Hobbit"}),
            ),
            (
                "e3".to_string(),
                json!({"genre":"sci-fi","title":"Foundation"}),
            ),
        ];
        let descs = vec![IndexDescriptor::Single("genre".to_string())];
        let idx = {
            let mut i = QueryIndexes::new();
            let refs: Vec<(String, &Value)> = data.iter().map(|(id, v)| (id.clone(), v)).collect();
            i.rebuild(&refs, &descs, &[]);
            i
        };
        let insertion_order: Vec<String> = data.iter().map(|(id, _)| id.clone()).collect();
        let candidates = idx
            .narrow_by_equality(&json!({"genre": "sci-fi"}), &insertion_order)
            .unwrap();
        assert_eq!(candidates, vec!["e1", "e3"]);
    }

    #[test]
    fn in_narrow_preserves_condition_then_index_insertion_order() {
        let data: Vec<(String, Value)> = vec![
            ("moderator-1".to_string(), json!({"role":"moderator"})),
            ("admin-1".to_string(), json!({"role":"admin"})),
            ("moderator-2".to_string(), json!({"role":"moderator"})),
        ];
        let descs = vec![IndexDescriptor::Single("role".to_string())];
        let idx = {
            let mut i = QueryIndexes::new();
            let refs: Vec<(String, &Value)> = data.iter().map(|(id, v)| (id.clone(), v)).collect();
            i.rebuild(&refs, &descs, &[]);
            i
        };
        let insertion_order: Vec<String> = data.iter().map(|(id, _)| id.clone()).collect();

        let candidates = idx
            .narrow_by_equality(
                &json!({"role": {"$in": ["admin", "moderator"]}}),
                &insertion_order,
            )
            .unwrap();

        assert_eq!(candidates, vec!["admin-1", "moderator-1", "moderator-2"]);
    }

    #[test]
    fn equality_narrow_returns_none_when_no_index_matches() {
        let data: Vec<(String, Value)> = vec![("e1".to_string(), json!({"genre":"sci-fi"}))];
        let descs = vec![IndexDescriptor::Single("genre".to_string())];
        let idx = {
            let mut i = QueryIndexes::new();
            let refs: Vec<(String, &Value)> = data.iter().map(|(id, v)| (id.clone(), v)).collect();
            i.rebuild(&refs, &descs, &[]);
            i
        };
        let insertion_order: Vec<String> = data.iter().map(|(id, _)| id.clone()).collect();
        // Filter on "title" which is not indexed
        let result = idx.narrow_by_equality(&json!({"title": {"$gt": "A"}}), &insertion_order);
        assert!(result.is_none());
    }

    #[test]
    fn compound_equality_narrow() {
        let data: Vec<(String, Value)> = vec![
            ("s1".to_string(), json!({"userId":"u1","key":"theme"})),
            ("s2".to_string(), json!({"userId":"u1","key":"lang"})),
            ("s3".to_string(), json!({"userId":"u2","key":"theme"})),
        ];
        let descs = vec![IndexDescriptor::Compound(vec![
            "userId".to_string(),
            "key".to_string(),
        ])];
        let idx = {
            let mut i = QueryIndexes::new();
            let refs: Vec<(String, &Value)> = data.iter().map(|(id, v)| (id.clone(), v)).collect();
            i.rebuild(&refs, &descs, &[]);
            i
        };
        let insertion_order: Vec<String> = data.iter().map(|(id, _)| id.clone()).collect();
        let candidates = idx
            .narrow_by_equality(&json!({"userId": "u1", "key": "theme"}), &insertion_order)
            .unwrap();
        assert_eq!(candidates, vec!["s1"]);
    }

    #[test]
    fn equality_narrow_eq_operator() {
        let data: Vec<(String, Value)> = vec![
            ("e1".to_string(), json!({"cat":"a"})),
            ("e2".to_string(), json!({"cat":"b"})),
        ];
        let descs = vec![IndexDescriptor::Single("cat".to_string())];
        let idx = {
            let mut i = QueryIndexes::new();
            let refs: Vec<(String, &Value)> = data.iter().map(|(id, v)| (id.clone(), v)).collect();
            i.rebuild(&refs, &descs, &[]);
            i
        };
        let insertion_order: Vec<String> = data.iter().map(|(id, _)| id.clone()).collect();
        // Using $eq operator explicitly
        let candidates = idx
            .narrow_by_equality(&json!({"cat": {"$eq": "a"}}), &insertion_order)
            .unwrap();
        assert_eq!(candidates, vec!["e1"]);
    }

    // ── Search index ──────────────────────────────────────────────────────────

    #[test]
    fn search_index_exact_token() {
        let data: Vec<(String, Value)> = vec![
            ("b1".to_string(), json!({"title":"Dune","year":1965})),
            ("b2".to_string(), json!({"title":"Neuromancer","year":1984})),
        ];
        let idx = {
            let mut i = QueryIndexes::new();
            let refs: Vec<(String, &Value)> = data.iter().map(|(id, v)| (id.clone(), v)).collect();
            i.rebuild(&refs, &[], &["title".to_string()]);
            i
        };
        let insertion_order: Vec<String> = data.iter().map(|(id, _)| id.clone()).collect();
        let candidates = idx
            .narrow_by_search(
                &json!({"$search": {"query": "dune", "fields": ["title"]}}),
                &insertion_order,
            )
            .unwrap();
        assert_eq!(candidates, vec!["b1"]);
    }

    #[test]
    fn search_index_prefix_match() {
        let data: Vec<(String, Value)> = vec![
            ("b1".to_string(), json!({"title":"Neuromancer"})),
            ("b2".to_string(), json!({"title":"Dune"})),
        ];
        let idx = {
            let mut i = QueryIndexes::new();
            let refs: Vec<(String, &Value)> = data.iter().map(|(id, v)| (id.clone(), v)).collect();
            i.rebuild(&refs, &[], &["title".to_string()]);
            i
        };
        let insertion_order: Vec<String> = data.iter().map(|(id, _)| id.clone()).collect();
        let candidates = idx
            .narrow_by_search(
                &json!({"$search": {"query": "neuro", "fields": ["title"]}}),
                &insertion_order,
            )
            .unwrap();
        assert_eq!(candidates, vec!["b1"]);
    }

    #[test]
    fn search_index_uncovered_field_returns_none() {
        let data: Vec<(String, Value)> =
            vec![("b1".to_string(), json!({"title":"Dune","author":"Herbert"}))];
        let idx = {
            let mut i = QueryIndexes::new();
            let refs: Vec<(String, &Value)> = data.iter().map(|(id, v)| (id.clone(), v)).collect();
            // Only "title" is indexed, NOT "author"
            i.rebuild(&refs, &[], &["title".to_string()]);
            i
        };
        let insertion_order: Vec<String> = data.iter().map(|(id, _)| id.clone()).collect();
        // Querying on "author" which is not indexed → None
        let result = idx.narrow_by_search(
            &json!({"$search": {"query": "herbert", "fields": ["author"]}}),
            &insertion_order,
        );
        assert!(result.is_none());
    }

    #[test]
    fn search_index_multi_token_intersection() {
        let data: Vec<(String, Value)> = vec![
            ("b1".to_string(), json!({"title":"Frank Herbert"})),
            ("b2".to_string(), json!({"title":"Frank Miller"})),
            ("b3".to_string(), json!({"title":"Herbert Ross"})),
        ];
        let idx = {
            let mut i = QueryIndexes::new();
            let refs: Vec<(String, &Value)> = data.iter().map(|(id, v)| (id.clone(), v)).collect();
            i.rebuild(&refs, &[], &["title".to_string()]);
            i
        };
        let insertion_order: Vec<String> = data.iter().map(|(id, _)| id.clone()).collect();
        // "frank herbert" → must have both tokens → only b1
        let candidates = idx
            .narrow_by_search(
                &json!({"$search": {"query": "frank herbert", "fields": ["title"]}}),
                &insertion_order,
            )
            .unwrap();
        assert_eq!(candidates, vec!["b1"]);
    }

    #[test]
    fn search_index_preserves_insertion_order() {
        let data: Vec<(String, Value)> = vec![
            ("b3".to_string(), json!({"title":"Dune Messiah"})),
            ("b1".to_string(), json!({"title":"Dune"})),
            ("b2".to_string(), json!({"title":"Children of Dune"})),
        ];
        let idx = {
            let mut i = QueryIndexes::new();
            let refs: Vec<(String, &Value)> = data.iter().map(|(id, v)| (id.clone(), v)).collect();
            i.rebuild(&refs, &[], &["title".to_string()]);
            i
        };
        let insertion_order: Vec<String> = data.iter().map(|(id, _)| id.clone()).collect();
        let candidates = idx
            .narrow_by_search(
                &json!({"$search": {"query": "dune", "fields": ["title"]}}),
                &insertion_order,
            )
            .unwrap();
        // Insertion order: b3, b1, b2
        assert_eq!(candidates, vec!["b3", "b1", "b2"]);
    }

    // ── Numeric canonicalization ─────────────────────────────────────────────
    // JS treats 1 and 1.0 as the same value; index keys must not diverge.

    #[test]
    fn integer_and_float_serde_produce_same_index_key() {
        // serde_json parses `1` as Number(PosInt(1)) and `1.0` as Number(Float(1.0));
        // without canonicalization these produce different serde_json::to_string outputs.
        let data: Vec<(String, Value)> = vec![
            // Stored with integer JSON `1`
            ("e1".to_string(), json!({"score": 1})),
        ];
        let descs = vec![IndexDescriptor::Single("score".to_string())];
        let idx = {
            let mut i = QueryIndexes::new();
            let refs: Vec<(String, &Value)> = data.iter().map(|(id, v)| (id.clone(), v)).collect();
            i.rebuild(&refs, &descs, &[]);
            i
        };
        let insertion_order: Vec<String> = data.iter().map(|(id, _)| id.clone()).collect();

        // Query with float `1.0` — must find the integer-stored entity.
        let candidates = idx
            .narrow_by_equality(&json!({"score": 1.0}), &insertion_order)
            .unwrap();
        assert_eq!(
            candidates,
            vec!["e1"],
            "integer 1 and float 1.0 must narrow to same key"
        );
    }

    #[test]
    fn float_stored_and_integer_query_match() {
        // Stored with float JSON `42.0` queried as integer `42`.
        let data: Vec<(String, Value)> = vec![("e1".to_string(), json!({"score": 42.0}))];
        let descs = vec![IndexDescriptor::Single("score".to_string())];
        let idx = {
            let mut i = QueryIndexes::new();
            let refs: Vec<(String, &Value)> = data.iter().map(|(id, v)| (id.clone(), v)).collect();
            i.rebuild(&refs, &descs, &[]);
            i
        };
        let insertion_order: Vec<String> = data.iter().map(|(id, _)| id.clone()).collect();

        let candidates = idx
            .narrow_by_equality(&json!({"score": 42}), &insertion_order)
            .unwrap();
        assert_eq!(candidates, vec!["e1"]);
    }
}
