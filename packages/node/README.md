# @proseql/node

Node.js file persistence for ProseQL. Re-exports everything from `@proseql/core` plus filesystem storage adapters.

## Install

```sh
npm install @proseql/node
```

## Quick Start

```ts
import { Effect, Schema } from "effect"
import { createNodeDatabase } from "@proseql/node"

const BookSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  author: Schema.String,
  year: Schema.Number,
})

const config = {
  books: {
    schema: BookSchema,
    file: "./data/books.yaml",
    relationships: {},
  },
} as const

const program = Effect.gen(function* () {
  const db = yield* createNodeDatabase(config)

  yield* db.books.create({ title: "Dune", author: "Frank Herbert", year: 1965 })
  // → saved to ./data/books.yaml

  const classics = yield* Effect.promise(
    () => db.books.query({ where: { year: { $lt: 1970 } } }).runPromise
  )
})

await Effect.runPromise(Effect.scoped(program))
```

For the full query and mutation API, see [`@proseql/core`](https://www.npmjs.com/package/@proseql/core).

## Persistence Approaches

Three ways to set up file persistence, from simplest to most configurable.

### A. `createNodeDatabase` (Zero-Config)

Codecs are inferred from file extensions. No manual layer wiring needed.

```ts
import { Effect } from "effect"
import { createNodeDatabase } from "@proseql/node"

const program = Effect.gen(function* () {
  const db = yield* createNodeDatabase(config, initialData, {
    writeDebounce: 50,  // optional: debounce writes (ms)
  })

  yield* db.books.create({ title: "Neuromancer", author: "William Gibson", year: 1984 })
  // → triggers debounced write to ./data/books.yaml
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

Codecs are inferred from file extensions. Mix formats across collections.

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
  books: { schema: BookSchema, file: "./data/books.yaml", relationships: {} },
  authors: { schema: AuthorSchema, file: "./data/authors.json", relationships: {} },
  events: { schema: EventSchema, file: "./data/events.jsonl", relationships: {} },
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
