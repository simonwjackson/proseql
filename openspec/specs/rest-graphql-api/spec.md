# API Layer (External Packages)

## Overview

Two separate packages expose proseql databases over the network. Both live as sibling projects (`../proseql-rpc`, `../proseql-rest`), not inside proseql core.

- **proseql-rpc** — Effect RPC layer. Primary integration for local-first apps where you control both client and server. Full type safety, streaming, typed errors.
- **proseql-rest** — Thin REST layer. Universal access for curl, scripts, other languages. Auto-generated CRUD routes + query parameter parsing.

GraphQL is intentionally excluded — for local-first apps where you control both ends, Effect RPC gives you everything GraphQL would plus type-safe errors, and REST covers the universal access case.

## Package: proseql-rpc

Location: `../proseql-rpc`

### Requirement: Derive RpcGroup from DatabaseConfig

An RpcGroup SHALL be automatically derived from a proseql DatabaseConfig, with one set of procedures per collection.

#### Scenario: Generated procedures per collection
- **GIVEN** a database config with a `books` collection
- **THEN** the RpcGroup SHALL include procedures:
  - `books.findById` — payload: `{ id: string }`, success: `Book`, error: `NotFoundError`
  - `books.query` — payload: `QueryConfig`, success: `ReadonlyArray<Book>`, error: `DanglingReferenceError | ValidationError`
  - `books.create` — payload: `CreateInput<Book>`, success: `Book`, error: `ValidationError | DuplicateKeyError | ...`
  - `books.update` — payload: `{ id: string, updates: ... }`, success: `Book`, error: `ValidationError | NotFoundError | ...`
  - `books.delete` — payload: `{ id: string }`, success: `Book`, error: `NotFoundError | ...`
  - `books.aggregate` — payload: `AggregateConfig`, success: `AggregateResult | GroupedAggregateResult`

#### Scenario: Typed errors flow to client
- **WHEN** a server-side operation fails with `NotFoundError`
- **THEN** the client SHALL receive a typed `NotFoundError` (not a generic HTTP error)
- **AND** `Effect.catchTag("NotFoundError", ...)` SHALL work on the client

#### Scenario: Multiple collections
- **GIVEN** config with `books` and `authors` collections
- **THEN** the RpcGroup SHALL include procedures for both, prefixed by collection name

### Requirement: Handler layer from database

A function SHALL create an Effect Layer that wires RPC handlers to a live proseql database.

#### Scenario: makeRpcHandlers
- **WHEN** `makeRpcHandlers(config, initialData)` is called
- **THEN** it SHALL return a Layer providing all RPC handler implementations
- **AND** each handler SHALL delegate to the corresponding database collection method

#### Scenario: Persistent database handlers
- **WHEN** handlers are created for a persistent database
- **THEN** mutations SHALL trigger persistence as normal

### Requirement: Streaming queries

Query RPCs SHALL support streaming results for large result sets.

#### Scenario: Stream query
- **WHEN** the client calls `books.query({ where: ... })`
- **THEN** the RPC MAY stream results incrementally (via Effect RPC's Stream support)
- **OR** collect and return the full array (configurable)

### Requirement: Transport agnostic

The RpcGroup and handlers SHALL work with any Effect RPC transport.

#### Scenario: HTTP transport
- **WHEN** served via `@effect/platform` HttpRouter
- **THEN** RPCs SHALL be accessible as HTTP endpoints

#### Scenario: WebSocket transport
- **WHEN** served via WebSocket
- **THEN** streaming queries and subscriptions SHALL work over the persistent connection

#### Scenario: In-process transport
- **WHEN** used in tests or same-process
- **THEN** the RpcGroup SHALL work with `RpcServer.makeNoSerialization` for zero-overhead calls

### Requirement: Batch operations

Batch CRUD operations SHALL be exposed as RPC procedures.

#### Scenario: Batch procedures
- **THEN** the RpcGroup SHALL include:
  - `books.createMany`
  - `books.updateMany`
  - `books.deleteMany`
  - `books.upsert`
  - `books.upsertMany`

## Package: proseql-rest

Location: `../proseql-rest`

### Requirement: Auto-generate CRUD routes

A function SHALL generate framework-agnostic HTTP handlers from a database configuration.

#### Scenario: Generated routes per collection
- **GIVEN** a database with a `books` collection
- **THEN** the following handlers SHALL be generated:
  - `GET /books` — query with where, sort, select, limit, offset via query params
  - `GET /books/:id` — findById
  - `POST /books` — create (body is entity data)
  - `PUT /books/:id` — update (body is partial updates)
  - `DELETE /books/:id` — delete
  - `POST /books/batch` — createMany (body is array)
  - `GET /books/aggregate` — aggregation via query params

### Requirement: Query parameter parsing

Filter expressions SHALL be parsed from URL query parameters.

#### Scenario: Simple equality
- **WHEN** `GET /books?genre=sci-fi`
- **THEN** translates to `where: { genre: "sci-fi" }`

#### Scenario: Operators
- **WHEN** `GET /books?year[$gte]=1970&year[$lt]=2000`
- **THEN** translates to `where: { year: { $gte: 1970, $lt: 2000 } }`

#### Scenario: Sort and pagination
- **WHEN** `GET /books?sort=year:desc&limit=10&offset=20`
- **THEN** translates to `sort: { year: "desc" }, limit: 10, offset: 20`

#### Scenario: Select fields
- **WHEN** `GET /books?select=title,year`
- **THEN** translates to `select: ["title", "year"]`

### Requirement: Framework-agnostic handler signature

Handlers SHALL use a generic signature that adapts to any framework.

#### Scenario: Handler shape
- **THEN** each handler SHALL match:
  ```ts
  type Handler = (request: {
    readonly params: Record<string, string>
    readonly query: Record<string, string | string[]>
    readonly body: unknown
  }) => Promise<{
    readonly status: number
    readonly body: unknown
    readonly headers?: Record<string, string>
  }>
  ```

#### Scenario: Framework adapters
- **THEN** documentation SHALL show integration with Hono, Express, and Bun.serve

### Requirement: Error mapping

Database errors SHALL map to HTTP status codes.

#### Scenario: Status mapping
- **THEN**:
  | Database Error | HTTP Status |
  |---|---|
  | NotFoundError | 404 |
  | ValidationError | 400 |
  | DuplicateKeyError | 409 |
  | UniqueConstraintError | 409 |
  | ForeignKeyError | 422 |
  | HookError | 422 |
  | TransactionError | 500 |

### Requirement: Relationship routes

Related data SHALL be accessible via nested routes.

#### Scenario: Ref relationship route
- **GIVEN** books have `author` ref relationship
- **THEN** `GET /books/:id/author` SHALL return the related author

#### Scenario: Inverse relationship route
- **GIVEN** authors have inverse `books` relationship
- **THEN** `GET /authors/:id/books` SHALL return the author's books

## Out of Scope

- GraphQL (use Effect RPC for typed queries, REST for universal access)
- WebSocket subscriptions in REST (use proseql-rpc for streaming)
- Authentication/authorization (use middleware in consumer's framework)
- OpenAPI generation (potential future addition)
- Client SDK generation
