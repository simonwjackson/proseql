# Reactive Queries — Design

## Architecture

### New Modules

**`core/reactive/change-event.ts`** — `ChangeEvent` type definition: `{ readonly collection: string; readonly operation: "create" | "update" | "delete" | "reload" }`. Factory functions for creating events. The `"reload"` operation covers file watcher reloads.

**`core/reactive/change-pubsub.ts`** — Creates and manages the shared `PubSub<ChangeEvent>`. Exports `createChangePubSub()` which returns an `Effect` producing a `PubSub.PubSub<ChangeEvent>`. The PubSub is unbounded (dropping change events is not acceptable — subscriptions must see all relevant changes to maintain correctness).

**`core/reactive/watch.ts`** — Core `watch()` implementation. Takes a PubSub, a collection `Ref`, a collection name, and a query config. Returns an `Effect` producing a `Stream<ReadonlyArray<T>>`. Internally: subscribes to the PubSub, filters events to the relevant collection, debounces, re-evaluates the query pipeline against the current `Ref` state, deduplicates consecutive identical results, and emits.

**`core/reactive/watch-by-id.ts`** — `watchById()` implementation. Thin wrapper over `watch()` with a `where: { id }` filter that maps the result array to `T | null`.

**`core/types/reactive-types.ts`** — All reactive query types: `ChangeEvent`, `WatchConfig<T>`, and the `watch`/`watchById` method signatures.

### Modified Modules

**`core/operations/crud/create.ts`**, **`update.ts`**, **`delete.ts`**, **`upsert.ts`** — Each CRUD function gains an optional `changePubSub` parameter. After state mutation (and after hooks), publishes a `ChangeEvent` to the PubSub. The publish is fire-and-forget (`Effect.fork` or `PubSub.publish` without awaiting subscriber processing).

**`core/storage/persistence-effect.ts`** — `createFileWatcher` gains an optional `changePubSub` parameter. After reloading data from disk into the `Ref`, publishes a `ChangeEvent` with `operation: "reload"`.

**`core/transactions/transaction.ts`** — `createTransaction` gains a `changePubSub` parameter. During the transaction, CRUD operations are given a suppressed/no-op PubSub (or a flag to skip publishing). On commit, iterates `mutatedCollections` and publishes one `ChangeEvent` per collection. On rollback, publishes nothing.

**`core/factories/database-effect.ts`** — `buildCollection` creates the shared PubSub (one per database), passes it to CRUD factories, file watcher, and transaction factory. Adds `watch` and `watchById` methods to the `EffectCollection` interface.

**`core/factories/crud-factory.ts`**, **`crud-factory-with-relationships.ts`** — Thread the PubSub through to the underlying CRUD operation calls.

## Key Decisions

### PubSub for mutation notifications

Effect's `PubSub` is the right primitive because it supports multiple subscribers with independent consumption. Each `watch()` call creates its own subscription to the shared PubSub. This decouples producers (CRUD operations, file watcher) from consumers (watch subscriptions) — producers do not need to know how many subscriptions exist or what queries they represent.

### Stream for subscription delivery

Effect `Stream` is the natural choice for delivering an ordered sequence of result sets over time. Streams compose with Effect's resource management (Scope-based cleanup), support operators like `debounce` and `changes` (deduplication), and integrate cleanly with both Effect-native consumers and callback-based consumers (via `Stream.runForEach`).

### Debounced re-evaluation

Re-evaluating a query on every single mutation is wasteful when mutations arrive in bursts (e.g., `createMany` inserting 100 entities fires 100 change events). Debouncing coalesces these into a single re-evaluation after the burst settles. The debounce interval is configurable per database (default 10ms — fast enough for interactive use, long enough to batch typical burst patterns).

### Transaction batching (suppress notifications until commit)

During a transaction, mutations are tentative — they may be rolled back. Publishing change events for tentative mutations would cause subscriptions to emit intermediate states that are then reverted, producing confusing flicker. Instead, individual mutation notifications are suppressed during a transaction. On commit, a single batch event is published for each mutated collection. On rollback, nothing is published — subscribers never see the tentative state.

Implementation: the transaction passes a no-op PubSub (or sets a suppression flag) to CRUD operations created via `buildCollectionForTx`. The real PubSub is held by the transaction context and used only at commit time.

### watchById as convenience over watch

`watchById(id)` is a thin wrapper: `watch({ where: { id } }).pipe(Stream.map(results => results[0] ?? null))`. It does not have a separate implementation. This keeps the core logic in one place and ensures `watchById` benefits from the same debouncing, deduplication, and resource management as `watch`.

### Relevance filtering (only re-evaluate when affected collection changes)

Each `ChangeEvent` carries a `collection` name. Subscriptions filter events by collection before re-evaluating. A mutation to the `authors` collection does not trigger re-evaluation of a `books` subscription. This is a coarse filter — it does not check whether the mutated entity matches the query's `where` clause (that would require maintaining a reverse index of which entities match which queries, adding significant complexity for marginal benefit). Instead, the re-evaluation runs the full query pipeline, and deduplication suppresses the emission if the result set is unchanged.

### Scope-based cleanup

Each `watch()` call subscribes to the PubSub. This subscription must be cleaned up to avoid memory leaks. The subscription is tied to an Effect `Scope` via `Effect.acquireRelease`: acquiring subscribes to the PubSub, releasing unsubscribes. When the database shuts down (Scope closes), all subscriptions are automatically cleaned up. Consumers can also interrupt the stream to unsubscribe early.

## File Layout

```
core/
  reactive/
    change-event.ts              (new — ChangeEvent type and factory functions)
    change-pubsub.ts             (new — createChangePubSub)
    watch.ts                     (new — watch() implementation)
    watch-by-id.ts               (new — watchById() implementation)
  types/
    reactive-types.ts            (new — ChangeEvent, WatchConfig, method signatures)
    database-config-types.ts     (modified — add reactive config options)
  operations/
    crud/
      create.ts                  (modified — publish ChangeEvent after mutation)
      update.ts                  (modified — publish ChangeEvent after mutation)
      delete.ts                  (modified — publish ChangeEvent after mutation)
      upsert.ts                  (modified — publish ChangeEvent after mutation)
  storage/
    persistence-effect.ts        (modified — file watcher publishes ChangeEvent on reload)
  transactions/
    transaction.ts               (modified — suppress notifications, batch on commit)
  factories/
    database-effect.ts           (modified — create PubSub, add watch/watchById to collections)
    crud-factory.ts              (modified — thread PubSub to CRUD operations)
    crud-factory-with-relationships.ts (modified — thread PubSub to CRUD operations)
tests/
  reactive-queries.test.ts       (new — full test suite)
```
