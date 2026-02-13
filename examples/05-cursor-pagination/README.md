# Cursor Pagination

Demonstrates offset-based and cursor-based pagination strategies with pageInfo.endCursor and hasNextPage indicators.

## Features

- Offset-based pagination using limit and offset
- Cursor-based pagination with opaque cursor tokens
- pageInfo.endCursor for fetching next page
- pageInfo.hasNextPage indicator for UI state
- Cursor pagination with sorting
- Cursor pagination with filter conditions

## Run

```sh
bun run examples/05-cursor-pagination/index.ts
```

## Key Concepts

ProseQL supports two pagination strategies. Offset-based pagination uses limit and offset parameters, suitable for simple use cases but inefficient for large offsets. Cursor-based pagination uses opaque cursor tokens, providing stable pagination even when data changes. The cursor option requires a key field for ordering and returns pageInfo with endCursor (pass to next query as after) and hasNextPage (indicates more data). Cursor pagination works with filters and sorting for filtered result sets.
