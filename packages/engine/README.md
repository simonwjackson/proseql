# @proseql/engine

Promise-first ProseQL database execution in Rust compiled to WebAssembly.

`@proseql/core` defines the shared TypeScript schema and data contract. This package compiles that supported schema subset into an engine descriptor, loads the packaged WASM, and exposes Promise-based query, mutation, persistence, and watch APIs. It does not fall back to a separate JavaScript query engine.

## Install

```sh
npm install @proseql/engine effect@4.0.0-beta.103
```

The package is tested with exactly `effect@4.0.0-beta.103` because database schemas come from Effect Schema.

## Node

```ts
import { Schema } from "effect"
import { createEngineDatabase } from "@proseql/engine"

const config = {
  books: {
    schema: Schema.Struct({ id: Schema.String, title: Schema.String }),
    relationships: {},
  },
} as const

const db = await createEngineDatabase(config, { books: [] })
await db.books.create({ id: "1", title: "Dune" })
const books = await db.books.query()
await db.close()
```

The Node entry point loads the Node-targeted JavaScript glue and `.wasm` file included in the npm package. Consumers do not need Rust, `wasm-bindgen`, or a repository checkout at runtime.

## Browser

Import the browser-safe loader from `@proseql/engine/browser`:

```ts
import { createEngineDatabase } from "@proseql/engine/browser"
```

A browser or bundler loads the included browser WASM asset through `import.meta.url`. Do not copy a WASM file from a different package version: the loader rejects stale generated bindings. Applications that also need browser persistence normally install `@proseql/browser`, which re-exports this browser engine and provides localStorage, sessionStorage, and IndexedDB hosts.

### Workers

`@proseql/engine/worker` statically imports the matching browser WASM glue and
exports `initializeWorkerWasmBindings`. This is required for service workers
because the platform forbids dynamic `import()` there. Runtime detection treats
window, service-worker, dedicated-worker, and Node scopes explicitly; a worker
that has not initialized the static binding receives
`WorkerWasmInitializationError` and never attempts Node builtins.

`createServiceWorkerEngineDatabase` is the supported single-writer worker
facade. It serializes the full operation stream and does not acknowledge a
mutation before persistent storage completes. A failed durable flush quarantines
and drops the in-memory runtime so a clean reopen cannot observe the rejected
mutation.

## Time-series options

These collection options reach the Rust engine through this package:

- `duplicateIds: "error" | "ignoreIdentical"` (default `"error"`). With `"ignoreIdentical"`, `create` and `createMany` accept a record whose ID exists with an identical payload, write nothing and return the stored record; a different payload is still a `DuplicateKeyError`. Importers that retry can use it.
- `orderedIndexes: ["timestamp"]` builds an ordered index. The engine uses it for `$gt`, `$gte`, `$lt` and `$lte` filters on the field. Results do not change. This package sorts through the host string collator, so the index narrows ranges but does not order sorts here.
- A partitioned source can use `{ kind: "timeBucket", field, bucket: "year" | "month" | "day" }` as its key; the field must be a UTC timestamp ending in `Z`.

Partitioned append without rewrite and lazy partition loading are native Rust runtime features only, on purpose. See `docs/native-sources.md` in the ProseQL repository.

[Write a storage host](../../docs/storage-hosts.md) for another runtime.

## Effect API

Install `@proseql/effect` when application code should receive `Effect` and `Stream` values instead of Promises. It uses this same Rust/WASM engine and reconstructs public tagged errors for Effect error handling.

## License

MIT
