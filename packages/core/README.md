# @proseql/core

Shared TypeScript contracts for proseQL 1.0.0. **This package is not a database engine.** Rust is the only database engine.

Core provides:

- Database, collection, query, CRUD, relationship, hook, migration and plugin types.
- Effect Schema exports and exact tagged error classes.
- Source configuration types and normalization.
- `StorageAdapterService` and `SerializerRegistryService` tags and their Shape contracts.
- Text codecs, serializer layers and codec inference.
- Pure configuration and path helpers used by the storage hosts.

All Effect-facing packages use exactly `effect@4.0.0-beta.103`.

## Choose a runtime

| Package | Use |
|---|---|
| [`@proseql/effect`](../effect/README.md) | Effect factories, CRUD Effects, query and watch Streams. |
| [`@proseql/engine`](../engine/README.md) | Promise API over the Rust/WASM engine. |
| [`@proseql/node`](../node/README.md) | Node file persistence with inferred codecs and a Node storage host. |
| [`@proseql/browser`](../browser/README.md) | Browser entry points and localStorage, sessionStorage and IndexedDB hosts. |
| [`proseql-native`](../../docs/native-sources.md) | Native Rust storage and callbacks. |

## Migrate from 0.x

```ts
// Before: import { createEffectDatabase } from "@proseql/core"
import { createEffectDatabase } from "@proseql/effect"
// For files:
import { createNodeDatabase } from "@proseql/node"
```

`createPersistentEffectDatabase` also comes from `@proseql/effect`. Core no longer exports factories, query/CRUD operations, Ref state, indexes, reactive execution or transaction implementations. Replace calls to private TS helpers with the database's public methods.

The old standalone ID generator utilities are no longer exported. Omit `id` on `create`, or configure a named plugin generator for custom IDs.

Function-valued `$remove` is no longer supported. Use a concrete value, or supply the surviving array with `$set`. The binding rejects functions with `ValidationError` before mutation.

See [storage hosts](../../docs/storage-hosts.md) for the host boundary, and the [1.0 migration audit](../../docs/rust-first-1.0-migration.md) for the implementation and test inventory.
