## 1. Shared Path Utilities

- [x] 1.1 Create `core/utils/nested-path.ts` with `getNestedValue(obj, path)`: splits on `.`, traverses properties, returns `undefined` for missing paths. Handles single-segment paths (no `.`) as direct property access with no overhead.
- [x] 1.2 Add `setNestedValue(obj, path, value)`: returns a new object with the value set at the dot-path. Immutable — copies intermediate objects along the path.
- [x] 1.3 Add `isDotPath(key)`: returns `key.includes(".")` (already implemented in nested-path.ts).
- [x] 1.4 Write unit tests for `getNestedValue`: flat path, 2-level path, 3-level path, missing intermediate, null intermediate, empty string path, single-segment path.
- [x] 1.5 Write unit tests for `setNestedValue`: set leaf on existing object, create intermediate objects, single-segment path, verify immutability (original unchanged).

## 2. Deduplicate Existing getNestedValue

- [x] 2.1 Replace local `getNestedValue` in `core/operations/query/sort.ts` with import from `core/utils/nested-path.ts`. Remove the local function.
- [x] 2.2 Replace local `getNestedValue` in `core/operations/query/sort-stream.ts` with import from `core/utils/nested-path.ts`. Remove the local function.
- [ ] 2.3 Replace local `getNestedValue` in `core/operations/query/cursor-stream.ts` with import from `core/utils/nested-path.ts`. Remove the local function.
- [ ] 2.4 Run existing tests (`just test-core`) to confirm no regressions from the import change.

## 3. Nested Filtering

- [ ] 3.1 In `core/operations/query/filter-stream.ts` `matchesWhere`: add shape-mirroring branch. When `key in item` and value is a plain object with no `$`-prefixed keys and `item[key]` is also a plain object, recurse: `matchesWhere(item[key], value, customOperators)`.
- [ ] 3.2 In `matchesWhere`: add dot-notation fallback. When key is not in item and `isDotPath(key)`, resolve via `getNestedValue(item, key)` and run `matchesFilter(resolvedValue, value, customOperators)`.
- [ ] 3.3 In the top-level `$search` handler: replace `item[field]` with `getNestedValue(item, field)` when resolving field values for tokenization. Replace the "all string fields" discovery with a recursive object walker that collects all string-valued paths.
- [ ] 3.4 Test shape-mirroring: `where: { metadata: { views: { $gt: 100 } } }` matches entities with `metadata.views > 100`.
- [ ] 3.5 Test dot-notation: `where: { "metadata.views": { $gt: 100 } }` produces same results as shape-mirroring.
- [ ] 3.6 Test nested exact match: `where: { metadata: { rating: 5 } }` matches entities with `metadata.rating === 5`.
- [ ] 3.7 Test nested with `$or`: `where: { $or: [{ metadata: { views: { $gt: 1000 } } }, { metadata: { rating: 5 } }] }`.
- [ ] 3.8 Test nested with `$not`: `where: { $not: { metadata: { views: { $lt: 10 } } } }`.
- [ ] 3.9 Test nested string operators: `where: { author: { name: { $startsWith: "Frank" } } }`.
- [ ] 3.10 Test 3-level nesting: `where: { a: { b: { c: { $eq: "deep" } } } }`.
- [ ] 3.11 Test mixed flat + nested in same where: `where: { title: "Dune", metadata: { views: { $gt: 100 } } }`.
- [ ] 3.12 Test nested `$search` field resolution: `where: { $search: { query: "hello", fields: ["metadata.description"] } }`.

## 4. Deep Merge Updates

- [ ] 4.1 In `core/operations/crud/update.ts`: create `deepMergeUpdates(current, updates)` helper. For each key in updates: if value has `$`-keys → `applyOperator`; if value is a plain object with no `$`-keys and current value is also a plain object → recurse; otherwise → direct assignment.
- [ ] 4.2 Refactor `applyUpdates` to use `deepMergeUpdates` instead of flat iteration.
- [ ] 4.3 Test deep merge: `update(id, { metadata: { views: 500 } })` preserves `metadata.rating` and `metadata.tags`.
- [ ] 4.4 Test nested operator: `update(id, { metadata: { views: { $increment: 1 } } })` increments only `metadata.views`.
- [ ] 4.5 Test nested `$set` replaces: `update(id, { metadata: { $set: { views: 0 } } })` replaces entire metadata.
- [ ] 4.6 Test mixed nested + flat update: `update(id, { title: "New Title", metadata: { rating: 5 } })`.
- [ ] 4.7 Test nested string operator: `update(id, { metadata: { description: { $append: " (Updated)" } } })`.
- [ ] 4.8 Test nested array operator: `update(id, { metadata: { tags: { $append: "classic" } } })`.
- [ ] 4.9 Test nested boolean operator: `update(id, { metadata: { featured: { $toggle: true } } })`.
- [ ] 4.10 Test deep merge on non-existent nested key: `update(id, { metadata: { newField: 42 } })` adds the field to metadata.
- [ ] 4.11 Test that flat schemas (no nested objects) behave identically to before (regression).

## 5. Nested Indexing

- [ ] 5.1 In `core/indexes/index-manager.ts` `computeIndexKey`: replace `(entity as Record<string, unknown>)[field]` with `getNestedValue(entity as Record<string, unknown>, field)`.
- [ ] 5.2 Test dot-path single index: `indexes: ["metadata.views"]` accelerates `where: { "metadata.views": 100 }`.
- [ ] 5.3 Test dot-path compound index: `indexes: [["metadata.rating", "genre"]]` accelerates `where: { "metadata.rating": 5, genre: "sci-fi" }`.
- [ ] 5.4 Test index maintenance on update: changing `metadata.views` updates the index correctly.
- [ ] 5.5 Test index maintenance on create/delete with nested indexed fields.

## 6. Nested Aggregation

- [ ] 6.1 In `core/operations/query/aggregate.ts` `updateAccumulators`: replace `entity[field]` with `getNestedValue(entity, field)` for sum, avg, min, max field resolution.
- [ ] 6.2 In `computeGroupedAggregates`: replace `entity[f]` with `getNestedValue(entity, f)` for groupBy key extraction.
- [ ] 6.3 Test scalar aggregate: `aggregate({ sum: "metadata.views", min: "metadata.rating", max: "metadata.rating" })`.
- [ ] 6.4 Test grouped aggregate: `aggregate({ groupBy: "metadata.rating", count: true })`.
- [ ] 6.5 Test avg on nested field: `aggregate({ avg: "metadata.views" })`.

## 7. Nested Search Index

- [ ] 7.1 In `core/indexes/search-index.ts` `addEntityToIndexMut`: replace `entityRecord[field]` with `getNestedValue(entityRecord, field)`.
- [ ] 7.2 Apply same fix to `removeEntityFromIndexMut` and the update path.
- [ ] 7.3 Test `searchIndex: ["metadata.description"]` builds correct inverted index from nested field values.
- [ ] 7.4 Test search index maintenance on create/update/delete with nested indexed field.
- [ ] 7.5 Test `$search` query against nested indexed field returns correct results.

## 8. Type System

- [ ] 8.1 In `core/types/types.ts` `WhereClause`: verify/extend to support recursive nested object form. When `T[K]` is an object type, `WhereClause` should accept either `FilterOperators<T[K]>` or a nested `WhereClause` over the nested type's fields.
- [ ] 8.2 In `core/types/crud-types.ts` `UpdateWithOperators`: extend to support deep partial with operator detection at any level. When the field type is an object, the update value can be a recursive `UpdateWithOperators` of that nested type.
- [ ] 8.3 Verify `ExtractNestedPaths<T>` covers dot-paths for index config, aggregate field references, and search index fields.
- [ ] 8.4 Write type-level tests: verify TypeScript accepts nested where clauses, nested update operators, dot-path index declarations, and dot-path aggregate field refs. Verify TypeScript rejects invalid nested paths.

## 9. Integration Tests

- [ ] 9.1 Create `tests/nested-schema.test.ts` with test schema: entity has `id`, `title`, `genre`, `metadata: { views, rating, tags, description }`, `author: { name, country }`.
- [ ] 9.2 Test end-to-end: create entities, query with nested filter + sort + select, verify results.
- [ ] 9.3 Test nested filter + pagination (offset-based).
- [ ] 9.4 Test nested filter + cursor pagination.
- [ ] 9.5 Test nested filter + aggregation in same test flow.
- [ ] 9.6 Test nested updates + re-query to verify state consistency.
- [ ] 9.7 Test persistence round-trip with nested data: create, flush, reload, verify nested fields intact.
- [ ] 9.8 Test computed fields on nested source data: `computed: { viewCount: (e) => e.metadata.views }` works after nesting support is in place.
- [ ] 9.9 Test reactive queries (watch) emit on nested field updates.

## 10. Cleanup

- [ ] 10.1 Run full test suite (`just test`) — all existing tests pass.
- [ ] 10.2 Run type check (`just typecheck`) — no type errors.
- [ ] 10.3 Run lint (`just lint`) — no lint errors.
