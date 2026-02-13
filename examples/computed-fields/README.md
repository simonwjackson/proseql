# Computed Fields

Demonstrates derived values that exist only at query time and are never persisted to storage.

## Features

- Define computed fields using pure functions on entity data
- Filter queries using computed field values
- Sort results by computed field values
- Select specific computed fields in query results
- Zero storage overhead when computed fields are not selected

## Run

```sh
bun run examples/computed-fields/index.ts
```

## Key Concepts

Computed fields are defined in the collection config as functions that transform entity data. The example shows a `displayName` field that combines title and year, an `isClassic` boolean based on publication year, and a `pageCategory` field that categorizes books by length. These fields can be used in where clauses, sort options, and select arrays just like regular fields, but they are computed on-demand and never stored.
