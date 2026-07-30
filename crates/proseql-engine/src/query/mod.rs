//! U3 — Query pipeline for the proseQL engine.
//!
//! Provides the full query surface over in-memory [`Collection`]s:
//!
//! - **Filtering** ([`filter`]) — all `FilterOperators` by type,
//!   `$or`/`$and`/`$not`, top-level `$search`, nested shape-mirroring,
//!   dot-notation field paths.
//! - **Search tokenisation** ([`search`]) — `tokenize()`, relevance scoring.
//! - **Sorting** ([`sort`]) — JS-compatible null-to-end, lexicographic string
//!   sort (approximates `localeCompare` for ASCII/Latin; documented deviation).
//! - **Pagination** ([`paginate`]) — offset/limit.
//! - **Cursor pagination** ([`cursor`]) — forward/backward with `CursorPageInfo`.
//! - **Field selection** ([`select`]) — object, array, dot-notation, and
//!   empty/null forms; empty = all fields (mirrors active `select-stream.ts`).
//! - **Aggregation** ([`aggregate`]) — count/sum/avg/min/max + groupBy;
//!   `GroupResult` is flat (`{ group, count?, sum?, … }`).
//! - **Computed fields** ([`computed`]) — callback materialisation before filter/sort.
//! - **Indexes** ([`indexes`]) — equality and full-text acceleration indexes.
//! - **Pipeline** ([`pipeline`]) — `execute_query`, `execute_cursor_query`,
//!   `execute_aggregate`, `execute_grouped_aggregate`.
//!
//! # TS references
//! - `packages/core/src/operations/query/` — source-of-truth for semantics
//! - `packages/core/src/types/operators.ts` — `matchesFilter`, `FilterOperators`
//! - `packages/core/src/types/aggregate-types.ts` — aggregate config/result types
//! - `packages/core/src/indexes/` — equality and search indexes
//! - `packages/core/src/operations/query/sort-stream.ts` — search relevance scoring

pub mod aggregate;
pub mod computed;
pub mod cursor;
pub mod filter;
pub mod indexes;
pub mod paginate;
pub mod pipeline;
pub mod search;
pub mod select;
pub mod sort;

// Re-export the public API consumed by external callers and conformance tests.
pub use aggregate::{AggregateConfig, AggregateResult, GroupResult};
pub use cursor::{apply_cursor, CursorConfig, CursorPageInfo, CursorPageResult};
pub use filter::matches_where;
pub use paginate::paginate;
pub use pipeline::{
    execute_aggregate, execute_cursor_query, execute_grouped_aggregate, execute_query, query_input,
    search_score, QueryInput,
};
pub use search::{compute_search_score, extract_search_config, tokenize, SearchConfig};
pub use select::apply_selection;
pub use sort::{
    sort_entities, sort_entities_with_registry, value_to_js_string, SortEntry, SortOrder,
};
