# @proseql/browser

Browser-safe ProseQL entry points and persistence hosts for the Rust/WebAssembly engine.

The package re-exports the browser build of `@proseql/effect`, the Promise-first `@proseql/engine/browser` facade, and adapters for localStorage, sessionStorage, and IndexedDB. Queries and mutations run in Rust/WASM; storage remains at the browser boundary.

## Install

```sh
npm install @proseql/browser effect@4.0.0-beta.103
```

This release is tested with exactly `effect@4.0.0-beta.103`.

## Promise-first WASM database

```ts
import { Schema } from "effect"
import {
  createLocalStorageEngineStorageHost,
  createPersistentEngineDatabase,
} from "@proseql/browser"

const config = {
  books: {
    schema: Schema.Struct({ id: Schema.String, title: Schema.String }),
    file: "books.json",
    relationships: {},
  },
} as const

const db = await createPersistentEngineDatabase(
  config,
  { books: [] },
  {
    storageHost: createLocalStorageEngineStorageHost({
      keyPrefix: "my-app:",
    }),
  },
)

await db.books.create({ id: "1", title: "Dune" })
await db.flush()
await db.close()
```

The browser loader resolves the `.wasm` asset included in `@proseql/engine` through the package's browser entry point. A normal ESM-aware bundler or browser serves that asset; no Rust build runs in the application.

Promise-first engine hosts are available for:

| Factory | Storage |
| --- | --- |
| `createLocalStorageEngineStorageHost` | Persistent web storage with cross-tab storage events |
| `createSessionStorageEngineStorageHost` | Storage scoped to the current tab/session |
| `createIndexedDBEngineStorageHost` | IndexedDB for larger browser datasets |

## Effect APIs and compatibility layers

`createEffectDatabase` and `createPersistentEffectDatabase` expose the same WASM-backed engine through Effect and Stream values. Existing Effect storage layers are also exported:

- `LocalStorageLayer` / `BrowserStorageLayer`
- `SessionStorageLayer`
- `IndexedDBStorageLayer`
- `makeLocalStorageLayer`, `makeSessionStorageLayer`, and `makeIndexedDBStorageLayer`

Browser-safe JSON, JSON5, JSONC, Hjson, YAML, TOML, TOON, and Prose codecs are re-exported from the core surface.

## Storage keys and quota failures

Browser storage uses flat keys. `pathToKey("./data/books.yaml")` returns `"proseql:data/books.yaml"`; pass a second argument to choose another prefix. localStorage and sessionStorage are usually limited to a few megabytes. Expected quota failures are reported as tagged `StorageError` values. Use IndexedDB for larger data.

## Known async transaction limitation

Transaction-origin tracking is not reliable across asynchronous work yielded from inside a browser transaction. Avoid unrelated asynchronous work inside browser transactions when persistence or watch-driven updates may interleave. Keep transaction callbacks synchronous apart from the database operations they coordinate, and do not assume an external update can always be distinguished after an arbitrary `await`. This limitation is tracked separately and is not fixed by this release.

## License

MIT
