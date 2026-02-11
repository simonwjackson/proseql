## 1. Types

- [x] 1.1 Create `core/types/computed-types.ts` with `ComputedFieldDefinition<T, R>` (function type `(entity: T) => R`), `ComputedFieldsConfig<T>` (record mapping field names to `ComputedFieldDefinition<T, unknown>`), `InferComputedFields<C>` (maps config to `{ [K]: ReturnType<C[K]> }`), `WithComputed<T, C>` (intersection `T & InferComputedFields<C>`)
- [x] 1.2 Add optional `computed` property to `CollectionConfig` in `core/types/database-config-types.ts`
- [x] 1.3 Modify `GenerateDatabase` in `core/types/types.ts` to extract `computed` from each collection config and merge `InferComputedFields` into the entity type `T`, so `SmartCollection<T & InferComputedFields<Computed>, Relations, DB>`
- [x] 1.4 Verify `WhereClause`, `SortConfig`, `ObjectSelectConfig`, and `QueryReturnType` automatically pick up computed field keys through the widened `T`
- [x] 1.5 Export computed types from `core/index.ts`

## 2. Computed Field Resolution

- [x] 2.1 Create `core/operations/query/resolve-computed.ts` with `resolveComputedFields<T, C>(entity: T, config: C): WithComputed<T, C>`. Iterate `Object.keys(config)`, call each derivation function with `entity`, spread results onto a new object.
- [x] 2.2 Implement `resolveComputedStream(stream, config)` that maps the resolution function over a `Stream<T>`, returning `Stream<WithComputed<T, C>>`. When config is empty/undefined, return the stream unchanged.
- [x] 2.3 Implement `stripComputedFields<T, C>(entity, config): T` that removes computed keys from an entity object. Used as a safety net before persistence.
- [x] 2.4 Implement lazy skip: when `select` is provided and has no intersection with computed field keys, bypass resolution entirely by returning the stream unchanged.

## 3. Query Pipeline Integration — Filter

- [x] 3.1 Verify that `filterData` in `core/operations/query/filter.ts` works on entities with computed fields attached (dynamic property access handles arbitrary keys). No code changes expected; confirm with a targeted test.
- [x] 3.2 Test filtering by a computed string field with `$contains` operator.
- [x] 3.3 Test filtering by a computed boolean field with direct equality (`where: { isClassic: true }`).
- [x] 3.4 Test filtering by a computed numeric field with `$gt`/`$lt` operators.

## 4. Query Pipeline Integration — Sort

- [x] 4.1 Verify that `sortData` in `core/operations/query/sort.ts` works on entities with computed fields attached. No code changes expected; confirm with a targeted test.
- [x] 4.2 Test sorting by a computed string field ascending and descending.
- [x] 4.3 Test sorting by a computed numeric field.

## 5. Query Pipeline Integration — Select

- [x] 5.1 Verify that `selectFields` in `core/operations/query/select.ts` works on entities with computed fields. Object-based select picks keys from the widened entity.
- [x] 5.2 Test selecting only stored fields — computed fields should be absent from results.
- [x] 5.3 Test selecting a mix of stored and computed fields — both present.
- [x] 5.4 Test selecting only computed fields — stored fields absent, computed fields present.
- [x] 5.5 Test default (no select) — all stored fields and all computed fields present.

## 6. Persistence Exclusion

- [x] 6.1 Verify that computed fields are never written into the `Ref`. The Ref stores only schema-validated entities; computed fields are resolved downstream.
- [x] 6.2 Test that saving a collection to disk produces a file with only stored fields (no computed field keys in serialized output).
- [ ] 6.3 Test round-trip: save to disk, reload from disk, query with computed fields — computed values re-derived correctly from stored data.

## 7. CRUD Input Sanitization

- [ ] 7.1 In `core/factories/crud-factory.ts`, strip keys matching computed field names from create input before schema validation.
- [ ] 7.2 In `core/factories/crud-factory.ts`, strip keys matching computed field names from update input before schema validation.
- [ ] 7.3 In `core/factories/crud-factory-with-relationships.ts`, apply the same stripping for create and update paths.
- [ ] 7.4 Test that creating an entity with a computed field name in the input ignores the provided value and uses the derivation function.
- [ ] 7.5 Test that updating an entity with a computed field name in the input ignores the provided value.

## 8. Factory Integration

- [ ] 8.1 In `core/factories/database-effect.ts` `buildCollection`: read `computed` from the collection config. When present, insert `resolveComputedStream` into the query pipeline after population and before filter.
- [ ] 8.2 Wire the lazy skip optimization: check select keys against computed keys, bypass resolution when no computed fields are selected.
- [ ] 8.3 Verify that collections without `computed` config have zero overhead (no resolution step inserted).

## 9. Tests — Core Behavior

- [ ] 9.1 Create `tests/computed-fields.test.ts` with test helpers: database with a books collection (id, title, year, authorId) and computed fields `displayName: (b) => \`${b.title} (${b.year})\``, `isClassic: (b) => b.year < 1980`.
- [ ] 9.2 Test that query results include computed fields by default.
- [ ] 9.3 Test that computed field values are correct (displayName format, isClassic boolean logic).
- [ ] 9.4 Test computed field with no select clause — all stored + computed fields present.
- [ ] 9.5 Test computed field with select including computed — only selected fields present.
- [ ] 9.6 Test computed field with select excluding computed — computed fields absent, not evaluated.
- [ ] 9.7 Test filter by computed boolean field.
- [ ] 9.8 Test filter by computed string field with operator.
- [ ] 9.9 Test sort by computed field ascending.
- [ ] 9.10 Test sort by computed field descending.
- [ ] 9.11 Test combined: filter by computed + sort by computed + select computed.
- [ ] 9.12 Test multiple computed fields on the same collection.
- [ ] 9.13 Test collection with no computed fields — behaves identically to before (regression check).

## 10. Tests — Edge Cases

- [ ] 10.1 Test computed field returning `null` or `undefined` — handled gracefully in filter/sort.
- [ ] 10.2 Test computed field on empty collection — no errors, empty results.
- [ ] 10.3 Test computed field with population: `authorName: (book) => book.author?.name ?? "Unknown"` with and without `populate`.
- [ ] 10.4 Test that create ignores computed field names in input.
- [ ] 10.5 Test that update ignores computed field names in input.
- [ ] 10.6 Test persistence round-trip: save, reload, verify computed fields re-derive correctly.
- [ ] 10.7 Test that computed fields do not appear in aggregation input (aggregation operates on stored fields).

## 11. Cleanup

- [ ] 11.1 Run full test suite (`bun test`) to verify no regressions
- [ ] 11.2 Run type check (`bunx tsc --noEmit`) to verify no type errors
