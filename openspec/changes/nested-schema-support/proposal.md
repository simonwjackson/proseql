## Why

ProseQL lets consumers define schemas with `Schema.Struct`, and Effect's schema system naturally supports nested structs. A consumer writes:

```ts
const BookSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  metadata: Schema.Struct({
    views: Schema.Number,
    rating: Schema.Number,
    tags: Schema.Array(Schema.String),
  }),
})
```

This works for create, read, and serialization. But the moment they try to filter by `metadata.views`, update just `metadata.rating`, index `metadata.views`, aggregate over `metadata.rating`, or search across nested string fields, the system either silently misses or requires replacing the entire nested object. The query engine treats nested objects as opaque blobs.

This breaks the core promise of ProseQL: define a schema, and the database understands it. Sorting already resolves dot-paths (via `getNestedValue` -- duplicated in three files), but filtering, updates, indexing, aggregation, and search do not. The consumer shouldn't have to think about which operations support nesting and which don't. It should just work.

## What Changes

Teach every runtime subsystem to resolve nested paths, using a single shared utility. Support two syntaxes that compose naturally:

- **Shape-mirroring**: `where: { metadata: { views: { $gt: 100 } } }` -- matches how the schema was defined.
- **Dot-notation**: `where: { "metadata.views": { $gt: 100 } }` -- flat string paths for programmatic use.

Updates use deep merge by default: `update("1", { metadata: { views: { $increment: 1 } } })` touches only `metadata.views`, preserving sibling fields. Use `$set` to replace an entire nested object.

Indexing, aggregation, and search accept dot-paths to reach into nested fields.

## Capabilities

### New Capabilities

- **Nested filtering (shape-mirroring)**: `where: { metadata: { views: { $gt: 100 } } }` recurses into nested objects, applying operators at each leaf. Disambiguation is clean: objects with `$`-prefixed keys are operators; objects without are nested where clauses.
- **Nested filtering (dot-notation)**: `where: { "metadata.views": { $gt: 100 } }` resolves the value via `getNestedValue` and applies operators against it. Both syntaxes compose with `$or`, `$and`, `$not`.
- **Deep merge updates**: `update(id, { metadata: { rating: 5 } })` merges into the nested object, preserving `metadata.views` and `metadata.tags`. Operator detection recurses: `{ metadata: { views: { $increment: 1 } } }` applies `$increment` to the nested field.
- **Nested `$set` override**: `update(id, { metadata: { $set: { views: 0 } } })` replaces the entire `metadata` object.
- **Dot-path indexes**: `indexes: ["metadata.views", ["metadata.rating", "genre"]]` indexes nested field values.
- **Dot-path aggregation**: `aggregate({ sum: "metadata.views", groupBy: "metadata.rating" })` resolves nested fields.
- **Dot-path search**: `searchIndex: ["metadata.description"]` indexes nested string fields. Multi-field `$search` with `fields: ["metadata.description"]` resolves nested paths.
- **Shared path utility**: `getNestedValue` and `setNestedValue` extracted to a shared module, replacing three existing copies.

### Modified Capabilities

- **`matchesWhere`** (filter-stream.ts): When a key exists on the entity and the filter value is a plain object (no `$` keys), recurse into `matchesWhere` on the nested object. When a key contains `.` and is not found on the entity, resolve via `getNestedValue`.
- **`applyUpdates`** (update.ts): When an update value is a plain object (no `$` keys) and the current entity value at that key is also an object, deep merge recursively. Operator detection (`$`-prefixed keys) applies at every nesting level.
- **`computeIndexKey`** (index-manager.ts): Replace `entity[field]` with `getNestedValue(entity, field)`.
- **`updateAccumulators`** (aggregate.ts): Replace `entity[field]` with `getNestedValue(entity, field)` for sum, avg, min, max. Same for `groupBy` in `computeGroupedAggregates`.
- **`$search` field resolution** (filter-stream.ts, search-index.ts): Replace `item[field]` with `getNestedValue(item, field)` when collecting string values for search.
- **Type system**: `WhereClause` extended to support recursive nested object form. `UpdateWithOperators` extended to support deep partial with operators at any level. `ExtractNestedPaths` already exists (2 levels deep); verify it covers index/aggregate/search field references.

## Impact

- **Runtime**: One new shared utility module (`utils/nested-path.ts`). Five existing modules gain `getNestedValue`/`setNestedValue` calls. Three duplicate `getNestedValue` implementations removed.
- **Types**: `WhereClause` gains recursive nested object support. `UpdateWithOperators` gains deep partial with operator detection at every level. Index, aggregate, and search config types accept dot-path strings (may already work via `string` type).
- **Disambiguation**: The `$`-prefix convention cleanly separates operators from nested objects at every level -- no ambiguity is possible since user-defined schema fields cannot start with `$`.
- **Breaking changes**: One deliberate behavior change: nested object updates now deep merge instead of wholesale replace. Consumers who rely on the current replace behavior must use `$set`. This is the right default for a schema-driven database.
- **Performance**: `getNestedValue` adds negligible overhead (one `split(".")` + property traversals). Deep merge in updates adds one recursive pass proportional to nesting depth. No impact on non-nested schemas.
