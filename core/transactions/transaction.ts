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
		// TODO 2.3: Implement single-writer lock acquisition
		// TODO 2.2: Implement snapshot capture
		// TODO 2.7: Implement mutation tracking set
		// TODO 2.6: Implement isActive flag

		// Placeholder: acquire lock (will be implemented in task 2.3)
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

		// Placeholder: Capture snapshots (will be implemented in task 2.2)
		const snapshots = new Map<string, ReadonlyMap<string, HasId>>()
		for (const [name, ref] of Object.entries(stateRefs)) {
			const snapshot = yield* Ref.get(ref)
			snapshots.set(name, snapshot)
		}

		// Mutation tracking set (will be fully implemented in task 2.7)
		const mutatedCollections = new Set<string>()

		// isActive flag (will be fully implemented in task 2.6)
		let isActive = true

		// Build the addMutation callback
		const addMutation = (collectionName: string): void => {
			mutatedCollections.add(collectionName)
		}

		// Build collection accessors
		const collections: Record<string, EffectCollection<HasId>> = {}
		for (const collectionName of Object.keys(stateRefs)) {
			collections[collectionName] = buildCollectionForTx(collectionName, addMutation)
		}

		// TODO 2.4: Implement commit
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

		// TODO 2.5: Implement rollback
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
