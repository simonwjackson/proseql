## 1. Types

- [x] 1.1 Create `core/types/aggregate-types.ts` with `ScalarAggregateConfig` (where?, count?, sum?, avg?, min?, max?), `GroupedAggregateConfig` (extends scalar + groupBy), `AggregateConfig` (union of both), `AggregateResult` (scalar result object), `GroupedAggregateResult` (array of group objects)
- [x] 1.2 Add `aggregate` method signature to `SmartCollection` in `core/types/types.ts`. Generic over config, return type branches on `groupBy` presence: `RunnableEffect<GroupedAggregateResult>` or `RunnableEffect<AggregateResult>`
- [x] 1.3 Export aggregate types from `core/index.ts`

## 2. Scalar Aggregation

- [x] 2.1 Create `core/operations/query/aggregate.ts` with `computeAggregates(entities, config)` returning `AggregateResult`. Single-pass reduction over the entity array.
- [ ] 2.2 Implement `count`: return `entities.length` (simple, no field needed)
- [ ] 2.3 Implement `sum`: for each requested field, accumulate numeric values. Non-numeric values (null, undefined, strings) are skipped (treated as 0). Empty result set → 0.
- [ ] 2.4 Implement `avg`: for each requested field, track sum and count of numeric values. Compute mean after pass. If no numeric values → null.
- [ ] 2.5 Implement `min`/`max`: for each requested field, track extreme value using `<`/`>` comparison. Null/undefined excluded. Empty result set → undefined.
- [ ] 2.6 Handle multi-field requests: normalize `string` to `[string]`, iterate all fields in the array for each aggregate type.

## 3. Grouped Aggregation

- [ ] 3.1 Implement `computeGroupedAggregates(entities, config)` returning `GroupedAggregateResult`. Partition entities into groups, then apply `computeAggregates` within each group.
- [ ] 3.2 Implement grouping: use `Map<string, Array<T>>` keyed by `JSON.stringify(groupFields.map(f => entity[f]))`. Preserve first-encounter ordering.
- [ ] 3.3 Handle single-field and multi-field groupBy (normalize string to array).
- [ ] 3.4 Handle null/undefined grouping values: form their own group.
- [ ] 3.5 Build group result objects with `group` field containing the grouping field values.

## 4. Factory Integration

- [ ] 4.1 In `core/factories/database-effect.ts` `buildCollection`: create an `aggregateFn` that reads Ref snapshot, optionally narrows via index, applies filter, collects via `Stream.runCollect`, then delegates to `computeAggregates` or `computeGroupedAggregates` based on `groupBy` presence.
- [ ] 4.2 Wrap `aggregateFn` with `withRunPromise` to provide `.runPromise` convenience.
- [ ] 4.3 Wire `aggregate` onto the collection object alongside `query` and CRUD methods.

## 5. Tests — Scalar Aggregates

- [ ] 5.1 Create `tests/aggregation.test.ts` with test helpers: database with products collection (id, name, price, category, stock)
- [ ] 5.2 Test `count` with no where → total collection size
- [ ] 5.3 Test `count` with where → filtered count
- [ ] 5.4 Test `count` on empty collection → 0
- [ ] 5.5 Test `sum` on numeric field → correct total
- [ ] 5.6 Test `sum` with non-numeric/null values → skipped
- [ ] 5.7 Test `sum` on empty result set → 0
- [ ] 5.8 Test `avg` on numeric field → correct mean
- [ ] 5.9 Test `avg` with all non-numeric → null
- [ ] 5.10 Test `avg` on empty result set → null
- [ ] 5.11 Test `min`/`max` on numeric field → correct extremes
- [ ] 5.12 Test `min`/`max` on string field → lexicographic comparison
- [ ] 5.13 Test `min`/`max` on empty result set → undefined
- [ ] 5.14 Test multiple aggregations in one call → all present in result
- [ ] 5.15 Test multiple fields per aggregation → all fields computed

## 6. Tests — Group By

- [ ] 6.1 Test single-field groupBy with count → correct group counts
- [ ] 6.2 Test single-field groupBy with sum → correct group sums
- [ ] 6.3 Test multi-field groupBy → correct group partitioning
- [ ] 6.4 Test groupBy with where → groups from filtered subset only
- [ ] 6.5 Test null grouping field value → forms own group
- [ ] 6.6 Test empty result (no matches) → empty array
- [ ] 6.7 Test groupBy with all aggregate types → all present per group
- [ ] 6.8 Test group ordering → matches first-encounter order

## 7. Cleanup

- [ ] 7.1 Run full test suite (`bun test`) to verify no regressions
- [ ] 7.2 Run type check (`bunx tsc --noEmit`) to verify no type errors
