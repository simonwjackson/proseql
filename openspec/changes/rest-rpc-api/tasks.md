## 1. RPC — Error and Payload Schemas

- [x] 1.1 Create `rpc/src/rpc-errors.ts`: define Effect Schemas for each proseql tagged error (`NotFoundError`, `ValidationError`, `DuplicateKeyError`, `UniqueConstraintError`, `ForeignKeyError`, `HookError`, `TransactionError`, `DanglingReferenceError`) so they can be serialized/deserialized across RPC transport
- [x] 1.2 Create `rpc/src/rpc-schemas.ts`: define payload schemas for RPC procedures — `FindByIdPayload`, `QueryPayload` (wrapping QueryConfig), `CreatePayload`, `UpdatePayload`, `DeletePayload`, `AggregatePayload`, and batch variants (`CreateManyPayload`, `UpdateManyPayload`, `DeleteManyPayload`, `UpsertPayload`, `UpsertManyPayload`)
- [x] 1.3 Export all schemas from `rpc/src/index.ts`

## 2. RPC — Group Derivation

- [x] 2.1 Create `rpc/src/rpc-group.ts` with `makeRpcGroup(config)` that iterates DatabaseConfig collection names and builds an RpcGroup
- [x] 2.2 For each collection, generate `findById` procedure: payload `{ id: string }`, success is collection entity type, error includes `NotFoundError`
- [x] 2.3 Generate `query` procedure: payload is `QueryConfig`, success is `ReadonlyArray<Entity>`, error includes `DanglingReferenceError | ValidationError`
- [x] 2.4 Generate `create` procedure: payload is create input, success is entity, error includes `ValidationError | DuplicateKeyError | UniqueConstraintError | ForeignKeyError | HookError`
- [x] 2.5 Generate `update` procedure: payload is `{ id: string, updates: Partial<Entity> }`, success is entity, error includes `ValidationError | NotFoundError | UniqueConstraintError | HookError`
- [x] 2.6 Generate `delete` procedure: payload is `{ id: string }`, success is entity, error includes `NotFoundError | HookError`
- [x] 2.7 Generate `aggregate` procedure: payload is `AggregateConfig`, success is `AggregateResult | GroupedAggregateResult`
- [x] 2.8 Generate batch procedures: `createMany`, `updateMany`, `deleteMany`, `upsert`, `upsertMany` with appropriate payload/success/error types
- [x] 2.9 Verify that multiple collections in a config each produce their own namespaced set of procedures

## 3. RPC — Handler Layer

- [x] 3.1 Create `rpc/src/rpc-handlers.ts` with `makeRpcHandlers(config, initialData?)` returning an Effect Layer
- [x] 3.2 Wire `findById` handler: delegate to `db[collection].findById(id)`, propagate typed error
- [x] 3.3 Wire `query` handler: delegate to `db[collection].query(config)`, collect stream to array
- [x] 3.4 Wire `create` handler: delegate to `db[collection].create(data)`, propagate typed errors
- [x] 3.5 Wire `update` handler: delegate to `db[collection].update(id, updates)`, propagate typed errors
- [x] 3.6 Wire `delete` handler: delegate to `db[collection].delete(id)`, propagate typed errors
- [x] 3.7 Wire `aggregate` handler: delegate to `db[collection].aggregate(config)`
- [x] 3.8 Wire batch handlers: `createMany`, `updateMany`, `deleteMany`, `upsert`, `upsertMany` delegating to corresponding SmartCollection methods
- [x] 3.9 Ensure mutations on persistent databases trigger persistence as normal

## 4. RPC — Streaming

- [x] 4.1 Add stream variant for `query` procedure using `Rpc.stream` so results can flow incrementally
- [x] 4.2 Support configurable behavior: stream results incrementally or collect-then-return based on caller preference
- [x] 4.3 Verify streaming works over in-process transport (`RpcServer.makeNoSerialization`)

## 5. REST — Route Generation

- [x] 5.1 Create `rest/src/handlers.ts` with `createRestHandlers(config, db)` returning an array of `{ method, path, handler }` route descriptors
- [x] 5.2 Define the framework-agnostic handler type: `(req: { params: Record<string, string>, query: Record<string, string | string[]>, body: unknown }) => Promise<{ status: number, body: unknown, headers?: Record<string, string> }>`
- [x] 5.3 Generate per-collection routes: `GET /:collection`, `GET /:collection/:id`, `POST /:collection`, `PUT /:collection/:id`, `DELETE /:collection/:id`, `POST /:collection/batch`, `GET /:collection/aggregate`

## 6. REST — Query Parameter Parsing

- [x] 6.1 Create `rest/src/query-params.ts` with `parseQueryParams(query)` returning a proseql-compatible query config
- [x] 6.2 Parse simple equality: `?genre=sci-fi` becomes `where: { genre: "sci-fi" }`
- [x] 6.3 Parse operator syntax: `?year[$gte]=1970&year[$lt]=2000` becomes `where: { year: { $gte: 1970, $lt: 2000 } }`
- [x] 6.4 Parse sort: `?sort=year:desc` becomes `sort: { year: "desc" }`
- [x] 6.5 Parse pagination: `?limit=10&offset=20` becomes `limit: 10, offset: 20`
- [x] 6.6 Parse field selection: `?select=title,year` becomes `select: ["title", "year"]`
- [x] 6.7 Handle type coercion: numeric strings to numbers, `"true"`/`"false"` to booleans where appropriate

## 7. REST — CRUD Handlers

- [x] 7.1 Implement `GET /:collection` handler: parse query params, delegate to `db[collection].query(config)`, collect results, return `{ status: 200, body: results }`
- [x] 7.2 Implement `GET /:collection/:id` handler: delegate to `db[collection].findById(id)`, return 200 or mapped error
- [x] 7.3 Implement `POST /:collection` handler: delegate to `db[collection].create(body)`, return `{ status: 201, body: entity }`
- [x] 7.4 Implement `PUT /:collection/:id` handler: delegate to `db[collection].update(id, body)`, return 200 or mapped error
- [x] 7.5 Implement `DELETE /:collection/:id` handler: delegate to `db[collection].delete(id)`, return 200 or mapped error
- [x] 7.6 Implement `POST /:collection/batch` handler: delegate to `db[collection].createMany(body)`, return 201
- [x] 7.7 Implement `GET /:collection/aggregate` handler: parse aggregate query params, delegate to `db[collection].aggregate(config)`, return 200

## 8. REST — Error Mapping

- [x] 8.1 Create `rest/src/error-mapping.ts` with `mapErrorToResponse(error)` that matches on `_tag` and returns `{ status, body }`
- [x] 8.2 Map `NotFoundError` to 404, `ValidationError` to 400, `DuplicateKeyError` to 409, `UniqueConstraintError` to 409, `ForeignKeyError` to 422, `HookError` to 422, `TransactionError` to 500
- [x] 8.3 Default unknown errors to 500 with a generic message
- [x] 8.4 Include error `_tag` and fields in response body for debugging

## 9. REST — Relationship Routes

- [x] 9.1 Create `rest/src/relationship-routes.ts` that inspects collection relationships in the config
- [x] 9.2 For `ref` relationships (e.g., books.author), generate `GET /books/:id/author` that finds the book, follows the ref, returns the related entity
- [x] 9.3 For `inverse` relationships (e.g., authors.books), generate `GET /authors/:id/books` that queries the inverse collection filtered by foreign key
- [x] 9.4 Return 404 when the parent entity is not found, 200 with the related data on success

## 10. Tests — RPC

- [x] 10.1 Create `rpc/tests/rpc-group.test.ts`: verify makeRpcGroup produces correct procedures for a single-collection config
- [x] 10.2 Test multi-collection config produces namespaced procedures for each collection
- [x] 10.3 Create `rpc/tests/rpc-handlers.test.ts`: test findById handler returns entity for valid id
- [x] 10.4 Test findById handler returns typed NotFoundError for missing id
- [x] 10.5 Test query handler returns filtered results
- [x] 10.6 Test create handler returns created entity
- [x] 10.7 Test create handler returns typed ValidationError for invalid data
- [x] 10.8 Test update handler returns updated entity
- [x] 10.9 Test delete handler returns deleted entity
- [x] 10.10 Test aggregate handler returns correct scalar result
- [x] 10.11 Test batch handlers (createMany, deleteMany) work correctly
- [x] 10.12 Test typed errors flow through to client: `Effect.catchTag("NotFoundError", ...)` works
- [x] 10.13 Create `rpc/tests/rpc-streaming.test.ts`: test query streaming returns results incrementally via in-process transport

## 11. Tests — REST

- [x] 11.1 Create `rest/tests/query-params.test.ts`: test simple equality parsing
- [x] 11.2 Test operator syntax parsing ($gte, $lt, $in, etc.)
- [x] 11.3 Test sort parsing (single field, multiple fields)
- [x] 11.4 Test pagination parsing (limit, offset)
- [x] 11.5 Test field selection parsing
- [x] 11.6 Test type coercion (numbers, booleans)
- [x] 11.7 Create `rest/tests/handlers.test.ts`: test GET collection returns all entities
- [x] 11.8 Test GET collection with query params returns filtered results
- [x] 11.9 Test GET by id returns correct entity
- [x] 11.10 Test GET by id for missing entity returns 404
- [x] 11.11 Test POST creates entity and returns 201
- [x] 11.12 Test POST with invalid data returns 400
- [x] 11.13 Test PUT updates entity and returns 200
- [x] 11.14 Test DELETE removes entity and returns 200
- [x] 11.15 Test POST batch creates multiple entities
- [x] 11.16 Test GET aggregate returns correct result
- [x] 11.17 Create `rest/tests/error-mapping.test.ts`: test each tagged error maps to correct HTTP status
- [x] 11.18 Test unknown error maps to 500
- [x] 11.19 Create `rest/tests/relationship.test.ts`: test ref relationship route returns related entity
- [ ] 11.20 Test inverse relationship route returns related entities
- [ ] 11.21 Test relationship route returns 404 for missing parent

## 12. Cleanup

- [ ] 12.1 Update `rpc/src/index.ts` to re-export all public API: `makeRpcGroup`, `makeRpcHandlers`, error schemas, payload schemas
- [ ] 12.2 Update `rest/src/index.ts` to re-export all public API: `createRestHandlers`, `parseQueryParams`, `mapErrorToResponse`
- [ ] 12.3 Run full test suite (`bun test`) to verify no regressions in core
- [ ] 12.4 Run type check (`bunx tsc --build`) to verify no type errors across all packages
