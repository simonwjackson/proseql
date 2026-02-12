## 1. Types

- [x] 1.1 Create `core/types/reactive-types.ts` with `ChangeEvent`: `{ readonly collection: string; readonly operation: "create" | "update" | "delete" | "reload" }`
- [x] 1.2 Define `WatchConfig<T>` type mirroring the existing query config (where, sort, select, limit, offset)
- [x] 1.3 Add `watch` and `watchById` method signatures to the collection interface types
- [x] 1.4 Add optional `readonly reactive?: { readonly debounceMs?: number }` to database config in `core/types/database-config-types.ts`
- [x] 1.5 Export new types from `core/index.ts`

## 2. Change Notification PubSub

- [x] 2.1 Create `core/reactive/change-pubsub.ts` with `createChangePubSub()`: returns `Effect.Effect<PubSub.PubSub<ChangeEvent>>` using `PubSub.unbounded()`
- [x] 2.2 Create `core/reactive/change-event.ts` with factory functions: `createChangeEvent(collection, operation)`, `reloadEvent(collection)`

## 3. Watch Implementation

- [x] 3.1 Create `core/reactive/watch.ts` with `watch(pubsub, ref, collectionName, config)`: subscribe to PubSub, filter by collection, debounce, re-evaluate query, deduplicate, emit as Stream
- [x] 3.2 Initial emission: the stream emits the current result set immediately upon subscription (before waiting for any change events)
- [x] 3.3 Apply the full query pipeline on each re-evaluation: filter, sort, select, paginate (reuse existing query functions)
- [x] 3.4 Deduplicate consecutive identical result sets to avoid spurious emissions (compare serialized results or use structural equality)

## 4. Query Re-evaluation Pipeline

- [x] 4.1 Extract a reusable `evaluateQuery(ref, config)` function that reads the current Ref state and runs the query pipeline (filter, sort, select, limit/offset)
- [x] 4.2 Ensure `evaluateQuery` returns `ReadonlyArray<T>` (not a Stream or cursor — watch delivers complete result snapshots)

## 5. Mutation Integration (CRUD publishes events)

- [x] 5.1 Add optional `changePubSub?: PubSub.PubSub<ChangeEvent>` parameter to `create` in `core/operations/crud/create.ts`. After state mutation and hooks, publish `ChangeEvent` with `operation: "create"`.
- [x] 5.2 Same for `createMany`: publish a single event after all entities are inserted (not per entity)
- [x] 5.3 Add `changePubSub` parameter to `update` in `core/operations/crud/update.ts`. Publish with `operation: "update"` after mutation.
- [x] 5.4 Same for `updateMany`: publish a single event after all updates
- [x] 5.5 Add `changePubSub` parameter to `delete` in `core/operations/crud/delete.ts`. Publish with `operation: "delete"` after mutation.
- [x] 5.6 Same for `deleteMany`: publish a single event after all deletes
- [x] 5.7 Add `changePubSub` parameter to `upsert` and `upsertMany` in `core/operations/crud/upsert.ts`. Publish appropriate event after mutation.

## 6. File Watcher Integration

- [x] 6.1 Modify `createFileWatcher` in `core/storage/persistence-effect.ts` to accept optional `changePubSub` parameter
- [x] 6.2 After reloading data from disk into the Ref, publish `ChangeEvent` with `operation: "reload"` to the PubSub

## 7. Transaction Batching

- [x] 7.1 Modify `createTransaction` in `core/transactions/transaction.ts` to accept `changePubSub` parameter
- [x] 7.2 During transaction: pass a no-op PubSub (or suppression flag) to CRUD operations created via `buildCollectionForTx` so individual mutations do not publish events
- [x] 7.3 On commit: iterate `mutatedCollections` and publish one `ChangeEvent` per collection to the real PubSub
- [x] 7.4 On rollback: publish nothing (subscribers never see tentative state)

## 8. Debouncing

- [x] 8.1 In `watch()`, apply debouncing to the change event stream before re-evaluation. Use configurable interval from database reactive config (default 10ms).
- [x] 8.2 Ensure debounce coalesces multiple events for the same collection into a single re-evaluation

## 9. watchById

- [x] 9.1 Create `core/reactive/watch-by-id.ts` implementing `watchById(pubsub, ref, collectionName, id)` as a thin wrapper over `watch()` with `where: { id }`, mapping results to `T | null`
- [x] 9.2 Emit `null` when the entity is deleted (result array becomes empty)

## 10. Scope Cleanup

- [x] 10.1 In `watch()`, use `Effect.acquireRelease` to subscribe to the PubSub on acquire and unsubscribe on release, tying the subscription lifetime to the enclosing Scope
- [x] 10.2 Ensure stream interruption triggers cleanup (unsubscribe from PubSub)

## 11. Factory Integration

- [x] 11.1 In `core/factories/database-effect.ts` `buildCollection`: create a single shared `PubSub<ChangeEvent>` per database
- [x] 11.2 Pass the PubSub to all CRUD factory function calls
- [x] 11.3 Pass the PubSub to file watcher creation
- [x] 11.4 Pass the PubSub to transaction factory
- [x] 11.5 Add `watch(config)` and `watchById(id)` methods to the `EffectCollection` interface and wire them to the implementations
- [x] 11.6 In `crud-factory.ts` and `crud-factory-with-relationships.ts`, thread the PubSub through to underlying CRUD calls

## 12. Tests — Basic Watch

- [x] 12.1 Create `tests/reactive-queries.test.ts` with test helpers: database with a hooked collection, PubSub, and Scope
- [x] 12.2 Test `watch()` emits the current result set immediately on subscription
- [x] 12.3 Test `watch()` with full query config (where, sort, select, limit) applies the pipeline correctly on initial emission
- [x] 12.4 Test `watch()` stream can be consumed via `Stream.take` and `Stream.runCollect`

## 13. Tests — Mutation Triggers

- [x] 13.1 Test create triggers watch: inserting a matching entity causes a new emission with the entity included
- [x] 13.2 Test update triggers watch: updating a matched entity causes a new emission with the updated entity
- [ ] 13.3 Test delete triggers watch: deleting a matched entity causes a new emission without the entity
- [ ] 13.4 Test entity entering result set: updating a non-matching entity to match the where clause triggers emission
- [ ] 13.5 Test entity leaving result set: updating a matching entity to no longer match triggers emission

## 14. Tests — Irrelevant Mutations

- [ ] 14.1 Test mutation to a different collection does not trigger re-evaluation
- [ ] 14.2 Test mutation that does not change the result set (e.g., creating a non-matching entity) does not produce a new emission (deduplication)

## 15. Tests — Transactions

- [ ] 15.1 Test transaction: no emissions during transaction (intermediate states suppressed)
- [ ] 15.2 Test transaction commit: exactly one emission with the final state after commit
- [ ] 15.3 Test transaction rollback: no emissions (state unchanged)

## 16. Tests — File Changes

- [ ] 16.1 Test file watcher reload triggers watch emission when result set changes
- [ ] 16.2 Test file watcher reload does not emit when result set is unchanged (deduplication)

## 17. Tests — Debounce

- [ ] 17.1 Test rapid mutations (e.g., 50 creates in a loop) produce at most one emission after debounce settles
- [ ] 17.2 Test configurable debounce interval is respected

## 18. Tests — Unsubscribe and Cleanup

- [ ] 18.1 Test stream interruption stops emissions and cleans up the PubSub subscription
- [ ] 18.2 Test Scope closure cleans up all active subscriptions
- [ ] 18.3 Test `watchById` emits entity state, re-emits on update, emits null on deletion

## 19. Cleanup

- [ ] 19.1 Run full test suite (`bun test`) to verify no regressions
- [ ] 19.2 Run type check (`bunx tsc --noEmit`) to verify no type errors
- [ ] 19.3 Run lint (`biome check .`) to verify no lint errors
