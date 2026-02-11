# Browser Storage Adapter — Design

## Architecture

### New Modules

**`browser/src/adapters/local-storage-adapter.ts`** — `StorageAdapterShape` implementation backed by `window.localStorage`. `read` calls `getItem` and fails with `StorageError` if the key is missing. `write` calls `setItem` wrapped in a try/catch that detects `QuotaExceededError` and surfaces it as `StorageError`. `exists` checks `getItem !== null`. `ensureDir` is `Effect.void` (no-op). `remove` calls `removeItem`. `watch` registers a `storage` event listener filtered to the target key and returns an unsubscribe function.

**`browser/src/adapters/session-storage-adapter.ts`** — Identical shape to the localStorage adapter but backed by `window.sessionStorage`. No cross-tab sync (sessionStorage is tab-scoped, the `storage` event does not fire for it). `watch` returns a no-op unsubscribe since sessionStorage has no cross-tab events; file-level watch is not meaningful in this context.

**`browser/src/adapters/indexeddb-adapter.ts`** — `StorageAdapterShape` implementation backed by IndexedDB. Opens (or creates) a database and object store on first access. `read` performs a `get` transaction wrapped in `Effect.async`. `write` performs a `put` transaction. `exists` performs a `count` query on the key. `remove` performs a `delete` transaction. `ensureDir` is `Effect.void`. `watch` is not natively supported by IndexedDB; the adapter accepts an optional polling interval or returns a no-op unsubscribe.

**`browser/src/path-to-key.ts`** — Pure function that converts a file path (e.g., `./data/books.yaml`) to a flat storage key (e.g., `proseql:data/books.yaml`). Strips leading `./`, normalizes backslashes to forward slashes, prepends the configurable prefix. Used by all three adapters to translate collection config paths to storage keys.

**`browser/src/browser-adapter-layer.ts`** — Factory functions `makeLocalStorageLayer`, `makeSessionStorageLayer`, `makeIndexedDBStorageLayer` that accept config and return `Layer.Layer<StorageAdapter>`. Also exports convenience aliases `LocalStorageLayer`, `SessionStorageLayer`, `IndexedDBStorageLayer`, and `BrowserStorageLayer` (defaults to localStorage).

**`browser/src/index.ts`** — Re-exports everything from `@proseql/core` plus all browser-specific layers, config types, and `pathToKey`.

### Modified Modules

None. No existing modules are modified. The browser package is entirely additive.

## Key Decisions

### New `packages/browser/` package following the node adapter pattern

The browser adapter lives in its own workspace package rather than inside core. This mirrors the node adapter pattern: core stays runtime-agnostic, and each runtime gets its own package that re-exports core plus a storage layer. Users install `@proseql/browser` instead of `@proseql/node` and get the same API with browser-compatible persistence.

### Path-to-key mapping strategy

Browser storage APIs use flat string keys, not hierarchical file paths. The `pathToKey` function normalizes collection config paths into storage keys by stripping `./`, collapsing separators, and prepending a configurable prefix (default `proseql:`). This keeps keys human-readable in DevTools and avoids collisions between multiple proseql instances on the same origin by allowing different prefixes.

### localStorage quota handling

`localStorage.setItem` throws a `DOMException` with name `QuotaExceededError` when the ~5MB limit is reached. The adapter catches this specific exception and wraps it in a `StorageError` with `operation: "write"` and a message that includes the key and a note about the quota. This gives users a clear, typed error they can match on rather than an opaque DOM exception.

### Cross-tab sync via storage events

The `window.storage` event fires when another tab modifies localStorage on the same origin. The localStorage adapter's `watch` implementation registers a listener filtered to the watched key. When a matching event fires, it calls the `onChange` callback, which triggers the persistence layer's reload logic. This gives cross-tab consistency for free. sessionStorage and IndexedDB do not have this mechanism -- sessionStorage is tab-scoped by definition, and IndexedDB would require a BroadcastChannel (out of scope for the initial implementation).

### IndexedDB wrapper using Effect

IndexedDB is callback-based (via `IDBRequest.onsuccess`/`onerror`). Each operation is wrapped in `Effect.async`, which registers the callbacks and resumes the fiber on completion. This fits naturally into the Effect model -- no Promises needed, cancellation is handled by aborting the transaction, and errors are surfaced as `StorageError`. The adapter opens a single database (configurable name, default `proseql`) with one object store (default `collections`) on first access and caches the `IDBDatabase` handle.

### Which codecs are browser-safe

JSON, JSON5, JSONC, and Hjson codecs are pure JavaScript and work in any runtime. YAML (`yaml` package) is also browser-safe. TOML (`smol-toml`) and TOON need verification -- if their dependencies include Node-only modules, the browser adapter should reject them at layer construction time by throwing `UnsupportedFormatError`. The adapter config accepts an optional `allowedFormats` list; if omitted, all formats are attempted and failures are reported at write/read time.

### Shared adapter factory for localStorage and sessionStorage

localStorage and sessionStorage have identical APIs (`getItem`, `setItem`, `removeItem`, `key`, `length`). The implementation uses a shared `makeWebStorageAdapter(storage: Storage, config)` factory that both `LocalStorageLayer` and `SessionStorageLayer` call with the appropriate `Storage` instance. The only difference is the `watch` implementation: localStorage registers a `storage` event listener, sessionStorage returns a no-op.

## File Layout

```
packages/browser/
  package.json                              (new — @proseql/browser, depends on @proseql/core)
  tsconfig.json                             (new — extends root tsconfig)
  src/
    index.ts                                (new — re-exports core + browser layers)
    path-to-key.ts                          (new — pathToKey utility)
    browser-adapter-layer.ts                (new — layer factories and convenience exports)
    adapters/
      web-storage-adapter.ts                (new — shared localStorage/sessionStorage impl)
      local-storage-adapter.ts              (new — localStorage-specific watch + factory)
      session-storage-adapter.ts            (new — sessionStorage-specific factory)
      indexeddb-adapter.ts                  (new — IndexedDB StorageAdapterShape impl)
  tests/
    path-to-key.test.ts                     (new — pathToKey unit tests)
    local-storage-adapter.test.ts           (new — localStorage adapter tests)
    session-storage-adapter.test.ts         (new — sessionStorage adapter tests)
    indexeddb-adapter.test.ts               (new — IndexedDB adapter tests)
    cross-tab-sync.test.ts                  (new — storage event / cross-tab tests)
    quota-handling.test.ts                  (new — quota exceeded error tests)
    integration.test.ts                     (new — full database lifecycle with browser adapters)
```
