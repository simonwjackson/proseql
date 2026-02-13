# @proseql/browser

Browser storage adapters for ProseQL. Provides localStorage, sessionStorage, and IndexedDB persistence layers.

## Installation

```sh
npm install @proseql/browser
```

## Usage

```ts
import { Effect, Layer } from "effect"
import {
  createPersistentEffectDatabase,
  LocalStorageLayer,
  makeSerializerLayer,
  jsonCodec,
  yamlCodec,
} from "@proseql/browser"

const config = {
  books: {
    schema: BookSchema,
    file: "./data/books.json",
    relationships: {},
  },
} as const

const program = Effect.gen(function* () {
  const db = yield* createPersistentEffectDatabase(config, { books: [] })
  yield* db.books.create({ title: "Dune", author: "Frank Herbert" })
})

const PersistenceLayer = Layer.merge(
  LocalStorageLayer,
  makeSerializerLayer([jsonCodec(), yamlCodec()]),
)

await Effect.runPromise(
  program.pipe(Effect.provide(PersistenceLayer), Effect.scoped),
)
```

## Storage Adapters

| Adapter | Storage | Cross-Tab Sync | Capacity |
|---------|---------|----------------|----------|
| `LocalStorageLayer` | localStorage | ✓ (via `storage` events) | ~5MB |
| `SessionStorageLayer` | sessionStorage | ✗ (tab-scoped) | ~5MB |
| `IndexedDBStorageLayer` | IndexedDB | ✗ | Large (quota-based) |

### LocalStorage (Default)

```ts
import { LocalStorageLayer, BrowserStorageLayer } from "@proseql/browser"

// BrowserStorageLayer is an alias for LocalStorageLayer
```

Cross-tab synchronization works automatically via the `window.storage` event.

### SessionStorage

```ts
import { SessionStorageLayer } from "@proseql/browser"
```

Data is scoped to the current tab and does not persist across tabs or sessions.

### IndexedDB

```ts
import { IndexedDBStorageLayer, makeIndexedDBStorageLayer } from "@proseql/browser"

// Custom configuration
const CustomIndexedDBLayer = makeIndexedDBStorageLayer({
  databaseName: "myapp",
  storeName: "collections",
  version: 1,
})
```

Suitable for larger datasets that exceed localStorage limits.

## Browser-Safe Codecs

All ProseQL serialization codecs are browser-compatible:

| Codec | Package | Browser-Safe | Notes |
|-------|---------|--------------|-------|
| JSON | built-in | ✓ | Native `JSON.parse`/`JSON.stringify` |
| JSON5 | `json5` | ✓ | Pure JavaScript |
| JSONC | `jsonc-parser` | ✓ | Pure JavaScript (VS Code's parser) |
| Hjson | `hjson` | ✓ | Pure JavaScript |
| YAML | `yaml` | ✓ | Pure JavaScript |
| TOML | `smol-toml` | ✓ | Pure JavaScript, ESM/CJS dual package |
| TOON | `@toon-format/toon` | ✓ | Pure JavaScript |
| Prose | built-in | ✓ | Template-driven, human-readable sentences |

All codecs work identically in Node.js and browser environments. No special configuration is required.

```ts
import {
  jsonCodec,
  json5Codec,
  jsoncCodec,
  hjsonCodec,
  yamlCodec,
  tomlCodec,
  toonCodec,
  makeSerializerLayer,
} from "@proseql/browser"

// Use any combination of codecs
const SerializerLayer = makeSerializerLayer([
  jsonCodec(),
  yamlCodec(),
  tomlCodec(),
])
```

## Path-to-Key Mapping

Browser storage APIs use flat string keys. ProseQL converts file paths to storage keys:

```ts
import { pathToKey } from "@proseql/browser"

pathToKey("./data/books.yaml")
// → "proseql:data/books.yaml"

pathToKey("./data/books.yaml", "myapp:")
// → "myapp:data/books.yaml"
```

The default prefix `proseql:` prevents collisions with other localStorage data.

## Quota Handling

localStorage and sessionStorage have ~5MB limits. When the quota is exceeded, write operations fail with a `StorageError`:

```ts
import { StorageError } from "@proseql/browser"

const result = await Effect.runPromise(
  db.books.create(largeRecord).pipe(
    Effect.catchTag("StorageError", (error) => {
      if (error.message.includes("quota")) {
        // Handle quota exceeded
      }
      return Effect.fail(error)
    }),
  ),
)
```

For larger datasets, use `IndexedDBStorageLayer` which has significantly higher limits.

## License

MIT
