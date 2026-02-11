## 1. Types

- [x] 1.1 Create `core/types/search-types.ts` with `SearchConfig` (query: string, fields?: ReadonlyArray<string>), `SearchScore` (entityId: string, score: number), `SearchIndexMap` (type alias for `Map<string, Set<string>>`), and `STOP_WORDS` constant (Set of common English stop words: the, a, an, of, in, to, is, it, for, etc.)
- [x] 1.2 Add `$search: string` to `FilterOperators<string>` in `core/types/types.ts` (field-level search operator for string fields only)
- [x] 1.3 Add top-level `$search: SearchConfig` to the `WhereClause` type in `core/types/types.ts` alongside `$and`, `$or`, `$not`
- [x] 1.4 Add optional `searchIndex: ReadonlyArray<string>` to collection config types in `core/types/database-config-types.ts` (fields to build the inverted index on)
- [x] 1.5 Export search types from `core/index.ts`

## 2. Tokenizer

- [x] 2.1 Create `core/operations/query/search.ts` with `tokenize(text: string): ReadonlyArray<string>` -- split on whitespace, strip leading/trailing punctuation, lowercase, filter empty strings
- [x] 2.2 Add `tokenizeWithStopWords(text: string, removeStopWords: boolean): ReadonlyArray<string>` -- calls `tokenize` then optionally filters out stop words
- [x] 2.3 Handle edge cases: empty string returns empty array, whitespace-only returns empty array, punctuation-only tokens are dropped

## 3. Relevance Scorer

- [x] 3.1 Implement `computeFieldScore(fieldValue: string, queryTokens: ReadonlyArray<string>): number` in `search.ts` -- tokenize the field value, compute term frequency, field length normalization, and term coverage. Return 0 if no tokens match.
- [x] 3.2 Implement `computeSearchScore(entity: Record<string, unknown>, queryTokens: ReadonlyArray<string>, fields: ReadonlyArray<string>): number` -- sum field scores across all specified fields. Return 0 if no fields match.
- [x] 3.3 Exact token matches score higher than prefix matches (e.g., "dune" matching "dune" scores more than "dun" matching "dune")

## 4. $search Operator Integration

- [x] 4.1 Add `$search` branch to `matchesFilter` in `core/types/operators.ts`: when `$search` is present and value is a string, tokenize both the search string and the field value, return true if every query token matches at least one field token (exact or prefix via `startsWith`)
- [x] 4.2 Add `$search` to the operator key lists in `isFilterOperatorObject` and the non-existent field handling in `filterData` so that `$search` is recognized as a valid operator
- [x] 4.3 Handle top-level `$search` in `filterData` in `core/operations/query/filter.ts`: when the where clause contains a `$search` key, tokenize the query, determine target fields (explicit or all string fields on the entity), check if any field matches all query tokens

## 5. Multi-Field Search

- [x] 5.1 Implement multi-field search path: when `$search` is a top-level object with `query` and optional `fields`, tokenize the query, iterate over specified fields (or all string-typed fields on the entity), return true if the combined field matches satisfy all query tokens
- [x] 5.2 Handle `fields` omission: introspect the entity to find all keys with string values, use those as the search fields
- [x] 5.3 A query token can match in any of the specified fields (not required to match in the same field) -- "herbert dune" should match when "herbert" is in `author` and "dune" is in `title`

## 6. Relevance Sort Integration

- [x] 6.1 Modify the query pipeline so that when `$search` is active and no explicit `sort` is provided, results are sorted by relevance score descending
- [x] 6.2 Compute relevance scores during the filter phase and attach as metadata (or compute in a post-filter pass) so the sort stage can consume them
- [x] 6.3 When an explicit `sort` is provided alongside `$search`, use the explicit sort and discard relevance ordering

## 7. Search Index

- [x] 7.1 Create `core/indexes/search-index.ts` with `buildSearchIndex(fields: ReadonlyArray<string>, entities: ReadonlyArray<Record<string, unknown>>): Effect<Ref<SearchIndexMap>>` -- tokenize each entity's indexed fields, populate the inverted index
- [x] 7.2 Implement `lookupSearchIndex(indexRef: Ref<SearchIndexMap>, queryTokens: ReadonlyArray<string>): Effect<Set<string>>` -- intersect ID sets for exact token matches, union with prefix-matched ID sets, return candidate entity IDs
- [x] 7.3 Wire search index into the query pipeline: when a search index is available and covers the queried fields, use `lookupSearchIndex` to narrow candidates before running `filterData`

## 8. CRUD Index Maintenance

- [x] 8.1 Implement `addToSearchIndex(indexRef: Ref<SearchIndexMap>, entity: Record<string, unknown>, fields: ReadonlyArray<string>): Effect<void>` -- tokenize the entity's indexed fields, add entity ID to each token's Set
- [x] 8.2 Implement `removeFromSearchIndex(indexRef: Ref<SearchIndexMap>, entity: Record<string, unknown>, fields: ReadonlyArray<string>): Effect<void>` -- tokenize the entity's indexed fields, remove entity ID from each token's Set, clean up empty Sets
- [x] 8.3 Implement `updateInSearchIndex(indexRef: Ref<SearchIndexMap>, oldEntity: Record<string, unknown>, newEntity: Record<string, unknown>, fields: ReadonlyArray<string>): Effect<void>` -- remove old tokens, add new tokens (only for changed fields)
- [x] 8.4 Wire search index maintenance into `buildCollection` in `database-effect.ts`: call add/remove/update search index functions alongside existing equality index maintenance in create, update, updateMany, delete, deleteMany paths

## 9. Tests -- Basic Search

- [x] 9.1 Create `tests/full-text-search.test.ts` with test helpers: database with books collection (id, title, author, year, description)
- [ ] 9.2 Test field-level `$search` basic match: `{ title: { $search: "dune" } }` matches "Dune"
- [ ] 9.3 Test case insensitivity: `{ title: { $search: "DUNE" } }` matches "Dune"
- [ ] 9.4 Test multi-term search: `{ title: { $search: "left hand darkness" } }` matches "The Left Hand of Darkness"
- [ ] 9.5 Test prefix matching: `{ title: { $search: "neuro" } }` matches "Neuromancer"
- [ ] 9.6 Test no match: `{ title: { $search: "xyz123" } }` returns no results
- [ ] 9.7 Test empty search string: `{ title: { $search: "" } }` returns all results (no filter applied)

## 10. Tests -- Multi-Field Search

- [ ] 10.1 Test top-level multi-field search: `{ $search: { query: "herbert dune", fields: ["title", "author"] } }` matches when terms span across fields
- [ ] 10.2 Test default all string fields: `{ $search: { query: "gibson" } }` without `fields` searches all string fields
- [ ] 10.3 Test single-field explicit: `{ $search: { query: "dune", fields: ["title"] } }` only searches title

## 11. Tests -- Relevance Scoring

- [ ] 11.1 Test relevance ordering: search for "dark hand" returns "The Left Hand of Darkness" (both terms match) above an entity with only one term match
- [ ] 11.2 Test explicit sort overrides relevance: `{ where: { title: { $search: "dark" } }, sort: { year: "asc" } }` sorts by year, not relevance
- [ ] 11.3 Test exact match scores higher than prefix match: "dune" query ranks exact "Dune" above "Duneland" (if it existed)

## 12. Tests -- Search Index

- [ ] 12.1 Test indexed search returns same results as unindexed search (correctness)
- [ ] 12.2 Test index maintenance on create: add a new entity, search finds it
- [ ] 12.3 Test index maintenance on update: update an entity's indexed field, search reflects the change
- [ ] 12.4 Test index maintenance on delete: delete an entity, search no longer finds it

## 13. Tests -- Combined Filters

- [ ] 13.1 Test `$search` with other field operators: `{ title: { $search: "dark" }, year: { $gt: 1960 } }` filters by both
- [ ] 13.2 Test `$search` inside `$or`: `{ $or: [{ title: { $search: "dark" } }, { author: { $search: "gibson" } }] }` matches either
- [ ] 13.3 Test `$search` inside `$and`: both conditions must match
- [ ] 13.4 Test `$search` combined with pagination: results are paginated after search filtering and relevance sort

## 14. Cleanup

- [ ] 14.1 Run full test suite (`bun test`) to verify no regressions
- [ ] 14.2 Run type check (`bunx tsc --noEmit`) to verify no type errors
- [ ] 14.3 Run lint (`biome check .`) and fix any issues
