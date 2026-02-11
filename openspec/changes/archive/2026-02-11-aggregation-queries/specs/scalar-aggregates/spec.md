# Scalar Aggregates (count, sum, avg, min, max)

## Overview

Scalar aggregate operations compute a single value from a filtered set of records. All five operations share the same pipeline: filter by `where` clause, then reduce to a scalar.

## API

```typescript
collection.aggregate(config: AggregateConfig): RunnableEffect<AggregateResult, never>
```

### AggregateConfig

```typescript
interface AggregateConfig {
  readonly where?: WhereClause<T, Relations, DB>
  readonly count?: true
  readonly sum?: string | ReadonlyArray<string>    // field name(s)
  readonly avg?: string | ReadonlyArray<string>
  readonly min?: string | ReadonlyArray<string>
  readonly max?: string | ReadonlyArray<string>
}
```

- Multiple aggregations can be requested in a single call (e.g., `{ count: true, sum: "price", avg: "price" }`).
- `where` filters the input set before aggregation. Omitting it aggregates the entire collection.
- Field-based aggregates (`sum`, `avg`, `min`, `max`) accept a string for a single field or an array for multiple fields.

### AggregateResult

```typescript
interface AggregateResult {
  readonly count?: number
  readonly sum?: Record<string, number>
  readonly avg?: Record<string, number | null>
  readonly min?: Record<string, unknown>
  readonly max?: Record<string, unknown>
}
```

- Only requested aggregations appear in the result.
- `sum` and `avg` results are keyed by field name. Single-field requests still use the object form for consistency.
- `avg` returns `null` for a field when no records match (division by zero).
- `min` and `max` return the actual field value (could be string, number, date string, etc.). Returns `undefined` for the field if no records match.

## Behavior

### count

Count the number of records after filtering. No field parameter needed.

```typescript
const result = await db.users.aggregate({ count: true }).runPromise
// { count: 42 }
```

### sum

Sum numeric field values. Non-numeric values (null, undefined, strings) are skipped (treated as 0 for sum purposes). If no records have a numeric value for the field, sum is 0.

```typescript
const result = await db.orders.aggregate({ sum: "total" }).runPromise
// { sum: { total: 1250.50 } }
```

### avg

Arithmetic mean of numeric field values. Non-numeric values are excluded from both numerator and denominator. If no numeric values exist, result is `null`.

```typescript
const result = await db.orders.aggregate({ avg: "total" }).runPromise
// { avg: { total: 62.525 } }
```

### min / max

Minimum/maximum value using JavaScript's `<` / `>` comparison. Works on numbers, strings, and date strings. Null/undefined values are excluded.

```typescript
const result = await db.orders.aggregate({ min: "total", max: "total" }).runPromise
// { min: { total: 5.00 }, max: { total: 500.00 } }
```

### Multiple Fields

```typescript
const result = await db.orders.aggregate({
  sum: ["total", "tax"],
  avg: ["total", "tax"]
}).runPromise
// { sum: { total: 1250, tax: 125 }, avg: { total: 62.5, tax: 6.25 } }
```

## Pipeline Integration

Aggregation reuses the existing filter pipeline:

```
Ref.get(map) → Stream.fromIterable(map.values()) → applyFilter(where) → Stream.runCollect → reduce
```

The reduce step is eager — it collects the filtered stream into an array, then computes all requested aggregations in a single pass over the array.

Index acceleration (from the indexing change) can narrow the initial set before filtering, same as regular queries.

## Error Handling

No new error types. Invalid field names silently produce zero/null results rather than errors — the field simply doesn't exist on any entity. This matches the behavior of SQL aggregates on nullable columns.

## Tests

- `count` with no where → total collection size
- `count` with where → filtered count
- `count` on empty collection → 0
- `sum` on numeric field → correct total
- `sum` with non-numeric values → skipped (treated as 0)
- `sum` on empty result set → 0
- `avg` on numeric field → correct mean
- `avg` with all non-numeric → null
- `avg` on empty result set → null
- `min`/`max` on numeric field → correct extremes
- `min`/`max` on string field → lexicographic comparison
- `min`/`max` on empty result set → undefined
- Multiple aggregations in one call → all present in result
- Multiple fields per aggregation → all fields computed
- Combined with `where` → aggregation runs on filtered subset
