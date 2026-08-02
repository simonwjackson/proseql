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
use crate::descriptor::ComputedFieldDescriptor;
use crate::errors::{EngineError, OperationError, ValidationError, ValidationIssue};

use super::aggregate::{
    compute_aggregates, compute_grouped_aggregates, AggregateConfig, AggregateResult, GroupResult,
};
use super::computed::{resolve_computed_for_all, should_resolve_computed};
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

pub struct BorrowedCompactSelection<'a> {
    pub fields: Vec<String>,
    pub columns: Vec<Vec<Option<&'a Value>>>,
}

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

    // The common unsorted path does not need owned intermediate rows. Keeping
    // candidates borrowed until after filtering and pagination avoids cloning
    // every entity merely to return a small page or selected projection. Query
    // authority remains here: indexes only narrow candidates and the complete
    // predicate still runs before offset/limit.
    if input.sort.is_empty()
        && extract_search_config(&input.r#where).is_none()
        && !should_resolve_computed(&input.select, &collection.descriptor.computed_fields)
    {
        return execute_borrowed_query(collection, input, registry.as_ref());
    }

    execute_query_over_entities(
        collect_candidates(collection, &input.r#where),
        input,
        &collection.descriptor.computed_fields,
        registry,
    )
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
pub fn execute_canonical_query_positions(
    collection: &Collection,
    input: &QueryInput,
    registry: &Arc<CallbackRegistry>,
    trust_exact_index: bool,
) -> Result<Option<Vec<usize>>, EngineError> {
    if input.cursor.is_some()
        || input.select.is_some()
        || extract_search_config(&input.r#where).is_some()
        || !collection.descriptor.computed_fields.is_empty()
    {
        return Ok(None);
    }
    let offset = input.offset.unwrap_or(0);
    let limit = input.limit.unwrap_or(usize::MAX);
    let mut positions: Vec<usize> = if let Some(where_clause) = input.r#where.as_ref() {
        if let Some((ids, posting_covers_where)) =
            collection.exact_equality_candidate_ids(where_clause)
        {
            ids.into_iter()
                .filter(|id| {
                    (trust_exact_index && posting_covers_where)
                        || collection.get(id).is_some_and(|entity| {
                            matches_where_with_registry(
                                entity,
                                where_clause,
                                Some(registry.as_ref()),
                            )
                        })
                })
                .filter_map(|id| collection.position_of(id))
                .collect()
        } else if let Some(ids) = collection.narrow_candidates(where_clause) {
            ids.into_iter()
                .filter(|id| {
                    collection.get(id).is_some_and(|entity| {
                        matches_where_with_registry(entity, where_clause, Some(registry.as_ref()))
                    })
                })
                .filter_map(|id| collection.position_of(&id))
                .collect()
        } else {
            collection
                .entries()
                .enumerate()
                .filter(|(_, (_, entity))| {
                    matches_where_with_registry(entity, where_clause, Some(registry.as_ref()))
                })
                .map(|(position, _)| position)
                .collect()
        }
    } else {
        (0..collection.len()).collect()
    };
    if !input.sort.is_empty()
        && !sort_positions_with_scalar_collation(
            collection,
            &mut positions,
            &input.sort,
            registry.as_ref(),
        )
    {
        return Ok(None);
    }
    Ok(Some(
        positions.into_iter().skip(offset).take(limit).collect(),
    ))
}

/// Sort borrowed collection positions with the same stable Rust comparator used
/// by the canonical owned pipeline. Every string comparison goes through the
/// scalar host collator, preserving comparator count, order, and first defect.
fn sort_positions_with_scalar_collation(
    collection: &Collection,
    positions: &mut [usize],
    sort: &[SortEntry],
    registry: &CallbackRegistry,
) -> bool {
    if registry.has_host_sort() {
        let rows = positions
            .iter()
            .map(|position| collection.entry_at(*position).map(|(_, row)| row))
            .collect::<Option<Vec<_>>>();
        let Some(rows) = rows else {
            return false;
        };
        let Some(order) = registry.host_sort(&rows, sort) else {
            return false;
        };
        let original = positions.to_vec();
        for (target, source) in order.into_iter().enumerate() {
            positions[target] = original[source];
        }
        return true;
    }

    let mut valid = true;
    let mut compare = |left_position: usize, right_position: usize| {
        let Some((_, left)) = collection.entry_at(left_position) else {
            valid = false;
            return std::cmp::Ordering::Equal;
        };
        let Some((_, right)) = collection.entry_at(right_position) else {
            valid = false;
            return std::cmp::Ordering::Equal;
        };
        super::sort::compare_entities(left, right, sort, Some(registry))
    };
    positions.sort_by(|left_position, right_position| compare(*left_position, *right_position));
    valid
}

pub fn execute_borrowed_compact_selection<'a>(
    collection: &'a Collection,
    input: &QueryInput,
    registry: &Arc<CallbackRegistry>,
) -> Result<Option<BorrowedCompactSelection<'a>>, EngineError> {
    if input.cursor.is_some()
        || extract_search_config(&input.r#where).is_some()
        || should_resolve_computed(&input.select, &collection.descriptor.computed_fields)
    {
        return Ok(None);
    }
    let Some(Value::Array(selected)) = input.select.as_ref() else {
        return Ok(None);
    };
    if selected.is_empty() || selected.iter().any(|field| !field.is_string()) {
        return Ok(None);
    }
    let mut fields = Vec::with_capacity(selected.len());
    for field in selected.iter().filter_map(Value::as_str) {
        if !fields.iter().any(|existing| existing == field) {
            fields.push(field.to_owned());
        }
    }
    let offset = input.offset.unwrap_or(0);
    let limit = input.limit.unwrap_or(usize::MAX);
    let capacity = limit.min(collection.len().saturating_sub(offset));
    let mut columns = fields
        .iter()
        .map(|_| Vec::with_capacity(capacity))
        .collect::<Vec<_>>();
    let mut push_entity = |entity: &'a Value| {
        for (field, column) in fields.iter().zip(&mut columns) {
            column.push(if field.contains('.') {
                super::filter::get_nested_value(entity, field)
            } else {
                entity.get(field)
            });
        }
    };
    let mut canonical_input = input.clone();
    canonical_input.select = None;
    if let Some(positions) =
        execute_canonical_query_positions(collection, &canonical_input, registry, false)?
    {
        for position in positions {
            let Some((_, entity)) = collection.entry_at(position) else {
                return Ok(None);
            };
            push_entity(entity);
        }
        return Ok(Some(BorrowedCompactSelection { fields, columns }));
    }
    if !input.sort.is_empty() {
        return Ok(None);
    }
    if let Some(where_clause) = input.r#where.as_ref() {
        for entity in borrowed_candidates(collection, Some(where_clause))
            .into_iter()
            .filter(|entity| {
                matches_where_with_registry(entity, where_clause, Some(registry.as_ref()))
            })
            .skip(offset)
            .take(limit)
        {
            push_entity(entity);
        }
    } else {
        for entity in collection
            .entries()
            .map(|(_, entity)| entity)
            .skip(offset)
            .take(limit)
        {
            push_entity(entity);
        }
    }
    Ok(Some(BorrowedCompactSelection { fields, columns }))
}

pub fn execute_cursor_query(
    collection: &Collection,
    input: &QueryInput,
    cursor_cfg: &CursorConfig,
    registry: &Arc<CallbackRegistry>,
) -> Result<CursorPageResult, EngineError> {
    execute_cursor_query_over_entities(
        collect_candidates(collection, &input.r#where),
        input,
        cursor_cfg,
        &collection.descriptor.computed_fields,
        registry,
    )
}

pub fn execute_query_over_entities(
    entities: Vec<Value>,
    input: &QueryInput,
    computed_fields: &[ComputedFieldDescriptor],
    registry: &Arc<CallbackRegistry>,
) -> Result<Vec<Value>, EngineError> {
    let with_computed = if should_resolve_computed(&input.select, computed_fields) {
        resolve_computed_for_all(&entities, computed_fields, registry)?
    } else {
        entities
    };
    let filtered: Vec<Value> = match &input.r#where {
        None => with_computed,
        Some(w) => with_computed
            .into_iter()
            .filter(|e| matches_where_with_registry(e, w, Some(registry.as_ref())))
            .collect(),
    };
    let sorted = sort_with_scoring(filtered, &input.r#where, &input.sort, Some(registry));
    let paginated = paginate(&sorted, input.offset, input.limit);
    Ok(paginated
        .iter()
        .map(|e| apply_selection(e, input.select.as_ref()))
        .collect())
}

pub fn execute_cursor_query_over_entities(
    entities: Vec<Value>,
    input: &QueryInput,
    cursor_cfg: &CursorConfig,
    computed_fields: &[ComputedFieldDescriptor],
    registry: &Arc<CallbackRegistry>,
) -> Result<CursorPageResult, EngineError> {
    let effective_sort: Vec<SortEntry> = if input.sort.is_empty() {
        vec![(cursor_cfg.key.clone(), SortOrder::Asc)]
    } else {
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

    let with_computed = if should_resolve_computed(&input.select, computed_fields) {
        resolve_computed_for_all(&entities, computed_fields, registry)?
    } else {
        entities
    };
    let filtered: Vec<Value> = match &input.r#where {
        None => with_computed,
        Some(w) => with_computed
            .into_iter()
            .filter(|e| matches_where_with_registry(e, w, Some(registry.as_ref())))
            .collect(),
    };
    let filtered_with_scores = attach_search_scores(filtered, &input.r#where);
    let mut sorted = filtered_with_scores;
    sort_entities_with_registry(&mut sorted, &effective_sort, Some(registry));
    let mut cursor_result = apply_cursor(&sorted, cursor_cfg)?;
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
    let filtered: Vec<Value> = match where_clause {
        None => candidates,
        Some(w) => candidates
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
    let filtered: Vec<Value> = match where_clause {
        None => candidates,
        Some(w) => candidates
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

fn borrowed_candidates<'a>(
    collection: &'a Collection,
    where_clause: Option<&Value>,
) -> Vec<&'a Value> {
    if let Some(where_clause) = where_clause {
        collection
            .narrow_candidates(where_clause)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| collection.get(id))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| collection.list())
    } else {
        collection.list()
    }
}

fn execute_borrowed_query(
    collection: &Collection,
    input: &QueryInput,
    registry: &CallbackRegistry,
) -> Result<Vec<Value>, EngineError> {
    let candidates = borrowed_candidates(collection, input.r#where.as_ref());

    let offset = input.offset.unwrap_or(0);
    let limit = input.limit.unwrap_or(usize::MAX);
    let matches = candidates.into_iter().filter(|entity| {
        input.r#where.as_ref().is_none_or(|where_clause| {
            matches_where_with_registry(entity, where_clause, Some(registry))
        })
    });
    Ok(matches
        .skip(offset)
        .take(limit)
        .map(|entity| apply_selection(entity, input.select.as_ref()))
        .collect())
}

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
