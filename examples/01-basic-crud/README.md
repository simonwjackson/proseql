# Basic CRUD Example

Demonstrates the core CRUD (Create, Read, Update, Delete) operations available in proseql, using the Effect API with `.runPromise` for promise-based execution.

## What This Example Covers

1. **Schema Definition** -- Define collection schemas using `Schema.Struct` from Effect, including optional timestamp fields and cross-collection relationships.

2. **Database Configuration** -- Configure a multi-collection database with `ref` and `inverse` relationship types between `users` and `companies`.

3. **CRUD Operations**
   - `create` / `createMany` -- Insert single or batch records with auto-generated IDs.
   - `findById` -- O(1) lookup by primary key.
   - `query` -- Retrieve all records, or filter with `where` clauses and `sort` options.
   - `update` -- Patch a single record by ID.
   - `upsert` -- Insert or update based on a `where` condition.
   - `updateMany` -- Update multiple records matching a predicate, with support for atomic operators like `$increment`.
   - `upsertMany` -- Batch upsert with per-record `where` / `create` / `update` specs.
   - `deleteMany` -- Remove all records matching a predicate.
   - `delete` -- Remove a single record by ID.

4. **Error Handling** -- Catch typed errors (`NotFoundError`) using both `try/catch` and Effect's `catchTag` for exhaustive, type-safe error recovery.

## Running

```bash
bun run index.ts
```

## Dependencies

- `@proseql/core`
- `effect`
