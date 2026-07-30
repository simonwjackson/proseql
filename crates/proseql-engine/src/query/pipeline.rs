//! Query pipeline — combines computed, filter, sort, paginate, cursor, and select
//! into a single synchronous query over a [`Collection`].
//!
//! # Pipeline order (mirrors TS)
//!
//! ```text
//! 1. Collect all entities in insertion order (optionally narrowed by indexes)
//! 2. Resolve computed fields          ← needed before filter/sort
//! 3. Apply where filter
//! 4. Apply sort (or relevance sort when top-level $search with no explicit sort)
//! 5. Apply offset/limit  OR  cursor pagination
//! 6. Apply field selection
//! ```
//!
//! # Index narrowing
//!
//! Before step 1 the pipeline tries to narrow the candidate set via
//! `collection.narrow_candidates()` (the stable contract that hides index internals):
//! 1. Equality index (when where clause has equality conditions on indexed fields).
//! 2. Full-text search index (when all queried fields are covered).
//!
//! The full where-clause filter still runs on the candidate set — narrowing is
//! a fast pre-filter that guarantees no false negatives (matches always pass the
//! full filter).
//!
//! # Search relevance scoring
//!
//! When the where clause contains a top-level `$search` operator:
//! - After filtering, each entity is annotated with `_searchScore` (f64).
//! - When no explicit sort is given, entities are sorted by score descending.
//! - When an explicit sort is given, that sort is applied; `_searchScore` stays
//!   as metadata on the entity (accessible unless select removes it).
//!
//! Mirrors `attachSearchScores` + `applyRelevanceSort` from
//! `packages/core/src/operations/query/sort-stream.ts`.
//!
//! # Cursor sort validation
//!
//! When cursor pagination is used with an explicit `input.sort`:
//! - The primary sort field must match `cursor_cfg.key`.
//! - Mismatch → `ValidationError` matching the TS factory error payload.
//! - No explicit sort → implicit `{cursor_key: "asc"}` is injected.
//!
//! # No panics
//!
//! Calling `execute_query` with `input.cursor.is_some()` returns a typed
//! `OperationError` instead of panicking.  Use `execute_cursor_query` for
//! cursor pagination.

use std::sync::Arc;

use serde_json::Value;

use crate::callbacks::CallbackRegistry;
use crate::collection::Collection;
use crate::errors::{EngineError, OperationError, ValidationError, ValidationIssue};

use super::aggregate::{
    compute_aggregates, compute_grouped_aggregates, AggregateConfig, AggregateResult, GroupResult,
};
use super::computed::resolve_computed_for_all;
use super::cursor::{apply_cursor, CursorConfig, CursorPageResult};
use super::filter::matches_where_with_registry;
use super::paginate::paginate;
use super::search::{compute_search_score, extract_search_config, resolve_score_fields, tokenize};
use super::select::apply_selection;
use super::sort::{sort_entities_with_registry, SortEntry, SortOrder};

/// Metadata key attached to entities during search scoring.
///
/// Mirrors `SEARCH_SCORE_KEY = "_searchScore"` from
/// `packages/core/src/types/search-types.ts`.
const SEARCH_SCORE_KEY: &str = "_searchScore";

// ── Query input ───────────────────────────────────────────────────────────────

/// Full query configuration (mirrors TS `db.collection.query(options)`).
#[derive(Debug, Default, Clone)]
pub struct QueryInput {
    /// Where clause for filtering.
    pub r#where: Option<Value>,
    /// Sort order: `[ ("field", SortOrder), ... ]` in priority order.
    pub sort: Vec<SortEntry>,
    /// Number of entities to skip.
    pub offset: Option<usize>,
    /// Maximum number of entities to return.
    pub limit: Option<usize>,
    /// Cursor pagination configuration (takes priority over offset/limit).
    pub cursor: Option<CursorConfig>,
    /// Field selection (`None` → all fields).
    pub select: Option<Value>,
}

// ── Query on Collection ───────────────────────────────────────────────────────

/// Execute a synchronous query over a `Collection`.
///
/// **Panics removed**: if `input.cursor` is `Some`, returns a typed
/// `OperationError` instructing the caller to use `execute_cursor_query`.
pub fn execute_query(
    collection: &Collection,
    input: &QueryInput,
    registry: &Arc<CallbackRegistry>,
) -> Result<Vec<Value>, EngineError> {
    // Guard: cursor pagination needs execute_cursor_query
    if input.cursor.is_some() {
        return Err(EngineError::Operation(OperationError {
            operation: "query".to_string(),
            reason: "cursor pagination requires execute_cursor_query".to_string(),
            message: "A cursor was provided to execute_query. Use execute_cursor_query for cursor \
                 pagination."
                .to_string(),
        }));
    }

    // 1. Collect candidates — try index narrowing first
    let candidates = collect_candidates(collection, &input.r#where);

    // 2. Resolve computed fields
    let with_computed = resolve_computed_for_all(
        &candidates,
        &collection.descriptor.computed_fields,
        registry,
    )?;

    // 3. Filter
    let filtered: Vec<Value> = match &input.r#where {
        None => with_computed,
        Some(w) => with_computed
            .into_iter()
            .filter(|e| matches_where_with_registry(e, w, Some(registry.as_ref())))
            .collect(),
    };

    // 4. Search scoring + sort (registry used for registered string collation)
    let sorted = sort_with_scoring(filtered, &input.r#where, &input.sort, Some(registry));

    // 5. Paginate (offset/limit)
    let paginated = paginate(&sorted, input.offset, input.limit);

    // 6. Select
    let result: Vec<Value> = paginated
        .iter()
        .map(|e| apply_selection(e, input.select.as_ref()))
        .collect();

    Ok(result)
}

/// Execute a cursor-paginated query over a `Collection`.
///
/// # Cursor sort validation
///
/// When `input.sort` is non-empty, the primary sort field must match
/// `cursor_cfg.key`, or a `ValidationError` is returned.
///
/// Mirrors the validation in `database-effect.ts`:
/// ```ts
/// if (primarySortKey !== cursorKey) {
///   return new ValidationError({
///     message: "Invalid cursor configuration",
///     issues: [{ field: "cursor.key",
///                message: `cursor key '${cursorKey}' must match primary sort field '${primarySortKey}'` }]
///   });
/// }
/// ```
pub fn execute_cursor_query(
    collection: &Collection,
    input: &QueryInput,
    cursor_cfg: &CursorConfig,
    registry: &Arc<CallbackRegistry>,
) -> Result<CursorPageResult, EngineError> {
    // Determine effective sort — validate if caller provided one
    let effective_sort: Vec<SortEntry> = if input.sort.is_empty() {
        // Default: ascending by cursor key (mirrors TS `effectiveSort = { [cursorKey]: "asc" }`)
        vec![(cursor_cfg.key.clone(), SortOrder::Asc)]
    } else {
        // Validate primary sort key matches cursor key
        let primary = &input.sort[0].0;
        if primary != &cursor_cfg.key {
            return Err(EngineError::Validation(ValidationError {
                message: "Invalid cursor configuration".to_string(),
                issues: vec![ValidationIssue {
                    field: "cursor.key".to_string(),
                    message: format!(
                        "cursor key '{}' must match primary sort field '{}'",
                        cursor_cfg.key, primary
                    ),
                    value: None,
                    expected: None,
                    received: None,
                }],
            }));
        }
        input.sort.clone()
    };

    // 1. Collect candidates
    let candidates = collect_candidates(collection, &input.r#where);

    // 2. Resolve computed fields
    let with_computed = resolve_computed_for_all(
        &candidates,
        &collection.descriptor.computed_fields,
        registry,
    )?;

    // 3. Filter
    let filtered: Vec<Value> = match &input.r#where {
        None => with_computed,
        Some(w) => with_computed
            .into_iter()
            .filter(|e| matches_where_with_registry(e, w, Some(registry.as_ref())))
            .collect(),
    };

    // 4. Attach search scores (mirrors TS cursor branch: attachSearchScores before sort)
    //    When top-level $search is present, scores are annotated before sort so that
    //    they are available as metadata on result items (even if the cursor's explicit
    //    sort takes precedence over relevance ordering).
    let filtered_with_scores = attach_search_scores(filtered, &input.r#where);

    // 5. Sort by effective_sort (cursor uses explicit sort or default asc-by-key)
    let mut sorted = filtered_with_scores;
    sort_entities_with_registry(&mut sorted, &effective_sort, Some(registry));

    // 5b. Cursor pagination
    let mut cursor_result = apply_cursor(&sorted, cursor_cfg)?;

    // 6. Select
    cursor_result.items = cursor_result
        .items
        .iter()
        .map(|e| apply_selection(e, input.select.as_ref()))
        .collect();

    Ok(cursor_result)
}

/// Execute an aggregate query (scalar) over a `Collection`.
pub fn execute_aggregate(
    collection: &Collection,
    where_clause: Option<&Value>,
    config: &AggregateConfig,
    registry: &Arc<CallbackRegistry>,
) -> Result<AggregateResult, EngineError> {
    let candidates = collect_candidates(collection, &where_clause.cloned());
    let with_computed = resolve_computed_for_all(
        &candidates,
        &collection.descriptor.computed_fields,
        registry,
    )?;
    let filtered: Vec<Value> = match where_clause {
        None => with_computed,
        Some(w) => with_computed
            .into_iter()
            .filter(|e| matches_where_with_registry(e, w, Some(registry.as_ref())))
            .collect(),
    };
    Ok(compute_aggregates(&filtered, config))
}

/// Execute a grouped aggregate query over a `Collection`.
pub fn execute_grouped_aggregate(
    collection: &Collection,
    where_clause: Option<&Value>,
    group_by: &[String],
    config: &AggregateConfig,
    registry: &Arc<CallbackRegistry>,
) -> Result<Vec<GroupResult>, EngineError> {
    let candidates = collect_candidates(collection, &where_clause.cloned());
    let with_computed = resolve_computed_for_all(
        &candidates,
        &collection.descriptor.computed_fields,
        registry,
    )?;
    let filtered: Vec<Value> = match where_clause {
        None => with_computed,
        Some(w) => with_computed
            .into_iter()
            .filter(|e| matches_where_with_registry(e, w, Some(registry.as_ref())))
            .collect(),
    };
    Ok(compute_grouped_aggregates(&filtered, group_by, config))
}

/// Helper: build a `QueryInput` from individual params.
///
/// Used by tests.
pub fn query_input(
    where_clause: Option<Value>,
    sort: Vec<(&str, &str)>,
    offset: Option<usize>,
    limit: Option<usize>,
    select: Option<Value>,
) -> QueryInput {
    QueryInput {
        r#where: where_clause,
        sort: sort
            .into_iter()
            .filter_map(|(f, o)| SortOrder::parse(o).map(|s| (f.to_string(), s)))
            .collect(),
        offset,
        limit,
        cursor: None,
        select,
    }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// Collect entities from the collection, optionally narrowing via query indexes.
///
/// Delegates to [`Collection::narrow_candidates`] — the stable public contract
/// that hides index internals.  The full where-clause filter is NOT applied
/// here; callers always run the predicate on the returned candidates.
///
/// Order: candidates are returned in insertion order regardless of index narrowing.
fn collect_candidates(collection: &Collection, where_clause: &Option<Value>) -> Vec<Value> {
    if let Some(ref w) = where_clause {
        // Delegate to the stable index contract on Collection
        if let Some(ids) = collection.narrow_candidates(w) {
            return ids
                .iter()
                .filter_map(|id| collection.get(id).cloned())
                .collect();
        }
    }

    // Fall through: full scan in insertion order
    collection.list().into_iter().cloned().collect()
}

/// Attach `_searchScore` to each entity when the where clause contains a
/// top-level `$search` operator.
///
/// Mirrors `attachSearchScores` from `sort-stream.ts`.  Returns the
/// entities unchanged (no `_searchScore` key added) when no top-level
/// `$search` is present.
fn attach_search_scores(entities: Vec<Value>, where_clause: &Option<Value>) -> Vec<Value> {
    let Some(sc) = extract_search_config(where_clause) else {
        return entities;
    };
    let query_tokens = tokenize(&sc.query);
    if query_tokens.is_empty() {
        return entities;
    }
    entities
        .into_iter()
        .map(|e| {
            let fields = resolve_score_fields(&e, &sc.fields);
            let score = compute_search_score(&e, &query_tokens, &fields);
            let mut obj = e.as_object().cloned().unwrap_or_default();
            obj.insert(SEARCH_SCORE_KEY.to_string(), serde_json::Value::from(score));
            Value::Object(obj)
        })
        .collect()
}

/// Apply search scoring and sort in the correct order.
///
/// Pipeline (mirrors `sort-stream.ts` + `attachSearchScores`):
/// 1. If top-level `$search` is present → compute `_searchScore` for each entity.
/// 2. If explicit sort is given → sort by those fields (using registered collator).
/// 3. If no explicit sort AND search scoring → sort by `_searchScore` descending.
/// 4. If no explicit sort AND no search → preserve filter order.
fn sort_with_scoring(
    entities: Vec<Value>,
    where_clause: &Option<Value>,
    sort: &[SortEntry],
    registry: Option<&CallbackRegistry>,
) -> Vec<Value> {
    let search_cfg = extract_search_config(where_clause);

    match search_cfg {
        Some(_) => {
            // Attach scores first (shared helper also used by cursor path)
            let mut scored = attach_search_scores(entities, where_clause);

            if !sort.is_empty() {
                // Explicit sort: use registered collator if available
                sort_entities_with_registry(&mut scored, sort, registry);
            } else {
                // Default relevance sort: higher score first (descending)
                scored.sort_by(|a, b| {
                    let sa = a
                        .get(SEARCH_SCORE_KEY)
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    let sb = b
                        .get(SEARCH_SCORE_KEY)
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    // Descending: sb.partial_cmp(sa)
                    // Stable: ties preserve prior order (Rust sort_by is stable)
                    sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
                });
            }

            scored
        }
        None => {
            // No search: apply explicit sort or preserve order (with registered collator)
            let mut entities = entities;
            if !sort.is_empty() {
                sort_entities_with_registry(&mut entities, sort, registry);
            }
            entities
        }
    }
}

/// Convenience: extract `_searchScore` from a scored entity.
///
/// Exposed for tests.
pub fn search_score(entity: &Value) -> Option<f64> {
    entity.get(SEARCH_SCORE_KEY).and_then(|v| v.as_f64())
}
