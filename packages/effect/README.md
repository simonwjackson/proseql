# @proseql/effect

Effect-first ProseQL APIs over the Rust/WebAssembly engine.

This package keeps the public TypeScript contract from `@proseql/core`, executes queries and mutations through `@proseql/engine`, wraps Promise operations as `Effect` and reactive results as `Stream`, and reconstructs public tagged errors so `Effect.catchTag` works. Unexpected WASM failures remain defects rather than being disguised as expected database errors.

## Install

```sh
npm install @proseql/effect effect@4.0.0-beta.103
```

Effect is pinned exactly because this release is tested against `effect@4.0.0-beta.103`.

## Use

```ts
import { Effect, Schema, Stream } from "effect"
import { createEffectDatabase } from "@proseql/effect"

const config = {
  books: {
    schema: Schema.Struct({ id: Schema.String, title: Schema.String }),
    relationships: {},
  },
} as const

const program = Effect.gen(function* () {
  const db = yield* createEffectDatabase(config, { books: [] })
  yield* db.books.create({ id: "1", title: "Dune" })
  const books = yield* Stream.runCollect(db.books.query())
  yield* Effect.promise(() => db.close())
  return Array.from(books)
})

const books = await Effect.runPromise(program)
```

Validation, not-found, storage, and other expected failures retain their ProseQL `_tag` and fields across the WASM boundary. Use normal Effect error operators such as `Effect.catchTag`.

## Node persistence

Import `createNodeDatabase`, `makeProseQLLayer`, `makeNodePersistenceLayer`, `NodeStorageLayer`, `makeNodeStorageLayer` and the `NodeAdapterConfig` type from `@proseql/effect/node`. The root entry does not add Node convenience helpers. These helpers use the engine's Node host and preserve their previous types.

```ts
import { createNodeDatabase } from "@proseql/effect/node"
import { Effect, Schema } from "effect"

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const db = yield* createNodeDatabase({
    books: { schema: Schema.Struct({ id: Schema.String, title: Schema.String }), file: "./data/books.json", relationships: {} },
  })
  yield* db.books.create({ id: "1", title: "Dune" })
})))
```

See the [Node persistence guide](../node/README.md) for configuration, document sources, and layers.

## Browser loading

Import `@proseql/effect/browser` for the browser-safe Effect API, engine browser hosts, and compatibility `StorageAdapter` layers for localStorage, sessionStorage and IndexedDB. The browser entry loads the packaged browser WASM; the root entry loads the Node WASM. Neither path builds Rust at runtime.

The browser entry also exports `pathToKey`, `DEFAULT_STORAGE_KEY_PREFIX` and `validateAllowedFormat`. `getFileExtension` remains the shared core export, inherited by this entry. See the [browser storage guide](../browser/README.md) for adapter configuration.

Service workers import `@proseql/effect/browser/worker`. Call `initializeWorkerWasmBindings()` during the worker event lifetime before opening the database. Browser entries do not import Node built-ins.

## Migrate imports

| Deprecated import | Replacement |
|---|---|
| `@proseql/node` | `@proseql/effect/node` |
| `@proseql/browser` | `@proseql/effect/browser` |
| `@proseql/browser/worker` | `@proseql/effect/browser/worker` |

The old packages publish one final 1.0.0 as pure re-export shims. New applications need neither shim. See the [complete per-export migration table](../../docs/shim-export-migration.md).

## License

MIT
