# Computed Fields — Design

## Architecture

### New Modules

**`core/types/computed-types.ts`** — `ComputedFieldsConfig<T>` (mapping from field name to `(entity: T) => unknown`), `ComputedFieldDefinition<T, R>` (single field: takes entity, returns `R`), and utility types: `InferComputedFields<C>` (extracts `{ [K]: ReturnType<C[K]> }` from a computed config), `WithComputed<T, C>` (merges stored entity type `T` with `InferComputedFields<C>`).

**`core/operations/query/resolve-computed.ts`** — `resolveComputedFields<T, C>(entity: T, computedConfig: C): WithComputed<T, C>`. Pure function that evaluates each derivation function against the entity and returns a new object with computed fields attached. Also exports `resolveComputedStream` that maps over a `Stream<T>` applying resolution, and `stripComputedFields<T, C>(entity: WithComputed<T, C>, computedConfig: C): T` for persistence stripping.

### Modified Modules

**`core/types/database-config-types.ts`** — `CollectionConfig` gains optional `computed` property of type `ComputedFieldsConfig<Schema.Schema.Type<schema>>`.

**`core/types/types.ts`** — `WhereClause`, `SortConfig`, `ObjectSelectConfig`, and `QueryReturnType` are widened to include computed field keys alongside stored field keys. `SmartCollection` generic signature may gain an additional type parameter for computed fields, or the computed field types are merged into `T` at the `GenerateDatabase` level.

**`core/operations/query/filter.ts`** / **`core/operations/query/filter-stream.ts`** — No structural changes needed. Because computed fields are resolved before filtering, the existing `filterData` operates on the widened entity type and already handles arbitrary keys via its dynamic property access.

**`core/operations/query/sort.ts`** / **`core/operations/query/sort-stream.ts`** — Same as filter: no structural changes. Sort comparators access properties dynamically and work on the widened entity.

**`core/operations/query/select.ts`** / **`core/operations/query/select-stream.ts`** — No structural changes. Object-based select picks keys from the entity, which now includes computed keys. The type-level changes ensure computed field names are valid select keys.

**`core/factories/database-effect.ts`** — `buildCollection` reads `computed` from the collection config. When present, it wraps the entity stream with `resolveComputedStream` after population but before filter/sort/select. For persistence (save/flush), it applies `stripComputedFields` before serialization.

**`core/factories/crud-factory.ts`** / **`core/factories/crud-factory-with-relationships.ts`** — Create and update paths strip computed field keys from input before schema validation. This prevents computed field names from being persisted or causing validation errors.

## Key Decisions

### Resolution before filter, not after

Computed fields must be available to `where` and `sort`, so they are resolved before the filter stage. The pipeline becomes: read Ref -> (populate) -> **resolve computed** -> filter -> sort -> select -> paginate. This means every entity in the pre-filter set pays the resolution cost, but computed functions are synchronous and cheap (string concatenation, arithmetic, boolean logic). For the in-memory scale this database targets, this is negligible.

### Lazy evaluation when select excludes all computed fields

When `select` is provided and none of the selected fields are computed, the resolution step is skipped entirely. This is a simple check: intersect `Object.keys(computedConfig)` with the select keys. If empty, bypass resolution. This avoids unnecessary work for queries that only need stored fields.

### Computed fields stripped at serialization boundary, not in Ref

The `Ref<ReadonlyMap<string, T>>` stores only schema-validated entities (stored fields). Computed fields are never written into the Ref. They exist only in the query result pipeline, materialized on-the-fly. This means:

- No Ref schema changes
- No migration concerns
- No risk of stale computed values in the store
- Persistence naturally excludes them (the Ref doesn't have them)

The `stripComputedFields` utility is a safety net for any code path that might accidentally pass a widened entity to the serializer.

### Type widening at GenerateDatabase level

Rather than adding a fourth generic parameter to `SmartCollection`, computed field types are merged into the entity type `T` at the `GenerateDatabase` type-level utility. `GenerateDatabase` already reads the config object; it can extract `computed` and produce `T & InferComputedFields<Computed>` as the effective entity type. This keeps `SmartCollection` signature changes minimal.

The `WhereClause`, `SortConfig`, and `SelectConfig` types already operate over `T`, so widening `T` at the `GenerateDatabase` level automatically threads computed fields through all query configuration types.

### CRUD inputs use the original schema type

Create and update operations accept the *stored* entity type, not the widened type. TypeScript won't offer computed field names in create/update autocompletion. At runtime, any extra keys matching computed field names are silently stripped before schema validation. This is a belt-and-suspenders approach: the type system prevents it, and the runtime ignores it.

### No computed-from-computed (no DAG)

Computed fields receive only stored fields (and populated data) as input. A computed field cannot reference another computed field. This keeps resolution a single flat pass with no dependency ordering. The spec explicitly puts DAG resolution out of scope.

### Population-aware computed fields

When `populate` is configured in a query, computed derivation functions receive the populated entity (stored fields + populated relationships). This means a computed field can derive from relationship data (e.g., `authorName: (book) => book.author?.name ?? "Unknown"`). When population is not configured, the relationship fields are absent and the function must handle that (returning a fallback).

This is achieved naturally: the resolution step runs *after* population in the pipeline, so the entity already has populated data attached.

## File Layout

```
core/
  types/
    computed-types.ts            (new — ComputedFieldsConfig, InferComputedFields, WithComputed)
    database-config-types.ts     (modified — CollectionConfig gains computed)
    types.ts                     (modified — GenerateDatabase merges computed into entity type)
  operations/
    query/
      resolve-computed.ts        (new — resolveComputedFields, resolveComputedStream, stripComputedFields)
      filter.ts                  (unchanged — operates on widened type)
      sort.ts                    (unchanged — operates on widened type)
      select.ts                  (unchanged — operates on widened type)
  factories/
    database-effect.ts           (modified — thread resolve step into query pipeline)
    crud-factory.ts              (modified — strip computed keys from create/update input)
    crud-factory-with-relationships.ts  (modified — strip computed keys from create/update input)
tests/
  computed-fields.test.ts        (new — full test suite)
```
