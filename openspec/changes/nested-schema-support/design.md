# Nested Schema Support -- Design

## Architecture

### New Modules

**`core/utils/nested-path.ts`** -- Shared utilities for resolving and mutating nested object paths. Extracts and deduplicates the `getNestedValue` function that already exists in three files (`sort.ts`, `sort-stream.ts`, `cursor-stream.ts`). Adds `setNestedValue` for deep updates and `deepMergeWithOperators` for the update engine.

```typescript
// Get a value from an object using a dot-separated path
getNestedValue(obj: Record<string, unknown>, path: string): unknown

// Set a value on an object at a dot-separated path, returning a new object (immutable)
setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown>

// Check if a string is a dot-notation path
isDotPath(key: string): boolean
```

### Modified Modules

**`core/operations/query/filter-stream.ts`** -- `matchesWhere` gains two new branches:

1. **Shape-mirroring**: When a key exists on the item and the filter value is a plain object with no `$`-prefixed keys, recurse into `matchesWhere(item[key], filterValue)` instead of doing an exact-match comparison.
2. **Dot-notation fallback**: When a key is not found on the item and the key contains `.`, resolve the value via `getNestedValue(item, key)` and run `matchesFilter` against it.

The disambiguation rule is: objects with any `$`-prefixed key are operator objects; objects with zero `$`-prefixed keys are nested where clauses. This is unambiguous because user-defined schema fields cannot start with `$`.

**`core/operations/crud/update.ts`** -- `applyUpdates` gains recursive deep merge behavior:

1. When an update value is a plain object with `$`-prefixed keys, it's an operator -- apply at this level (existing behavior).
2. When an update value is a plain object with no `$`-prefixed keys AND the current entity value at that key is also a plain object -- recurse into the nested object, applying the same operator-detection logic at each level.
3. When the update value is a plain object but the entity value is not an object (or doesn't exist) -- direct assignment (existing behavior).

This preserves backward compatibility for flat schemas (no nested objects means no recursion) and gives deep merge semantics for nested schemas.

A new helper function `deepMergeUpdates(current, updates)` encapsulates this recursion and is called from `applyUpdates` instead of the current flat iteration.

**`core/indexes/index-manager.ts`** -- `computeIndexKey` replaces `(entity as Record<string, unknown>)[field]` with `getNestedValue(entity as Record<string, unknown>, field)`. Single call-site change. Dot-path index keys like `"metadata.views"` now resolve correctly.

**`core/operations/query/aggregate.ts`** -- `updateAccumulators` replaces `entity[field]` with `getNestedValue(entity, field)` for all aggregate operations (sum, avg, min, max). `computeGroupedAggregates` replaces `entity[f]` with `getNestedValue(entity, f)` for groupBy key extraction.

**`core/indexes/search-index.ts`** -- `addEntityToIndexMut` replaces `entityRecord[field]` with `getNestedValue(entityRecord, field)`. Same for `removeEntityFromIndexMut` and the update path. Dot-path search index fields like `"metadata.description"` now resolve correctly.

**`core/operations/query/filter-stream.ts` ($search handler)** -- The top-level `$search` handler's field resolution replaces `item[field]` / `item[k]` with `getNestedValue(item, field)` when collecting string field values for tokenization.

**`core/operations/query/sort.ts`** -- Remove local `getNestedValue`, import from `utils/nested-path.ts`.

**`core/operations/query/sort-stream.ts`** -- Remove local `getNestedValue`, import from `utils/nested-path.ts`.

**`core/operations/query/cursor-stream.ts`** -- Remove local `getNestedValue`, import from `utils/nested-path.ts`.

## Key Decisions

### Shape-mirroring is the primary syntax; dot-notation is the fallback

Shape-mirroring (`where: { metadata: { views: { $gt: 100 } } }`) matches how consumers define their schemas and is the most natural form. Dot-notation (`where: { "metadata.views": { $gt: 100 } }`) is supported as a fallback for cases where string keys are more convenient (programmatic construction, dynamic field names).

Both syntaxes produce identical behavior at runtime. Shape-mirroring is checked first (key exists on item, value is a non-operator object → recurse). Dot-notation is the fallback (key not on item, key contains `.` → resolve via `getNestedValue`).

### Disambiguation: $-prefix convention is unambiguous

At every nesting level, the engine checks whether a filter/update value is an "operator object" by looking for `$`-prefixed keys. This convention already exists throughout the codebase (`isFilterOperatorObject`, `isUpdateOperator`). Since Effect Schema field names cannot start with `$` (they would fail schema validation), there is zero ambiguity between:

- `{ views: { $gt: 100 } }` → operator object (has `$gt`)
- `{ views: { count: 5 } }` → nested where clause (no `$` keys)
- `{ views: 100 }` → exact match (primitive value)

### Deep merge by default for updates; $set to replace

When an update specifies a nested object value and the entity's current value at that key is also an object, the engine merges recursively. This means:

```typescript
// Given entity: { metadata: { views: 100, rating: 4, tags: ["sci-fi"] } }

update(id, { metadata: { views: 500 } })
// Result: { metadata: { views: 500, rating: 4, tags: ["sci-fi"] } }
// Only views changed, rating and tags preserved

update(id, { metadata: { views: { $increment: 1 } } })
// Result: { metadata: { views: 101, rating: 4, tags: ["sci-fi"] } }
// Operator applied at leaf, siblings preserved

update(id, { metadata: { $set: { views: 0 } } })
// Result: { metadata: { views: 0 } }
// Entire metadata replaced (rating and tags gone)
```

This is a deliberate behavior change from the current wholesale-replace semantics. The rationale: in a schema-driven database, the schema defines the full shape, so a partial nested object is obviously a partial update. The old behavior (replace) is still available via `$set`.

### getNestedValue resolution is trivially cheap

`getNestedValue` does `path.split(".") + property traversals`. For non-nested paths (no `.`), `split` returns a single-element array and the function degrades to a single property access -- effectively zero overhead. For nested paths, the cost is O(depth) string splits + property lookups, which is negligible for the 2-3 levels of nesting that real schemas use.

### No depth limit on nesting

The runtime supports arbitrarily deep nesting. The type system (`ExtractNestedPaths<T>`) currently limits to 2 levels to prevent infinite recursion in TypeScript. This is acceptable: the types provide autocomplete for the common case, and deeper paths work at runtime even without type-level autocomplete. The type limit can be extended later if needed.

### Search index field traversal

For search without a configured `searchIndex`, the `$search` handler currently discovers string fields via `Object.keys(item).filter(k => typeof item[k] === "string")`. This is extended to recursively walk nested objects and collect all string-valued paths. This means `$search` with no explicit `fields` array automatically finds nested strings.

When `searchIndex` is configured with dot-paths, the index builder uses `getNestedValue` to extract field values during tokenization. This is consistent with how equality indexes handle their field references.

## File Layout

```
core/
  utils/
    nested-path.ts               (new -- getNestedValue, setNestedValue, isDotPath)
  operations/
    query/
      filter-stream.ts           (modified -- nested where recursion, dot-path fallback, nested $search)
      sort.ts                    (modified -- import getNestedValue from utils)
      sort-stream.ts             (modified -- import getNestedValue from utils)
      cursor-stream.ts           (modified -- import getNestedValue from utils)
      aggregate.ts               (modified -- getNestedValue for field resolution)
    crud/
      update.ts                  (modified -- deep merge with operator detection)
  indexes/
    index-manager.ts             (modified -- getNestedValue in computeIndexKey)
    search-index.ts              (modified -- getNestedValue in addEntityToIndexMut)
  types/
    types.ts                     (modified -- WhereClause recursive nested support)
    crud-types.ts                (modified -- UpdateWithOperators deep partial)
tests/
  nested-schema.test.ts          (new -- full test suite)
```
