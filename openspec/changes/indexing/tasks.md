## 1. Types and Configuration

- [x] 1.1 Create `core/types/index-types.ts` with `IndexMap` (`Map<unknown, Set<string>>`), `IndexRef` (`Ref<IndexMap>`), `CollectionIndexes` (`Map<string, IndexRef>`), and `NormalizedIndex` (`ReadonlyArray<string>`) types
- [x] 1.2 Add `readonly indexes?: ReadonlyArray<string | ReadonlyArray<string>>` to `CollectionConfig` in `core/types/database-config-types.ts`
- [x] 1.3 Export new index types from `core/types/index.ts` or `core/index.ts`

## 2. Index Manager

- [x] 2.1 Create `core/indexes/index-manager.ts` with `normalizeIndexes(indexes)` — converts `["email", ["userId", "category"]]` to `[["email"], ["userId", "category"]]`
- [ ] 2.2 Implement `buildIndexes(normalizedIndexes, initialData)` returning `Effect<CollectionIndexes>`. For each index, scan all entities and build the `Map<key, Set<id>>`. Single-field keys use the raw value. Compound keys use `JSON.stringify(fields.map(f => entity[f]))`. Skip null/undefined values.
- [ ] 2.3 Implement `addToIndex(indexes, entity)` — add an entity's field values to all applicable indexes. Returns `Effect<void>` operating on index Refs.
- [ ] 2.4 Implement `removeFromIndex(indexes, entity)` — remove an entity's ID from all applicable index entries. Clean up empty Sets. Returns `Effect<void>`.
- [ ] 2.5 Implement `updateInIndex(indexes, oldEntity, newEntity)` — for each index, check if the indexed field(s) changed. If so, remove old entry and add new. Returns `Effect<void>`.
- [ ] 2.6 Implement batch variants: `addManyToIndex`, `removeManyFromIndex` — collect all changes and apply in one `Ref.update` per index Ref.

## 3. Index Lookup

- [ ] 3.1 Create `core/indexes/index-lookup.ts` with `resolveWithIndex(where, indexes, map)`. Returns `Array<T> | undefined` — entity array if index was used, `undefined` if no usable index.
- [ ] 3.2 Implement index eligibility check: for each normalized index, check if all key fields have equality conditions (direct value, `$eq`, or `$in`) in the where clause. Skip `$or`/`$and`/`$not` at the top level.
- [ ] 3.3 Implement single-value lookup: equality/$eq → `index.get(value)` → resolve IDs to entities from the map.
- [ ] 3.4 Implement multi-value lookup: `$in` → union of `index.get(v)` for each value in the array.
- [ ] 3.5 Implement compound index lookup: compute compound key(s) from where values, handle `$in` Cartesian product for compound indexes.
- [ ] 3.6 Implement index selection: when multiple indexes match, prefer the one covering more fields (compound over single).

## 4. CRUD Integration

- [ ] 4.1 Add `indexes?: CollectionIndexes` parameter to `create` and `createMany` in `core/operations/crud/create.ts`. After entity insertion into data Ref, call `addToIndex`. For `createMany`, use batch variant.
- [ ] 4.2 Add `indexes?: CollectionIndexes` parameter to `update` and `updateMany` in `core/operations/crud/update.ts`. After entity update, call `updateInIndex` with old and new entity.
- [ ] 4.3 Add `indexes?: CollectionIndexes` parameter to `delete` and `deleteMany` in `core/operations/crud/delete.ts`. Before removing entity from data Ref (while entity is still accessible), call `removeFromIndex`.
- [ ] 4.4 Add `indexes?: CollectionIndexes` parameter to `upsert` and `upsertMany` in `core/operations/crud/upsert.ts`. Route to addToIndex (create path) or updateInIndex (update path).

## 5. Factory Integration

- [ ] 5.1 In `core/factories/database-effect.ts` `buildCollection`: read `indexes` from collection config, normalize via `normalizeIndexes`, call `buildIndexes` with initial data.
- [ ] 5.2 Pass `CollectionIndexes` to all CRUD factory function calls (create, createMany, update, updateMany, delete, deleteMany, upsert, upsertMany).
- [ ] 5.3 Update `queryFn`: before creating the stream, call `resolveWithIndex(options?.where, indexes, map)`. If it returns entities, use those as the initial stream instead of `map.values()`.
- [ ] 5.4 Default to empty `CollectionIndexes` when `indexes` is not configured (preserves existing behavior).

## 6. Tests — Index Declaration and Building

- [ ] 6.1 Create `tests/indexing.test.ts` with test helpers: create database with indexed collection
- [ ] 6.2 Test index built from initial data: correct field values mapped to correct entity IDs
- [ ] 6.3 Test multiple entities with same field value: all IDs in the index Set
- [ ] 6.4 Test null/undefined values not indexed
- [ ] 6.5 Test collection without indexes: empty CollectionIndexes

## 7. Tests — Index Maintenance

- [ ] 7.1 Test create → index entry added
- [ ] 7.2 Test update changing indexed field → old removed, new added
- [ ] 7.3 Test update not changing indexed field → index unchanged
- [ ] 7.4 Test delete → index entries removed, empty Sets cleaned up
- [ ] 7.5 Test createMany → batch index update
- [ ] 7.6 Test upsert (create path) → index added
- [ ] 7.7 Test upsert (update path) → index updated
- [ ] 7.8 Test index consistency after mixed CRUD sequence

## 8. Tests — Query Acceleration

- [ ] 8.1 Test equality query on indexed field returns correct results
- [ ] 8.2 Test `$eq` on indexed field returns correct results
- [ ] 8.3 Test `$in` on indexed field returns correct results (union)
- [ ] 8.4 Test query on non-indexed field returns correct results (full scan)
- [ ] 8.5 Test mixed indexed + non-indexed conditions: narrowed then filtered
- [ ] 8.6 Test `$or`/`$and`/`$not` queries fall back to full scan
- [ ] 8.7 Test empty index entry (no matches) returns empty result
- [ ] 8.8 Test result parity: same results with and without index configured

## 9. Tests — Compound Indexes

- [ ] 9.1 Test compound index equality query on all fields → index lookup
- [ ] 9.2 Test partial compound query → falls back to full scan
- [ ] 9.3 Test compound query with extra non-indexed fields → index used, extras post-filtered
- [ ] 9.4 Test `$in` on one compound field → Cartesian product lookup
- [ ] 9.5 Test compound index maintenance (create/update/delete)
- [ ] 9.6 Test compound key handles mixed types (string + number)

## 10. Cleanup

- [ ] 10.1 Run full test suite (`bun test`) to verify no regressions
- [ ] 10.2 Run type check (`bunx tsc --noEmit`) to verify no type errors
