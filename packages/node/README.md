# @proseql/node

Node.js file persistence for ProseQL. Re-exports everything from `@proseql/core` plus filesystem storage adapters.

## Install

```sh
npm install @proseql/node
```

## Quick Start

```ts
import { mkdir } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { createNodeDatabase } from "@proseql/node"

const BookPayload = Schema.Struct({
  title: Schema.String,
  author: Schema.String,
  year: Schema.Number,
})

const config = {
  collections: {
    books: {
      schema: BookPayload,
      id: { kind: "derivedFromKey", field: "id" },
      relationships: {},
    },
  },
  sources: [
    {
      id: "library",
      kind: "documents",
      root: "./data/library",
      include: "**/*.yaml",
      format: "yaml",
      collections: "all",
      outbox: "generated.yaml",
    },
  ],
} as const

const program = Effect.gen(function* () {
  yield* Effect.promise(() => mkdir("./data/library", { recursive: true }))
  const db = yield* createNodeDatabase(config)

  yield* db.books.create({ id: "dune", title: "Dune", author: "Frank Herbert", year: 1965 })
  yield* Effect.promise(() => db.flush())
  // → saved under books.dune in ./data/library/generated.yaml

  const classics = yield* Effect.promise(() =>
    db.books.query({ where: { year: { $lt: 1970 } } }).runPromise,
  )

  return classics
})

await Effect.runPromise(Effect.scoped(program))
```

For the full query and mutation API, see [`@proseql/core`](https://www.npmjs.com/package/@proseql/core).

## Document Sources

Document sources are the source-oriented persistence shape for plain-text documents that can contain several collections in the same file. Collections define logical behavior; sources define discovery and write routing.

```ts
const config = {
  collections: {
    games: {
      schema: GamePayload,
      id: { kind: "derivedFromKey", field: "id" },
      relationships: {},
    },
    systems: {
      schema: SystemPayload,
      id: { kind: "derivedFromKey", field: "id" },
      relationships: {},
    },
  },
  sources: [
    {
      id: "library",
      kind: "documents",
      root: "./data/library",
      include: "**/*.yaml",
      format: "yaml",
      collections: "all",
      outbox: "generated.yaml",
    },
  ],
} as const
```

Any matching YAML file can contribute records to any selected collection:

```yaml
systems:
  snes:
    name: Super Nintendo

games:
  smw:
    title: Super Mario World
    systemId: snes
```

Another matching file can add more `games`; all records merge into the logical `db.games` collection. Duplicate `(collection, id)` records fail loudly by default, and unknown top-level collection keys fail unless the source opts into `unknownCollections: "preserve"`.

### Key-Derived IDs

Document sources use object keys as record IDs. With `id: { kind: "derivedFromKey", field: "id" }`, persisted payloads omit `id` and runtime records are hydrated from the enclosing key. A physical `id` field in persisted YAML is invalid.

```yaml
games:
  smw:
    title: Super Mario World
    systemId: snes
```

At runtime:

```ts
const game = yield* db.games.findById("smw")
// { id: "smw", title: "Super Mario World", systemId: "snes" }
```

### Outbox and durability

Existing records retain origin-file attribution. Updates and deletes rewrite the file where the record was loaded. New records have no origin, so they are written to the configured `outbox`; the outbox must be rediscoverable by the source include patterns. Empty matched files and existing empty source roots are valid. Missing source roots fail by default unless `optional: true` is configured. Missing outbox parent directories are created by the Node storage adapter on first write.

Mutations are debounced. Call `await db.flush()` when a process or CLI command needs durable filesystem persistence before exit. `flush()` surfaces persistence failures. Without `flush()`, a mutation may only be in memory until the debounced write runs or the scope finalizer flushes.

### Watchers and formatting

Node-backed persistent databases watch document-source roots. Add, change, and remove events trigger a debounced whole-source rediscovery/reload and publish the normal reactive reload events used by `watch()` and `watchById()`.

Writes preserve semantic data and sibling collection sections, but YAML comments, exact ordering, and original formatting are not preserved.

### Read-only document graphs

A `documentGraph` source assembles one effective, read-only collection graph from an ordered set of directory roots, merging many physical fragments into one logical read model (later fragments overlay earlier ones). It is the overlay counterpart to the writable `documents` source and never writes back.

```ts
const db = yield* createNodeDatabase({
  collections: {
    foods: {
      schema: FoodPayload,
      id: { kind: "derivedFromKey", field: "id" },
      relationships: {},
    },
  },
  sources: [
    {
      id: "config-graph",
      kind: "documentGraph",
      include: "**/*.config.{yaml,json,toml}",
      roots: [
        { root: "./config/base" },
        { root: "./config/overrides", optional: true },
      ],
    },
  ],
})
```

Through `@proseql/node`, a graph reads from the real filesystem with codecs inferred automatically (a graph registers all base codecs, since fragments are decoded by extension). Discovery uses real glob semantics across nested directories; each startup-present root is watched, and a valid fragment change rebuilds the graph while an invalid reload keeps the last-known-good graph. Graph-owned collections reject every mutation with `OperationError` (`reason: "read-only-source"`), including inside `$transaction`, and `initialData` for a graph-owned collection fails database creation. See the [`@proseql/core` README](https://www.npmjs.com/package/@proseql/core) for the full merge, transform, and migration semantics.

## Persistence Approaches

Three ways to set up file persistence, from simplest to most configurable.

### A. `createNodeDatabase` (Zero-Config)

Codecs are inferred from source formats, source paths, and file extensions. No manual layer wiring needed.

```ts
import { Effect } from "effect"
import { createNodeDatabase } from "@proseql/node"

const program = Effect.gen(function* () {
  const db = yield* createNodeDatabase(config, initialData, {
    writeDebounce: 50,  // optional: debounce writes (ms)
  })

  yield* db.books.create({ id: "neuromancer", title: "Neuromancer", author: "William Gibson", year: 1984 })
  // → triggers debounced write to the configured source outbox
})

await Effect.runPromise(Effect.scoped(program))
```

### B. `makeNodePersistenceLayer` (Explicit Layer)

Builds a `Layer` from your config. Use when composing with other layers or passing extra codecs.

```ts
import { Effect } from "effect"
import {
  createPersistentEffectDatabase,
  makeNodePersistenceLayer,
} from "@proseql/node"

const PersistenceLayer = makeNodePersistenceLayer(config)

const program = Effect.gen(function* () {
  const db = yield* createPersistentEffectDatabase(config, initialData)
  // ...
})

await Effect.runPromise(
  program.pipe(Effect.provide(PersistenceLayer), Effect.scoped)
)
```

### C. Manual `Layer.merge` (Full Control)

Wire `NodeStorageLayer` and `makeSerializerLayer` by hand. Use for custom codec options, plugin codecs, or non-standard setups.

```ts
import { Effect, Layer } from "effect"
import {
  createPersistentEffectDatabase,
  NodeStorageLayer,
  makeSerializerLayer,
  jsonCodec,
  yamlCodec,
} from "@proseql/node"

const ManualLayer = Layer.merge(
  NodeStorageLayer,
  makeSerializerLayer([jsonCodec(), yamlCodec()])
)

const program = Effect.gen(function* () {
  const db = yield* createPersistentEffectDatabase(config, initialData)
  // ...
})

await Effect.runPromise(
  program.pipe(Effect.provide(ManualLayer), Effect.scoped)
)
```

## File Formats

Codecs are inferred from document source `format` values, source paths, and file extensions. Document sources use one object-document format per source; YAML is the primary multi-collection format.

| Format | Extension | Description |
|--------|-----------|-------------|
| JSON   | `.json`   | The classic |
| JSONL  | `.jsonl`  | One object per line, streaming-friendly |
| YAML   | `.yaml`   | For humans who hate braces |
| JSON5  | `.json5`  | JSON with comments and trailing commas |
| JSONC  | `.jsonc`  | JSON with comments (VS Code style) |
| TOML   | `.toml`   | Config-brained perfection |
| TOON   | `.toon`   | Compact and LLM-friendly |
| Hjson  | `.hjson`  | JSON for people who make typos |
| Prose  | `.prose`  | Data that reads like a sentence |

```ts
const config = {
  collections: {
    books: { schema: BookPayload, id: { kind: "derivedFromKey", field: "id" }, relationships: {} },
    authors: { schema: AuthorPayload, id: { kind: "derivedFromKey", field: "id" }, relationships: {} },
  },
  sources: [
    {
      id: "library",
      kind: "documents",
      root: "./data/library",
      include: "**/*.yaml",
      format: "yaml",
      collections: "all",
      outbox: "generated.yaml",
    },
  ],
} as const
```

## Prose Format

Prose files are self-describing. The `@prose` directive contains the template:

```
@prose [{id}] "{title}" by {author} ({year}) — {genre}

[1] "Dune" by Frank Herbert (1965) — sci-fi
[2] "Neuromancer" by William Gibson (1984) — sci-fi
```

The codec learns the template from the file automatically. For explicit control:

```ts
import { proseCodec, makeSerializerLayer } from "@proseql/node"

// explicit template
proseCodec({ template: '[{id}] "{title}" by {author} ({year}) — {genre}' })

// or let it learn from the @prose directive
proseCodec()
```

### Format Override

When prose data lives inside a file with a non-prose extension:

```ts
const config = {
  catalog: {
    schema: CatalogSchema,
    file: "./docs/catalog.md",
    format: "prose",  // ← use prose codec, not markdown
    relationships: {},
  },
} as const
```

## Append-Only Collections

For event logs, audit trails, and write-once data. Each `create()` appends a single JSONL line instead of rewriting the file.

```ts
const config = {
  events: {
    schema: EventSchema,
    file: "./data/events.jsonl",
    appendOnly: true,  // ← the magic flag
    relationships: {},
  },
} as const
```

```ts
// these work normally
await db.events.create({ type: "click", target: "button-1" }).runPromise
await db.events.query({ where: { type: "click" } }).runPromise
await db.events.findById("evt_001").runPromise
await db.events.aggregate({ count: true }).runPromise

// these throw OperationError — append-only means append-only
await db.events.update("evt_001", { type: "tap" }).runPromise  // OperationError
await db.events.delete("evt_001").runPromise                    // OperationError
```

## Debounced Writes

Mutations trigger debounced writes. Rapid changes batch into fewer I/O operations.

```ts
const db = yield* createNodeDatabase(config, initialData, {
  writeDebounce: 100,  // 100ms debounce
})
```

### `flush()`

Force all pending writes to disk immediately:

```ts
await db.flush()
console.log(`Pending writes: ${db.pendingCount()}`)  // → 0
```

## Node Storage Layer

The `NodeStorageLayer` provides atomic writes (temp file + rename) with retry and exponential backoff.

```ts
import { makeNodeStorageLayer, NodeStorageLayer } from "@proseql/node"

// default configuration
NodeStorageLayer

// custom configuration
const CustomStorageLayer = makeNodeStorageLayer({
  maxRetries: 3,
  baseDelay: 100,
  createMissingDirectories: true,
  fileMode: 0o644,
  dirMode: 0o755,
})
```

## API Reference

### Exports from `@proseql/node`

Everything from `@proseql/core` is re-exported, plus:

| Export | Description |
|--------|-------------|
| `createNodeDatabase` | Zero-config convenience wrapper |
| `makeNodePersistenceLayer` | Build persistence layer from config |
| `NodeStorageLayer` | Default filesystem storage layer |
| `makeNodeStorageLayer` | Create storage layer with custom config |

### Types

```ts
import type { NodeAdapterConfig } from "@proseql/node"

interface NodeAdapterConfig {
  readonly maxRetries?: number       // default: 3
  readonly baseDelay?: number        // default: 100ms
  readonly createMissingDirectories?: boolean  // default: true
  readonly fileMode?: number         // default: 0o644
  readonly dirMode?: number          // default: 0o755
}
```

## License

MIT
