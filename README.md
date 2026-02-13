# proseql

<div align="center">

[![License: MIT](https://img.shields.io/github/license/simonwjackson/proseql?style=for-the-badge&labelColor=161B22&color=DDB6F2)](LICENSE)
[![npm](https://img.shields.io/npm/v/@proseql/core?style=for-the-badge&label=%40proseql%2Fcore&labelColor=161B22&color=9fdf9f)](https://www.npmjs.com/package/@proseql/core)
[![CI](https://img.shields.io/github/actions/workflow/status/simonwjackson/proseql/ci.yml?style=for-the-badge&label=CI&labelColor=161B22)](https://github.com/simonwjackson/proseql/actions)

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white&labelColor=161B22)](https://www.typescriptlang.org/)
[![Effect](https://img.shields.io/badge/Built_with-Effect-white?style=for-the-badge&labelColor=161B22)](https://effect.website/)
[![Bun](https://img.shields.io/badge/Bun-FBF0DF?style=for-the-badge&logo=bun&logoColor=FBF0DF&labelColor=161B22)](https://bun.sh/)

[![No Server Required](https://img.shields.io/badge/No_Server_Required-ff7b72?style=for-the-badge&labelColor=161B22)](.)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-9fdf9f?style=for-the-badge&logo=node.js&logoColor=9fdf9f&labelColor=161B22)](.)
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-79c0ff?style=for-the-badge&labelColor=161B22)](https://github.com/simonwjackson/proseql/pulls)

</div>

**prose** /prōz/ *n.* — written language in its ordinary form.
**SQL** /ˈsiːkwəl/ *n.* — the language of relational databases.

A type-safe relational database that persists to plain text files. No server. No binary blobs. Just files you can read, edit, `git diff`, and actually understand.

```
your-project/
├── data/
│   ├── books.yaml          ← you can just open this
│   ├── authors.json         ← or this
│   ├── publishers.toml      ← or this, we don't judge
│   └── catalog.prose        ← or this, it reads like English
└── ...
```

## Install

```sh
npm install @proseql/core
# For file persistence (Node.js):
npm install @proseql/node
```

## Quick Start

Your data lives in plain text files. Here's `books.yaml`:

```yaml
- id: "1"
  title: Dune
  author: Frank Herbert
  year: 1965
  genre: sci-fi
```

Query and mutate with type-safe APIs:

```ts
import { Effect, Schema } from "effect"
import { createNodeDatabase } from "@proseql/node"

const BookSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  author: Schema.String,
  year: Schema.Number,
  genre: Schema.String,
})

const program = Effect.gen(function* () {
  const db = yield* createNodeDatabase({
    books: {
      schema: BookSchema,
      file: "./data/books.yaml",
      relationships: {},
    },
  })

  // find it
  const dune = await db.books.findById("1").runPromise

  // query it
  const classics = await db.books.query({
    where: { year: { $lt: 1970 } },
    sort: { year: "asc" },
  }).runPromise

  // change it
  await db.books.update("1", { genre: "masterpiece" }).runPromise
  // → books.yaml just changed on disk. go open it.
})

await Effect.runPromise(Effect.scoped(program))
```

## Packages

| Package | Description |
|---------|-------------|
| [`@proseql/core`](packages/core/README.md) | Runtime-agnostic database core. Schema, CRUD, queries, aggregation, relationships, indexing, transactions, plugins. |
| [`@proseql/node`](packages/node/README.md) | Node.js file persistence. File formats, debounced writes, append-only collections. |
| [`@proseql/browser`](packages/browser/README.md) | Browser storage adapters: localStorage, sessionStorage, IndexedDB. |
| [`@proseql/cli`](packages/cli/README.md) | Command-line interface. Query, create, update, delete, migrate, convert formats. |
| [`@proseql/rest`](packages/rest/README.md) | Framework-agnostic REST API handlers. Route generation, query parsing, error mapping. |
| [`@proseql/rpc`](packages/rpc/README.md) | Effect RPC integration. Type-safe procedures, streaming queries, error schemas. |

## Examples

| Example | Description |
|---------|-------------|
| [01-basic-crud](examples/01-basic-crud) | Create, read, update, delete operations |
| [02-filtering-and-selection](examples/02-filtering-and-selection) | Query operators, field selection, sorting |
| [03-update-operators](examples/03-update-operators) | Atomic mutations: $increment, $append, $toggle |
| [04-nested-data](examples/04-nested-data) | Nested schemas, shape-mirroring, dot-notation |
| [05-cursor-pagination](examples/05-cursor-pagination) | Offset and cursor-based pagination |
| [06-aggregation](examples/06-aggregation) | Count, sum, avg, min, max, groupBy |
| [07-computed-fields](examples/07-computed-fields) | Derived values at query time |
| [08-full-text-search](examples/08-full-text-search) | Token-based search, search indexes |
| [09-query-with-population](examples/09-query-with-population) | Relationship population, nested joins |
| [10-lifecycle-hooks](examples/10-lifecycle-hooks) | Before/after hooks, validation, rejection |
| [11-persistence-setup](examples/11-persistence-setup) | Three ways to wire file persistence |
| [12-file-persistence](examples/12-file-persistence) | Multi-format bookshelf tracker (9 formats) |
| [13-prose-format](examples/13-prose-format) | Human-readable prose files |
| [14-append-only-jsonl](examples/14-append-only-jsonl) | Event logs, audit trails |
| [15-reactive-queries](examples/15-reactive-queries) | Live query streams |
| [16-advanced-features](examples/16-advanced-features) | ID generation, indexing, unique constraints, transactions, migrations, plugins, foreign keys |

## License

MIT
