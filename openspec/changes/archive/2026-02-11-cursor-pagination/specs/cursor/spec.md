# Cursor Pagination

## Overview

Cursor-based pagination anchors page boundaries to a specific record's sort key value rather than a numeric position. This eliminates the duplicate/skip problem inherent in offset-based pagination when data changes between page fetches.

## Types

### CursorConfig

```typescript
interface CursorConfig {
  readonly key: string       // sort field used as the cursor (e.g. "createdAt", "id")
  readonly after?: string    // cursor value — fetch items after this value
  readonly before?: string   // cursor value — fetch items before this value
  readonly limit: number     // max items per page (required, no default)
}
```

- `after` and `before` are mutually exclusive. Specifying both is a validation error.
- Omitting both returns the first page (forward from the start).
- Cursor values are opaque strings. Internally they represent the sort key value of the boundary record.

### CursorPageResult

```typescript
interface CursorPageResult<T> {
  readonly items: ReadonlyArray<T>
  readonly pageInfo: {
    readonly startCursor: string | null   // cursor of first item in page
    readonly endCursor: string | null     // cursor of last item in page
    readonly hasNextPage: boolean
    readonly hasPreviousPage: boolean
  }
}
```

- When `items` is empty, `startCursor` and `endCursor` are both `null`.

### QueryConfig Changes

`QueryConfig` becomes a discriminated union. The two variants are mutually exclusive at the type level:

```typescript
// Offset variant (existing)
{
  where?, sort?, select?, populate?,
  limit?: number,
  offset?: number
}

// Cursor variant (new)
{
  where?, sort?, select?, populate?,
  cursor: CursorConfig
}
```

Specifying `cursor` alongside `limit` or `offset` at the top level is a type error — `limit` lives inside `CursorConfig`.

### QueryReturnType Changes

When `cursor` is present in the config, the return type is `Effect<CursorPageResult<T>, E>` instead of `RunnableStream<T, E>`. The result is eager (not a stream) because cursor metadata requires knowing page boundaries.

A `.runPromise` convenience is still provided on the return value for non-Effect consumers.

## Behavior

### Forward Pagination (after)

1. Filter the sorted result set to items where `record[key] > after`.
2. Take the first `limit + 1` items.
3. If `limit + 1` items exist, `hasNextPage = true`; return only the first `limit`.
4. `hasPreviousPage = true` (a cursor was provided, so earlier records exist).

### Backward Pagination (before)

1. Filter the sorted result set to items where `record[key] < before`.
2. Take the last `limit + 1` items.
3. If `limit + 1` items exist, `hasPreviousPage = true`; return only the last `limit`.
4. `hasNextPage = true` (a cursor was provided, so later records exist).

### First Page (no after/before)

1. Take the first `limit + 1` items from the sorted result set.
2. If `limit + 1` items exist, `hasNextPage = true`.
3. `hasPreviousPage = false`.

### Cursor Encoding

Cursor values are the string representation of the sort key value (via `String(record[key])`). No base64 or opaque encoding — values are transparent and human-readable.

### Sort Interaction

- If `sort` is provided, the cursor key must match the primary sort field. Mismatches produce a validation error.
- If `sort` is omitted, the cursor key is used as the implicit sort field (ascending).
- Multi-field sort: the cursor key must be the first sort field. Secondary sort fields break ties but don't affect cursor boundaries.

### Pipeline Integration

The cursor stage replaces the paginate stage in the pipeline when `cursor` is present:

1. Filter (where)
2. Populate
3. Sort (using cursor key as primary sort, or validating against explicit sort)
4. **Cursor slice** (replaces offset/limit pagination)
5. Select

The cursor slice is not a Stream combinator that returns a Stream. It collects the stream, applies cursor logic, and produces a `CursorPageResult`.

## Error Cases

| Condition | Error |
|---|---|
| `after` and `before` both specified | `ValidationError` with message describing mutual exclusivity |
| `cursor.key` doesn't exist on entity type | `ValidationError` with message identifying the invalid key |
| `cursor.key` conflicts with explicit `sort` primary field | `ValidationError` with message describing the mismatch |
| `limit <= 0` | `ValidationError` with message requiring positive limit |
| `cursor` specified alongside top-level `limit` or `offset` | Type error (compile-time only, not runtime) |

## Tests

- Forward pagination: first page, second page via `after: endCursor`, final page `hasNextPage = false`
- Backward pagination: last page, previous page via `before: startCursor`, first page `hasPreviousPage = false`
- Empty results: no items match → empty items, null cursors, both has* = false
- Stability: insert a record between pages, next page still starts at correct item
- Combined with `where`: cursor applies after filtering
- Combined with `populate`: populated fields present in page items
- Combined with `select`: selected fields applied to page items
- Combined with explicit `sort`: cursor key must match primary sort
- Implicit sort: omitting sort uses cursor key ascending
- Validation errors: both after+before, invalid key, limit <= 0, sort mismatch
