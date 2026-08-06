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

## Effect API

Install `@proseql/effect` when application code should receive `Effect` and `Stream` values instead of Promises. It uses this same Rust/WASM engine and reconstructs public tagged errors for Effect error handling.

## License

MIT
