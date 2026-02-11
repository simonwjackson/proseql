## Why

The query system supports filtering by exact values, ranges, string prefixes, and logical combinators -- but no way to search string fields by natural language terms. Users who need to find records matching "left hand darkness" against a title field must construct brittle `$contains` chains or pull all records and implement their own tokenization and matching. This is the wrong level of abstraction: a data layer that persists text should be able to search it.

Full-text search is the most obvious missing capability for any database that stores human-readable content. The target scale (hundreds to tens of thousands of records) means a lightweight in-memory approach is practical without pulling in an external search engine.

## What Changes

Add a `$search` filter operator that performs tokenized term matching against string fields. The operator integrates into the existing `where` clause, composing with all other filter operators via the standard AND/OR/NOT logic. When no explicit `sort` is provided, results are ordered by relevance score instead of insertion order.

A separate search index (`Map<token, Set<id>>`) can optionally be configured per collection to avoid full-scan tokenization on every query. The index is maintained automatically on CRUD mutations, following the same Ref-based pattern as existing equality indexes.

## Capabilities

### New Capabilities

- `$search` (field-level): Tokenize a search string and match against a single string field. Supports term matching and prefix matching (e.g., "neuro" matches "Neuromancer"). Case-insensitive by default.
- `$search` (multi-field): Search across multiple string fields simultaneously via a top-level `$search` object with `query` and optional `fields` array. When `fields` is omitted, all string fields on the entity are searched.
- Relevance scoring: Rank results by term frequency, field length normalization, and query term coverage. Applied as default sort when no explicit `sort` clause is provided.
- Tokenizer: Whitespace splitting, punctuation stripping, and lowercasing. Configurable stop word filtering (on by default).
- Search index: Optional in-memory inverted index (`Map<token, Set<id>>`) configured via `searchIndex` on collection config. Automatically maintained on create, update, and delete operations.

### Modified Capabilities

- `FilterOperators`: Gains the `$search` operator for string fields. Existing operators are unchanged.
- `WhereClause`: Accepts a top-level `$search` key for multi-field search alongside existing field-level and logical operators.
- `filterData`: Extended to recognize and evaluate `$search` at both field and top levels. All other filter behavior is unchanged.
- `matchesFilter`: Extended to handle the `$search` operator on string values by tokenizing and matching.
- Query pipeline: When `$search` is present and no explicit `sort` is provided, results are sorted by relevance score before pagination. The pipeline remains filter -> sort -> select -> paginate, with relevance injected at the sort stage.

## Impact

- **Types**: New `SearchConfig`, `SearchScore`, and search index types added. `FilterOperators<string>` extended with `$search`. Collection config extended with optional `searchIndex` field.
- **Query pipeline**: `matchesFilter` gains a `$search` branch. `filterData` gains top-level `$search` handling. Sort stage gains relevance-based default when search is active.
- **Indexes**: New `SearchIndexMap` type (`Map<string, Set<string>>` -- token to entity IDs). New functions for building, querying, and maintaining the search index, following the existing `index-manager.ts` patterns.
- **Factories**: `buildCollection` gains search index initialization and wires search index maintenance into CRUD mutation hooks.
- **Breaking changes**: None. This is purely additive. Existing queries are unaffected.
