# Write a storage host

The Rust engine is the database engine. A storage host supplies runtime I/O, not query or mutation logic. TypeScript runtimes use `EngineStorageHost`; native Rust runtimes use [`StorageHost` and `DurableStorageHost`](native-sources.md#write-a-rust-storage-host). Browser storage is one implementation of this boundary.

TypeScript hosts use the internal orchestration layer in `packages/engine/src/host/` for file load/save, document and documentGraph assembly, partitions, codecs and migration previews. The WASM engine plugs into that layer through `EngineStorageHost`. The Rust `proseql-storage` crate implements the same responsibilities natively, with `proseql-native` composing the native runtime. This duplicates persistence orchestration; routing WASM persistence through Rust `proseql-storage` remains a follow-up. Neither host layer owns query, CRUD, index, reactive or transaction execution.

## TypeScript contract

Import the public types from `@proseql/engine` or `@proseql/engine/browser`:

```ts
import type {
  EngineStorageHost,
  EngineStorageWatchEvent,
} from "@proseql/engine/browser"
```

Every required method returns a Promise. Resolve only when its storage operation has completed. Reject on failure; do not return empty text for a failed read or report a failed write as successful.

| Method | Contract |
|---|---|
| `read(path)` | Return the complete stored text. Reject when missing. |
| `write(path, data)` | Replace the complete text; create the entry if missing. Avoid exposing partial text. |
| `append(path, data)` | Append the text, creating an empty entry first if missing. Preserve existing bytes. |
| `exists(path)` | Report whether the entry or a supported virtual directory exists. Do not hide permission or transport errors as absence. |
| `remove(path)` | Remove the entry. Missing entries may be treated as already removed. |
| `ensureDir(path)` | Prepare the parent of this **file path**. Key/value hosts can do nothing. |
| `listDirectory(dirPath)` | Return immediate file paths, including the directory prefix, not bare names or directories. |
| `listRecursive(rootPath)` | Return all descendant file paths in the same path representation. |
| `watch(path, onChange)` | Subscribe to file changes, including replacement/removal. Return a synchronous stop function. |
| `watchDir(dirPath, onChange)` | Subscribe to descendant additions, changes and removals. Return a synchronous stop function. |
| `close?()` | Wait for pending work and release resources. Make repeated calls safe. |

Use consistent path normalization for keys, listings and watch matching. Return stable, sorted listings where possible. Missing virtual directories can list as empty. Apply access rules and namespace checks before accessing storage. Database paths are trusted configuration, not an authorization mechanism.

`EngineStorageWatchEvent` contains `filename: string | null` and `type: "add" | "change" | "remove"`. Browser hosts put the normalized logical path in `filename`. Use `null` when the changed filename is unknown. Consumers reload on notification; events are not a durable operation log. Release listeners when stopped and do not call a stopped listener. Do not hold a host lock while invoking a callback that may read storage.

Use `StorageError` from `@proseql/core` for host failures, with `path`, `operation`, `message`, and optional structured `cause`. Operations are `read`, `write`, `delete`, `watch`, or `list`; append uses `write`. Its wire `_tag` is exactly `StorageError`. Reject unsupported configured formats with `UnsupportedFormatError`, not silent conversion. The engine adapter also wraps unexpected rejected values in `StorageError`.

## Browser hosts as the worked example

The implementation is [`browser-storage-host.ts`](../packages/engine/src/browser-storage-host.ts). It supplies localStorage, sessionStorage and IndexedDB hosts:

1. Normalize the logical path, then prepend `keyPrefix` (default `proseql:`). Strip only that prefix from listings. Entries from another namespace never appear.
2. Implement file operations with `getItem`/`setItem` or IndexedDB transactions. Directories are virtual; `ensureDir` is a no-op, and listings select keys beneath a directory boundary.
3. Notify only after the storage write completes. The IndexedDB host waits for transaction completion, not just request success, so an aborted transaction cannot be acknowledged.
4. Route same-process notifications through local listeners. Use browser `storage` events for other localStorage contexts and `BroadcastChannel` for IndexedDB contexts. An origin ID suppresses self-notifications.
5. Translate missing keys, quota limits, denied access and unavailable storage into tagged errors. IndexedDB `close` stops watchers, waits for pending operations and releases cached connections.

The optional `__proseqlBrowserStorageHost` marker enables browser-specific persistence reconciliation. It is not a durability flag. Preserve it when wrapping a browser host; do not add it to an unrelated host to claim stronger storage guarantees.

A wrapper can add auditing without changing the contract:

```ts
import {
  createIndexedDBEngineStorageHost,
  createPersistentEngineDatabase,
  type EngineStorageHost,
} from "@proseql/engine/browser"
import { Schema } from "effect"

const base = createIndexedDBEngineStorageHost({ databaseName: "notes" })
const completedWrites: string[] = []
const host: EngineStorageHost = {
  ...base,
  async write(path, data) {
    await base.write(path, data)
    completedWrites.push(path)
  },
}

const db = await createPersistentEngineDatabase(
  {
    notes: {
      schema: Schema.Struct({ id: Schema.String, text: Schema.String }),
      relationships: {},
      file: "notes.json",
    },
  },
  undefined,
  { storageHost: host },
)
await db.notes.create({ id: "n1", text: "Stored through the host" })
await db.flush()
await db.close()
```

For a new backend, implement the same interface directly and pass it through `persistenceOptions.storageHost`. Use the Node entry point for Node-specific modules and the browser entry point for browser-safe loading. The database owns subscriptions it creates and closes the configured host when closed; do not share an owned host with another live database without an explicit lifetime policy.

## Guarantees and checks

A host is not a second database. Do not implement schema decoding, computed fields, query filtering, or hooks in it. Ordinary Promise persistence does not imply native file/directory synchronization, cross-file atomicity, exactly-once event delivery, or a multi-writer lock. IndexedDB transaction completion is stronger than request completion, but it does not turn localStorage or a remote transport into native durable storage. Browser storage can be evicted and is not suitable for secrets without an application security policy.

Exercise a new host against real storage: missing reads, read/write/append/remove round trips, namespace isolation, immediate and recursive listings, watch add/change/remove and stop, reopen, quota/permission/transport failure, and close with pending writes. Check failed writes never acknowledge partial data. The existing browser tests in `packages/engine/tests/` provide examples. For serialized, acknowledged worker writes, use the service-worker facade rather than assuming ordinary debounced persistence acknowledges each write durably.
