/**
 * Effect-based delete operations for entities.
 *
 * Uses Ref<ReadonlyMap> for atomic state mutation and typed errors
 * (NotFoundError, OperationError, ForeignKeyError).
 *
 * Preserves soft delete support, foreign key constraint checking,
 * and cascade handling from the legacy implementation.
 */

import { Effect, Ref } from "effect"
import type {
	DeleteManyResult,
} from "../../types/crud-types.js"
import {
	NotFoundError,
	ForeignKeyError,
	OperationError,
} from "../../errors/crud-errors.js"
import { checkDeleteConstraintsEffect } from "../../validators/foreign-key.js"
import type { CollectionIndexes } from "../../types/index-types.js"
import { removeFromIndex, removeManyFromIndex } from "../../indexes/index-manager.js"

// ============================================================================
// Types
// ============================================================================

type HasId = { readonly id: string }

type RelationshipConfig = {
	readonly type: "ref" | "inverse"
	readonly target: string
	readonly foreignKey?: string
}

type DeleteOptions = {
	readonly soft?: boolean
}

type DeleteManyOptions = {
	readonly soft?: boolean
	readonly limit?: number
}

// ============================================================================
// Delete Single Entity
// ============================================================================

/**
 * Delete a single entity by ID with optional soft delete.
 *
 * Steps:
 * 1. Look up entity by ID in Ref state (O(1))
 * 2. If soft delete requested, verify entity has deletedAt field
 * 3. Check foreign key constraints across all collections
 * 4. Soft delete: update entity with deletedAt timestamp
 *    Hard delete: remove entity from Ref state
 */
export const del = <T extends HasId>(
	collectionName: string,
	allRelationships: Record<string, Record<string, RelationshipConfig>>,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
	supportsSoftDelete: boolean = false,
	indexes?: CollectionIndexes,
) =>
(id: string, options?: DeleteOptions): Effect.Effect<T, NotFoundError | OperationError | ForeignKeyError> =>
	Effect.gen(function* () {
		// Look up entity by ID (O(1))
		const currentMap = yield* Ref.get(ref)
		const entity = currentMap.get(id)
		if (entity === undefined) {
			return yield* Effect.fail(
				new NotFoundError({
					collection: collectionName,
					id,
					message: `Entity '${id}' not found in collection '${collectionName}'`,
				}),
			)
		}

		const isSoft = options?.soft === true

		// Check if soft delete is requested but entity doesn't support it
		if (isSoft && !supportsSoftDelete) {
			return yield* Effect.fail(
				new OperationError({
					operation: "soft delete",
					reason: "Entity does not have a deletedAt field",
					message: "Entity does not have a deletedAt field",
				}),
			)
		}

		// Check foreign key constraints
		yield* checkDeleteConstraintsEffect(
			id,
			collectionName,
			allRelationships,
			stateRefs,
		)

		if (isSoft) {
			// Soft delete: mark with deletedAt timestamp
			// If already soft-deleted, preserve the original deletedAt
			const existingDeletedAt = (entity as Record<string, unknown>).deletedAt
			const now = new Date().toISOString()
			const softDeleted = {
				...entity,
				deletedAt: existingDeletedAt || now,
				updatedAt: existingDeletedAt ? (entity as Record<string, unknown>).updatedAt : now,
			} as T

			yield* Ref.update(ref, (map) => {
				const next = new Map(map)
				next.set(id, softDeleted)
				return next
			})

			return softDeleted
		}

		// Hard delete: remove from indexes first (while entity is still accessible)
		if (indexes && indexes.size > 0) {
			yield* removeFromIndex(indexes, entity)
		}

		// Hard delete: remove from state
		yield* Ref.update(ref, (map) => {
			const next = new Map(map)
			next.delete(id)
			return next
		})

		return entity
	})

// ============================================================================
// Delete Multiple Entities
// ============================================================================

/**
 * Delete multiple entities matching a predicate with optional soft delete.
 *
 * Uses a predicate function to select which entities to delete.
 * The caller (database factory) can use the Stream-based filter pipeline
 * to build the predicate from a WhereClause.
 *
 * All matching entities are deleted atomically in a single Ref.update call.
 */
export const deleteMany = <T extends HasId>(
	collectionName: string,
	allRelationships: Record<string, Record<string, RelationshipConfig>>,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
	supportsSoftDelete: boolean = false,
	indexes?: CollectionIndexes,
) =>
(
	predicate: (entity: T) => boolean,
	options?: DeleteManyOptions,
): Effect.Effect<DeleteManyResult<T>, OperationError | ForeignKeyError> =>
	Effect.gen(function* () {
		// Get current state and find matching entities
		const currentMap = yield* Ref.get(ref)
		let matchingEntities: T[] = []
		for (const entity of currentMap.values()) {
			if (predicate(entity)) {
				matchingEntities.push(entity)
			}
		}

		// Apply limit if specified
		if (options?.limit !== undefined && options.limit > 0) {
			matchingEntities = matchingEntities.slice(0, options.limit)
		}

		if (matchingEntities.length === 0) {
			return { count: 0, deleted: [] }
		}

		const isSoft = options?.soft === true

		// Check if soft delete is requested but entities don't support it
		if (isSoft && !supportsSoftDelete) {
			return yield* Effect.fail(
				new OperationError({
					operation: "soft delete",
					reason: "Entities do not have a deletedAt field",
					message: "Entities do not have a deletedAt field",
				}),
			)
		}

		// Check foreign key constraints for all entities (only for hard delete)
		if (!isSoft) {
			for (const entity of matchingEntities) {
				yield* checkDeleteConstraintsEffect(
					entity.id,
					collectionName,
					allRelationships,
					stateRefs,
				)
			}
		}

		const now = new Date().toISOString()
		const deleted: T[] = []

		if (isSoft) {
			// Soft delete: update matching entities with deletedAt
			const updatedEntities = new Map<string, T>()
			for (const entity of matchingEntities) {
				const existingDeletedAt = (entity as Record<string, unknown>).deletedAt
				const softDeleted = {
					...entity,
					deletedAt: existingDeletedAt || now,
					updatedAt: existingDeletedAt ? (entity as Record<string, unknown>).updatedAt : now,
				} as T
				updatedEntities.set(entity.id, softDeleted)
				deleted.push(softDeleted)
			}

			yield* Ref.update(ref, (map) => {
				const next = new Map(map)
				for (const [id, entity] of updatedEntities) {
					next.set(id, entity)
				}
				return next
			})
		} else {
			// Hard delete: remove from indexes first (while entities are still accessible)
			if (indexes && indexes.size > 0) {
				yield* removeManyFromIndex(indexes, matchingEntities)
			}

			// Hard delete: remove matching entities from state
			const deletedIds = new Set(matchingEntities.map((e) => e.id))
			deleted.push(...matchingEntities)

			yield* Ref.update(ref, (map) => {
				const next = new Map(map)
				for (const id of deletedIds) {
					next.delete(id)
				}
				return next
			})
		}

		return { count: deleted.length, deleted }
	})

