# createTransaction Factory

## Overview

Lower-level transaction factory that returns a `TransactionContext` for manual commit/rollback control. Use this when the callback style of `db.$transaction(fn)` doesn't fit — for example, when the transaction scope spans multiple async boundaries or when commit/rollback decisions depend on external conditions.

## API

```typescript
const createTransaction = (
  db: Database,
  stateRefs: Record<string, Ref<ReadonlyMap<string, HasId>>>,
  persistenceTrigger?: PersistenceTrigger,
): Effect<TransactionContext, TransactionError>
```

Returns a `TransactionContext` that must be explicitly committed or rolled back by the caller.

### TransactionContext

```typescript
interface TransactionContext {
  // Collection accessors — same interface as db.collectionName
  readonly [collectionName: string]: SmartCollection<...>

  // Lifecycle
  readonly commit: () => Effect<void, TransactionError>
  readonly rollback: () => Effect<void, TransactionError>
  readonly isActive: boolean

  // Introspection
  readonly mutatedCollections: ReadonlySet<string>
}
```

- `commit()` finalizes changes, triggers persistence for mutated collections, marks transaction inactive.
- `rollback()` restores all snapshots, marks transaction inactive, triggers no persistence.
- `isActive` reflects whether the transaction is still open.
- `mutatedCollections` tracks which collections have been written to during the transaction.
- Calling `commit()` or `rollback()` on an inactive transaction produces `TransactionError` with `operation` set accordingly and `reason: "transaction is no longer active"`.

## Behavior

### Begin

When `createTransaction` is called:

1. Capture a snapshot of every collection Ref via `Ref.get`.
2. Suppress persistence hooks (set a transaction-active flag that `afterMutation` checks).
3. Return the `TransactionContext` with collection accessors pointing to the live Refs.

### Commit

1. Verify transaction is still active.
2. Trigger persistence saves for each collection in `mutatedCollections`.
3. Clear snapshots and mark transaction inactive.
4. Re-enable persistence hooks.

### Rollback

1. Verify transaction is still active.
2. Restore each collection Ref to its snapshot via `Ref.set`.
3. Clear snapshots and mark transaction inactive.
4. Re-enable persistence hooks.

### Abandoned Transactions

If a `TransactionContext` goes out of scope without commit or rollback, the mutations remain in the live Refs but persistence hooks remain suppressed. This is a bug in the caller's code. To mitigate, the `$transaction` callback API (see transaction-callback spec) handles this automatically — `createTransaction` is the escape hatch for advanced use cases.

An `Effect.acquireRelease` pattern could be used to auto-rollback on scope exit, but this adds complexity. For v1, document the requirement to always commit or rollback.

## Relationship to $transaction

`db.$transaction(fn)` is implemented in terms of `createTransaction`:

```
$transaction(fn) =
  createTransaction(db, stateRefs, trigger)
    .pipe(
      Effect.flatMap(ctx =>
        fn(ctx).pipe(
          Effect.tap(() => ctx.commit()),
          Effect.catchAll(err => ctx.rollback().pipe(Effect.flatMap(() => Effect.fail(err))))
        )
      )
    )
```

This keeps the transaction logic in one place with `$transaction` as a convenience wrapper.

## Tests

- Create transaction, perform operations, commit → changes persist
- Create transaction, perform operations, rollback → changes reverted
- Double commit → `TransactionError`
- Double rollback → `TransactionError`
- Commit after rollback → `TransactionError`
- `mutatedCollections` tracks which collections were written to
- `isActive` reflects correct state throughout lifecycle
