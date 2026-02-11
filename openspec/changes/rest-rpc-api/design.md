# REST & RPC API — Design

## Architecture

### New Modules

**`rpc/src/rpc-group.ts`** — `makeRpcGroup(config)`: derives an RpcGroup from a DatabaseConfig. Iterates over collection names in the config and programmatically builds an RpcGroup with typed procedures per collection. Each procedure's payload, success, and error schemas are derived from the collection's Effect Schema and the error types used by the corresponding SmartCollection methods. The derivation happens at the type level via mapped types over the config, and at the value level via a loop that calls `Rpc.effect` / `Rpc.stream` for each operation.

**`rpc/src/rpc-handlers.ts`** — `makeRpcHandlers(config, initialData?)`: creates an Effect Layer providing handler implementations for every procedure in the derived RpcGroup. Each handler reads from (or writes to) a live proseql database. The database is created internally or accepted as a dependency. Handlers are thin delegators: `books.findById` calls `db.books.findById(id)`, `books.query` calls `db.books.query(config)`, and so on.

**`rpc/src/rpc-errors.ts`** — Schema definitions for proseql's tagged errors (`NotFoundError`, `ValidationError`, `DuplicateKeyError`, etc.) in a form that `@effect/rpc` can serialize and deserialize. These schemas allow typed errors to flow across the wire and be caught with `Effect.catchTag` on the client.

**`rpc/src/rpc-schemas.ts`** — Reusable RPC payload and result schemas derived from DatabaseConfig collection schemas. Includes `QueryConfigSchema`, `AggregateConfigSchema`, and batch operation schemas that map to proseql's internal types.

**`rest/src/handlers.ts`** — `createRestHandlers(config, db)`: generates an array of route descriptors, each containing a method, path pattern, and handler function. The handler signature is `(req: { params, query, body }) => Promise<{ status, body, headers? }>`. One set of handlers per collection covering GET (list/query), GET by id, POST (create), PUT (update), DELETE, POST batch, GET aggregate, and relationship sub-routes.

**`rest/src/query-params.ts`** — Parses URL query parameters into proseql WhereClause, sort, pagination, and select structures. Handles equality shorthand (`?genre=sci-fi`), operator syntax (`?year[$gte]=1970&year[$lt]=2000`), comma-separated select (`?select=title,year`), colon-delimited sort (`?sort=year:desc`), and numeric limit/offset.

**`rest/src/error-mapping.ts`** — Maps proseql tagged error `_tag` values to HTTP status codes and formats error response bodies. The mapping is a static record: `NotFoundError -> 404`, `ValidationError -> 400`, `DuplicateKeyError -> 409`, `UniqueConstraintError -> 409`, `ForeignKeyError -> 422`, `HookError -> 422`, `TransactionError -> 500`. Unknown errors default to 500.

**`rest/src/relationship-routes.ts`** — Generates sub-routes for collection relationships. For a `ref` relationship like `books.author`, generates `GET /books/:id/author`. For an `inverse` relationship like `authors.books`, generates `GET /authors/:id/books`. Delegates to the database's query/populate capabilities.

### Modified Modules

**`rpc/src/index.ts`** — Currently an empty stub (`export {}`). Replaced with re-exports of `makeRpcGroup`, `makeRpcHandlers`, and the error/schema modules.

**`rest/src/index.ts`** — Currently an empty stub (`export {}`). Replaced with re-exports of `createRestHandlers`, query param parsing utilities, and the error mapping.

## Key Decisions

### Two separate packages, not one

REST and RPC serve fundamentally different consumers. RPC is for Effect-native apps that want full type safety and streaming. REST is for universal access. Bundling them would force REST users to pull in `@effect/rpc` and vice versa. Separate packages keep dependencies minimal and concerns isolated.

### RpcGroup derived from config (type-level code generation)

The RpcGroup is not hand-written per database. It is derived programmatically from the DatabaseConfig using mapped types. This means adding a collection to your config automatically adds all RPC procedures for it -- no boilerplate, no drift between database shape and API shape. The derivation uses TypeScript's type system to propagate entity types, error unions, and relationship information from config through to the RPC procedure signatures.

### Framework-agnostic REST handlers

REST handlers use a minimal request/response signature that makes no assumptions about the HTTP framework. The handler receives `{ params, query, body }` and returns `{ status, body, headers? }`. Adapting to Hono, Express, or Bun.serve is a few lines of glue code, not a framework-specific plugin. This keeps `@proseql/rest` dependency-free beyond Effect and core.

### Query parameter parsing for REST filters

REST query parameters map directly to proseql's WhereClause structure using a convention borrowed from MongoDB-style query APIs. Simple equality is `?field=value`. Operators use bracket syntax: `?field[$gte]=value`. This is more expressive than most REST APIs while remaining URL-safe and human-readable. The parser handles type coercion (strings to numbers/booleans where appropriate).

### Error-to-HTTP-status mapping

Rather than swallowing database errors into generic 500s, each tagged error maps to a semantically correct HTTP status. This is a static mapping -- no dynamic logic, no configuration. The error `_tag` is the discriminant, and the response body includes the error's fields for debugging. Consumers get meaningful HTTP responses without losing structured error information.

### Streaming via Effect RPC Stream support

Query and aggregate procedures in the RPC layer can return results as an Effect Stream rather than a collected array. This allows large result sets to flow incrementally over WebSocket or HTTP streaming transports. The choice between streaming and collected is configurable per call. REST does not support streaming -- it always returns collected JSON.

### No GraphQL

GraphQL adds a query language, schema definition layer, resolver pattern, and substantial runtime. For local-first apps where you control both ends, Effect RPC provides everything GraphQL does (typed queries, selection, error handling) with less overhead and better type safety. For universal access, REST covers the common cases. GraphQL would be a third way to do the same thing with significant implementation cost and no clear benefit.

## File Layout

```
packages/
  rpc/
    src/
      index.ts               (modified — re-exports public API)
      rpc-group.ts            (new — makeRpcGroup, type-level derivation from DatabaseConfig)
      rpc-handlers.ts         (new — makeRpcHandlers, Layer wiring RPCs to live database)
      rpc-errors.ts           (new — serializable schemas for proseql tagged errors)
      rpc-schemas.ts          (new — payload/result schemas for RPC procedures)
    tests/
      rpc-group.test.ts       (new — RpcGroup derivation tests)
      rpc-handlers.test.ts    (new — handler integration tests with in-process transport)
      rpc-streaming.test.ts   (new — streaming query tests)
  rest/
    src/
      index.ts               (modified — re-exports public API)
      handlers.ts             (new — createRestHandlers, route generation)
      query-params.ts         (new — URL query parameter parsing)
      error-mapping.ts        (new — tagged error to HTTP status mapping)
      relationship-routes.ts  (new — nested routes for ref/inverse relationships)
    tests/
      handlers.test.ts        (new — CRUD handler tests)
      query-params.test.ts    (new — query parameter parsing tests)
      error-mapping.test.ts   (new — error-to-status mapping tests)
      relationship.test.ts    (new — relationship route tests)
```
