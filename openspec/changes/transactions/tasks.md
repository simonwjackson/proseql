## 1. Types

- [x] 1.1 Update `TransactionContext` in `core/types/crud-types.ts`: change `rollback` to `() => Effect<never, TransactionError>`, `commit` to `() => Effect<void, TransactionError>`, add `readonly mutatedCollections: ReadonlySet<string>`, add collection accessor index signature
- [x] 1.2 Add `$transaction` method signature to the database type in `core/types/types.ts`: `$transaction<A, E>(fn: (ctx: TransactionContext) => Effect<A, E>): Effect<A, E | TransactionError>`
- [x] 1.3 Export updated types from `core/types/index.ts`

## 2. Transaction Core

- [x] 2.1 Create `core/transactions/transaction.ts` with `createTransaction` factory function. Parameters: `stateRefs`, `transactionLock: Ref<boolean>`, `buildCollectionForTx` callback, optional `persistenceTrigger`. Returns `Effect<TransactionContext, TransactionError>`.
- [x] 2.2 Implement snapshot capture: on begin, `Ref.get` each collection's ReadonlyMap and store in a local `Map<string, ReadonlyMap<string, HasId>>`.
- [x] 2.3 Implement single-writer lock: use `Ref.modify` on `transactionLock` to atomically check-and-acquire. Fail with `TransactionError { operation: "begin", reason: "another transaction is already active" }` if already locked.
- [x] 2.4 Implement `commit()`: verify `isActive`, trigger `persistenceTrigger.schedule` for each collection in `mutatedCollections`, release lock via `Ref.set(transactionLock, false)`, mark inactive.
- [x] 2.5 Implement `rollback()`: verify `isActive`, restore each collection Ref to its snapshot via `Ref.set`, release lock, mark inactive. Return `Effect.fail(TransactionError { operation: "rollback" })` to short-circuit.
- [x] 2.6 Implement `isActive` as a mutable flag checked by commit/rollback/operations. Operations on inactive transaction produce `TransactionError { operation: "begin", reason: "transaction is no longer active" }`.
- [x] 2.7 Implement mutation tracking: a `Set<string>` that `afterMutation` adds collection names to instead of scheduling persistence writes.

## 3. $transaction Callback Wrapper

- [x] 3.1 Implement `$transaction(fn)` in `core/transactions/transaction.ts`: create transaction → run `fn(ctx)` → on success call `ctx.commit()` → on failure call `ctx.rollback()` then re-raise the original error.
- [x] 3.2 Handle nested transaction detection: if `transactionLock` is already held, fail with `TransactionError { operation: "begin", reason: "nested transactions not supported" }`.

## 4. Factory Integration

- [x] 4.1 Add `transactionLock: Ref<boolean>` to `createEffectDatabase` in `core/factories/database-effect.ts`. Initialize as `Ref.make(false)`.
- [x] 4.2 Create a `buildCollectionForTx` function that mirrors `buildCollection` but accepts a transaction-aware `afterMutation` that records mutations to the transaction's set instead of scheduling persistence.
- [x] 4.3 Wire `$transaction` method on the database object: call `createTransaction` with `stateRefs`, `transactionLock`, `buildCollectionForTx`, and `persistenceTrigger`.
- [x] 4.4 Update `afterMutation` in regular (non-tx) `buildCollection`: add a check against a `transactionActive` flag. If active, add collection to mutation set instead of scheduling write. (This handles the case where non-tx CRUD methods are called during a transaction via the ctx's collection accessors which share the same Refs.)

## 5. Tests — Transaction Callback

- [x] 5.1 Create `tests/transactions.test.ts` with test helpers: create a multi-collection database (users + posts with relationships)
- [x] 5.2 Test successful transaction: create user + create post in `$transaction`, both visible after commit
- [x] 5.3 Test failed transaction: create user, then fail (Effect.fail), user creation reverted
- [x] 5.4 Test explicit rollback: call `ctx.rollback()` mid-transaction, all changes reverted
- [x] 5.5 Test error preservation: original CRUD error type accessible after rollback via `catchTag`
- [x] 5.6 Test nested transaction rejection: `$transaction` inside `$transaction` → `TransactionError`

## 6. Tests — createTransaction (Manual)

- [x] 6.1 Test manual commit: `createTransaction` → operations → `commit()` → changes persist
- [x] 6.2 Test manual rollback: `createTransaction` → operations → `rollback()` → changes reverted
- [x] 6.3 Test double commit → `TransactionError`
- [x] 6.4 Test double rollback → `TransactionError`
- [x] 6.5 Test commit after rollback → `TransactionError`
- [x] 6.6 Test `mutatedCollections` tracks correct collection names
- [x] 6.7 Test `isActive` reflects correct state (true after begin, false after commit/rollback)

## 7. Tests — Snapshot Isolation

- [x] 7.1 Test read-own-writes: create entity within transaction, query sees it immediately
- [x] 7.2 Test snapshot immutability: rollback restores exact pre-transaction state including entities that were deleted during transaction
- [x] 7.3 Test lock release on commit: new transaction can begin after previous commits
- [x] 7.4 Test lock release on rollback: new transaction can begin after previous rolls back
- [x] 7.5 Test lock release on error: automatic rollback in `$transaction` releases lock
- [x] 7.6 Test concurrent transaction rejection: second `createTransaction` while first is active → `TransactionError`

## 8. Tests — Persistence Integration

- [x] 8.1 Test no persistence writes during active transaction (use a spy/mock on persistence trigger)
- [x] 8.2 Test batch persistence on commit: single save triggered per mutated collection
- [x] 8.3 Test no persistence on rollback: trigger never called after rollback

## 9. Cleanup

- [ ] 9.1 Remove or update the inert `TransactionalOptions` type if no longer needed
- [ ] 9.2 Update `BatchRelationshipOptions.transaction` to use the real transaction mechanism or remove the boolean flag
- [ ] 9.3 Run full test suite (`bun test`) to verify no regressions
- [ ] 9.4 Run type check (`bunx tsc --noEmit`) to verify no type errors
