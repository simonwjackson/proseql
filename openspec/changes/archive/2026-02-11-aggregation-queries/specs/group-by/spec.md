# Group By

## Overview

Partition matching records by one or more fields, then apply aggregate functions within each group. Returns an array of group objects, each containing the grouping field values and the computed aggregates for that group.

## API

```typescript
collection.aggregate(config: GroupedAggregateConfig): RunnableEffect<GroupedAggregateResult, never>
```

### GroupedAggregateConfig

```typescript
interface GroupedAggregateConfig {
  readonly where?: WhereClause<T, Relations, DB>
  readonly groupBy: string | ReadonlyArray<string>
  readonly count?: true
  readonly sum?: string | ReadonlyArray<string>
  readonly avg?: string | ReadonlyArray<string>
  readonly min?: string | ReadonlyArray<string>
  readonly max?: string | ReadonlyArray<string>
}
```

- `groupBy` is required when using grouped aggregation. A string for single-field grouping, an array for multi-field grouping.
- The presence of `groupBy` distinguishes grouped from scalar aggregation at the type level.
- All scalar aggregate options (count, sum, avg, min, max) work within each group.

### GroupedAggregateResult

```typescript
type GroupedAggregateResult = ReadonlyArray<{
  readonly group: Record<string, unknown>   // grouping field values
  readonly count?: number
  readonly sum?: Record<string, number>
  readonly avg?: Record<string, number | null>
  readonly min?: Record<string, unknown>
  readonly max?: Record<string, unknown>
}>
```

Each element represents one group. The `group` field contains the values of the grouping fields for that group.

## Behavior

### Single-Field Grouping

```typescript
const result = await db.orders.aggregate({
  groupBy: "status",
  count: true,
  sum: "total"
}).runPromise
// [
//   { group: { status: "pending" }, count: 5, sum: { total: 250 } },
//   { group: { status: "shipped" }, count: 12, sum: { total: 1500 } },
//   { group: { status: "delivered" }, count: 8, sum: { total: 900 } },
// ]
```

### Multi-Field Grouping

```typescript
const result = await db.orders.aggregate({
  groupBy: ["status", "region"],
  count: true
}).runPromise
// [
//   { group: { status: "pending", region: "US" }, count: 3 },
//   { group: { status: "pending", region: "EU" }, count: 2 },
//   { group: { status: "shipped", region: "US" }, count: 7 },
//   ...
// ]
```

### Group Key Construction

Groups are determined by the combination of field values. Two entities are in the same group when all grouping field values are strictly equal (`===`). Entities with `null` or `undefined` for a grouping field form their own group (null is a valid group key).

### Ordering

Result groups are ordered by first encounter — the order groups appear matches the order their first member appears in the (optionally filtered) data. No explicit sort on groups. Callers can sort the result array themselves.

### Empty Groups

Groups with zero members don't appear in the result. The result is only groups that have at least one matching entity.

### Aggregate Semantics Within Groups

Each group applies the same aggregate logic as scalar aggregates:
- `count` — number of entities in the group
- `sum` — sum of numeric values in the group (non-numeric skipped)
- `avg` — mean of numeric values in the group (null if no numerics)
- `min`/`max` — extreme values in the group

## Type Discrimination

`AggregateConfig` is a union of scalar and grouped variants:

```typescript
type AggregateConfig =
  | ScalarAggregateConfig    // no groupBy
  | GroupedAggregateConfig   // has groupBy
```

The return type branches on the presence of `groupBy`:
- Without `groupBy` → `AggregateResult` (single object)
- With `groupBy` → `GroupedAggregateResult` (array of group objects)

## Pipeline Integration

```
Ref.get(map) → Stream.fromIterable → applyFilter(where) → Stream.runCollect → groupReduce
```

The `groupReduce` step:
1. Iterate collected entities, partition into groups by grouping field values (using a `Map` keyed by `JSON.stringify` of group values).
2. For each group, compute the requested aggregates.
3. Return the array of group results.

## Tests

- Single-field groupBy with count → correct group counts
- Single-field groupBy with sum → correct group sums
- Multi-field groupBy → correct group partitioning
- GroupBy with where clause → groups computed on filtered subset
- Null grouping field value → forms its own group
- Empty result (no matches) → empty array
- GroupBy with all aggregate types → all present per group
- Group ordering → matches first-encounter order
- Type discrimination: config with groupBy returns array, without returns object
