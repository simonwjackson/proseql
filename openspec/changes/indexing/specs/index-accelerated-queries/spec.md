# Index-Accelerated Equality Queries

## Overview

The query engine checks for a usable index before applying a filter. When a `where` clause uses direct equality, `$eq`, or `$in` on an indexed field, the engine resolves matching entity IDs from the index in O(1) per value, then loads only those entities from the Ref state. Remaining non-indexed filter conditions are applied as a post-filter on the narrowed candidate set.

## Behavior

### Index Selection

Before filtering, the query engine inspects the `where` clause:

1. For each top-level field in the where clause (excluding `$or`, `$and`, `$not`):
   - If the field has a single-field index AND the condition is direct equality, `$eq`, or `$in`:
     - Mark this field as index-eligible.
2. If at least one field is index-eligible, use the index with the highest selectivity (fewest expected matches). For simplicity in v1, use the first index-eligible field found.

### Supported Operators

| Where clause pattern | Index used? | How |
|---|---|---|
| `{ email: "alice@example.com" }` | Yes | Direct equality → lookup single value |
| `{ email: { $eq: "alice@example.com" } }` | Yes | `$eq` → lookup single value |
| `{ email: { $in: ["a@b.com", "c@d.com"] } }` | Yes | `$in` → union of lookups for each value |
| `{ email: { $ne: "alice@example.com" } }` | No | Negation requires full scan |
| `{ email: { $startsWith: "a" } }` | No | Range/pattern requires full scan |
| `{ age: { $gt: 25 } }` | No | Range operators not supported by hash index |

### Query Pipeline Integration

The index lookup replaces the initial `Stream.fromIterable(map.values())` step when an index is usable:

**Without index (current):**
```
Ref.get(map) → Stream.fromIterable(map.values()) → filter → populate → sort → paginate → select
```

**With index:**
```
Ref.get(map) → indexLookup(where, indexes) → Stream.fromIterable(matchingEntities) → filter(remainingConditions) → populate → sort → paginate → select
```

The filter stage still runs on the narrowed set to apply any non-indexed conditions. If the where clause is fully covered by the index (e.g., single equality on indexed field, no other conditions), the filter stage is a no-op pass-through.

### Candidate Resolution

Given a set of entity IDs from the index:

```typescript
const candidateIds: Set<string> = index.get(value) ?? new Set()
const candidates = Array.from(candidateIds)
  .map(id => map.get(id))
  .filter(entity => entity !== undefined)
```

### Remaining Conditions

After narrowing by index, the remaining where conditions (fields not covered by the index) are applied via the existing `matchesWhere` function. The `where` object is passed through unchanged — the filter function re-checks all conditions including the indexed one. This is correct (redundant but harmless) and avoids the complexity of splitting the where clause.

## Transparency

Index usage is invisible to the caller. The query API, return types, and semantics are identical whether an index is used or not. The only observable difference is performance.

## Tests

- Equality query on indexed field resolves via index (verify by checking result correctness)
- `$eq` query on indexed field resolves via index
- `$in` query on indexed field resolves via index (union of matches)
- Query on non-indexed field falls back to full scan
- Query with mixed indexed and non-indexed conditions: index narrows, filter applies remaining
- Query with `$or`/`$and`/`$not`: falls back to full scan (no index optimization for logical operators in v1)
- Empty index entry (no matches) returns empty result
- Results are identical with and without index (correctness parity)
