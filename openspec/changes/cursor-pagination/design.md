# Cursor Pagination — Design

## Architecture

### New Modules

**`core/operations/query/cursor-stream.ts`** — The cursor slice function. Takes a sorted stream, cursor config, and produces a `CursorPageResult`. This is not a Stream-to-Stream combinator like the other pipeline stages — it terminates the stream into a concrete result because cursor metadata (`hasNextPage`, `hasPreviousPage`, cursors) requires collecting items.

```
applyCursor(config: CursorConfig) =>
  <T>(stream: Stream<T>) => Effect<CursorPageResult<T>, ValidationError>
```

**`core/types/cursor-types.ts`** — `CursorConfig`, `CursorPageResult<T>`, and the `RunnableCursorPage<T, E>` convenience type (Effect with `.runPromise`).

### Modified Modules

**`core/types/types.ts`** — `QueryConfig` gains two additional union variants (cursor without populate, cursor with populate). `QueryReturnType` branches: if `Config extends { cursor: CursorConfig }`, return `RunnableCursorPage` instead of `RunnableStream`. `SmartCollection.query` signature unchanged (generic over config).

**`core/factories/database-effect.ts`** — `queryFn` detects `options.cursor`. When present: skips `applyPagination`, instead collects the sorted+filtered stream through `applyCursor`. Returns a `RunnableCursorPage` instead of `RunnableStream`. The pipeline order stays the same up through sort — the branch point is after sort.

## Key Decisions

### Cursor values are plain strings, not encoded

The spec calls for `String(record[key])` — no base64, no JSON wrapping. This keeps cursors inspectable and debuggable. The tradeoff is that cursor values are tied to the sort key's string representation, so non-string sort keys (numbers, dates) convert via `String()`. This is fine for an in-memory database where the cursor is consumed by the same system that produced it.

### `applyCursor` collects the stream

Unlike `applyPagination` which is a lazy stream combinator (`Stream → Stream`), cursor pagination needs to:
1. Filter by cursor boundary (`> after` or `< before`)
2. Collect `limit + 1` items to determine `hasNextPage`/`hasPreviousPage`
3. Extract cursor values from the first and last items
4. Package into `CursorPageResult`

This requires eager collection. The function signature is `Stream<T> → Effect<CursorPageResult<T>>`, not `Stream<T> → Stream<T>`. This is an acceptable cost — cursor pagination inherently needs the boundary items.

### Sort validation happens in `applyCursor`

If the caller provides an explicit `sort` config AND a `cursor.key`, `applyCursor` validates that the cursor key matches the primary (first) sort field. If `sort` is omitted, the cursor key is used as an implicit ascending sort — but the actual sort is applied by the existing `applySort` stage, not by `applyCursor`. The factory is responsible for injecting the implicit sort when cursor is present and sort is absent.

### Return type branching in `QueryReturnType`

The outer branch checks `Config extends { cursor: CursorConfig }` first, before the existing populate/select branches. Within the cursor branch, the same populate/select logic applies to determine the item type `T`, but the wrapper changes from `RunnableStream<T, E>` to `RunnableCursorPage<T, E>`.

`RunnableCursorPage<T, E>` is:
```typescript
type RunnableCursorPage<T, E> = Effect.Effect<CursorPageResult<T>, E, never> & {
  readonly runPromise: Promise<CursorPageResult<T>>
}
```

### Factory pipeline branching

In `database-effect.ts`, `queryFn` currently always returns `RunnableStream`. With cursor pagination, the function needs to branch:

```
if (options.cursor) {
  // Validate cursor config
  // Inject implicit sort if sort is absent
  // Pipeline: filter → populate → sort → applyCursor → select (applied to items inside CursorPageResult)
  // Return RunnableCursorPage
} else {
  // Existing pipeline: filter → populate → sort → applyPagination → applySelect
  // Return RunnableStream
}
```

Select with cursor is slightly different: select must be applied to each item inside the `CursorPageResult.items` array, not as a stream combinator. This means `applySelect` runs inside `applyCursor` or the factory maps over items after cursor collection.

Simpler approach: apply select as a stream combinator before cursor collection. The cursor stage operates on already-projected items. This works because select doesn't affect cursor keys (cursor keys are extracted before select projection).

Actually, cursor keys are extracted from the items themselves. If select excludes the cursor key field, the cursor values would be lost. Two options:
1. Always include the cursor key in the result items (even if not in select) — leaks internal state
2. Extract cursor values before applying select — cleaner

**Decision:** Extract cursor values before select. Pipeline becomes: filter → populate → sort → collect with cursor boundary → extract cursors from pre-select items → apply select to items → return `CursorPageResult` with projected items but correct cursors.

In practice, `applyCursor` receives the stream after sort, collects items, extracts cursor metadata, then the factory applies select to the items array before packaging the final result.

### Backward pagination item ordering

When using `before`, the spec says to take the last `limit + 1` items where `record[key] < before`. The items in the result should be in ascending order (matching the sort direction), not reversed. Implementation: filter to items before cursor, reverse to find the last N+1, then reverse back.

## Error Handling

All validation errors use the existing `ValidationError` tagged error from `core/errors/crud-errors.ts`. The `issues` array provides structured detail:

- `after` + `before` both set: `{ field: "cursor", message: "after and before are mutually exclusive" }`
- Invalid key: `{ field: "cursor.key", message: "key '<key>' does not exist on entity" }`
- Sort mismatch: `{ field: "cursor.key", message: "cursor key '<key>' must match primary sort field '<sortField>'" }`
- Bad limit: `{ field: "cursor.limit", message: "limit must be a positive integer" }`

## File Layout

```
core/
  types/
    cursor-types.ts        (new — CursorConfig, CursorPageResult, RunnableCursorPage)
    types.ts               (modified — QueryConfig union, QueryReturnType branching)
  operations/
    query/
      cursor-stream.ts     (new — applyCursor function)
  factories/
    database-effect.ts     (modified — cursor branch in queryFn)
tests/
  cursor-pagination.test.ts  (new — full test suite)
```
