# Snapshot Isolation

## Overview

Defines how transactions interact with concurrent reads and writes. In this in-memory database, transactions use a single-writer model: only one transaction can be active at a time, and reads within a transaction see the transaction's own writes immediately.

## Isolation Model

### Read-Own-Writes

Within an active transaction, all reads (queries, findById) see mutations made earlier in the same transaction. There is no read snapshot — the transaction operates directly on the live Ref state. This means:

```typescript
yield* ctx.users.create({ id: "u1", name: "Alice", ... })
const result = yield* ctx.users.findById("u1")
// result is the entity just created
```

This is the simplest model and matches user expectations for an in-memory database.

### Single-Writer Serialization

Only one transaction can be active at a time across the entire database. If a second `$transaction` or `createTransaction` call is made while a transaction is active, it produces a `TransactionError` with `operation: "begin"` and `reason: "another transaction is already active"`.

This eliminates all concurrency hazards (dirty reads, lost updates, write skew) at the cost of throughput. For an in-memory/file-backed database, this tradeoff is appropriate — transactions are expected to be short-lived.

### Non-Transactional Operations

CRUD operations outside a transaction are unaffected. They read and write Refs directly as today. If a transaction is active, non-transactional operations still see the live Ref state (including uncommitted transaction writes). This is acceptable because:

1. The single-writer lock prevents concurrent transactions
2. Non-transactional writes during a transaction are a caller bug (mixing transactional and non-transactional writes to the same data)
3. Adding a read lock for non-transactional operations adds complexity without clear benefit for the in-memory use case

Document this as a known limitation: avoid mixing transactional and non-transactional writes to the same collections concurrently.

## Snapshot Mechanics

### Capture

At transaction begin, for each collection:

```typescript
const snapshot = yield* Ref.get(ref)
// snapshot is ReadonlyMap<string, T> — an immutable reference
```

Since `ReadonlyMap` is immutable and Ref updates replace the entire map (via `new Map(map)`), the snapshot is automatically isolated from future mutations. No deep cloning needed.

### Restore

On rollback:

```typescript
yield* Ref.set(ref, snapshot)
```

This replaces the current map entirely. Any entities created, updated, or deleted during the transaction are gone.

### Scope

Snapshots are captured for **all** collections at transaction begin, not just collections that will be mutated. This is simpler and avoids the problem of a transaction accessing a collection it didn't anticipate at begin time. The memory cost is negligible — snapshots are references to existing immutable maps, not copies.

## Transaction Lock

The single-writer lock is implemented as a `Ref<boolean>` (or `Ref<Option<TransactionId>>`) at the database level:

```typescript
const transactionLock: Ref<boolean>
```

- `createTransaction` checks the lock via `Ref.get`. If locked, fail with `TransactionError`.
- On begin: `Ref.set(lock, true)`
- On commit/rollback: `Ref.set(lock, false)`

The lock is checked and set atomically via `Ref.modify` to prevent race conditions in the (unlikely but possible) case of concurrent Effect fibers.

## Tests

- Read-own-writes: create within transaction, query sees it immediately
- Single-writer: concurrent `$transaction` calls → second one fails with `TransactionError`
- Snapshot immutability: rollback restores exact pre-transaction state including deleted entities
- Non-transactional reads during transaction: see live state (including uncommitted writes)
- Lock release on commit: new transaction can begin after previous commits
- Lock release on rollback: new transaction can begin after previous rolls back
- Lock release on error: automatic rollback releases lock even on unhandled errors
