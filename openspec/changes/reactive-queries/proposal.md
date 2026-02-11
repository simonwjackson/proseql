## Why

The database supports CRUD operations and file persistence, but every query is a one-shot read. Consumers who need to keep a UI, cache, or derived data structure in sync with the database must poll — repeatedly re-running the same query and diffing results. This is wasteful, error-prone, and produces stale reads between poll intervals.

The file watcher already reloads data from disk into the in-memory `Ref`, but there is no mechanism to push those changes to interested consumers. Lifecycle hooks (`onChange`) fire on mutations, but they deliver raw entity data, not re-evaluated query results. A consumer watching "all sci-fi books sorted by title" must manually reconstruct the query pipeline inside a hook callback.

Reactive queries close this gap: subscribe once with a query config, receive the evaluated result set whenever anything changes it — whether the change comes from an in-process mutation, a transaction commit, or an external file edit.

## What Changes

Introduce a `watch()` method on each collection that accepts the same query config as `findMany`/`query` and returns an Effect producing a `Stream<ReadonlyArray<T>>`. The stream emits the current result set immediately, then re-emits whenever a mutation or file reload affects the underlying collection. A PubSub carries change events from mutation sites and the file watcher to active subscriptions. Each subscription re-evaluates its query pipeline against the current `Ref` state on each relevant event, emitting only when the result set actually changes.

A `watchById(id)` convenience method watches a single entity by ID, emitting its current state and updates, with a terminal signal on deletion.

## Capabilities

### New Capabilities

- `watch(config)`: Subscribe to a query's live result set. Returns an `Effect` producing a `Stream<ReadonlyArray<T>>` that emits the initial result immediately, then re-emits on every change that affects the result set. Supports the full query pipeline: where, sort, select, limit, offset.
- `watchById(id)`: Convenience method to watch a single entity. Returns a `Stream<T | null>` that emits the entity's current state, re-emits on updates, and emits `null` on deletion.
- Change notification PubSub: Internal `PubSub<ChangeEvent>` that CRUD operations and the file watcher publish to. Each `ChangeEvent` carries the collection name and operation type. Subscriptions filter events by collection before re-evaluating.
- Debounced re-evaluation: Rapid mutations (e.g., `createMany` with 100 entities) are coalesced via a configurable debounce interval so that subscriptions emit at most once per burst rather than once per mutation.
- Transaction batching: During an active transaction, change notifications are suppressed. On commit, a single batch event is published so subscriptions emit exactly once with the final state. On rollback, no notifications are published.

### Modified Capabilities

- `create`, `createMany`, `update`, `updateMany`, `delete`, `deleteMany`, `upsert`, `upsertMany`: Each CRUD operation publishes a `ChangeEvent` to the PubSub after mutating state. This is a fire-and-forget publish that does not affect the CRUD operation's return value or error channel.
- File watcher (`createFileWatcher`): After reloading data from disk into the `Ref`, publishes a `ChangeEvent` to the PubSub so that active subscriptions re-evaluate.
- Transaction (`createTransaction` / `$transaction`): Accepts the PubSub and suppresses individual mutation notifications during the transaction. On commit, publishes a single batch event for each mutated collection.
- `createDatabase` / `buildCollection`: Accepts an optional reactive queries configuration (debounce interval) and creates the shared PubSub, threading it to CRUD operations, file watchers, and transaction factories.

## Impact

- **No breaking changes.** Reactive queries are additive. Existing databases without `watch()` calls behave identically. The PubSub is created unconditionally but costs nothing when no subscriptions exist.
- **CRUD operations** gain a PubSub publish call after mutation. This is a single `PubSub.publish` call — negligible overhead.
- **File watcher** gains a PubSub publish call after reload. Same negligible overhead.
- **Transaction system** gains notification suppression logic and a commit-time batch publish. The `mutatedCollections` set already tracks which collections were written, so this adds minimal complexity.
- **Type surface** grows: `ChangeEvent`, `Subscription`, `WatchConfig`, and the `watch`/`watchById` method signatures on `EffectCollection`. These are additive.
- **Resource management**: Each `watch()` call creates a PubSub subscription that must be cleaned up. Subscriptions are tied to Effect `Scope` — they are automatically cleaned up when the scope closes. Manual unsubscription is also supported via stream interruption.
