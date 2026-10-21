# @proseql/ai

AI tool definitions and an executor for ProseQL databases. Generate OpenAI-compatible function tools from your config, then run tool calls against the Rust/WASM-backed Effect database.

## Install

```sh
npm install @proseql/ai @proseql/effect effect@4.0.0-beta.103
```

## Quick Start

```ts
import { Effect, Schema } from "effect"
import { createEffectDatabase } from "@proseql/effect"
import { makeReadOnlyTools } from "@proseql/ai"

const config = {
  books: {
    schema: Schema.Struct({ id: Schema.String, title: Schema.String }),
    relationships: {},
  },
} as const

const db = await Effect.runPromise(createEffectDatabase(config, {
  books: [{ id: "1", title: "Dune" }],
}))
const tools = makeReadOnlyTools(db, config)

// Pass tools.definitions to your model's function-calling API.
const result = await tools.execute("proseql_query", {
  collection: "books",
  where: { title: "Dune" },
})
// result is a JSON string containing the matching records.
```

Use `createNodeDatabase` from `@proseql/effect/node` for persistent files. Both factories use the Rust/WASM engine.

## API

| Export | Purpose |
| --- | --- |
| `makeReadOnlyTools(db, config)` | Make definitions and an executor for describe, query and find-by-ID tools. |
| `makeTools(db, config)` | Add create, update and delete tools. |
| `describeConfig(config)` | Describe collection fields, relationships and search indexes. |
| `describeCollection(collectionConfig)` | Describe one collection. |
| `buildReadOnlyDefinitions()` | Return read-only tool definitions without a database. |
| `buildFullDefinitions()` | Return full CRUD tool definitions without a database. |

A tool kit provides `definitions` and `execute(toolName, args): Promise<string>`. Queries default to a limit of 50. The executor returns failures as JSON objects with an `error` field. Read-only tool kits reject writes.

Tool calls do not provide authentication or authorization. Apply access controls before passing calls to the executor. Only expose `makeTools` when the caller may modify the database.
