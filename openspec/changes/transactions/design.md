# Transactions — Design

## Architecture

### New Module

**`core/transactions/transaction.ts`** — Core transaction logic: `createTransaction` factory, snapshot capture, rollback restore, commit with persistence flush, and the single-writer lock. Also exports the `$transaction` callback convenience wrapper.

### Modified Modules

**`core/factories/database-effect.ts`** — The database object gains a `$transaction` method. The factory passes `stateRefs`, `persistenceTrigger`, and a `transactionLock` Ref to the transaction module. The `afterMutation` callback gains a check: if a transaction is active, track the collection name as mutated instead of scheduling a persistence write.

**`core/types/crud-types.ts`** — `TransactionContext` type is updated to reflect the actual runtime shape: collection accessors, `commit()`, `rollback()`, `isActive`, `mutatedCollections`.

**`core/types/types.ts`** — The `GenerateDatabase` / database return type gains `$transaction` method.

## Key Decisions

### Operate on live Refs, not shadow copies

The transaction operates directly on the database's live `Ref<ReadonlyMap>` state. Mutations are immediately visible to subsequent reads within the transaction (read-own-writes). On rollback, `Ref.set` restores the snapshot.

Alternative considered: create shadow Ref copies, merge on commit. This is more isolated but significantly more complex — every CRUD function would need to accept an alternate Ref, and relationship validation across collections becomes ambiguous (which Ref to check). The live-Ref approach is simpler and correct for a single-writer model.

### Single-writer lock via Ref<boolean>

A `Ref<boolean>` at the database level gates transaction creation. `Ref.modify` provides atomic check-and-set. This prevents two concurrent fibers from both starting transactions.

This is intentionally simple. A queue or semaphore would allow waiting for the lock, but waiting adds complexity and makes transaction performance unpredictable. Fail-fast is better: the caller retries or restructures.

### Persistence deferral via afterMutation gating

Currently, `afterMutation` calls `trigger.schedule(collectionName)` to schedule debounced writes. During a transaction:

1. A `Ref<boolean>` flag (`transactionActive`) is checked by `afterMutation`.
2. If active, `afterMutation` adds the collection name to a `Ref<Set<string>>` of mutated collections instead of scheduling a write.
3. On commit, the transaction reads the mutated set and calls `trigger.schedule` for each.
4. On rollback, the mutated set is discarded.

This reuses the existing persistence trigger infrastructure — no new persistence code needed.

### Snapshot all collections, not just anticipated ones

Snapshots are captured for every collection at transaction begin. This is O(n) Ref reads where n is the number of collections, but each read is O(1) — it just copies the ReadonlyMap reference. The alternative (lazy snapshotting on first access) saves almost nothing and introduces the risk of missing a collection that gets mutated unexpectedly via relationship cascades.

### $transaction implemented via createTransaction

```
$transaction(fn) =
  acquireTransaction()
    → fn(ctx)
    → commit on success / rollback+rethrow on failure
```

This is a thin wrapper: acquire, run, finalize. The `createTransaction` factory does the real work. Both are exported so users can choose callback or manual style.

### TransactionContext provides collection accessors, not the raw db

The `ctx` object returned to the `$transaction` callback has the same `ctx.users.create(...)` shape as `db.users.create(...)`. Internally these point to the same CRUD functions backed by the same Refs. The difference is that `afterMutation` is routed through the transaction's mutation tracking instead of the persistence trigger.

Implementation: `buildCollection` in the factory already creates CRUD wrappers. For the transaction context, we create a new set of wrappers with a transaction-aware `afterMutation` that records mutations instead of persisting. This means `buildCollection` needs to accept an `afterMutation` parameter (it already does — just pass a different one).

### Error channel

`$transaction` adds `TransactionError` to the error channel but preserves the inner `E`:

```typescript
Effect<A, E | TransactionError>
```

If the inner function fails with a CRUD error, rollback happens, then the CRUD error is re-raised. The caller can `catchTag` either CRUD errors or `TransactionError` independently.

## Concurrency Model

- One active transaction at a time per database instance.
- Non-transactional operations are not blocked — they see live state including uncommitted writes.
- This is documented as a known limitation: don't mix transactional and non-transactional writes to the same collections.

## File Layout

```
core/
  transactions/
    transaction.ts          (new — createTransaction, $transaction, snapshot/restore)
  types/
    crud-types.ts           (modified — TransactionContext shape)
    types.ts                (modified — database type gains $transaction)
  factories/
    database-effect.ts      (modified — wire transactionLock, $transaction, afterMutation gating, makeBuildCollectionForTx)
tests/
  transactions.test.ts      (new — full test suite)
```
