/**
 * Transaction support for atomic multi-collection operations.
 *
 * `createTransaction` returns a TransactionContext with collection accessors,
 * commit/rollback methods, and mutation tracking. Mutations are visible
 * immediately within the transaction (read-own-writes) and either committed
 * atomically or rolled back to pre-transaction state.
 *
 * `$transaction` is a callback wrapper that auto-commits on success and
 * auto-rolls back on failure.
 */

import { Effect, Ref } from "effect"
import { TransactionError } from "../errors/crud-errors.js"
import type { TransactionContext } from "../types/crud-types.js"
import type { EffectCollection } from "../factories/database-effect.js"

// ============================================================================
// Types
// ============================================================================

type HasId = { readonly id: string }

/**
 * Internal ref map type used for cross-collection references.
 */
type StateRefs = Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>

/**
 * Persistence trigger interface for scheduling debounced saves.
 */
interface PersistenceTrigger {
	/** Schedule a debounced save for the given key */
	readonly schedule: (key: string) => void
}

/**
 * Callback type for building a collection with transaction-aware afterMutation.
 * The afterMutation adds the collection name to the mutation set instead of
 * scheduling a persistence write.
 */
type BuildCollectionForTx = (
	collectionName: string,
	addMutation: (name: string) => void,
) => EffectCollection<HasId>

// ============================================================================
// createTransaction Factory
// ============================================================================

/**
 * Create a new transaction context.
 *
 * Parameters:
 * - stateRefs: The database's collection Refs (will be snapshotted and potentially restored)
 * - transactionLock: Single-writer lock Ref (prevents concurrent transactions)
 * - buildCollectionForTx: Callback to create collection accessors with transaction-aware mutations
 * - persistenceTrigger: Optional trigger for scheduling saves on commit
 *
 * Returns an Effect that yields a TransactionContext. The context provides:
 * - Collection accessors with the same interface as db.collectionName
 * - commit() to finalize changes and trigger persistence
 * - rollback() to restore snapshots and discard changes
 * - isActive to check if transaction is still open
 * - mutatedCollections to see which collections were written to
 *
 * On failure (e.g., lock already held), returns TransactionError.
 */
export const createTransaction = <DB extends Record<string, EffectCollection<HasId>>>(
	stateRefs: StateRefs,
	transactionLock: Ref.Ref<boolean>,
	buildCollectionForTx: BuildCollectionForTx,
	persistenceTrigger?: PersistenceTrigger,
): Effect.Effect<TransactionContext<DB>, TransactionError> =>
	Effect.gen(function* () {
		// Task 2.3: Single-writer lock - atomically check and acquire via Ref.modify
		const lockAcquired = yield* Ref.modify(transactionLock, (locked) => {
			if (locked) {
				return [false, true] as const // Lock not acquired, stays locked
			}
			return [true, true] as const // Lock acquired, now locked
		})

		if (!lockAcquired) {
			return yield* new TransactionError({
				operation: "begin",
				reason: "another transaction is already active",
				message: "Cannot begin transaction: another transaction is already active",
			})
		}

		// Task 2.2: Capture snapshots on begin
		// Snapshot all collections upfront (O(n) Ref.get, each is O(1) - copies the reference)
		const snapshots = new Map<string, ReadonlyMap<string, HasId>>()
		for (const [name, ref] of Object.entries(stateRefs)) {
			const snapshot = yield* Ref.get(ref)
			snapshots.set(name, snapshot)
		}

		// Task 2.7: Mutation tracking set
		// CRUD operations call addMutation(collectionName) instead of scheduling persistence writes.
		// On commit, persistenceTrigger.schedule is called for each collection in this set.
		// On rollback, this set is simply discarded (no persistence writes).
		const mutatedCollections = new Set<string>()

		// isActive flag - guards all transaction operations
		let isActive = true

		// Build the addMutation callback
		const addMutation = (collectionName: string): void => {
			mutatedCollections.add(collectionName)
		}

		// Helper to check if transaction is still active before any operation
		const checkActive = (): Effect.Effect<void, TransactionError> =>
			Effect.suspend(() =>
				isActive
					? Effect.void
					: new TransactionError({
							operation: "begin",
							reason: "transaction is no longer active",
							message: "Cannot perform operation: transaction is no longer active",
						}),
			)

		// Helper to wrap an effect-returning method with isActive check
		const wrapWithActiveCheck = <A, E>(
			effect: Effect.Effect<A, E>,
		): Effect.Effect<A, E | TransactionError> =>
			Effect.flatMap(checkActive(), () => effect)

		// Build collection accessors with isActive guards
		const collections: Record<string, EffectCollection<HasId>> = {}
		for (const collectionName of Object.keys(stateRefs)) {
			const baseCollection = buildCollectionForTx(collectionName, addMutation)

			// Wrap each method to check isActive before proceeding
			// Note: query returns Stream/CursorPage which need different handling
			collections[collectionName] = {
				...baseCollection,
				create: (...args) => wrapWithActiveCheck(baseCollection.create(...args)),
				createMany: (...args) => wrapWithActiveCheck(baseCollection.createMany(...args)),
				update: (...args) => wrapWithActiveCheck(baseCollection.update(...args)),
				updateMany: (...args) => wrapWithActiveCheck(baseCollection.updateMany(...args)),
				delete: (...args) => wrapWithActiveCheck(baseCollection.delete(...args)),
				deleteMany: (...args) => wrapWithActiveCheck(baseCollection.deleteMany(...args)),
				upsert: (...args) => wrapWithActiveCheck(baseCollection.upsert(...args)),
				upsertMany: (...args) => wrapWithActiveCheck(baseCollection.upsertMany(...args)),
				findById: (...args) => wrapWithActiveCheck(baseCollection.findById(...args)),
				createWithRelationships: (...args) =>
					wrapWithActiveCheck(baseCollection.createWithRelationships(...args)),
				updateWithRelationships: (...args) =>
					wrapWithActiveCheck(baseCollection.updateWithRelationships(...args)),
				deleteWithRelationships: (...args) =>
					wrapWithActiveCheck(baseCollection.deleteWithRelationships(...args)),
				deleteManyWithRelationships: (...args) =>
					wrapWithActiveCheck(baseCollection.deleteManyWithRelationships(...args)),
				// aggregate uses the base implementation since reads don't modify state
				// and its conditional return type is incompatible with wrapWithActiveCheck
				aggregate: baseCollection.aggregate,
			} as EffectCollection<HasId>
		}

		const commit = (): Effect.Effect<void, TransactionError> =>
			Effect.gen(function* () {
				if (!isActive) {
					return yield* new TransactionError({
						operation: "commit",
						reason: "transaction is no longer active",
						message: "Cannot commit: transaction is no longer active",
					})
				}

				// Trigger persistence for mutated collections
				if (persistenceTrigger) {
					for (const name of mutatedCollections) {
						persistenceTrigger.schedule(name)
					}
				}

				// Release lock
				yield* Ref.set(transactionLock, false)
				isActive = false
			})

		const rollback = (): Effect.Effect<never, TransactionError> =>
			Effect.gen(function* () {
				if (!isActive) {
					return yield* new TransactionError({
						operation: "rollback",
						reason: "transaction is no longer active",
						message: "Cannot rollback: transaction is no longer active",
					})
				}

				// Restore snapshots
				for (const [name, snapshot] of snapshots) {
					const ref = stateRefs[name]
					if (ref) {
						yield* Ref.set(ref, snapshot)
					}
				}

				// Release lock
				yield* Ref.set(transactionLock, false)
				isActive = false

				// Rollback always fails to short-circuit
				return yield* new TransactionError({
					operation: "rollback",
					reason: "transaction rolled back",
					message: "Transaction rolled back",
				})
			})

		// Build the TransactionContext
		const ctx: TransactionContext<DB> = {
			commit,
			rollback,
			get isActive() {
				return isActive
			},
			get mutatedCollections() {
				return mutatedCollections as ReadonlySet<string>
			},
			...collections,
		} as TransactionContext<DB>

		return ctx
	})

// ============================================================================
// $transaction Callback Wrapper
// ============================================================================

/**
 * Execute a callback within an atomic transaction context.
 *
 * All CRUD operations inside the callback operate against the live in-memory state.
 * On success, changes are committed and persistence is triggered.
 * On failure (error thrown or explicit rollback), all mutations are reverted.
 *
 * Usage:
 * ```ts
 * const result = await db.$transaction((ctx) =>
 *   Effect.gen(function* () {
 *     const user = yield* ctx.users.create({ name: "Alice" })
 *     const post = yield* ctx.posts.create({ authorId: user.id, title: "Hello" })
 *     return { user, post }
 *   })
 * ).pipe(Effect.runPromise)
 * ```
 *
 * @param stateRefs - The database's collection Refs
 * @param transactionLock - Single-writer lock Ref
 * @param buildCollectionForTx - Callback to create collection accessors
 * @param persistenceTrigger - Optional trigger for scheduling saves on commit
 * @param fn - The callback to execute within the transaction
 * @returns Effect that yields the callback result, with TransactionError in error channel
 */
export const $transaction = <DB extends Record<string, EffectCollection<HasId>>, A, E>(
	stateRefs: StateRefs,
	transactionLock: Ref.Ref<boolean>,
	buildCollectionForTx: BuildCollectionForTx,
	persistenceTrigger: PersistenceTrigger | undefined,
	fn: (ctx: TransactionContext<DB>) => Effect.Effect<A, E>,
): Effect.Effect<A, E | TransactionError> =>
	Effect.gen(function* () {
		// Task 3.2: Check for nested transactions before attempting to acquire lock
		// $transaction is the user-facing callback API, so if the lock is already held
		// when $transaction is called, it's a nested transaction attempt.
		const isLocked = yield* Ref.get(transactionLock)
		if (isLocked) {
			return yield* new TransactionError({
				operation: "begin",
				reason: "nested transactions not supported",
				message: "Cannot begin transaction: nested transactions not supported",
			})
		}

		// Create the transaction context
		const ctx = yield* createTransaction<DB>(
			stateRefs,
			transactionLock,
			buildCollectionForTx,
			persistenceTrigger,
		)

		// Run the callback and handle success/failure
		const result = yield* fn(ctx).pipe(
			// On success: commit and return the result
			Effect.flatMap((value) =>
				Effect.gen(function* () {
					yield* ctx.commit()
					return value
				}),
			),
			// On failure: rollback and re-raise the original error
			Effect.catchAll((error) =>
				Effect.gen(function* () {
					// Only rollback if still active (might have been explicitly rolled back)
					if (ctx.isActive) {
						// Rollback always fails with TransactionError, but we want to
						// re-raise the original error, so we catch the rollback error
						yield* ctx.rollback().pipe(Effect.catchAll(() => Effect.void))
					}
					// Re-raise the original error
					return yield* Effect.fail(error)
				}),
			),
		)

		return result
	})
