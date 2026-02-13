# Append-Only JSONL

Demonstrates append-only collections for event logs, audit trails, and write-once data. Each `create()` appends a single JSONL line instead of rewriting the entire file.

## Features

- `appendOnly: true` configuration with `.jsonl` file
- `create()` appends one JSON line per record
- `query()` and `findById()` work normally
- `aggregate()` works normally
- `update()` and `delete()` throw `OperationError`
- `flush()` rewrites the file cleanly

## Run

```sh
bun run examples/14-append-only-jsonl/index.ts
```

## Key Concepts

Append-only collections are designed for immutable event streams. The `.jsonl` format stores one JSON object per line, making it streaming-friendly and easy to inspect.

Setting `appendOnly: true` in the collection config prevents mutations (`update`, `delete`) while allowing reads (`query`, `findById`, `aggregate`) to work normally. This is enforced at the database level with `OperationError`.

Call `db.flush()` to rewrite the file cleanly (e.g., to compact or normalize the output).
