## Why

The database supports filtering, sorting, field selection, pagination, relationship population, and aggregation -- but no way to expose derived values alongside stored fields. Users who need a display name built from first and last name, an age calculated from a birthdate, or a boolean flag like `isOverdue` must compute these outside the query layer, then merge the results manually. This is error-prone and defeats the purpose of having a typed query system: the database knows the entity shape, it should be able to derive fields from it and thread them through the entire pipeline (filter, sort, select) with full type safety.

Computed fields are the most natural extension of the existing query system. They close the gap between raw storage and presentation-ready data without polluting persistence.

## What Changes

Add a `computed` property to `CollectionConfig` that maps field names to synchronous derivation functions. Each function receives the stored entity and returns a value. The return type is inferred by TypeScript and merged into the entity type for query results.

Computed fields are resolved after entities are read from the `Ref` but before they enter the query pipeline, so they are available to `where`, `sort`, and `select` stages. They are stripped before any persistence (write-back, serialization) and ignored in create/update inputs.

No new top-level method is introduced. The existing `query` method transparently includes computed fields in its results. The `SmartCollection` entity type is widened at the type level to include computed field names and their inferred types.

## Capabilities

### New Capabilities

- `computed` config: Declare virtual fields per collection via `computed: { fieldName: (entity) => derivedValue }`. The derivation function is synchronous and receives the stored entity (plus populated data when population is configured).
- Computed fields in results: Query results include computed fields alongside stored fields by default. No extra API call needed.
- Filter by computed field: `where` clauses accept computed field names with the same operators as stored fields (`$eq`, `$gt`, `$contains`, etc.).
- Sort by computed field: `sort` configuration accepts computed field names with `"asc"` / `"desc"` ordering.
- Select computed fields: Object-based `select` can include or exclude computed fields. When a computed field is excluded from `select`, it is not evaluated (no wasted computation).
- Type inference: The return type of each derivation function determines the computed field's type. TypeScript enforces this in `where`, `sort`, and `select` configurations.

### Modified Capabilities

- `CollectionConfig`: Gains optional `computed` property mapping field names to derivation functions.
- `SmartCollection` entity type: Widened at the type level to include computed fields, so `query` result types reflect them.
- `WhereClause`: Extended to accept computed field names and their typed operators.
- `SortConfig`: Extended to accept computed field names.
- `ObjectSelectConfig`: Extended to accept computed field names.
- Query pipeline: A resolution step is inserted after entity retrieval (and optional population) that evaluates computed functions and attaches results to entities before filter/sort/select.
- Persistence: The serialization path strips computed field names before writing to disk. No structural changes to the storage layer.
- CRUD inputs: Create and update operations ignore any keys that match computed field names. No validation errors, values are silently dropped.

## Impact

- **Types**: New `ComputedFieldsConfig<T>` type. `CollectionConfig` extended with optional `computed`. `SmartCollection` generic parameters and `QueryConfig`/`WhereClause`/`SortConfig`/`SelectConfig` widened to include computed field keys.
- **Query pipeline**: New resolution step (`resolveComputedFields`) inserted between entity retrieval and `filterData`. Operates per-entity, attaching computed values. Skipped entirely when no computed fields are configured.
- **Select optimization**: When `select` is present and no computed fields are selected, the resolution step is skipped for those fields (lazy evaluation).
- **Persistence**: The save path strips keys not present in the original schema before serialization. No changes to serializer modules.
- **CRUD operations**: Create/update input sanitization strips computed field names before validation and insertion.
- **Factories**: `buildCollection` reads the `computed` config, creates the resolution function, and threads it into the query pipeline.
- **Breaking changes**: None. Collections without `computed` behave identically to before. This is purely additive.
