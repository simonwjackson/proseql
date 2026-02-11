# Compound Index Support

## Overview

Compound indexes span multiple fields, enabling O(1) lookups for queries that filter on all fields in the compound key simultaneously. A compound index on `["userId", "category"]` accelerates queries like `{ userId: "u1", category: "settings" }`.

## Configuration

Compound indexes are array entries in the `indexes` config:

```typescript
indexes: ["email", ["userId", "category"]]
```

- `"email"` — single-field index
- `["userId", "category"]` — compound index on two fields

## Data Structure

A compound index uses the same `Map<unknown, Set<string>>` structure, but the key is a composite of all field values:

```typescript
// Compound key generation
const compoundKey = JSON.stringify(fields.map(f => entity[f]))
// e.g., '["u1","settings"]'
```

Using `JSON.stringify` on an array of values produces a stable, order-preserving string key. This handles all JSON-serializable value types (strings, numbers, booleans, null).

## Behavior

### Index Eligibility

A compound index is eligible when the where clause provides equality conditions (`direct`, `$eq`, or `$in`) for **all** fields in the compound key:

| Compound index | Where clause | Index used? |
|---|---|---|
| `["userId", "category"]` | `{ userId: "u1", category: "settings" }` | Yes |
| `["userId", "category"]` | `{ userId: "u1" }` | No (partial) |
| `["userId", "category"]` | `{ userId: "u1", category: "settings", status: "active" }` | Yes (extra fields filtered post-index) |

Partial compound matches do not use the compound index. A separate single-field index on `userId` would be needed for `{ userId: "u1" }` alone.

### $in with Compound Indexes

When one or more fields in a compound index use `$in`, the lookup produces the Cartesian product of the `$in` values:

```typescript
// where: { userId: { $in: ["u1", "u2"] }, category: "settings" }
// lookups: ["u1","settings"], ["u2","settings"]
```

Each combination is looked up in the compound index, and the results are unioned.

### Maintenance

Same as single-field indexes (see index-maintenance spec), but:
- On create: compute compound key from entity's field values, add to index
- On update: if any field in the compound key changes, remove old compound key, add new
- On delete: remove compound key entry

### Index Selection Priority

When multiple indexes could serve a query, prefer the index that covers more fields (compound over single-field). This reduces the candidate set more aggressively.

For v1, the selection is simple: iterate declared indexes, pick the first one where all key fields have equality conditions in the where clause. Compound indexes naturally win when they match because they're checked as units.

## Tests

- Compound index on `["userId", "category"]`: equality query on both fields → index lookup
- Partial query (only `userId`) → no compound index used, falls back
- Query with extra fields beyond compound key → index used, extra fields post-filtered
- `$in` on one compound field → Cartesian product lookup
- Create/update/delete maintain compound index correctly
- Compound key generation handles mixed types (string + number)
- Results identical with and without compound index (correctness parity)
