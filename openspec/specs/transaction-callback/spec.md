# Transaction Callback ($transaction)

## Overview

`db.$transaction(fn)` executes a callback within an atomic transaction context. All CRUD operations inside the callback operate against the live in-memory state. On success, changes are committed and persistence is triggered as a single batch. On failure (error thrown or explicit rollback), all mutations are reverted to their pre-transaction state and nothing is persisted.

## API

```typescript
db.$transaction<A, E>(
  fn: (ctx: TransactionContext) => Effect<A, E>
): Effect<A, E | TransactionError>
```

- `fn` receives a `TransactionContext` that provides the same collection accessors as `db` but scoped to the transaction.
- The return value of `fn` becomes the return value of the transaction.
- If `fn` fails (via Effect error channel), the transaction rolls back automatically.
- If `fn` succeeds, the transaction commits automatically.
- Explicit `ctx.rollback()` inside `fn` triggers immediate rollback and short-circuits with a `TransactionError`.

### TransactionContext Shape

```typescript
interface TransactionContext {
  // Same collection accessors as the database
  readonly [collectionName: string]: SmartCollection<...>

  // Manual control
  readonly rollback: () => Effect<never, TransactionError>
  readonly commit: () => Effect<void, TransactionError>
  readonly isActive: boolean
}
```

- Collection accessors on `ctx` use the same Ref state as the database — mutations are visible immediately within the transaction.
- `rollback()` restores all snapshots and marks the transaction inactive.
- `commit()` is called automatically on success — manual `commit()` is rarely needed but available for advanced patterns.
- Calling any operation after rollback/commit produces a `TransactionError` with `operation: "begin"` and `reason: "transaction is no longer active"`.

## Behavior

### Lifecycle

1. **Begin**: Snapshot all collection Refs (`Ref.get` each collection's `ReadonlyMap`) before `fn` executes.
2. **Execute**: Run `fn(ctx)`. All CRUD operations mutate Refs normally. Persistence hooks are suppressed (no debounced saves fire during the transaction).
3. **Commit (success)**: Trigger a single batched persistence save for all collections that were mutated. Clear the snapshot.
4. **Rollback (failure)**: Restore each collection Ref to its snapshot via `Ref.set`. No persistence is triggered.

### Persistence Deferral

While a transaction is active, the `afterMutation` callback on CRUD methods must not schedule persistence writes. Instead, the transaction tracks which collections were mutated. On commit, it triggers saves for exactly those collections.

This prevents partial writes during a multi-step transaction and reduces I/O by coalescing multiple mutations into a single write per collection.

### Error Propagation

- Errors from CRUD operations within `fn` propagate through the Effect error channel.
- The transaction catches any error, performs rollback, then re-raises the original error.
- `TransactionError` is added to the error channel for transaction-level failures (begin, commit, rollback failures).
- The original error type `E` from `fn` is preserved — the caller can still `catchTag` specific CRUD errors.

### Nesting

Nested `$transaction` calls are not supported. If `fn` calls `db.$transaction` again, the inner call produces a `TransactionError` with `operation: "begin"` and `reason: "nested transactions not supported"`.

## Tests

- Successful transaction: multiple creates across collections, all visible after commit
- Failed transaction: create then error, all mutations reverted
- Explicit rollback: `ctx.rollback()` reverts changes
- Persistence: no writes during transaction, single batch write on commit
- Rollback persistence: no writes triggered after rollback
- Error preservation: original CRUD error type is accessible after rollback
- Nested transaction: inner `$transaction` produces `TransactionError`
- Operations after rollback: produce `TransactionError`
