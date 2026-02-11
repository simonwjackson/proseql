## Why

The in-memory database engine and query pipeline are runtime-agnostic, but persistence is locked to Node.js. The only storage adapter (`NodeStorageLayer`) depends on `fs`, `path`, and `crypto` -- none of which exist in a browser. Anyone building a local-first web application with proseql today has to give up persistence entirely or write a custom adapter from scratch. A first-party browser adapter removes that barrier and opens up the largest deployment target (the browser) without any changes to the core engine.

This is the single most impactful portability gap. The core package already avoids Node imports; the missing piece is a browser-side `StorageAdapterShape` implementation.

## What Changes

Add a new `packages/browser/` package (`@proseql/browser`) that provides three `StorageAdapterShape` implementations -- localStorage, sessionStorage, and IndexedDB -- exposed as Effect Layers. The package follows the same structure as `@proseql/node`: it re-exports everything from `@proseql/core` and adds browser-specific storage layers.

File paths from collection configs are mapped to flat storage keys via a configurable prefix scheme (e.g., `./data/books.yaml` becomes `proseql:data/books.yaml`). The localStorage adapter listens for cross-tab `storage` events to trigger collection reloads. The IndexedDB adapter wraps the async IDB API in Effect, handling larger datasets that exceed the ~5MB localStorage quota. Codecs that depend on Node-only libraries are rejected at construction time with an `UnsupportedFormatError`.

## Capabilities

### New Capabilities

- `LocalStorageLayer`: A `StorageAdapterShape` Layer that persists collection data to the browser's `localStorage` API. Handles quota errors by surfacing `StorageError` with a descriptive message. Supports cross-tab synchronization via the `storage` event.
- `SessionStorageLayer`: A `StorageAdapterShape` Layer that persists to `sessionStorage` for ephemeral per-tab data. Same API surface as localStorage but scoped to the tab session.
- `IndexedDBStorageLayer`: A `StorageAdapterShape` Layer that persists to an IndexedDB object store. Handles datasets exceeding the localStorage quota. All I/O is async and maps naturally to Effect.
- `pathToKey`: Utility that maps file paths from collection configs to flat storage keys with a configurable prefix (default `proseql:`). Normalizes separators and strips leading `./`.
- `BrowserStorageLayer`: Convenience alias that defaults to `LocalStorageLayer` for quick setup.
- Cross-tab sync: The localStorage adapter registers a `storage` event listener. When another tab writes to a watched key, the `watch` callback fires, triggering a collection reload in the current tab.
- Quota error handling: Writes that exceed the storage quota are caught and re-thrown as `StorageError` with `operation: "write"` and a message indicating the quota was exceeded.

### Modified Capabilities

- None. The core package, node adapter, and all existing modules are unchanged. This is purely additive.

## Impact

- **New package**: `packages/browser/` with `@proseql/browser` package name. Depends on `@proseql/core` (workspace dependency).
- **StorageAdapterShape**: No changes to the interface. All three browser adapters implement the existing shape as-is. `ensureDir` is a no-op (browser storage is flat). `remove` deletes the key.
- **Serializers**: No changes to the core codec system. The browser package validates at layer construction time that the configured codec is browser-safe (JSON, JSON5, JSONC, Hjson, YAML are safe; TOML and TOON may not be, depending on their dependencies).
- **Factories**: No changes. `createPersistentEffectDatabase` works identically when provided a browser storage layer.
- **Breaking changes**: None. This is a new package with no modifications to existing packages.
