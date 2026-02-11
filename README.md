# proseql

**prose** /prōz/ *n.* — written language in its ordinary form.
**SQL** /ˈsiːkwəl/ *n.* — the language of relational databases.

A type-safe relational database that persists to plain text files. No server. No binary blobs. Just files you can read, edit, `git diff`, and actually understand.

```
your-project/
├── data/
│   ├── books.yaml          ← you can just open this
│   ├── authors.json         ← or this
│   └── publishers.toml      ← or this, we don't judge
└── ...
```

## Install

```sh
npm install proseql
```

## Enough. Show Me.

```ts
import { Effect, Schema } from "effect"
import { createEffectDatabase } from "proseql"

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
} from "proseql"

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
| YAML   | `.yaml`   | For humans who hate braces |
| JSON5  | `.json5`  | JSON, but chill (comments, trailing commas) |
| JSONC  | `.jsonc`  | JSON with comments, because you deserve them |
| TOML   | `.toml`   | Config-brained perfection |
| TOON   | `.toon`   | Compact and LLM-friendly |
| Hjson  | `.hjson`  | JSON for people who make typos |

```ts
// pick and choose
makeSerializerLayer([jsonCodec(), yamlCodec(), tomlCodec()])

// or just take them all
import { AllTextFormatsLayer } from "proseql"
```

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

// delete
await db.books.delete("1").runPromise

// batch delete
await db.books.deleteMany(["1", "2", "3"]).runPromise
```

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
| `$contains` `$all` `$size` | arrays | Array matching |

Or just pass a value for exact match:

```ts
const scifi = await db.books.query({ where: { genre: "sci-fi" } }).runPromise
```

### Sorting

```ts
const sorted = await db.books.query({
  sort: { year: "desc", title: "asc" },
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
  min: "year",
  max: "year",
  avg: "year",
}).runPromise
// → { count: 42, min: 1818, max: 2024, avg: 1973.5 }

// by genre
const genres = await db.books.aggregate({
  groupBy: "genre",
  count: true,
}).runPromise
// → [
//   { genre: "sci-fi", count: 23 },
//   { genre: "fantasy", count: 12 },
//   { genre: "literary horror", count: 7 },
// ]

// filtered
const modern = await db.books.aggregate({
  where: { year: { $gte: 2000 } },
  count: true,
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
import type { Migration } from "proseql"

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
} from "proseql"

generateUUID()              // "550e8400-e29b-41d4-a716-446655440000"
generateNanoId()            // "V1StGXR8_Z5jdHi6B-myT"
generateULID()              // "01ARZ3NDEKTSV4RRFFQ69G5FAV"
generateTimestampId()       // "1704067200000-a3f2-0001"
generatePrefixedId("book")  // "book_1704067200000-a3f2-0001"
generateTypedId("book")     // "book_V1StGXR8_Z5jdHi6B-myT"
```

## License

MIT
