# Nested Data

Demonstrates nested Schema.Struct support with shape-mirroring vs dot-notation filtering, sorting, deep merge updates, nested operators, and aggregation on nested fields.

## Features

- Shape-mirroring syntax: mirrors object structure in queries
- Dot-notation syntax: flat string paths for nested access
- Comparison operators on nested fields
- Sorting by nested field values
- Deep merge updates that preserve sibling fields
- Update operators ($increment, etc.) on nested paths
- Multi-path updates in a single operation
- Aggregation (sum, avg) on nested fields
- GroupBy with nested field paths

## Run

```sh
bun run examples/04-nested-data/index.ts
```

## Key Concepts

Nested schemas are first-class citizens in ProseQL. Query filtering supports both shape-mirroring (where clauses mirror the object structure) and dot-notation (flat string paths like "metadata.rating"). Updates use deep merging, preserving unspecified nested fields. Update operators work on nested paths, allowing atomic mutations deep in the object tree. Aggregation and groupBy operations support nested field paths using dot-notation.
