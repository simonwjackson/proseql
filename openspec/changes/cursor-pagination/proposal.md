## Why

Offset/limit pagination is positionally fragile. When records are inserted or deleted between page fetches, items shift -- causing duplicates on the next page or skipped records that silently disappear. This is unavoidable with offset-based addressing because the offset refers to a position in a result set that may have changed.

Cursor-based pagination anchors each page request to a specific record's sort key value rather than a numeric position. The page after a given cursor always starts from the correct place regardless of what was added or removed elsewhere in the collection. This is the correct primitive for any UI that paginates through data that may be modified concurrently (feeds, lists, background syncs).

## What Changes

Extend `QueryConfig` to accept a cursor-based pagination mode alongside the existing `limit`/`offset`. A query specifies a sort field as the cursor key, a direction (`after` or `before` a given cursor value), and a `limit`. The return shape includes the result items plus cursor metadata (`startCursor`, `endCursor`, `hasNextPage`, `hasPreviousPage`) so callers can request the next or previous page without computing offsets.

Cursor-based and offset-based pagination are mutually exclusive on the same query. Specifying both is a type error.

## Capabilities

### New Capabilities

- `cursor`: Query option specifying cursor-based pagination (`after`/`before` cursor value, `limit`, and sort key). Returns a page result with items and cursor metadata for forward and backward traversal.

### Modified Capabilities

- `QueryConfig`: Extended as a discriminated union so `cursor` and `offset` cannot coexist on the same query. Existing `limit`/`offset` queries are unchanged.
- `query()`: When `cursor` is provided, returns a page result object (items + cursor metadata) instead of a bare `AsyncIterable`.

## Impact

- **Types**: `QueryConfig` gains a new union variant. `QueryReturnType` branches on cursor presence.
- **Query engine**: Needs to filter based on sort-key comparison (`>` / `<` the cursor value) instead of positional skip, then apply limit + 1 to detect `hasNextPage`.
- **Existing behavior**: Zero breaking changes. Offset/limit queries continue to work identically.
- **Tests**: New test suite for cursor pagination covering forward/backward traversal, stability under concurrent mutation, combination with `where`/`sort`/`populate`/`select`.
