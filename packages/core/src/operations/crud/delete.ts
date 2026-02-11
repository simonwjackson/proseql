/**
 * Effect-based delete operations for entities.
 *
 * Uses Ref<ReadonlyMap> for atomic state mutation and typed errors
 * (NotFoundError, OperationError, ForeignKeyError).
 *
 * Preserves soft delete support, foreign key constraint checking,
 * and cascade handling from the legacy implementation.
 */

import { Effect, Ref } from "effect";
import {
	type ForeignKeyError,
	type HookError,
	NotFoundError,
	OperationError,
} from "../../errors/crud-errors.js";
import {
	runAfterDeleteHooks,
	runBeforeDeleteHooks,
	runOnChangeHooks,
} from "../../hooks/hook-runner.js";
import {
	removeFromIndex,
	removeManyFromIndex,
} from "../../indexes/index-manager.js";
import { removeFromSearchIndex } from "../../indexes/search-index.js";
import type { DeleteManyResult } from "../../types/crud-types.js";
import type { HooksConfig } from "../../types/hook-types.js";
import type { CollectionIndexes } from "../../types/index-types.js";
import type { SearchIndexMap } from "../../types/search-types.js";
import { checkDeleteConstraintsEffect } from "../../validators/foreign-key.js";

// ============================================================================
// Types
// ============================================================================

type HasId = { readonly id: string };

type RelationshipConfig = {
	readonly type: "ref" | "inverse";
	readonly target: string;
	readonly foreignKey?: string;
};

type DeleteOptions = {
	readonly soft?: boolean;
};

type DeleteManyOptions = {
	readonly soft?: boolean;
	readonly limit?: number;
};

// ============================================================================
// Delete Single Entity
// ============================================================================

/**
 * Delete a single entity by ID with optional soft delete.
 *
 * Steps:
 * 1. Look up entity by ID in Ref state (O(1))
 * 2. Run beforeDelete hooks (can reject)
 * 3. If soft delete requested, verify entity has deletedAt field
 * 4. Check foreign key constraints across all collections
 * 5. Soft delete: update entity with deletedAt timestamp
 *    Hard delete: remove entity from Ref state
 */
export const del =
	<T extends HasId>(
		collectionName: string,
		allRelationships: Record<string, Record<string, RelationshipConfig>>,
		ref: Ref.Ref<ReadonlyMap<string, T>>,
		stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
		supportsSoftDelete: boolean = false,
		indexes?: CollectionIndexes,
		hooks?: HooksConfig<T>,
		searchIndexRef?: Ref.Ref<SearchIndexMap>,
		searchIndexFields?: ReadonlyArray<string>,
	) =>
	(
		id: string,
		options?: DeleteOptions,
	): Effect.Effect<
		T,
		NotFoundError | OperationError | ForeignKeyError | HookError
	> =>
		Effect.gen(function* () {
			// Look up entity by ID (O(1))
			const currentMap = yield* Ref.get(ref);
			const entity = currentMap.get(id);
			if (entity === undefined) {
				return yield* Effect.fail(
					new NotFoundError({
						collection: collectionName,
						id,
						message: `Entity '${id}' not found in collection '${collectionName}'`,
					}),
				);
			}

			// Run beforeDelete hooks (can reject the delete)
			yield* runBeforeDeleteHooks(hooks?.beforeDelete, {
				operation: "delete",
				collection: collectionName,
				id,
				entity,
			});

			const isSoft = options?.soft === true;

			// Check if soft delete is requested but entity doesn't support it
			if (isSoft && !supportsSoftDelete) {
				return yield* Effect.fail(
					new OperationError({
						operation: "soft delete",
						reason: "Entity does not have a deletedAt field",
						message: "Entity does not have a deletedAt field",
					}),
				);
			}

			// Check foreign key constraints
			yield* checkDeleteConstraintsEffect(
				id,
				collectionName,
				allRelationships,
				stateRefs,
			);

			if (isSoft) {
				// Soft delete: mark with deletedAt timestamp
				// If already soft-deleted, preserve the original deletedAt
				const existingDeletedAt = (entity as Record<string, unknown>).deletedAt;
				const now = new Date().toISOString();
				const softDeleted = {
					...entity,
					deletedAt: existingDeletedAt || now,
					updatedAt: existingDeletedAt
						? (entity as Record<string, unknown>).updatedAt
						: now,
				} as T;

				yield* Ref.update(ref, (map) => {
					const next = new Map(map);
					next.set(id, softDeleted);
					return next;
				});

				// Run afterDelete hooks (fire-and-forget, errors swallowed)
				yield* runAfterDeleteHooks(hooks?.afterDelete, {
					operation: "delete",
					collection: collectionName,
					id,
					entity: softDeleted,
				});

				// Run onChange hooks with type: "delete" (fire-and-forget, errors swallowed)
				yield* runOnChangeHooks(hooks?.onChange, {
					type: "delete",
					collection: collectionName,
					id,
					entity: softDeleted,
				});

				return softDeleted;
			}

			// Hard delete: remove from indexes first (while entity is still accessible)
			if (indexes && indexes.size > 0) {
				yield* removeFromIndex(indexes, entity);
			}

			// Hard delete: remove from search index first (while entity is still accessible)
			if (searchIndexRef && searchIndexFields && searchIndexFields.length > 0) {
				yield* removeFromSearchIndex(searchIndexRef, entity, searchIndexFields);
			}

			// Hard delete: remove from state
			yield* Ref.update(ref, (map) => {
				const next = new Map(map);
				next.delete(id);
				return next;
			});

			// Run afterDelete hooks (fire-and-forget, errors swallowed)
			yield* runAfterDeleteHooks(hooks?.afterDelete, {
				operation: "delete",
				collection: collectionName,
				id,
				entity,
			});

			// Run onChange hooks with type: "delete" (fire-and-forget, errors swallowed)
			yield* runOnChangeHooks(hooks?.onChange, {
				type: "delete",
				collection: collectionName,
				id,
				entity,
			});

			return entity;
		});

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
 * Runs hooks per entity: beforeDelete can reject deletion,
 * afterDelete and onChange run after state mutation.
 *
 * All matching entities are deleted atomically in a single Ref.update call.
 */
export const deleteMany =
	<T extends HasId>(
		collectionName: string,
		allRelationships: Record<string, Record<string, RelationshipConfig>>,
		ref: Ref.Ref<ReadonlyMap<string, T>>,
		stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
		supportsSoftDelete: boolean = false,
		indexes?: CollectionIndexes,
		hooks?: HooksConfig<T>,
		searchIndexRef?: Ref.Ref<SearchIndexMap>,
		searchIndexFields?: ReadonlyArray<string>,
	) =>
	(
		predicate: (entity: T) => boolean,
		options?: DeleteManyOptions,
	): Effect.Effect<
		DeleteManyResult<T>,
		OperationError | ForeignKeyError | HookError
	> =>
		Effect.gen(function* () {
			// Get current state and find matching entities
			const currentMap = yield* Ref.get(ref);
			let matchingEntities: T[] = [];
			for (const entity of currentMap.values()) {
				if (predicate(entity)) {
					matchingEntities.push(entity);
				}
			}

			// Apply limit if specified
			if (options?.limit !== undefined && options.limit > 0) {
				matchingEntities = matchingEntities.slice(0, options.limit);
			}

			if (matchingEntities.length === 0) {
				return { count: 0, deleted: [] };
			}

			const isSoft = options?.soft === true;

			// Check if soft delete is requested but entities don't support it
			if (isSoft && !supportsSoftDelete) {
				return yield* Effect.fail(
					new OperationError({
						operation: "soft delete",
						reason: "Entities do not have a deletedAt field",
						message: "Entities do not have a deletedAt field",
					}),
				);
			}

			// Run beforeDelete hooks for each entity (can reject deletion)
			for (const entity of matchingEntities) {
				yield* runBeforeDeleteHooks(hooks?.beforeDelete, {
					operation: "delete",
					collection: collectionName,
					id: entity.id,
					entity,
				});
			}

			// Check foreign key constraints for all entities (only for hard delete)
			if (!isSoft) {
				for (const entity of matchingEntities) {
					yield* checkDeleteConstraintsEffect(
						entity.id,
						collectionName,
						allRelationships,
						stateRefs,
					);
				}
			}

			const now = new Date().toISOString();
			const deleted: T[] = [];

			if (isSoft) {
				// Soft delete: update matching entities with deletedAt
				const updatedEntities = new Map<string, T>();
				for (const entity of matchingEntities) {
					const existingDeletedAt = (entity as Record<string, unknown>)
						.deletedAt;
					const softDeleted = {
						...entity,
						deletedAt: existingDeletedAt || now,
						updatedAt: existingDeletedAt
							? (entity as Record<string, unknown>).updatedAt
							: now,
					} as T;
					updatedEntities.set(entity.id, softDeleted);
					deleted.push(softDeleted);
				}

				yield* Ref.update(ref, (map) => {
					const next = new Map(map);
					for (const [id, entity] of updatedEntities) {
						next.set(id, entity);
					}
					return next;
				});
			} else {
				// Hard delete: remove from indexes first (while entities are still accessible)
				if (indexes && indexes.size > 0) {
					yield* removeManyFromIndex(indexes, matchingEntities);
				}

				// Hard delete: remove from search index first (while entities are still accessible)
				if (
					searchIndexRef &&
					searchIndexFields &&
					searchIndexFields.length > 0
				) {
					for (const entity of matchingEntities) {
						yield* removeFromSearchIndex(
							searchIndexRef,
							entity,
							searchIndexFields,
						);
					}
				}

				// Hard delete: remove matching entities from state
				const deletedIds = new Set(matchingEntities.map((e) => e.id));
				deleted.push(...matchingEntities);

				yield* Ref.update(ref, (map) => {
					const next = new Map(map);
					for (const id of deletedIds) {
						next.delete(id);
					}
					return next;
				});
			}

			// Run afterDelete and onChange hooks for each deleted entity
			for (const entity of deleted) {
				// Run afterDelete hooks (fire-and-forget, errors swallowed)
				yield* runAfterDeleteHooks(hooks?.afterDelete, {
					operation: "delete",
					collection: collectionName,
					id: entity.id,
					entity,
				});

				// Run onChange hooks with type: "delete" (fire-and-forget, errors swallowed)
				yield* runOnChangeHooks(hooks?.onChange, {
					type: "delete",
					collection: collectionName,
					id: entity.id,
					entity,
				});
			}

			return { count: deleted.length, deleted };
		});
