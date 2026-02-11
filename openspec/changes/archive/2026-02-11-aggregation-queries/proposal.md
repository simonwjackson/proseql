## Why

The query system supports filtering, sorting, field selection, pagination, and relationship population -- but no way to compute derived values from a result set. Users who need a count of matching records, a sum of a numeric field, or a breakdown by category must pull every matching record into memory with `collect()` and then write their own reduction logic. This defeats the purpose of having a query layer: the database has the data, it should be able to answer questions about it without forcing a full materialization.

This is the most fundamental gap in the current API. Aggregation is table-stakes for any data layer.

## What Changes

Add an `aggregate` method to `SmartCollection` that accepts the same `where` clause as `query` and returns computed scalar or grouped results instead of entity iterables. The method operates over the in-memory data set, reusing the existing `filterData` pipeline for the `where` phase and adding a reduce step after it.

A separate `AggregateConfig` type is introduced alongside `QueryConfig`. The return type is a plain object (or array of grouped objects), not an `AsyncIterable`, since aggregation results are always finite and eagerly computed.

## Capabilities

### New Capabilities

- `count`: Return the number of records matching a `where` clause (or all records when no clause is given).
- `sum`: Compute the sum of a numeric field across matching records.
- `avg`: Compute the arithmetic mean of a numeric field across matching records.
- `min`: Return the minimum value of a comparable field across matching records.
- `max`: Return the maximum value of a comparable field across matching records.
- `groupBy`: Partition matching records by one or more fields, then apply any of the above aggregate functions within each group. Returns an array of group objects keyed by the grouping fields.

### Modified Capabilities

- `SmartCollection`: Gains the `aggregate` method alongside the existing `query` method. The `query` method itself is unchanged.
- `WhereClause`: No structural changes. Aggregation reuses the existing `WhereClause` type as-is to filter the input set before aggregation.

## Impact

- **Types**: New `AggregateConfig`, `AggregateResult`, and `GroupedAggregateResult` types added to the type system. `SmartCollection` interface extended with `aggregate`.
- **Query pipeline**: The existing `filterData` function is reused without modification. A new `aggregate` module is added alongside `filter`, `sort`, and `select`.
- **Factories**: `CrudMethodsWithRelationships` and the factory functions gain the `aggregate` method binding.
- **Async utilities**: No changes. Aggregation returns `Promise<T>`, not `AsyncIterable<T>`.
- **Breaking changes**: None. This is purely additive.
