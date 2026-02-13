# Full-Text Search

Demonstrates field-level and multi-field text search with optional inverted index optimization.

## Features

- Single-field search using `$search` operator
- Multi-term search with all terms matching
- Cross-field search spanning multiple columns
- All-fields search when fields parameter is omitted
- Optional search index for O(tokens) lookup performance on large collections

## Run

```sh
bun run examples/08-full-text-search/index.ts
```

## Key Concepts

The `$search` operator performs case-insensitive tokenized search. For single-field searches, use `{ field: { $search: "query" } }`. For multi-field searches, use `{ $search: { query: "terms", fields: ["field1", "field2"] } }`. Without the `searchIndex` config, searches scan all entities. With `searchIndex: ["field1", "field2"]`, an inverted index is built for faster lookups on large datasets.
