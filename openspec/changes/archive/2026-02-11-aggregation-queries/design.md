# Aggregation Queries — Design

## Architecture

### New Modules

**`core/operations/query/aggregate.ts`** — Core aggregation logic: `computeAggregates(entities, config)` for scalar aggregation, `computeGroupedAggregates(entities, config)` for grouped aggregation. Both operate on a collected array of entities, not a stream.

**`core/types/aggregate-types.ts`** — `AggregateConfig` (scalar and grouped variants as a discriminated union), `AggregateResult`, `GroupedAggregateResult`, and the typed return type that branches on `groupBy` presence.

### Modified Modules

**`core/types/types.ts`** — `SmartCollection` gains the `aggregate` method signature.

**`core/factories/database-effect.ts`** — `buildCollection` creates an `aggregateFn` that reads the Ref, applies the filter, collects results, and delegates to the aggregate module. The function is wired onto the collection object alongside `query` and CRUD methods.

## Key Decisions

### Eager collection, not stream-based

Aggregation inherently requires seeing all matching entities (you can't compute an average from a partial stream). The implementation collects the filtered stream into an array, then computes aggregates in a single pass. There's no benefit to streaming here.

### Single-pass reduction

All requested aggregates are computed in one iteration over the collected array. The reducer maintains accumulators for each requested operation:

```typescript
// Pseudocode for single pass
for (const entity of entities) {
  if (config.count) accumulators.count++
  if (config.sum) for (const field of sumFields) accumulators.sum[field] += numericValue(entity[field])
  if (config.avg) for (const field of avgFields) { accumulators.avg[field].sum += val; accumulators.avg[field].count++ }
  if (config.min) for (const field of minFields) accumulators.min[field] = min(accumulators.min[field], entity[field])
  if (config.max) for (const field of maxFields) accumulators.max[field] = max(accumulators.max[field], entity[field])
}
```

This is O(n * k) where n is entities and k is aggregate operations — effectively O(n) since k is small and constant.

### Group keys via JSON.stringify

Same approach as compound index keys. Group identity is determined by `JSON.stringify(groupFields.map(f => entity[f]))`. This handles all value types and produces stable, comparable keys for the grouping Map.

### Return type branches on groupBy

The `aggregate` method is generic over the config:

```typescript
aggregate<C extends AggregateConfig>(config: C):
  C extends { groupBy: string | ReadonlyArray<string> }
    ? RunnableEffect<GroupedAggregateResult, never>
    : RunnableEffect<AggregateResult, never>
```

This gives callers the correct return type without needing separate methods.

### No population in aggregation

Aggregation operates on the raw entity fields, not populated relationships. If you need to aggregate over populated data, query with populate first, collect, then aggregate externally. This keeps the aggregation pipeline simple and avoids the complexity of populating entities just to reduce them.

### Error channel is never

Aggregation doesn't produce typed errors. Invalid field names return zero/null results. The where clause filtering uses the same pipeline as queries and doesn't add new error types. The error channel is `never`.

### Reuses filter pipeline and index acceleration

The aggregation pipeline starts identically to a query: read Ref, optionally narrow via index, filter by where clause. The divergence is after collection: instead of sort/paginate/select, it reduces.

## File Layout

```
core/
  types/
    aggregate-types.ts       (new — AggregateConfig, AggregateResult, GroupedAggregateResult)
    types.ts                 (modified — SmartCollection gains aggregate)
  operations/
    query/
      aggregate.ts           (new — computeAggregates, computeGroupedAggregates)
  factories/
    database-effect.ts       (modified — build aggregateFn, wire to collection)
tests/
  aggregation.test.ts        (new — full test suite)
```
