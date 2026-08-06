# @proseql/rpc

Effect 4 RPC definitions and Rust/WASM-backed server handlers for ProseQL, tested with exactly `effect@4.0.0-beta.103`.

The root `@proseql/rpc` export is the client-safe call contract: operation names, payloads, results, and error schemas. It does not install or load the database engine. The `@proseql/rpc/server` export builds handlers through `@proseql/effect`, so server-side queries and mutations run in the Rust/WASM engine.

This package does not provide a network server, choose a transport, or implement authentication or authorization. Applications use client and server transports from `effect/unstable/rpc` and must authenticate and authorize callers before any request reaches these handlers, especially mutation handlers.

## Install

Definition-only clients install:

```sh
npm install @proseql/rpc effect@4.0.0-beta.103
```

Servers also install the optional server peer:

```sh
npm install @proseql/rpc @proseql/effect effect@4.0.0-beta.103
```

Importing `@proseql/rpc` does not load `@proseql/effect`, `@proseql/engine`, or WASM. Server construction is available only from `@proseql/rpc/server`.

## Definitions and clients

```ts
import { Schema } from "effect"
import { RpcClient } from "effect/unstable/rpc"
import { makeRpcGroup } from "@proseql/rpc"

const Book = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  year: Schema.Number,
})

const config = {
  books: { schema: Book, relationships: {} },
} as const

const group = makeRpcGroup(config)

// Supply an Effect RpcClient.Protocol for your chosen transport.
const client = yield* RpcClient.make(group)

const created = yield* client["books.create"]({
  data: { id: "1", title: "Dune", year: 1965 },
})
const rows = yield* client["books.query"]({
  where: { year: { $gte: 1960 } },
  sort: { year: "desc" },
})
```

`makeRpcGroup` returns an Effect 4 `RpcGroup`. Requests are plain payloads; there are no constructible request classes.

Every collection defines these qualified tags:

| Operation | Example tag | Result |
| --- | --- | --- |
| Find by id | `books.findById` | Entity |
| Collected query | `books.query` | Row array or cursor page |
| Streamed query | `books.queryStream` | Stream of rows |
| Create / update / delete | `books.create`, `books.update`, `books.delete` | Entity |
| Aggregate | `books.aggregate` | Scalar or grouped aggregate |
| Bulk create / update / delete | `books.createMany`, `books.updateMany`, `books.deleteMany` | Bulk result |
| Upsert / bulk upsert | `books.upsert`, `books.upsertMany` | Upsert result |

Collection names must start with an ASCII letter and contain only letters, numbers, `_`, or `-`. This keeps tag namespaces unambiguous.

## WASM-backed server handlers

```ts
import { Layer } from "effect"
import { RpcServer } from "effect/unstable/rpc"
import { makeRpcGroup } from "@proseql/rpc"
import { makeRpcHandlers } from "@proseql/rpc/server"

const group = makeRpcGroup(config)
const handlers = makeRpcHandlers(config, {
  books: [{ id: "1", title: "Dune", year: 1965 }],
})

const serverLayer = RpcServer.layer(group).pipe(
  Layer.provide(handlers),
  // Layer.provide(your RpcServer.Protocol layer),
)
```

`makeRpcHandlers` creates the database through `@proseql/effect`, whose execution path is the Rust/WASM engine. To share an existing Effect database with other application services:

```ts
import { createEffectDatabase } from "@proseql/effect"
import { makeRpcHandlersFromDatabase } from "@proseql/rpc/server"

const db = yield* createEffectDatabase(config, { books: [] })
const handlers = makeRpcHandlersFromDatabase(config, db)
```

## Query contract

The wire query supports the direct Effect adapter's serializable query shapes:

- declarative `where` filters, including comparison, membership, logical, relationship, and `$search` filters
- `sort`
- array or object `select`
- nested `populate`
- `limit` and `offset`
- cursor pages through `cursor`

A collected cursor query returns `{ items, pageInfo }`; other collected queries return an array. `queryStream` streams rows and rejects cursor payloads because cursor queries return a page rather than a row stream. Cursor plus `limit` or `offset`, unknown `$` operators, non-JSON filter values, and invalid pagination values fail before execution with `InvalidRpcRequestError`.

Bulk update and delete pass the declarative filter to the canonical database path. They do not replace operators with equality checks.

Streaming has no ProseQL-specific chunk or buffer options. Transport buffering is configured with Effect's client transport options, such as `streamBufferSize`, when appropriate. The current WASM query API materializes the matching rows before the RPC stream starts; client cancellation still stops further transport emission and finalizes the server stream, but it does not make the underlying database query incremental.

## Typed failures

RPC schemas preserve ProseQL error tags and fields across serialization. Clients can use normal Effect error handling:

```ts
const result = client["books.findById"]({ id: "missing" }).pipe(
  Effect.catchTag("NotFoundError", (error) =>
    Effect.succeed({ found: false as const, id: error.id }),
  ),
)
```

The operation contracts cover the failures their database calls can return, including validation, not-found, duplicate-key, unique-constraint, foreign-key, hook, operation, population, dangling-reference, and invalid-request failures. Shared transaction, concurrency, and collection error schemas are also exported for applications that compose broader protocols, but this package does not define a remote transaction operation.

## Exports

### `@proseql/rpc`

- `makeRpcGroup`
- `makeCollectionRpcs`
- payload, result, query, and error schemas
- corresponding TypeScript types

### `@proseql/rpc/server`

- `makeRpcHandlers`
- `makeRpcHandlersFromDatabase`
- handler service types

Clients and servers import `RpcClient`, `RpcServer`, `RpcTest`, and transport implementations directly from `effect/unstable/rpc`.

## Security

This package defines calls and handlers only. It does not provide authentication, authorization, rate limiting, or a hardened network listener. Enforce those policies at the transport/application boundary before exposing ProseQL handlers.

## License

MIT
