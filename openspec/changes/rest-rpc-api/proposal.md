## Why

proseql has a complete in-memory database with CRUD, queries, aggregation, transactions, and persistence -- but no way to expose it over the network. Every consumer must import the library directly and run it in-process. This makes proseql unusable for client-server architectures, cross-language access, and any scenario where the database lives on a different machine than the caller.

Two complementary access patterns are needed. First, a type-safe RPC layer for Effect-native consumers who want full type inference, typed error channels, and streaming -- the same experience as calling the database locally, but over the wire. Second, a plain REST layer for universal access: curl, scripts, other languages, and any HTTP client. Together they cover the full spectrum without introducing GraphQL complexity.

## What Changes

Two new packages are implemented alongside `@proseql/core`:

- **`@proseql/rpc`** derives an `RpcGroup` from a `DatabaseConfig` at the type level. Each collection produces a set of typed procedures (findById, query, create, update, delete, aggregate, and batch variants). A `makeRpcHandlers` function creates an Effect Layer that wires each procedure to the corresponding SmartCollection method on a live database. Typed errors flow through to the client unchanged -- `Effect.catchTag("NotFoundError", ...)` works on the client side. Streaming queries are supported via Effect RPC's Stream transport.

- **`@proseql/rest`** generates framework-agnostic HTTP handlers from the same `DatabaseConfig`. Each collection produces route handlers for standard CRUD endpoints plus query-with-filters, batch operations, aggregation, and relationship traversal. Query parameters are parsed into proseql `WhereClause` structures (equality, operators like `$gte`/`$lt`, sort, pagination, field selection). Database errors map to appropriate HTTP status codes. The handler signature is a plain request-in/response-out function that adapts to Hono, Express, or Bun.serve with minimal glue.

## Capabilities

### New Capabilities

- `makeRpcGroup`: Derive a fully typed RpcGroup from a DatabaseConfig. Each collection contributes findById, query, create, update, delete, aggregate, createMany, updateMany, deleteMany, upsert, and upsertMany procedures with correct payload types, success types, and error channels.
- `makeRpcHandlers`: Create an Effect Layer that wires RPC procedures to a live proseql database instance. Each handler delegates to the corresponding SmartCollection method.
- `RPC streaming`: Query procedures can stream results incrementally via Effect RPC's Stream support, or collect and return the full array.
- `RPC transport agnostic`: The RpcGroup works with HTTP transport (`@effect/platform` HttpRouter), WebSocket transport, and in-process transport (`RpcServer.makeNoSerialization`).
- `createRestHandlers`: Generate framework-agnostic HTTP handlers from a DatabaseConfig. Produces route descriptors for all CRUD endpoints, batch operations, aggregation, and relationship routes.
- `Query parameter parsing`: Parse URL query parameters into proseql WhereClause structures. Supports equality (`?genre=sci-fi`), operators (`?year[$gte]=1970`), sort (`?sort=year:desc`), pagination (`?limit=10&offset=20`), and field selection (`?select=title,year`).
- `Error-to-HTTP mapping`: Database tagged errors map to HTTP status codes (NotFoundError -> 404, ValidationError -> 400, DuplicateKeyError -> 409, etc.).
- `Relationship routes`: Nested routes for ref and inverse relationships (`GET /books/:id/author`, `GET /authors/:id/books`).

### Modified Capabilities

- `@proseql/core`: No changes. Both packages depend on core's public API (SmartCollection, DatabaseConfig, error types) without modification.

## Impact

- **New packages**: `packages/rpc/` and `packages/rest/` are implemented from their current stubs. Both depend on `@proseql/core` but do not modify it.
- **Type system**: The RPC package introduces type-level derivation from DatabaseConfig to RpcGroup. This is self-contained within `@proseql/rpc`.
- **Dependencies**: `@proseql/rpc` adds a dependency on `@effect/rpc`. `@proseql/rest` has no new external dependencies beyond `effect` and `@proseql/core`.
- **Breaking changes**: None. Both packages are new, and core is unchanged.
