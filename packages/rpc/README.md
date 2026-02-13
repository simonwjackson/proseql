# @proseql/rpc

Type-safe Effect RPC integration for ProseQL databases. Derive typed RPC procedures from your database config with full error inference.

## Install

```sh
npm install @proseql/rpc
```

## Quick Start

```ts
import { Effect, Schema } from "effect"
import { createEffectDatabase } from "@proseql/core"
import { makeRpcGroup, makeRpcHandlers } from "@proseql/rpc"

const BookSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  author: Schema.String,
  year: Schema.Number,
})

const config = {
  books: {
    schema: BookSchema,
    relationships: {},
  },
} as const

// 1. Derive RPC group from your database config
const rpcs = makeRpcGroup(config)

// 2. Create handler implementations
const program = Effect.gen(function* () {
  const handlers = yield* makeRpcHandlers(config, {
    books: [{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 }],
  })

  // 3. Use handlers directly or wire to RPC transport
  const book = yield* handlers.books.findById({ id: "1" })
  console.log(book.title) // "Dune"
})

await Effect.runPromise(program)
```

For the full query and mutation API, see [`@proseql/core`](https://www.npmjs.com/package/@proseql/core).

## RPC Group Derivation

`makeRpcGroup` derives typed RPC request schemas from your database config. Each collection gets request classes for all CRUD and batch operations.

```ts
import { makeRpcGroup } from "@proseql/rpc"

const rpcs = makeRpcGroup(config)
// rpcs.books.FindByIdRequest
// rpcs.books.QueryRequest
// rpcs.books.CreateRequest
// rpcs.books.UpdateRequest
// rpcs.books.DeleteRequest
// rpcs.books.AggregateRequest
// rpcs.books.CreateManyRequest
// rpcs.books.UpdateManyRequest
// rpcs.books.DeleteManyRequest
// rpcs.books.UpsertRequest
// rpcs.books.UpsertManyRequest
// rpcs.books.QueryStreamRequest
```

### Request Tags

Each request class is tagged with the collection and operation name:

| Request Class | Tag |
|--------------|-----|
| `FindByIdRequest` | `books.findById` |
| `QueryRequest` | `books.query` |
| `QueryStreamRequest` | `books.queryStream` |
| `CreateRequest` | `books.create` |
| `UpdateRequest` | `books.update` |
| `DeleteRequest` | `books.delete` |
| `AggregateRequest` | `books.aggregate` |
| `CreateManyRequest` | `books.createMany` |
| `UpdateManyRequest` | `books.updateMany` |
| `DeleteManyRequest` | `books.deleteMany` |
| `UpsertRequest` | `books.upsert` |
| `UpsertManyRequest` | `books.upsertMany` |

### Creating Request Instances

```ts
const rpcs = makeRpcGroup(config)

// FindById
const findById = new rpcs.books.FindByIdRequest({ id: "1" })

// Query with filters and sorting
const query = new rpcs.books.QueryRequest({
  where: { year: { $gt: 1980 } },
  sort: { year: "desc" },
  limit: 10,
})

// Create
const create = new rpcs.books.CreateRequest({
  data: { title: "Neuromancer", author: "William Gibson", year: 1984 },
})

// Update
const update = new rpcs.books.UpdateRequest({
  id: "1",
  updates: { genre: "classic" },
})

// Delete
const deleteReq = new rpcs.books.DeleteRequest({ id: "1" })

// Aggregate
const aggregate = new rpcs.books.AggregateRequest({
  count: true,
  groupBy: "author",
})
```

## RPC Handlers

### `makeRpcHandlers`

Creates handler implementations from a database config. Returns an Effect that produces handlers for all collections.

```ts
import { Effect } from "effect"
import { makeRpcHandlers } from "@proseql/rpc"

const program = Effect.gen(function* () {
  const handlers = yield* makeRpcHandlers(config, {
    books: [{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 }],
  })

  // Use handlers
  const book = yield* handlers.books.findById({ id: "1" })
  const allBooks = yield* handlers.books.query({})
  const created = yield* handlers.books.create({
    data: { title: "New Book", author: "Author", year: 2024 },
  })
})
```

### `makeRpcHandlersFromDatabase`

Creates handlers from an existing database instance. Use this when you need file persistence or want to share a database across multiple transports.

```ts
import { Effect, Layer } from "effect"
import { createPersistentEffectDatabase, NodeStorageLayer, makeSerializerLayer, jsonCodec } from "@proseql/node"
import { makeRpcHandlersFromDatabase } from "@proseql/rpc"

const config = {
  books: {
    schema: BookSchema,
    file: "./data/books.json",
    relationships: {},
  },
} as const

const program = Effect.gen(function* () {
  // Create persistent database
  const db = yield* createPersistentEffectDatabase(config, { books: [] })

  // Wire RPC handlers to the persistent database
  const handlers = makeRpcHandlersFromDatabase(config, db)

  // Mutations through RPC now trigger persistence automatically
  yield* handlers.books.create({
    data: { id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
  })

  // Flush to ensure data is written
  yield* Effect.promise(() => db.flush())
})

const PersistenceLayer = Layer.merge(
  NodeStorageLayer,
  makeSerializerLayer([jsonCodec()]),
)

await Effect.runPromise(
  program.pipe(Effect.provide(PersistenceLayer), Effect.scoped),
)
```

### `makeRpcHandlersLayer`

Creates an Effect Layer providing a `DatabaseContext` service.

```ts
import { Effect } from "effect"
import { makeRpcHandlersLayer, makeDatabaseContextTag } from "@proseql/rpc"

const layer = makeRpcHandlersLayer(config, { books: initialBooks })

const DatabaseContextTag = makeDatabaseContextTag<typeof config>()

const program = Effect.gen(function* () {
  const ctx = yield* DatabaseContextTag
  const book = yield* ctx.db.books.findById("1")
})

await Effect.runPromise(program.pipe(Effect.provide(layer)))
```

## Error Schemas

All ProseQL errors have RPC-safe schemas for transport. Errors maintain their `_tag` through the RPC layer, enabling `Effect.catchTag` on the client side.

### CRUD Errors

| Error | When |
|-------|------|
| `NotFoundError` | Entity with ID doesn't exist |
| `ValidationError` | Schema validation failed |
| `DuplicateKeyError` | Entity with same ID already exists |
| `UniqueConstraintError` | Unique field constraint violated |
| `ForeignKeyError` | Referenced entity doesn't exist |
| `HookError` | Lifecycle hook rejected the operation |
| `OperationError` | Operation not allowed (e.g., update on append-only) |
| `ConcurrencyError` | Concurrent modification conflict |
| `TransactionError` | Transaction operation failed |

### Query Errors

| Error | When |
|-------|------|
| `DanglingReferenceError` | Referenced entity no longer exists |
| `CollectionNotFoundError` | Collection doesn't exist in config |
| `PopulationError` | Relationship population failed |

### Error Handling

Errors flow through the RPC layer with their tags preserved:

```ts
import { Effect } from "effect"

const result = await Effect.runPromise(
  handlers.books.findById({ id: "nonexistent" }).pipe(
    Effect.catchTag("NotFoundError", (error) =>
      Effect.succeed({
        status: "not_found",
        collection: error.collection,
        id: error.id,
      }),
    ),
    Effect.catchTag("ValidationError", (error) =>
      Effect.succeed({
        status: "validation_failed",
        issues: error.issues,
      }),
    ),
  ),
)
```

Or use `Effect.catchTags` for multiple error types:

```ts
const result = await Effect.runPromise(
  handlers.books.findById({ id: "nonexistent" }).pipe(
    Effect.catchTags({
      NotFoundError: (e) => Effect.succeed({ status: "not_found", id: e.id }),
      ValidationError: (e) => Effect.succeed({ status: "invalid", issues: e.issues }),
    }),
  ),
)
```

## Payload Schemas

Request payloads are defined using Effect Schema for type-safe serialization.

### Query Payload

```ts
import { QueryPayloadSchema } from "@proseql/rpc"

// Supports:
// - where: filter conditions
// - sort: field ordering
// - select: field selection
// - populate: relationship population
// - limit/offset: pagination
// - cursor: cursor-based pagination
// - streamingOptions: for queryStream
```

### CRUD Payloads

```ts
import {
  FindByIdPayloadSchema,
  CreatePayloadSchema,
  UpdatePayloadSchema,
  DeletePayloadSchema,
  AggregatePayloadSchema,
} from "@proseql/rpc"

// FindById: { id: string }
// Create: { data: Record<string, unknown> }
// Update: { id: string, updates: Record<string, unknown> }
// Delete: { id: string }
// Aggregate: { where?, groupBy?, count?, sum?, avg?, min?, max? }
```

### Batch Payloads

```ts
import {
  CreateManyPayloadSchema,
  UpdateManyPayloadSchema,
  DeleteManyPayloadSchema,
  UpsertPayloadSchema,
  UpsertManyPayloadSchema,
} from "@proseql/rpc"

// CreateMany: { data: Array<Record>, options?: { skipDuplicates? } }
// UpdateMany: { where: Record, updates: Record }
// DeleteMany: { where: Record, options?: { limit? } }
// Upsert: { where: Record, create: Record, update: Record }
// UpsertMany: { data: Array<{ where, create, update }> }
```

## Streaming Queries

Use `QueryStreamRequest` for incremental result delivery over RPC transport.

```ts
import { Stream, Chunk } from "effect"

const rpcs = makeRpcGroup(config)
const handlers = await Effect.runPromise(makeRpcHandlers(config, initialData))

// queryStream returns a Stream instead of collecting to array
const stream = handlers.books.queryStream({
  where: { genre: "sci-fi" },
  streamingOptions: { chunkSize: 100 }, // batch items before sending
})

// Collect results
const results = await Effect.runPromise(
  Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray)),
)
```

### Streaming Options

| Option | Description |
|--------|-------------|
| `chunkSize` | Number of items to batch before sending (default: 1) |
| `bufferSize` | Client-side buffer size for backpressure (default: 16) |

## Result Schemas

Response types for batch and aggregate operations.

```ts
import {
  AggregateResultSchema,
  GroupedAggregateResultSchema,
  CreateManyResultSchema,
  UpdateManyResultSchema,
  DeleteManyResultSchema,
  UpsertResultSchema,
  UpsertManyResultSchema,
  CursorPageResultSchema,
} from "@proseql/rpc"
```

### Aggregate Results

```ts
// Scalar aggregation
type AggregateResult = {
  count?: number
  sum?: Record<string, number>
  avg?: Record<string, number | null>
  min?: Record<string, unknown>
  max?: Record<string, unknown>
}

// Grouped aggregation
type GroupedAggregateResult = Array<{
  group: Record<string, unknown>
  count?: number
  sum?: Record<string, number>
  avg?: Record<string, number | null>
  min?: Record<string, unknown>
  max?: Record<string, unknown>
}>
```

### Batch Results

```ts
// CreateMany
type CreateManyResult = {
  created: Array<Entity>
  skipped?: Array<{ data: unknown; reason: string }>
}

// UpdateMany
type UpdateManyResult = {
  count: number
  updated: Array<Entity>
}

// DeleteMany
type DeleteManyResult = {
  count: number
  deleted: Array<Entity>
}

// Upsert
type UpsertResult = Entity & { __action: "created" | "updated" }

// UpsertMany
type UpsertManyResult = {
  created: Array<Entity>
  updated: Array<Entity>
  unchanged: Array<Entity>
}
```

## Building an RPC Router

Use `RpcRouter` from `@effect/rpc` to compose handlers into a router:

```ts
import { Rpc, RpcRouter } from "@effect/rpc"
import { makeRpcGroup, makeRpcHandlers } from "@proseql/rpc"

const rpcs = makeRpcGroup(config)

const program = Effect.gen(function* () {
  const handlers = yield* makeRpcHandlers(config, initialData)

  // Create RPC handlers using Rpc.effect
  const findBookById = Rpc.effect(rpcs.books.FindByIdRequest, (req) =>
    handlers.books.findById({ id: req.id }),
  )

  const queryBooks = Rpc.effect(rpcs.books.QueryRequest, (req) =>
    handlers.books.query({
      where: req.where,
      sort: req.sort,
      limit: req.limit,
      offset: req.offset,
    }),
  )

  const createBook = Rpc.effect(rpcs.books.CreateRequest, (req) =>
    handlers.books.create({ data: req.data }),
  )

  // Build router
  const router = RpcRouter.make(findBookById, queryBooks, createBook)
})
```

## API Reference

### Exports

| Export | Description |
|--------|-------------|
| `makeRpcGroup` | Derive RPC request schemas from database config |
| `makeRpcHandlers` | Create handlers from config + initial data |
| `makeRpcHandlersFromDatabase` | Create handlers from existing database |
| `makeRpcHandlersLayer` | Create Layer providing DatabaseContext |
| `makeRpcHandlersLayerFromDatabase` | Create Layer from existing database |
| `makeDatabaseContextTag` | Create Context.Tag for database service |
| `RpcRouter` | Re-exported from @effect/rpc |

### Request Factories

| Factory | Description |
|---------|-------------|
| `makeFindByIdRequest` | Create FindById request class |
| `makeQueryRequest` | Create Query request class |
| `makeQueryStreamRequest` | Create streaming Query request class |
| `makeCreateRequest` | Create Create request class |
| `makeUpdateRequest` | Create Update request class |
| `makeDeleteRequest` | Create Delete request class |
| `makeAggregateRequest` | Create Aggregate request class |
| `makeCreateManyRequest` | Create CreateMany request class |
| `makeUpdateManyRequest` | Create UpdateMany request class |
| `makeDeleteManyRequest` | Create DeleteMany request class |
| `makeUpsertRequest` | Create Upsert request class |
| `makeUpsertManyRequest` | Create UpsertMany request class |
| `makeCollectionRpcs` | Create all request classes for a collection |

### Error Schemas

| Schema | Description |
|--------|-------------|
| `NotFoundErrorSchema` | Entity not found |
| `ValidationErrorSchema` | Schema validation failed |
| `DuplicateKeyErrorSchema` | Duplicate ID |
| `UniqueConstraintErrorSchema` | Unique constraint violated |
| `ForeignKeyErrorSchema` | Foreign key constraint violated |
| `HookErrorSchema` | Lifecycle hook rejected |
| `OperationErrorSchema` | Operation not allowed |
| `ConcurrencyErrorSchema` | Concurrent modification |
| `TransactionErrorSchema` | Transaction failed |
| `DanglingReferenceErrorSchema` | Dangling reference |
| `CollectionNotFoundErrorSchema` | Collection not found |
| `PopulationErrorSchema` | Population failed |
| `CrudErrorSchema` | Union of CRUD errors |
| `QueryErrorSchema` | Union of query errors |
| `RpcErrorSchema` | Union of all RPC errors |

### Payload Schemas

| Schema | Description |
|--------|-------------|
| `FindByIdPayloadSchema` | FindById payload |
| `QueryPayloadSchema` | Query payload |
| `CreatePayloadSchema` | Create payload |
| `UpdatePayloadSchema` | Update payload |
| `DeletePayloadSchema` | Delete payload |
| `AggregatePayloadSchema` | Aggregate payload |
| `CreateManyPayloadSchema` | CreateMany payload |
| `UpdateManyPayloadSchema` | UpdateMany payload |
| `DeleteManyPayloadSchema` | DeleteMany payload |
| `UpsertPayloadSchema` | Upsert payload |
| `UpsertManyPayloadSchema` | UpsertMany payload |
| `StreamingOptionsSchema` | Streaming options |

### Result Schemas

| Schema | Description |
|--------|-------------|
| `AggregateResultSchema` | Scalar aggregate result |
| `GroupedAggregateResultSchema` | Grouped aggregate result |
| `CreateManyResultSchema` | CreateMany result |
| `UpdateManyResultSchema` | UpdateMany result |
| `DeleteManyResultSchema` | DeleteMany result |
| `UpsertResultSchema` | Upsert result |
| `UpsertManyResultSchema` | UpsertMany result |
| `CursorPageResultSchema` | Cursor pagination result |
| `CursorPageInfoSchema` | Cursor page info |

## License

MIT
