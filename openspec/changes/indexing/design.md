# Indexing — Design

## Architecture

### New Modules

**`core/indexes/index-manager.ts`** — Core index logic: `createIndexes` (build from initial data), `updateIndexOnCreate`, `updateIndexOnUpdate`, `updateIndexOnDelete`. Handles both single-field and compound indexes. All operations return Effects and work with `Ref<IndexMap>`.

**`core/indexes/index-lookup.ts`** — Query-time index resolution: `resolveWithIndex(where, indexes, map)` returns either a narrowed entity array (index hit) or `undefined` (no usable index, fall back to full scan).

**`core/types/index-types.ts`** — `IndexMap`, `IndexRef`, `CollectionIndexes`, `NormalizedIndex` types.

### Modified Modules

**`core/types/database-config-types.ts`** — `CollectionConfig` gains `readonly indexes?: ReadonlyArray<string | ReadonlyArray<string>>`.

**`core/factories/database-effect.ts`** — On database creation, build indexes from initial data for each collection. Pass `CollectionIndexes` to CRUD factory functions and to the query function. The query pipeline checks for an index before creating the stream.

**`core/operations/crud/create.ts`**, **`update.ts`**, **`delete.ts`**, **`upsert.ts`** — Each CRUD operation gains an optional `indexes: CollectionIndexes` parameter. After the data Ref mutation, update the affected indexes.

**`core/operations/query/filter-stream.ts`** — No changes to the filter itself. The index narrowing happens upstream in the factory's `queryFn`, which provides a smaller initial stream to the filter stage.

## Key Decisions

### Indexes stored in Refs alongside data

Each index is a `Ref<Map<unknown, Set<string>>>`. This keeps index updates atomic and consistent with the data Ref updates within the same `Effect.gen` block.

### Index narrowing happens in queryFn, not in filter-stream

The factory's `queryFn` currently does:
```typescript
const map = yield* Ref.get(ref)
const items = Array.from(map.values())
let s = Stream.fromIterable(items)
s = applyFilter(options?.where)(s)
```

With indexing:
```typescript
const map = yield* Ref.get(ref)
const narrowed = resolveWithIndex(options?.where, indexes, map)
const items = narrowed ?? Array.from(map.values())
let s = Stream.fromIterable(items)
s = applyFilter(options?.where)(s)  // still runs — handles remaining conditions
```

This is the minimal integration point. The filter still runs on the narrowed set, which is redundant for the indexed field but avoids the complexity of splitting the where clause. For the in-memory use case, this redundant re-check is negligible.

### Compound key via JSON.stringify

Compound index keys use `JSON.stringify(fields.map(f => entity[f]))`. This produces stable, order-preserving string keys for any JSON-serializable value combination. The `Map` key is a string, not an array, because `Map` uses reference equality for object keys.

### Index normalization

Same pattern as unique constraints: all indexes are normalized to arrays internally.
- `"email"` → `["email"]`
- `["userId", "category"]` → `["userId", "category"]`

The normalization happens once at factory creation time.

### No index for range operators, negation, or logical operators

Hash indexes support equality only. Range operators (`$gt`, `$lt`, etc.), negation (`$ne`), and logical operators (`$or`, `$and`, `$not`) always fall back to full scan. A B-tree index could support ranges, but the complexity isn't justified for the in-memory/file-backed use case.

### CRUD operations update indexes inline

Index updates happen inside the same `Effect.gen` block as the data mutation. For batch operations (`createMany`, `updateMany`, etc.), index changes are collected and applied in a single `Ref.update` call per index to avoid churning.

### Transaction integration

During a transaction, index Refs are snapshotted and restored on rollback, just like data Refs. The transaction module already snapshots all Refs — indexes are additional Refs to include. This means the transaction feature (separate change) needs to be index-aware, but the index feature itself doesn't need transaction awareness.

## File Layout

```
core/
  indexes/
    index-manager.ts        (new — create, update, delete index entries)
    index-lookup.ts          (new — query-time index resolution)
  types/
    index-types.ts           (new — IndexMap, IndexRef, CollectionIndexes)
    database-config-types.ts (modified — add indexes to CollectionConfig)
  operations/
    crud/
      create.ts              (modified — update indexes after insert)
      update.ts              (modified — update indexes after update)
      delete.ts              (modified — update indexes after delete)
      upsert.ts              (modified — update indexes after upsert)
  factories/
    database-effect.ts       (modified — build indexes, pass to CRUD, use in queryFn)
tests/
  indexing.test.ts           (new — full test suite)
```
