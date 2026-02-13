# proseql

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

## Enough. Show Me.

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

const db = await Effect.runPromise(
  createEffectDatabase({
    books: { schema: BookSchema, relationships: {} },
  }, {
    books: [
      { id: "1", title: "Dune", author: "Frank Herbert", year: 1965, genre: "sci-fi" },
      { id: "2", title: "Neuromancer", author: "William Gibson", year: 1984, genre: "sci-fi" },
      { id: "3", title: "The Left Hand of Darkness", author: "Ursula K. Le Guin", year: 1969, genre: "sci-fi" },
    ],
  }),
)

// find it
const dune = await db.books.findById("1").runPromise

// query it
const classics = await db.books.query({
  where: { year: { $lt: 1970 } },
  sort: { year: "asc" },
}).runPromise

// change it
await db.books.update("1", { genre: "masterpiece" }).runPromise

// that's it. that's the database.
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

## Persist to Files

Add a `file` field. Mutations save automatically. Your data is always a plain text file on disk.

```ts
import { Effect, Layer } from "effect"
import {
  createPersistentEffectDatabase,
  NodeStorageLayer,
  makeSerializerLayer,
  yamlCodec,
  jsonCodec,
} from "@proseql/node"

const config = {
  books: {
    schema: BookSchema,
    file: "./data/books.yaml",      // ← that's it
    relationships: {},
  },
  authors: {
    schema: AuthorSchema,
    file: "./data/authors.json",     // ← mix formats, live dangerously
    relationships: {},
  },
} as const

const program = Effect.gen(function* () {
  const db = yield* createPersistentEffectDatabase(config, {
    books: [],
    authors: [],
  })

  yield* db.books.create({ title: "Annihilation", author: "Jeff VanderMeer", year: 2014, genre: "weird fiction" })
  // → saved to ./data/books.yaml
  // → go ahead, open the file. it's right there.
})

const PersistenceLayer = Layer.merge(
  NodeStorageLayer,
  makeSerializerLayer([yamlCodec(), jsonCodec()]),
)

await Effect.runPromise(
  program.pipe(Effect.provide(PersistenceLayer), Effect.scoped),
)
```

Writes are debounced. Call `db.flush()` when you're impatient.

### Pick Your Format

| Format | Extension | Vibe |
|--------|-----------|------|
| JSON   | `.json`   | The classic |
| JSONL  | `.jsonl`  | One object per line, streaming-friendly |
| YAML   | `.yaml`   | For humans who hate braces |
| JSON5  | `.json5`  | JSON, but chill (comments, trailing commas) |
| JSONC  | `.jsonc`  | JSON with comments, because you deserve them |
| TOML   | `.toml`   | Config-brained perfection |
| TOON   | `.toon`   | Compact and LLM-friendly |
| Hjson  | `.hjson`  | JSON for people who make typos |
| Prose  | `.prose`  | Data that reads like a sentence |

```ts
// pick and choose
makeSerializerLayer([jsonCodec(), yamlCodec(), tomlCodec()])

// or just take them all
import { AllTextFormatsLayer } from "@proseql/core"
```

### Prose Format

Most codecs are zero-config. Prose is different — it needs a template that describes how each record becomes a sentence.

```ts
const config = {
  books: {
    schema: BookSchema,
    file: "./data/books.prose",
    relationships: {},
  },
}

// prose requires a template — each record becomes a sentence
makeSerializerLayer([
  proseCodec({ template: '"{title}" by {author} ({year}) — {genre}' }),
  jsonCodec(),
])
```

On disk, it looks like this:

```
@prose "{title}" by {author} ({year}) — {genre}

"Dune" by Frank Herbert (1965) — sci-fi
"Neuromancer" by William Gibson (1984) — sci-fi
```

The `@prose` directive tells the parser which template to use for decoding. Because `proseCodec` requires a `template` argument, it isn't included in `AllTextFormatsLayer` — you always register it explicitly.

### Append-Only Collections

For event logs, audit trails, and other write-once data: set `appendOnly: true`. Each `create()` appends a single JSONL line instead of rewriting the file.

```ts
const config = {
  events: {
    schema: EventSchema,
    file: "./data/events.jsonl",    // ← must be .jsonl
    appendOnly: true,               // ← the magic flag
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

On disk, it's one JSON object per line. `flush()` rewrites the file cleanly.

## CRUD

The usual suspects, but type-safe and with `.runPromise` to keep things simple.

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
  update: { genre: "documentary" },  // honestly more accurate
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

For when plain field replacement isn't enough. Operators give you atomic, type-safe mutations.

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

#### Logical Operators

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

const db = await Effect.runPromise(
  createEffectDatabase(config, { books: initialBooks }),
)

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

## Lifecycle Hooks

Run logic before or after mutations. Normalize data, enforce rules, log things, live your best life.

```ts
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

Schemas change. Data files shouldn't break. Migrations run automatically on load.

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
    file: "./data/books.yaml",
    version: 2,
    migrations,
    relationships: {},
  },
} as const
```

File at version 0? Runs 0 → 1 → 2, validates, writes back. File already at version 2? Loaded normally. Migration fails? Original file untouched.

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

Rolled-back transactions never touch disk.

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

const db = await Effect.runPromise(
  createEffectDatabase(config, initialData, {
    plugins: [regexPlugin, snowflakePlugin],
  }),
)

// use the custom operator in queries
const matches = await db.books.query({
  where: { title: { $regex: "^The.*" } },
}).runPromise

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
| `StorageError` | File system trouble |
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

## Packages

ProseQL is a monorepo. Pick the package that fits your runtime.

| Package | What It Does |
|---------|-------------|
| `@proseql/core` | Runtime-agnostic database core. All the logic, no platform dependencies. |
| `@proseql/node` | Re-exports core + `NodeStorageLayer` for file system persistence. |
| `@proseql/browser` | Browser storage adapters: localStorage, sessionStorage, IndexedDB. |

```ts
// Node.js — file system persistence
import { createPersistentEffectDatabase, NodeStorageLayer } from "@proseql/node"

// Browser — localStorage with cross-tab sync
import { createPersistentEffectDatabase, LocalStorageLayer } from "@proseql/browser"

// In-memory only (works everywhere)
import { createEffectDatabase } from "@proseql/core"
```

The browser package supports cross-tab synchronization via `storage` events (localStorage) and IndexedDB for datasets that exceed the ~5MB localStorage limit. See [packages/browser/README.md](packages/browser/README.md) for details.

## License

MIT
