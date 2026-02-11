## Why

Only the `id` field has uniqueness enforced today. Fields like `email`, `sku`, or `slug` can silently accept duplicates even though the schema comments and test fixtures already describe them as unique. This breaks two things:

1. **Data integrity** -- `create` and `createMany` happily insert rows with duplicate emails/slugs. The `checkUniqueConstraints` helper exists in `create.ts` but is never called because `extractUniqueFields` always returns `[]`.

2. **Upsert semantics** -- `upsert` needs to know *which* field identifies an existing row so it can decide between insert and update. The `UpsertInput` type already accepts a generic `UniqueFields` parameter and the `where` clause type branches on it, but the runtime ignores the collection's `uniqueFields` config. Upsert works today only when callers manually pass the right `where` -- nothing validates that the field is actually unique or prevents a match on a non-unique field.

The type-level scaffolding (`ExtractUniqueFields`, `UpsertInput<T, UniqueFields>`, `UniqueConstraintError`, `checkUniqueConstraints`) and test expectations (`uniqueFields: ["email", "username"]` in the upsert test config) are already in place. The gap is purely runtime: constraints are declared but never read, validated, or enforced.

## What Changes

Wire the `uniqueFields` collection config into the runtime so that:

- The database factory reads `uniqueFields` from each collection's config and passes them to CRUD operation factories.
- `create` / `createMany` call `checkUniqueConstraints` before inserting, returning a `UNIQUE_CONSTRAINT` error on violation.
- `upsert` / `upsertMany` validate that the `where` clause targets a declared unique field (or `id`), and use the unique field index for the existence check instead of a naive scan.
- Compound unique constraints (e.g., `["userId", "settingKey"]`) are supported alongside single-field constraints.

## Capabilities

### New Capabilities

- `unique field enforcement on create`: Reject inserts that would duplicate a value on any field declared in `uniqueFields`, returning a `UNIQUE_CONSTRAINT` error with the conflicting field, value, and existing entity ID.
- `compound unique constraints`: Support tuple entries in `uniqueFields` (e.g., `[["userId", "settingKey"]]`) so uniqueness can span multiple fields.
- `upsert where-clause validation`: Verify at runtime that the `where` clause in an upsert targets a declared unique field or `id`, returning an `OPERATION_NOT_ALLOWED` error otherwise.

### Modified Capabilities

- `createDatabase` factory: Reads and forwards `uniqueFields` from collection config to operation factories.
- `create` / `createMany`: Calls `checkUniqueConstraints` after schema validation and before insert. `skipDuplicates` in `createMany` extends to unique-field duplicates, not just ID collisions.
- `upsert` / `upsertMany`: Uses declared unique fields to look up existing entities instead of blindly matching all `where` keys. Rejects `where` clauses that reference non-unique fields.
- `extractUniqueFields` / `extractUniqueFieldsFromSchema`: Replaced by reading the explicit `uniqueFields` config rather than attempting schema introspection.

## Impact

- **Error contract**: Callers that currently insert duplicates silently will start receiving `UNIQUE_CONSTRAINT` errors. This is a breaking behavioral change for any dataset that already contains duplicates.
- **Config contract**: Collections that want unique enforcement must declare `uniqueFields`. Collections without it behave exactly as today (only `id` uniqueness).
- **Upsert callers**: Code that upserts by a non-unique field will start failing validation. This surfaces bugs rather than introducing them.
- **Performance**: Unique checks do a linear scan per field per insert. Acceptable for the in-memory/file-backed scope of this database; indexing (a separate change) can optimize later.
