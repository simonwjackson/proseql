## Why

The current foundation — hand-rolled Result types, a monolithic query closure, mutable arrays behind closures, Zod for one-way validation, and AsyncIterable as the query return type — has reached its architectural ceiling. The type system is already buckling (5+ `as unknown as` casts in database.ts, skipped type tests, a 792-line conditional type file). Every planned feature (aggregations, transactions, cursor pagination, hooks) would add more branching to an already-monolithic query function and more conditional types to an already-strained type system.

Effect provides a coherent replacement for each of these layers simultaneously: Schema for bidirectional encode/decode, Stream for composable query pipelines, typed error channels for the currently-silent read path, Ref for atomic state management, and Layer/Service for dependency injection. Migrating now — before building features on the current foundation — avoids building on top of known architectural limitations.

## What Changes

- **Schema layer**: Replace Zod with Effect Schema. Schemas gain bidirectional encode/decode (critical for file persistence round-trips), composable transforms (enables schema migrations natively), and branded/nominal types.
- **Error model**: Replace hand-rolled `Result<T, CrudError>` and tagged union errors with Effect's typed error channel (`Effect<A, E, R>`). Extend error typing to the query/read path, which currently has no error model at all.
- **Query pipeline**: Replace the monolithic 130-line query closure (`database.ts:240-387`) with Effect `Stream` composition. Filter, populate, sort, paginate, and select become composable pipeline stages instead of sequential blocks in one function.
- **State management**: Replace mutable arrays accessed via `getCollectionData`/`setCollectionData` closures with `Ref<T>`. This gives atomic updates, change tracking, and a foundation for transactions without a custom implementation.
- **Persistence layer**: Replace manual debounce timers and file watcher cleanup with Effect `Schedule` (debounce/retry), `acquireRelease` (resource lifecycle), and `Fiber` (file watching). StorageAdapter and SerializerRegistry become Effect Services with Layer-based composition.
- **Async utilities**: Remove `collect`, `collectLimit`, `count`, `first`, `map` from `async-iterable.ts` — these are built into Effect Stream.
- **Public API surface**: Consumer code works with `Effect<A, E, R>` and `Stream<A, E, R>` instead of `Promise<Result<T, E>>` and `AsyncIterable<T>`. This is a **BREAKING** change to every consumer.

## Capabilities

### New Capabilities

- `effect-schema`: Effect Schema definitions replacing Zod, with bidirectional encode/decode for persistence and composable transforms for migrations. Covers all current entity schemas plus the config/relationship definition layer.
- `effect-query-pipeline`: Stream-based composable query pipeline replacing the monolithic query closure. Each stage (filter, populate, sort, select, paginate) is an independent combinator. This is the structural prerequisite for aggregation-queries and cursor-pagination changes.
- `effect-error-model`: Typed error channel covering both CRUD mutations and queries/reads. Replaces the hand-rolled Result type and tagged union errors. Adds error reporting to the read path (dangling foreign keys, missing collections, population failures) which currently degrades silently.
- `effect-state-management`: Ref-based collection state replacing mutable array closures. Provides atomic reads/writes, change notification (foundation for lifecycle-hooks change), and snapshot capability (foundation for transactions change).
- `effect-persistence`: Effect Service/Layer-based persistence replacing manual wiring. StorageAdapter and SerializerRegistry as Services. Schedule-based debounced writes. Managed resource lifecycle for file watchers.
- `effect-database-factory`: New `createDatabase` factory returning an Effect that produces the database. Layer-based dependency injection for storage, serializers, and configuration.

### Modified Capabilities

_(No existing specs to modify — openspec/specs/ is empty)_

## Impact

- **BREAKING**: Every consumer-facing API changes. `query()` returns `Stream<T, E, R>` not `AsyncIterable<T>`. CRUD methods return `Effect<T, E, R>` not `Promise<Result<T, E>>`. `createDatabase` returns `Effect<DB, E, R>` not `DB | Promise<DB>`.
- **Dependencies**: Add `effect` as a core dependency. Remove `zod`.
- **Affected code**: Every file in `core/` is affected. The type system (`types/`), factories, operations, storage, serializers, validators, and utilities all change.
- **Test suite**: All 24 test files need rewriting to work with Effect's test utilities (`Effect.runPromise`, `Stream.runCollect`, etc.).
- **Examples**: All 15 example files need rewriting.
- **Downstream changes**: The `aggregation-queries`, `cursor-pagination`, `transactions`, and `lifecycle-hooks` proposals become significantly simpler to implement on this foundation. `transactions` may become trivial (Ref snapshots). `lifecycle-hooks` may be partially solved by Effect middleware patterns.
