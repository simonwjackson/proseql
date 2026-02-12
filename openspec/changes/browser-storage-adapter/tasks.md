## 1. Package Scaffolding

- [x] 1.1 Create `packages/browser/` directory with `package.json` (`@proseql/browser`, workspace dependency on `@proseql/core`, `"type": "module"`)
- [x] 1.2 Create `packages/browser/tsconfig.json` extending the root tsconfig, with appropriate `paths` and `references`
- [x] 1.3 Create `packages/browser/src/index.ts` that re-exports everything from `@proseql/core`
- [x] 1.4 Add `packages/browser` to the workspace root `package.json` workspaces array
- [x] 1.5 Verify `bun install` resolves the new workspace package and `bunx tsc --build` compiles it

## 2. Path-to-Key Mapping

- [x] 2.1 Create `packages/browser/src/path-to-key.ts` with `pathToKey(path: string, prefix?: string): string`. Default prefix `proseql:`. Strip leading `./`, normalize backslashes to forward slashes.
- [x] 2.2 Export `pathToKey` from `packages/browser/src/index.ts`
- [x] 2.3 Handle edge cases: empty string, absolute paths, paths with multiple leading `./`, trailing slashes

## 3. Shared Web Storage Adapter

- [x] 3.1 Create `packages/browser/src/adapters/web-storage-adapter.ts` with `makeWebStorageAdapter(storage: Storage, config: WebStorageConfig): StorageAdapterShape`
- [x] 3.2 Implement `read`: call `storage.getItem(pathToKey(path))`, fail with `StorageError` if `null`
- [x] 3.3 Implement `write`: call `storage.setItem(pathToKey(path), data)` in a try/catch that detects `QuotaExceededError`
- [x] 3.4 Implement `exists`: return `storage.getItem(pathToKey(path)) !== null`
- [x] 3.5 Implement `remove`: call `storage.removeItem(pathToKey(path))`
- [x] 3.6 Implement `ensureDir`: return `Effect.void` (no-op, browser storage is flat)
- [x] 3.7 Accept a `watch` function parameter so localStorage and sessionStorage can provide different implementations

## 4. LocalStorage Adapter

- [x] 4.1 Create `packages/browser/src/adapters/local-storage-adapter.ts` that calls `makeWebStorageAdapter` with `window.localStorage`
- [x] 4.2 Implement `watch` for localStorage: register a `storage` event listener on `window`, filter events by the target key, call `onChange` on match, return unsubscribe function that removes the listener
- [x] 4.3 Create `makeLocalStorageLayer(config?)` factory returning `Layer.Layer<StorageAdapter>`
- [x] 4.4 Export `LocalStorageLayer` as the default-config convenience alias

## 5. SessionStorage Adapter

- [x] 5.1 Create `packages/browser/src/adapters/session-storage-adapter.ts` that calls `makeWebStorageAdapter` with `window.sessionStorage`
- [x] 5.2 Implement `watch` as a no-op: return `Effect.succeed(() => {})` (sessionStorage has no cross-tab events)
- [x] 5.3 Create `makeSessionStorageLayer(config?)` factory returning `Layer.Layer<StorageAdapter>`
- [x] 5.4 Export `SessionStorageLayer` as the default-config convenience alias

## 6. IndexedDB Adapter

- [x] 6.1 Create `packages/browser/src/adapters/indexeddb-adapter.ts` implementing `StorageAdapterShape`
- [x] 6.2 Implement `openDatabase`: wrap `indexedDB.open` in `Effect.async`, create object store on `onupgradeneeded`, cache `IDBDatabase` handle. Config: database name (default `proseql`), store name (default `collections`), version.
- [x] 6.3 Implement `read`: open a `readonly` transaction, call `store.get(pathToKey(path))`, wrap in `Effect.async`, fail with `StorageError` if result is `undefined`
- [x] 6.4 Implement `write`: open a `readwrite` transaction, call `store.put(data, pathToKey(path))`, wrap in `Effect.async`
- [x] 6.5 Implement `exists`: open a `readonly` transaction, call `store.count(pathToKey(path))`, return `count > 0`
- [x] 6.6 Implement `remove`: open a `readwrite` transaction, call `store.delete(pathToKey(path))`, wrap in `Effect.async`
- [x] 6.7 Implement `ensureDir`: return `Effect.void` (no-op)
- [x] 6.8 Implement `watch`: return no-op unsubscribe (IndexedDB has no native change notification; BroadcastChannel-based sync is out of scope)
- [x] 6.9 Create `makeIndexedDBStorageLayer(config?)` factory returning `Layer.Layer<StorageAdapter>`
- [x] 6.10 Export `IndexedDBStorageLayer` as the default-config convenience alias

## 7. Browser Adapter Layer Exports

- [x] 7.1 Create `packages/browser/src/browser-adapter-layer.ts` that re-exports all layer factories and convenience aliases from the individual adapter files
- [x] 7.2 Export `BrowserStorageLayer` as an alias for `LocalStorageLayer` (sensible default)
- [x] 7.3 Export all layers, factories, config types, and `pathToKey` from `packages/browser/src/index.ts`

## 8. Quota Error Handling

- [x] 8.1 Detect `QuotaExceededError` by checking `DOMException.name === "QuotaExceededError"` in the `write` catch block
- [x] 8.2 Wrap as `StorageError` with `operation: "write"` and a message including the key name and a note about the storage quota being exceeded
- [x] 8.3 Verify IndexedDB write failures (e.g., `ConstraintError`, `QuotaExceededError`) are also surfaced as `StorageError`

## 9. Format Restriction Validation

- [x] 9.1 Document which codecs are browser-safe in the package README or JSDoc: JSON, JSON5, JSONC, Hjson, YAML are safe; TOML and TOON require verification
- [x] 9.2 If TOML/TOON codecs depend on Node-only modules, add a runtime check that raises `UnsupportedFormatError` when they are used with a browser adapter
- [x] 9.3 Optionally accept an `allowedFormats` list in the adapter config to restrict codecs at construction time

## 10. Tests — Path-to-Key

- [x] 10.1 Create `packages/browser/tests/path-to-key.test.ts`
- [x] 10.2 Test default prefix: `./data/books.yaml` maps to `proseql:data/books.yaml`
- [x] 10.3 Test custom prefix: `./data/books.yaml` with prefix `myapp:` maps to `myapp:data/books.yaml`
- [x] 10.4 Test backslash normalization: `.\data\books.yaml` maps to `proseql:data/books.yaml`
- [x] 10.5 Test no leading `./`: `data/books.yaml` maps to `proseql:data/books.yaml`
- [x] 10.6 Test empty string: maps to `proseql:`
- [x] 10.7 Test nested paths: `./a/b/c/d.json` maps to `proseql:a/b/c/d.json`

## 11. Tests — LocalStorage Adapter

- [x] 11.1 Create `packages/browser/tests/local-storage-adapter.test.ts` using a mock `Storage` implementation
- [x] 11.2 Test `write` then `read` round-trip: data is stored and retrieved correctly
- [x] 11.3 Test `exists` returns `false` for missing key, `true` after write
- [x] 11.4 Test `remove` deletes the key, subsequent `exists` returns `false`
- [x] 11.5 Test `read` on missing key fails with `StorageError`
- [x] 11.6 Test `ensureDir` is a no-op (succeeds without side effects)
- [x] 11.7 Test `write` with quota exceeded throws `StorageError` with appropriate message

## 12. Tests — SessionStorage Adapter

- [x] 12.1 Create `packages/browser/tests/session-storage-adapter.test.ts` using a mock `Storage` implementation
- [x] 12.2 Test `write`/`read` round-trip
- [x] 12.3 Test `watch` returns a no-op unsubscribe function
- [x] 12.4 Test `exists`, `remove`, `ensureDir` behave identically to localStorage adapter

## 13. Tests — IndexedDB Adapter

- [x] 13.1 Create `packages/browser/tests/indexeddb-adapter.test.ts` using `fake-indexeddb` or a similar mock
- [x] 13.2 Test `write` then `read` round-trip
- [x] 13.3 Test `exists` returns `false` for missing key, `true` after write
- [x] 13.4 Test `remove` deletes the entry
- [x] 13.5 Test `read` on missing key fails with `StorageError`
- [x] 13.6 Test database and object store are created on first access
- [x] 13.7 Test multiple collections can coexist in the same object store with different keys

## 14. Tests — Cross-Tab Sync

- [ ] 14.1 Create `packages/browser/tests/cross-tab-sync.test.ts`
- [ ] 14.2 Test `watch` registers a `storage` event listener and calls `onChange` when the watched key is modified
- [ ] 14.3 Test `watch` ignores `storage` events for unrelated keys
- [ ] 14.4 Test unsubscribe function removes the event listener
- [ ] 14.5 Test multiple watchers on different keys coexist independently

## 15. Tests — Integration

- [ ] 15.1 Create `packages/browser/tests/integration.test.ts`
- [ ] 15.2 Test full database lifecycle with `LocalStorageLayer`: create persistent database, insert records, reload from storage, verify data
- [ ] 15.3 Test full database lifecycle with `IndexedDBStorageLayer`: same flow with larger dataset
- [ ] 15.4 Test switching between localStorage and IndexedDB layers with the same database config

## 16. Cleanup

- [ ] 16.1 Run full test suite (`bun test`) to verify no regressions in existing packages
- [ ] 16.2 Run type check (`bunx tsc --build`) to verify no type errors
- [ ] 16.3 Run linter (`biome check .`) and fix any issues
- [ ] 16.4 Verify `nix flake check` passes with the new package
