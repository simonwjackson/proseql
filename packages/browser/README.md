# @proseql/browser

> **Deprecated:** Use `@proseql/effect/browser`. Version 1.0.0 is the final compatibility shim release. It preserves all existing exports.

| Old import | New import |
|---|---|
| `@proseql/browser` | `@proseql/effect/browser` |
| `@proseql/browser/worker` | `@proseql/effect/browser/worker` |

Install `@proseql/effect` instead. The examples below use the replacement.

Browser-safe ProseQL entry points and persistence hosts for the Rust/WebAssembly engine.

The package re-exports the browser build of `@proseql/effect`, the Promise-first `@proseql/engine/browser` facade, and adapters for localStorage, sessionStorage, and IndexedDB. Queries and mutations run in Rust/WASM; storage remains at the browser boundary.

## Install

```sh
npm install @proseql/effect effect@4.0.0-beta.103
```

This release is tested with exactly `effect@4.0.0-beta.103`.

## Promise-first WASM database

```ts
import { Schema } from "effect"
import {
  createLocalStorageEngineStorageHost,
  createPersistentEngineDatabase,
} from "@proseql/effect/browser"

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

| Factory | Storage | Supported owners |
| --- | --- | --- |
| `createLocalStorageEngineStorageHost` | Persistent web storage with cross-tab storage events | Window |
| `createSessionStorageEngineStorageHost` | Storage scoped to the current tab/session | Window |
| `createIndexedDBEngineStorageHost` | IndexedDB for larger browser datasets | Window, dedicated worker |
| `createServiceWorkerIndexedDBEngineStorageHost` | Explicitly named IndexedDB/channel namespace | Single service-worker owner |

## Service-worker ownership

Import the worker-specific entry point so the matching WASM glue is static rather
than loaded with `import()`, which ServiceWorkerGlobalScope forbids:

```ts
import {
  createServiceWorkerEngineDatabase,
  createServiceWorkerIndexedDBEngineStorageHost,
  initializeWorkerWasmBindings,
} from "@proseql/effect/browser/worker"

await initializeWorkerWasmBindings()
const storageHost = createServiceWorkerIndexedDBEngineStorageHost({
  databaseName: "my-reader-v1",
  storeName: "collections",
  version: 1,
  keyPrefix: "my-reader:",
  channelName: "my-reader-proseql",
  originId: "my-reader-worker-owner",
})
const db = await createServiceWorkerEngineDatabase(config, initialData, {
  storageHost,
})
```

The worker facade FIFO-serializes reads and writes. A mutation resolves only
after the IndexedDB transaction completes. Persistence failure rejects the
mutation, closes and quarantines the facade, and requires constructing a fresh
facade before further access; reopening loads only the prior durable state.
Pages must communicate with this owner through application messages and must
not open the same writable database. Low-level watch subscriptions are withheld
from this facade so they cannot expose a mutation before its durable flush;
applications publish their own messages only after a mutating request resolves.

`close()` waits for in-flight IndexedDB transactions, stops channels/watchers,
and closes the cached connection. A later worker event creates a fresh host and
database using the same explicit identity.

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

Transaction-origin tracking is not reliable across arbitrary asynchronous work yielded from inside a multi-window browser transaction. Avoid unrelated asynchronous work inside those callbacks when persistence or watch-driven updates may interleave. The single-owner service-worker facade does not expose that race between independent callers because its complete operation stream is FIFO serialized.

## Local Nix bundle

`nix build .#browser` produces built `core`, `engine`, `effect`, and `browser`
packages, the matching browser WASM, tarballs, the exact external dependency
closure, and `source-identity.json`. The identity is derived from the complete
filtered Nix source store path. `checks.browser-offline-consumer` imports both
browser entry points from that closure without registry or network access.

## License

MIT
