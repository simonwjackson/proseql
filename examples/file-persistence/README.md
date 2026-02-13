# File Persistence -- 9 Format Bookshelf Tracker

A bookshelf tracker that persists each collection to a different file format,
demonstrating ProseQL's multi-format persistence in a single database.

## Formats used

| Collection    | File                  | Format |
|---------------|-----------------------|--------|
| authors       | `authors.yaml`        | YAML   |
| books         | `books.json`          | JSON   |
| genres        | `genres.json5`        | JSON5  |
| publishers    | `publishers.toml`     | TOML   |
| reviews       | `reviews.jsonc`       | JSONC  |
| series        | `series.hjson`        | Hjson  |
| tags          | `tags.toon`           | TOON   |
| readingLog    | `reading-log.jsonl`   | JSONL  |
| quotes        | `quotes.prose`        | Prose  |

## How it works

The example uses `makeNodePersistenceLayer(config)` which calls
`inferCodecsFromConfig` under the hood. That function inspects each
collection's `file` extension (or explicit `format` override) and
instantiates only the codecs that are actually needed -- no manual codec
wiring required.

## Idempotent runs

Run the example twice. On the first run it seeds the database with sample
data. On the second run it detects existing data from disk and skips seeding,
then runs the same queries against the loaded data.

## Running

```bash
bun run examples/file-persistence/index.ts
```

Data files are written to `./examples/data/`. Open any of them -- they are
all human-readable plain text.

## Key concepts

- **`makeNodePersistenceLayer(config)`** -- builds a `Layer` providing
  `StorageAdapter` and `SerializerRegistry`, with codecs inferred from file
  extensions.
- **Debounced writes** -- mutations trigger writes that are debounced (10ms in
  this example) to batch rapid changes into fewer I/O operations.
- **`db.flush()`** -- forces all pending writes to disk immediately.
- **Populated queries** -- `populate: { author: true }` joins related records
  from other collections at query time.
- **Aggregation** -- `db.books.aggregate({ count: true })` works across all
  format backends.
