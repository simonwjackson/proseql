# @proseql/core

Runtime-agnostic in-memory database with type-safe queries, relationships, and Effect integration.

## Install

```sh
npm install @proseql/core
```

## Quick Start

```ts
import { Effect, Schema } from "effect"
import { createEffectDatabase } from "@proseql/core"

const BookSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  author: Schema.String,
  year: Schema.Number,
  genre: Schema.String,
})

const config = {
  books: {
    schema: BookSchema,
    relationships: {},
  },
} as const

const program = Effect.gen(function* () {
  const db = yield* createEffectDatabase(config, {
    books: [
      { id: "1", title: "Dune", author: "Frank Herbert", year: 1965, genre: "sci-fi" },
    ],
  })

  // query
  const scifi = await db.books.query({
    where: { genre: "sci-fi" },
  }).runPromise

  // create
  const book = await db.books.create({
    title: "Neuromancer",
    author: "William Gibson",
    year: 1984,
    genre: "sci-fi",
  }).runPromise

  // update
  await db.books.update("1", { genre: "classic" }).runPromise
})

await Effect.runPromise(program)
```

## Schema Definition

Schemas use Effect's `Schema.Struct` for type-safe validation:

```ts
import { Schema } from "effect"

const BookSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  author: Schema.String,
  year: Schema.Number,
  genre: Schema.String,
})

const AuthorSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  birthYear: Schema.Number,
  country: Schema.String,
})
```

### Nested Data

Schemas can contain nested objects. ProseQL supports them everywhere — filtering, sorting, updates, aggregation, indexing, search, and computed fields.

```ts
const BookSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  genre: Schema.String,
  metadata: Schema.Struct({
    views: Schema.Number,
    rating: Schema.Number,
    tags: Schema.Array(Schema.String),
    description: Schema.String,
  }),
  author: Schema.Struct({
    name: Schema.String,
    country: Schema.String,
  }),
})
```

Two ways to reference nested fields:

```ts
// shape-mirroring — mirrors the object structure
await db.books.query({ where: { metadata: { rating: 5 } } }).runPromise

// dot-notation — flat string path
await db.books.query({ where: { "metadata.rating": 5 } }).runPromise
```

Both are equivalent. Use whichever reads better in context.

## CRUD

Type-safe operations with `.runPromise` for convenience.

```ts
// create one
const book = await db.books.create({
  title: "The Dispossessed",
  author: "Ursula K. Le Guin",
  year: 1974,
  genre: "sci-fi",
}).runPromise

// create a bunch
const batch = await db.books.createMany([
  { title: "Snow Crash", author: "Neal Stephenson", year: 1992, genre: "sci-fi" },
  { title: "Parable of the Sower", author: "Octavia Butler", year: 1993, genre: "sci-fi" },
]).runPromise

// find by ID — O(1), not a scan
const found = await db.books.findById("1").runPromise

// update
await db.books.update("1", { genre: "prophetic" }).runPromise

// upsert — create if missing, update if found
const result = await db.books.upsert({
  where: { id: "42" },
  create: { title: "Hitchhiker's Guide", author: "Douglas Adams", year: 1979, genre: "comedy" },
  update: { genre: "documentary" },
}).runPromise

// update many by predicate
await db.books.updateMany(
  (book) => book.genre === "sci-fi",
  { genre: "speculative fiction" },
).runPromise

// upsert many
await db.books.upsertMany([
  { where: { id: "1" }, create: { title: "Dune", author: "Frank Herbert", year: 1965, genre: "sci-fi" }, update: { genre: "classic" } },
  { where: { id: "99" }, create: { title: "New Book", author: "New Author", year: 2024, genre: "new" }, update: { genre: "updated" } },
]).runPromise

// delete
await db.books.delete("1").runPromise

// delete by predicate
await db.books.deleteMany(
  (book) => book.year < 1970,
).runPromise
```

### Update Operators

Atomic, type-safe mutations.

```ts
// increment/decrement numbers
await db.books.update("1", { year: { $increment: 1 } }).runPromise
await db.books.update("1", { year: { $decrement: 5 } }).runPromise
await db.books.update("1", { year: { $multiply: 2 } }).runPromise

// string append/prepend
await db.books.update("1", { title: { $append: " (Revised)" } }).runPromise
await db.books.update("1", { title: { $prepend: "The " } }).runPromise

// array operations
await db.books.update("1", { tags: { $append: "classic" } }).runPromise
await db.books.update("1", { tags: { $prepend: "must-read" } }).runPromise
await db.books.update("1", { tags: { $remove: "draft" } }).runPromise

// toggle booleans
await db.books.update("1", { inStock: { $toggle: true } }).runPromise

// explicit set (same as plain value, but composable with other operators)
await db.books.update("1", { genre: { $set: "masterpiece" } }).runPromise

// nested updates — deep merge preserves sibling fields
await db.books.update("1", { metadata: { views: 500 } }).runPromise
// → metadata.views = 500, metadata.rating/tags/description unchanged

// nested operators
await db.books.update("1", { metadata: { views: { $increment: 100 } } }).runPromise

// update multiple nested paths at once
await db.books.update("1", {
  metadata: { rating: 5, views: { $increment: 200 } },
  author: { country: "CA" },
}).runPromise
```

| Operator | Works On | What It Does |
|----------|----------|-------------|
| `$set` | everything | Explicit set (equivalent to plain value) |
| `$increment` | numbers | Add to current value |
| `$decrement` | numbers | Subtract from current value |
| `$multiply` | numbers | Multiply current value |
| `$append` | strings, arrays | Append to end |
| `$prepend` | strings, arrays | Prepend to beginning |
| `$remove` | arrays | Remove matching element(s) |
| `$toggle` | booleans | Flip the value |

## Querying

### Filtering

```ts
const results = await db.books.query({
  where: {
    year: { $gte: 1960, $lt: 1990 },
    genre: { $in: ["sci-fi", "fantasy"] },
    title: { $contains: "Dark" },
  },
}).runPromise
```

| Operator | Works On | What It Does |
|----------|----------|-------------|
| `$eq` | everything | Equals |
| `$ne` | everything | Not equals |
| `$in` | everything | In list |
| `$nin` | everything | Not in list |
| `$gt` `$gte` `$lt` `$lte` | numbers, strings | Comparisons |
| `$startsWith` `$endsWith` `$contains` | strings | String matching |
| `$search` | strings | Token-based text search (see [Full-Text Search](#full-text-search)) |
| `$contains` `$all` `$size` | arrays | Array matching |
| `$or` | clauses | Match **any** of the given conditions |
| `$and` | clauses | Match **all** of the given conditions |
| `$not` | clause | Negate a condition |

Nested fields work with any operator — use shape-mirroring or dot-notation:

```ts
// shape-mirroring
const popular = await db.books.query({
  where: { metadata: { views: { $gt: 700 } } },
}).runPromise

// dot-notation
const highlyRated = await db.books.query({
  where: { "metadata.rating": { $gte: 4 } },
}).runPromise
```

Or just pass a value for exact match:

```ts
const scifi = await db.books.query({ where: { genre: "sci-fi" } }).runPromise
```

### Logical Operators

Combine conditions with `$or`, `$and`, and `$not`:

```ts
// books that are either sci-fi OR published before 1970
const results = await db.books.query({
  where: {
    $or: [
      { genre: "sci-fi" },
      { year: { $lt: 1970 } },
    ],
  },
}).runPromise

// NOT fantasy
const notFantasy = await db.books.query({
  where: {
    $not: { genre: "fantasy" },
  },
}).runPromise

// combine with field-level filters
const complex = await db.books.query({
  where: {
    $and: [
      { year: { $gte: 1960 } },
      { $or: [{ genre: "sci-fi" }, { genre: "fantasy" }] },
    ],
  },
}).runPromise

// logical operators work with nested fields too
const featured = await db.books.query({
  where: {
    $or: [
      { metadata: { rating: 5 } },
      { author: { country: "UK" } },
    ],
  },
}).runPromise
```

### Sorting

```ts
const sorted = await db.books.query({
  sort: { year: "desc", title: "asc" },
}).runPromise

// sort by nested fields using dot-notation
const mostViewed = await db.books.query({
  sort: { "metadata.views": "desc" },
}).runPromise
```

### Field Selection

```ts
const titles = await db.books.query({
  select: ["title", "author"],
}).runPromise
// → [{ title: "Dune", author: "Frank Herbert" }, ...]
```

### Pagination

```ts
// offset-based (the simple kind)
const page = await db.books.query({
  sort: { title: "asc" },
  limit: 10,
  offset: 20,
}).runPromise

// cursor-based (the stable kind — inserts and deletes don't break it)
const page1 = await db.books.query({
  sort: { title: "asc" },
  cursor: { key: "title", limit: 10 },
}).runPromise
// page1.pageInfo.endCursor → "Neuromancer"
// page1.pageInfo.hasNextPage → true

const page2 = await db.books.query({
  sort: { title: "asc" },
  cursor: { key: "title", after: page1.pageInfo.endCursor, limit: 10 },
}).runPromise
```

### Aggregation

```ts
const stats = await db.books.aggregate({
  count: true,
  sum: "pages",
  min: "year",
  max: "year",
  avg: "year",
}).runPromise
// → { count: 42, sum: { pages: 12840 }, min: { year: 1818 }, max: { year: 2024 }, avg: { year: 1973.5 } }

// by genre
const genres = await db.books.aggregate({
  groupBy: "genre",
  count: true,
}).runPromise
// → [
//   { group: { genre: "sci-fi" }, count: 23 },
//   { group: { genre: "fantasy" }, count: 12 },
//   { group: { genre: "literary horror" }, count: 7 },
// ]

// filtered
const modern = await db.books.aggregate({
  where: { year: { $gte: 2000 } },
  count: true,
}).runPromise

// aggregate nested fields using dot-notation
const nested = await db.books.aggregate({
  where: { metadata: { rating: { $gte: 4 } } },
  count: true,
  sum: "metadata.views",
  avg: "metadata.rating",
}).runPromise
// → { count: 4, sum: { "metadata.views": 3600 }, avg: { "metadata.rating": 4.5 } }

// group by nested field
const byCountry = await db.books.aggregate({
  groupBy: "author.country",
  count: true,
}).runPromise
// → [
//   { group: { "author.country": "USA" }, count: 3 },
//   { group: { "author.country": "UK" }, count: 2 },
// ]
```

## Full-Text Search

Search text fields with token-based matching. Results are ranked by relevance.

```ts
// field-level search
const results = await db.books.query({
  where: { title: { $search: "left hand" } },
}).runPromise

// multi-field search — terms can span across fields
const results = await db.books.query({
  where: {
    $search: { query: "herbert dune", fields: ["title", "author"] },
  },
}).runPromise

// search all string fields (omit fields)
const results = await db.books.query({
  where: {
    $search: { query: "cyberpunk" },
  },
}).runPromise
```

Search nested fields by specifying dot-paths:

```ts
const results = await db.books.query({
  where: {
    $search: { query: "cyberpunk", fields: ["metadata.description"] },
  },
}).runPromise
```

Add a `searchIndex` for faster lookups on large collections:

```ts
const config = {
  books: {
    schema: BookSchema,
    searchIndex: ["title", "metadata.description", "author.name"],
    relationships: {},
  },
} as const
```

Without a search index, `$search` scans all entities (still works, just slower). With one, it hits the inverted index for O(tokens) candidate lookup.

## Computed Fields

Derived values that exist only at query time. Never persisted, zero overhead when not selected.

```ts
const config = {
  books: {
    schema: BookSchema,
    computed: {
      displayName: (book) => `${book.title} (${book.year})`,
      isClassic: (book) => book.year < 1980,
      // computed fields can read nested data
      viewCount: (book) => book.metadata.views,
      isHighlyRated: (book) => book.metadata.rating >= 4,
      summary: (book) => `${book.title} by ${book.author.name} (${book.metadata.rating}/5)`,
    },
    relationships: {},
  },
} as const

const program = Effect.gen(function* () {
  const db = yield* createEffectDatabase(config, { books: initialBooks })

  // computed fields appear in query results automatically
  const books = await db.books.query().runPromise
  // → [{ title: "Dune", year: 1965, displayName: "Dune (1965)", isClassic: true, ... }]

  // filter on computed fields
  const classics = await db.books.query({
    where: { isClassic: true },
  }).runPromise

  // select specific fields (including computed)
  const labels = await db.books.query({
    select: ["displayName"],
  }).runPromise
  // → [{ displayName: "Dune (1965)" }, ...]

  // sort by computed fields
  const sorted = await db.books.query({
    sort: { displayName: "asc" },
  }).runPromise
})
```

## Relationships

Books have authors. Authors write books. ProseQL gets it.

```ts
const config = {
  books: {
    schema: BookSchema,
    relationships: {
      author: { type: "ref" as const, target: "authors" as const, foreignKey: "authorId" },
    },
  },
  authors: {
    schema: AuthorSchema,
    relationships: {
      books: { type: "inverse" as const, target: "books" as const, foreignKey: "authorId" },
    },
  },
} as const
```

Populate related data in queries:

```ts
const booksWithAuthors = await db.books.query({
  populate: { author: true },
}).runPromise
// → [{ title: "Dune", author: { name: "Frank Herbert", ... } }, ...]
```

Foreign keys are enforced. Try referencing a ghost author:

```ts
await db.books.create({
  title: "Mystery Novel",
  authorId: "definitely-not-real",
}).runPromise
// → ForeignKeyError. Nice try.
```

## Indexing

Full scans are for people with time to kill. Declare indexes for O(1) lookups.

```ts
const config = {
  books: {
    schema: BookSchema,
    indexes: ["genre", "authorId", ["genre", "year"]],
    relationships: {},
  },
} as const
```

Nested fields use dot-notation in index declarations:

```ts
const config = {
  books: {
    schema: BookSchema,
    indexes: ["metadata.views", "metadata.rating", "author.country"],
    relationships: {},
  },
} as const
```

Indexes are maintained automatically. Queries on indexed fields just... go fast.

```ts
// hits the genre index
const scifi = await db.books.query({
  where: { genre: "sci-fi" },
}).runPromise

// hits the compound [genre, year] index
const recent = await db.books.query({
  where: { genre: "sci-fi", year: 2024 },
}).runPromise
```

## Reactive Queries

Subscribe to live query results. Mutations automatically push updates through the stream.

```ts
import { Effect, Stream, Scope } from "effect"

// watch a filtered query — emits current results, then re-emits on every change
const program = Effect.gen(function* () {
  const db = yield* createEffectDatabase(config, initialData)

  const stream = yield* db.books.watch({
    where: { genre: "sci-fi" },
    sort: { year: "desc" },
  })

  // process each emission
  yield* Stream.runForEach(stream, (books) =>
    Effect.sync(() => console.log("Current sci-fi:", books.length))
  )
})

// run with a scope (stream cleans up automatically when scope closes)
await Effect.runPromise(Effect.scoped(program))
```

Watch a single entity by ID:

```ts
const program = Effect.gen(function* () {
  const db = yield* createEffectDatabase(config, initialData)

  const stream = yield* db.books.watchById("1")

  // emits the entity (or null if it doesn't exist)
  // re-emits on update, emits null on deletion
  yield* Stream.runForEach(stream, (book) =>
    Effect.sync(() => {
      if (book) console.log("Book updated:", book.title)
      else console.log("Book was deleted")
    })
  )
})
```

Streams are debounced and deduplicated automatically — rapid mutations produce at most one emission after the debounce interval settles. Nested field changes trigger emissions too — updating `metadata.views` on a watched entity re-emits the stream.

## Lifecycle Hooks

Run logic before or after mutations. Normalize data, enforce rules, log things, live your best life.

```ts
import { Effect } from "effect"
import { HookError } from "@proseql/core"

const config = {
  books: {
    schema: BookSchema,
    hooks: {
      beforeCreate: (ctx) =>
        Effect.succeed({
          ...ctx.data,
          title: ctx.data.title.trim(),
          createdAt: new Date().toISOString(),
        }),

      afterCreate: (ctx) =>
        Effect.sync(() => console.log(`New book: "${ctx.entity.title}"`)),

      beforeUpdate: (ctx) =>
        Effect.succeed({
          ...ctx.changes,
          updatedAt: new Date().toISOString(),
        }),

      onChange: (ctx) =>
        Effect.sync(() => console.log(`${ctx.operation} on books`)),
    },
    relationships: {},
  },
} as const
```

Hooks can reject operations:

```ts
beforeCreate: (ctx) =>
  ctx.data.year > new Date().getFullYear()
    ? Effect.fail(new HookError({
        hook: "beforeCreate",
        collection: "books",
        operation: "create",
        reason: "We don't accept books from the future",
        message: "We don't accept books from the future",
      }))
    : Effect.succeed(ctx.data),
```

## Schema Migrations

Schemas change. Data shouldn't break. Migrations run automatically on load.

```ts
import type { Migration } from "@proseql/core"

const migrations: ReadonlyArray<Migration> = [
  {
    from: 0,
    to: 1,
    // v1 added a "genre" field
    transform: (book) => ({
      ...book,
      genre: book.genre ?? "uncategorized",
    }),
  },
  {
    from: 1,
    to: 2,
    // v2 split "author" string into "authorFirst" and "authorLast"
    transform: (book) => ({
      ...book,
      authorFirst: book.author?.split(" ")[0] ?? "",
      authorLast: book.author?.split(" ").slice(1).join(" ") ?? "",
      author: undefined,
    }),
  },
]

const config = {
  books: {
    schema: BookSchemaV2,
    version: 2,
    migrations,
    relationships: {},
  },
} as const
```

Data at version 0? Runs 0 → 1 → 2, validates, continues. Data already at version 2? Loaded normally. Migration fails? Original data untouched.

## Transactions

All or nothing. If any operation fails, everything rolls back.

```ts
await db.$transaction(async (tx) => {
  const author = await tx.authors.create({
    name: "Becky Chambers",
  }).runPromise

  await tx.books.createMany([
    { title: "The Long Way to a Small, Angry Planet", authorId: author.id, year: 2014, genre: "sci-fi" },
    { title: "A Closed and Common Orbit", authorId: author.id, year: 2016, genre: "sci-fi" },
    { title: "Record of a Spaceborn Few", authorId: author.id, year: 2018, genre: "sci-fi" },
  ]).runPromise

  // if anything above throws, none of it happened
})
```

## Unique Constraints

Some things should only exist once.

```ts
const config = {
  books: {
    schema: BookSchema,
    uniqueFields: ["isbn"],
    relationships: {},
  },
  reviews: {
    schema: ReviewSchema,
    uniqueFields: [["userId", "bookId"]],  // one review per user per book
    relationships: {},
  },
} as const
```

```ts
await db.books.create({ title: "Dune", isbn: "978-0441172719", ... }).runPromise
await db.books.create({ title: "Dune (but again)", isbn: "978-0441172719", ... }).runPromise
// → UniqueConstraintError. There can be only one.
```

## Plugin System

Extend ProseQL with custom codecs, operators, ID generators, and global hooks.

```ts
import type { ProseQLPlugin } from "@proseql/core"

const regexPlugin: ProseQLPlugin = {
  name: "regex-search",
  operators: [{
    name: "$regex",
    types: ["string"],
    evaluate: (value, pattern) =>
      typeof value === "string" && new RegExp(pattern as string).test(value),
  }],
}

const snowflakePlugin: ProseQLPlugin = {
  name: "snowflake-ids",
  idGenerators: [{
    name: "snowflake",
    generate: () => generateSnowflakeId(),
  }],
}

const program = Effect.gen(function* () {
  const db = yield* createEffectDatabase(config, initialData, {
    plugins: [regexPlugin, snowflakePlugin],
  })

  // use the custom operator in queries
  const matches = await db.books.query({
    where: { title: { $regex: "^The.*" } },
  }).runPromise
})

// reference the custom ID generator in collection config
const config = {
  books: {
    schema: BookSchema,
    idGenerator: "snowflake",  // uses the plugin's generator
    relationships: {},
  },
} as const
```

Plugins can also contribute format codecs and global lifecycle hooks that run across all collections.

## Error Handling

Every error is tagged. Catch exactly what you want.

```ts
import { Effect } from "effect"
import { NotFoundError } from "@proseql/core"

const result = await Effect.runPromise(
  db.books.findById("nope").pipe(
    Effect.catchTag("NotFoundError", () =>
      Effect.succeed({ title: "Book not found", suggestion: "Try the library?" }),
    ),
  ),
)
```

Or use try/catch if that's more your speed:

```ts
try {
  await db.books.findById("nope").runPromise
} catch (err) {
  if (err instanceof NotFoundError) {
    console.log("Have you tried the library?")
  }
}
```

| Error | When |
|-------|------|
| `NotFoundError` | ID doesn't exist |
| `ValidationError` | Schema says no |
| `DuplicateKeyError` | ID already taken |
| `UniqueConstraintError` | Unique field collision |
| `ForeignKeyError` | Referenced entity is a ghost |
| `HookError` | Lifecycle hook rejected it |
| `TransactionError` | Transaction couldn't begin/commit/rollback |
| `StorageError` | Storage adapter trouble |
| `SerializationError` | Couldn't encode/decode |
| `MigrationError` | Migration went sideways |
| `PluginError` | Plugin validation or conflict |

## ID Generation

Pick a strategy. Or don't — we'll generate one for you.

```ts
import {
  generateUUID,
  generateNanoId,
  generateULID,
  generateTimestampId,
  generatePrefixedId,
  generateTypedId,
} from "@proseql/core"

generateUUID()              // "550e8400-e29b-41d4-a716-446655440000"
generateNanoId()            // "V1StGXR8_Z5jdHi6B-myT"
generateULID()              // "01ARZ3NDEKTSV4RRFFQ69G5FAV"
generateTimestampId()       // "1704067200000-a3f2-0001"
generatePrefixedId("book")  // "book_1704067200000-a3f2-0001"
generateTypedId("book")     // "book_V1StGXR8_Z5jdHi6B-myT"
```

## Serialization

The core package includes all serialization codecs, which are runtime-agnostic:

| Format | Extension | Codec |
|--------|-----------|-------|
| JSON   | `.json`   | `jsonCodec()` |
| JSONL  | `.jsonl`  | `jsonlCodec()` |
| YAML   | `.yaml`   | `yamlCodec()` |
| JSON5  | `.json5`  | `json5Codec()` |
| JSONC  | `.jsonc`  | `jsoncCodec()` |
| TOML   | `.toml`   | `tomlCodec()` |
| TOON   | `.toon`   | `toonCodec()` |
| Hjson  | `.hjson`  | `hjsonCodec()` |
| Prose  | `.prose`  | `proseCodec()` |

```ts
import {
  makeSerializerLayer,
  jsonCodec,
  yamlCodec,
  tomlCodec,
  AllTextFormatsLayer,
} from "@proseql/core"

// pick and choose
makeSerializerLayer([jsonCodec(), yamlCodec(), tomlCodec()])

// or take them all (except prose, which must be registered explicitly)
AllTextFormatsLayer
```

### Prose Format

Prose is a human-readable format where data looks like English sentences:

```ts
import { proseCodec } from "@proseql/core"

// explicit template
proseCodec({ template: '[{id}] "{title}" by {author} ({year}) — {genre}' })

// or let it learn from the @prose directive in the file
proseCodec()
```

On disk, prose files look like this:

```
@prose [{id}] "{title}" by {author} ({year}) — {genre}

[1] "Dune" by Frank Herbert (1965) — sci-fi
[2] "Neuromancer" by William Gibson (1984) — sci-fi
```

## Persistence

For file persistence on Node.js, see [`@proseql/node`](https://www.npmjs.com/package/@proseql/node).

For browser storage (localStorage, sessionStorage, IndexedDB), see [`@proseql/browser`](https://www.npmjs.com/package/@proseql/browser).

## License

MIT
