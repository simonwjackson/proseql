## 1. Types

- [x] 1.1 Create `core/types/cursor-types.ts` with `CursorConfig` interface (`key: string`, `after?: string`, `before?: string`, `limit: number`), `CursorPageResult<T>` interface (`items: ReadonlyArray<T>`, `pageInfo: { startCursor, endCursor, hasNextPage, hasPreviousPage }`), and `RunnableCursorPage<T, E>` type (Effect with `.runPromise` returning `Promise<CursorPageResult<T>>`)
- [x] 1.2 Update `core/types/types.ts`: extend `QueryConfig` union with two cursor variants (with/without populate) that include `cursor: CursorConfig` and exclude top-level `limit`/`offset`
- [x] 1.3 Update `core/types/types.ts`: extend `QueryReturnType` to branch on `Config extends { cursor: CursorConfig }`, returning `RunnableCursorPage` (with correct item type from populate/select logic) instead of `RunnableStream`
- [x] 1.4 Export new cursor types from `core/index.ts`

## 2. Cursor Stream Implementation

- [x] 2.1 Create `core/operations/query/cursor-stream.ts` with `applyCursor(config: CursorConfig)` function. Takes a sorted `Stream<T>` and returns `Effect<CursorPageResult<T>, ValidationError>`. Implements: cursor boundary filtering (`> after` or `< before`), `limit + 1` fetch for has-more detection, cursor value extraction via `String(record[key])`
- [x] 2.2 Implement forward pagination (after): filter to `record[key] > after`, take first `limit + 1`, set `hasNextPage` if overflow, `hasPreviousPage = true`
- [x] 2.3 Implement backward pagination (before): filter to `record[key] < before`, take last `limit + 1`, set `hasPreviousPage` if overflow, `hasNextPage = true`, maintain ascending item order
- [x] 2.4 Implement first page (no after/before): take first `limit + 1`, set `hasNextPage` if overflow, `hasPreviousPage = false`
- [x] 2.5 Handle empty results: return empty items, null cursors, both has-flags false
- [x] 2.6 Add validation: reject `after` + `before` both set, reject `limit <= 0`, validate cursor key exists on items. All produce `ValidationError`

## 3. Factory Integration

- [x] 3.1 Update `queryFn` in `core/factories/database-effect.ts`: detect `options.cursor`, branch pipeline. When cursor present: inject implicit ascending sort on cursor key if no explicit sort, validate cursor key matches primary sort field if sort is explicit
- [ ] 3.2 Implement cursor pipeline branch: filter → populate → sort → collect via `applyCursor` → apply select to collected items → package as `CursorPageResult` → wrap with `RunnableCursorPage` (`.runPromise`)
- [ ] 3.3 Ensure select is applied after cursor value extraction so projected items don't lose cursor key data
- [ ] 3.4 Update `queryFn` options type to accept `cursor?: CursorConfig` (runtime), relying on `QueryConfig` type union for compile-time mutual exclusivity with `limit`/`offset`

## 4. Tests

- [ ] 4.1 Create `tests/cursor-pagination.test.ts` with test helpers: generate N sequentially-IDed items, helper to run cursor queries against an in-memory database
- [ ] 4.2 Test forward pagination: first page returns correct items and `hasNextPage = true`, second page via `after: endCursor` returns next items, final page has `hasNextPage = false`
- [ ] 4.3 Test backward pagination: page via `before` cursor returns previous items, first page has `hasPreviousPage = false`
- [ ] 4.4 Test empty results: query matching no items returns empty items, null cursors, both has-flags false
- [ ] 4.5 Test stability: insert a record between page fetches, verify next page starts at correct cursor position without duplicates or skips
- [ ] 4.6 Test combined with `where`: cursor applies after filtering, correct subset paginated
- [ ] 4.7 Test combined with `populate`: populated fields present in cursor page items
- [ ] 4.8 Test combined with `select`: selected fields applied to page items, cursor metadata still correct
- [ ] 4.9 Test combined with explicit `sort`: cursor key must match primary sort field, results in correct order
- [ ] 4.10 Test implicit sort: omitting sort with cursor key uses ascending order
- [ ] 4.11 Test validation errors: both `after` + `before` → `ValidationError`, invalid key → `ValidationError`, `limit <= 0` → `ValidationError`, sort mismatch → `ValidationError`
- [ ] 4.12 Run full test suite (`bun test`) to verify no regressions in existing offset/limit pagination
