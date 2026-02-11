## Why

Every CRUD operation mutates the in-memory dataset and persists independently. When a logical unit of work spans multiple operations (e.g., creating an order and its line items, transferring a balance between two accounts), a failure partway through leaves the dataset in an inconsistent state. The failed operations are gone, but the successful ones remain -- orphaned rows, broken foreign keys, incorrect totals.

The type system already anticipates this: `TransactionContext`, `TransactionalOptions`, `TransactionError`, and `BatchRelationshipOptions.transaction` all exist but are inert. No factory produces a `TransactionContext`, no CRUD method reads one, and no rollback logic exists. The types promise atomicity that the runtime does not deliver.

For a database that enforces relationships and foreign keys, this is a correctness gap, not a convenience gap.

## What Changes

Add a transaction factory that provides snapshot-and-restore atomicity for multi-operation writes. A transaction captures the state of affected collections before any mutations begin. If all operations succeed, the transaction commits (a no-op for in-memory; a single batched persist for file-backed databases). If any operation fails, the transaction restores every affected collection to its pre-transaction snapshot.

Persistence is deferred until commit, so a rolled-back transaction never touches disk.

## Capabilities

### New Capabilities

- `db.$transaction(fn)`: Execute a callback with an implicit transaction context. All CRUD operations within the callback operate against the live dataset. On success, changes persist atomically. On failure (thrown error or explicit `ctx.rollback()`), all mutations revert.
- `createTransaction(db)`: Lower-level factory that returns a `TransactionContext` for manual `commit()`/`rollback()` control when the callback style does not fit.
- Snapshot isolation: Reads within a transaction see the transaction's own writes. Concurrent access to the same in-memory dataset is serialized (single-writer).

### Modified Capabilities

- `wrapWithPersistence`: Persistence hooks defer writes while a transaction is active, flushing on commit instead of after each individual mutation.
- `TransactionContext` type: Gains a reference to the snapshotted collections so rollback can restore them. The existing `rollback()`, `commit()`, and `isActive` fields become functional.
- `TransactionError`: Used by the transaction factory to surface begin/commit/rollback failures through the existing `Result` error channel.

## Impact

- **Relationship operations**: `createWithRelationships`, `deleteWithRelationships`, and other multi-collection writes become safe by default when wrapped in a transaction.
- **Persistence layer**: Batching writes per-transaction instead of per-mutation reduces disk I/O and eliminates partial-write states in files shared by multiple collections.
- **Error handling**: No new error types. `TransactionError` and its type guard (`isTransactionError`) already exist and slot into `handleCrudError`.
- **Existing API**: Non-transactional usage is unchanged. All current CRUD methods continue to work identically without a transaction context.
