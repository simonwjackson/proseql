## Why

Every query performs a full table scan. `filterData` iterates the entire collection array and calls `matchesFilter` on each record, making every `where` clause O(n) regardless of selectivity. For collections with thousands of records, queries on high-cardinality fields like `id`, `email`, or `slug` pay the same cost as scanning the whole table even when they match a single record. An in-memory hash index on declared fields would make equality and `$in` lookups O(1) amortized, without changing the query API or persistence layer.

## What Changes

Collections gain an optional `indexes` declaration in their config. The database maintains in-memory `Map` structures that map field values to sets of record references. These maps are built at database creation (or data load) and kept in sync by the existing CRUD mutation methods. The query engine checks for a usable index before falling back to a full scan.

## Capabilities

### New Capabilities

- `Index Declaration`: Define indexed fields per collection in the database config, e.g. `indexes: ["email", "slug"]`.
- `Automatic Index Maintenance`: Indexes are rebuilt on data load and updated transparently on create, update, upsert, and delete operations.
- `Index-Accelerated Equality Queries`: `where` clauses using direct equality (`{ email: "x" }`) or `$eq`/`$in` operators resolve via index lookup instead of a full scan.
- `Compound Index Support`: Optional multi-field indexes for queries that filter on multiple fields simultaneously.

### Modified Capabilities

- `filterData`: Accepts an optional index map parameter. When an index covers the filtered field(s), it narrows the candidate set before applying remaining filters, preserving existing operator semantics.
- `DatabaseBuilder`: Builds and attaches index structures during `buildAllCollections`. Wraps mutation methods to keep indexes in sync (layered on top of the existing persistence hooks).
- `DatabaseConfig` type: Extended with an optional `indexes` property per collection definition.

## Impact

- **Query performance**: Equality and `$in` filters on indexed fields drop from O(n) to O(1) average lookup plus O(m) for m matching records.
- **Memory**: Each index adds a `Map<value, Set<record>>` proportional to collection size. For typical file-backed datasets (hundreds to low thousands of records), this is negligible.
- **Mutation overhead**: Each write pays O(k) to update k indexes on the affected collection. Acceptable given that reads vastly outnumber writes in this use case.
- **API surface**: No breaking changes. Existing queries work identically. The `indexes` config property is optional; omitting it preserves current full-scan behavior.
- **Persistence**: No changes. Indexes are purely in-memory structures rebuilt from data on load.
