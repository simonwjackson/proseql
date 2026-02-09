/**
 * Effect-based delete operations with relationship cascade support.
 *
 * Uses Ref<ReadonlyMap> for atomic state mutation and typed errors.
 * Supports cascade, restrict, set_null, cascade_soft, and preserve
 * cascade options for relationship handling during deletion.
 */

import { Effect, Ref } from "effect"
import type { RelationshipDef } from "../../types/types.js"
import type {
	CascadeOption,
	DeleteWithRelationshipsOptions,
	DeleteWithRelationshipsResult,
	RestrictViolation,
} from "../../types/crud-relationship-types.js"
import {
	NotFoundError,
	ForeignKeyError,
	ValidationError,
	OperationError,
} from "../../errors/crud-errors.js"

// ============================================================================
// Types
// ============================================================================

type HasId = { readonly id: string }

type RelationshipConfig = {
	readonly type: "ref" | "inverse"
	readonly target?: string
	readonly __targetCollection?: string
	readonly foreignKey?: string
}

type CollectionConfig = {
	readonly schema: unknown
	readonly relationships: Record<string, RelationshipConfig>
}

type DatabaseConfig = Record<string, CollectionConfig>

type CascadeResult = {
	readonly [collection: string]: {
		readonly count: number
		readonly ids: ReadonlyArray<string>
	}
}

// ============================================================================
// Helpers
// ============================================================================

const getTargetCollection = (rel: RelationshipConfig): string | undefined =>
	rel.target || rel.__targetCollection

/**
 * Find the foreign key field name in the target collection that references
 * back to the source collection.
 */
const findForeignKey = (
	relationship: RelationshipConfig,
	field: string,
	sourceCollection: string,
	targetConfig: CollectionConfig | undefined,
): string | null => {
	if (relationship.type === "inverse") {
		if (!targetConfig) return null
		for (const [targetField, targetRel] of Object.entries(targetConfig.relationships)) {
			const target = getTargetCollection(targetRel)
			if (target === sourceCollection && targetRel.type === "ref") {
				return targetRel.foreignKey || `${targetField}Id`
			}
		}
		return null
	}
	// For ref relationships
	return relationship.foreignKey || `${field}Id`
}

/**
 * Find all entities in a target collection that reference the given entity ID
 * via the specified foreign key.
 */
const findRelatedEntities = (
	entityId: string,
	foreignKey: string,
	targetRef: Ref.Ref<ReadonlyMap<string, HasId>>,
): Effect.Effect<ReadonlyArray<HasId>> =>
	Ref.get(targetRef).pipe(
		Effect.map((targetMap) => {
			const related: HasId[] = []
			for (const entity of targetMap.values()) {
				if ((entity as Record<string, unknown>)[foreignKey] === entityId) {
					related.push(entity)
				}
			}
			return related
		}),
	)

/**
 * Cascade delete (hard or soft) related entities in a target collection.
 */
const cascadeDeleteEntities = (
	entities: ReadonlyArray<HasId>,
	targetRef: Ref.Ref<ReadonlyMap<string, HasId>>,
	soft: boolean,
): Effect.Effect<{ readonly count: number; readonly ids: ReadonlyArray<string> }> => {
	const entityIds = new Set(entities.map((e) => e.id))
	const now = new Date().toISOString()

	if (soft) {
		return Ref.update(targetRef, (map) => {
			const next = new Map(map)
			for (const id of entityIds) {
				const entity = next.get(id)
				if (entity) {
					next.set(id, {
						...entity,
						deletedAt: now,
						updatedAt: now,
					} as HasId)
				}
			}
			return next
		}).pipe(
			Effect.map(() => ({
				count: entityIds.size,
				ids: [...entityIds],
			})),
		)
	}

	return Ref.update(targetRef, (map) => {
		const next = new Map(map)
		for (const id of entityIds) {
			next.delete(id)
		}
		return next
	}).pipe(
		Effect.map(() => ({
			count: entityIds.size,
			ids: [...entityIds],
		})),
	)
}

/**
 * Set foreign keys to null for related entities in a target collection.
 */
const setForeignKeysToNull = (
	entities: ReadonlyArray<HasId>,
	foreignKey: string,
	targetRef: Ref.Ref<ReadonlyMap<string, HasId>>,
): Effect.Effect<void> => {
	const entityIds = new Set(entities.map((e) => e.id))
	const now = new Date().toISOString()

	return Ref.update(targetRef, (map) => {
		const next = new Map(map)
		for (const id of entityIds) {
			const entity = next.get(id)
			if (entity) {
				next.set(id, {
					...entity,
					[foreignKey]: null,
					updatedAt: now,
				} as HasId)
			}
		}
		return next
	})
}

/**
 * Check if entity supports soft delete (has deletedAt field or can have it added).
 */
const hasSoftDelete = <T>(entity: T): entity is T & { deletedAt?: string } =>
	typeof entity === "object" && entity !== null

// ============================================================================
// Process Cascade Options for a Single Entity
// ============================================================================

/**
 * Process all relationship cascade options for a single entity being deleted.
 * Returns restrict violations and cascade results.
 */
const processRelationshipCascades = <T extends HasId>(
	entityId: string,
	collectionName: string,
	relationships: Record<string, RelationshipConfig>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
	dbConfig: DatabaseConfig,
	options: DeleteWithRelationshipsOptions<T, Record<string, RelationshipDef>> | undefined,
): Effect.Effect<
	{
		readonly restrictViolations: ReadonlyArray<RestrictViolation>
		readonly cascadeResults: Record<string, { count: number; ids: string[] }>
	},
	OperationError
> =>
	Effect.gen(function* () {
		const restrictViolations: RestrictViolation[] = []
		const cascadeResults: Record<string, { count: number; ids: string[] }> = {}

		for (const [field, relationship] of Object.entries(relationships)) {
			const targetCollection = getTargetCollection(relationship)
			if (!targetCollection) continue

			const targetConfig = dbConfig[targetCollection]
			const foreignKey = findForeignKey(relationship, field, collectionName, targetConfig)
			if (!foreignKey) continue

			const targetRef = stateRefs[targetCollection]
			if (!targetRef) continue

			const cascadeOption: CascadeOption =
				(options?.include as Record<string, CascadeOption> | undefined)?.[field] || "preserve"

			const relatedEntities = yield* findRelatedEntities(entityId, foreignKey, targetRef)

			if (relatedEntities.length === 0) continue

			switch (cascadeOption) {
				case "restrict":
					restrictViolations.push({
						collection: collectionName,
						relatedCollection: targetCollection,
						relatedCount: relatedEntities.length,
						message: `Cannot delete ${collectionName} with ID ${entityId} because it has ${relatedEntities.length} related ${targetCollection} entities`,
					})
					break

				case "cascade": {
					const result = yield* cascadeDeleteEntities(
						relatedEntities,
						targetRef,
						options?.soft || false,
					)
					if (!cascadeResults[targetCollection]) {
						cascadeResults[targetCollection] = { count: 0, ids: [] }
					}
					cascadeResults[targetCollection].count += result.count
					cascadeResults[targetCollection].ids.push(...result.ids)
					break
				}

				case "cascade_soft": {
					const result = yield* cascadeDeleteEntities(
						relatedEntities,
						targetRef,
						true,
					)
					if (!cascadeResults[targetCollection]) {
						cascadeResults[targetCollection] = { count: 0, ids: [] }
					}
					cascadeResults[targetCollection].count += result.count
					cascadeResults[targetCollection].ids.push(...result.ids)
					break
				}

				case "set_null":
					yield* setForeignKeysToNull(relatedEntities, foreignKey, targetRef)
					break

				case "preserve":
				default:
					break
			}
		}

		return { restrictViolations, cascadeResults }
	})

// ============================================================================
// Delete with Relationships (single entity)
// ============================================================================

/**
 * Delete a single entity with relationship cascade support.
 *
 * Steps:
 * 1. Look up entity by ID in Ref state (O(1))
 * 2. Process relationship cascades (restrict, cascade, set_null, etc.)
 * 3. Fail if any restrict violations exist
 * 4. Perform the delete (soft or hard)
 * 5. Return deleted entity with cascade information
 */
export const deleteWithRelationships = <T extends HasId>(
	collectionName: string,
	relationships: Record<string, RelationshipConfig>,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
	dbConfig: DatabaseConfig,
) =>
(
	id: string,
	options?: DeleteWithRelationshipsOptions<T, Record<string, RelationshipDef>>,
): Effect.Effect<
	DeleteWithRelationshipsResult<T>,
	NotFoundError | ValidationError | OperationError
> =>
	Effect.gen(function* () {
		// 1. Look up entity
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

		// 2. Process relationship cascades
		const { restrictViolations, cascadeResults } = yield* processRelationshipCascades(
			id,
			collectionName,
			relationships,
			stateRefs,
			dbConfig,
			options,
		)

		// 3. Check for restrict violations
		if (restrictViolations.length > 0) {
			return yield* Effect.fail(
				new ValidationError({
					message: restrictViolations.map((v) => v.message).join("; "),
					issues: restrictViolations.map((v) => ({
						field: "relationships",
						message: v.message,
					})),
				}),
			)
		}

		// 4. Perform the delete
		let deletedEntity: T

		if (options?.soft && hasSoftDelete(entity)) {
			const now = new Date().toISOString()
			const softDeleted = {
				...entity,
				deletedAt: now,
				updatedAt: now,
			} as T

			yield* Ref.update(ref, (map) => {
				const next = new Map(map)
				next.set(id, softDeleted)
				return next
			})
			deletedEntity = softDeleted
		} else {
			yield* Ref.update(ref, (map) => {
				const next = new Map(map)
				next.delete(id)
				return next
			})
			deletedEntity = entity
		}

		// 5. Return result
		const result: DeleteWithRelationshipsResult<T> = {
			deleted: deletedEntity,
			...(Object.keys(cascadeResults).length > 0
				? { cascaded: cascadeResults }
				: {}),
		}

		return result
	})

// ============================================================================
// Delete Many with Relationships
// ============================================================================

/**
 * Delete multiple entities matching a predicate with relationship cascade support.
 *
 * Steps:
 * 1. Find all matching entities using predicate
 * 2. Apply limit if specified
 * 3. Check all restrict violations first (fail-fast)
 * 4. Process cascade operations for all entities
 * 5. Perform the deletes (soft or hard)
 * 6. Return count, deleted entities, and cascade information
 */
export const deleteManyWithRelationships = <T extends HasId>(
	collectionName: string,
	relationships: Record<string, RelationshipConfig>,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
	dbConfig: DatabaseConfig,
) =>
(
	predicate: (entity: T) => boolean,
	options?: DeleteWithRelationshipsOptions<T, Record<string, RelationshipDef>> & { readonly limit?: number },
): Effect.Effect<
	{ readonly count: number; readonly deleted: ReadonlyArray<T>; readonly cascaded?: CascadeResult },
	ValidationError | OperationError
> =>
	Effect.gen(function* () {
		// 1. Find matching entities
		const currentMap = yield* Ref.get(ref)
		let matchingEntities: T[] = []
		for (const entity of currentMap.values()) {
			if (predicate(entity)) {
				matchingEntities.push(entity)
			}
		}

		// 2. Apply limit
		if (options?.limit !== undefined && options.limit > 0) {
			matchingEntities = matchingEntities.slice(0, options.limit)
		}

		if (matchingEntities.length === 0) {
			return { count: 0, deleted: [] }
		}

		// 3. Check restrict violations for ALL entities first
		const allRestrictViolations: RestrictViolation[] = []

		for (const entity of matchingEntities) {
			for (const [field, relationship] of Object.entries(relationships)) {
				const targetCollection = getTargetCollection(relationship)
				if (!targetCollection) continue

				const targetConfig = dbConfig[targetCollection]
				const foreignKey = findForeignKey(relationship, field, collectionName, targetConfig)
				if (!foreignKey) continue

				const targetRef = stateRefs[targetCollection]
				if (!targetRef) continue

				const cascadeOption: CascadeOption =
					(options?.include as Record<string, CascadeOption> | undefined)?.[field] || "preserve"

				if (cascadeOption !== "restrict") continue

				const relatedEntities = yield* findRelatedEntities(entity.id, foreignKey, targetRef)

				if (relatedEntities.length > 0) {
					allRestrictViolations.push({
						collection: collectionName,
						relatedCollection: targetCollection,
						relatedCount: relatedEntities.length,
						message: `Cannot delete ${collectionName} with ID ${entity.id} because it has ${relatedEntities.length} related ${targetCollection} entities`,
					})
				}
			}
		}

		if (allRestrictViolations.length > 0) {
			return yield* Effect.fail(
				new ValidationError({
					message: allRestrictViolations.map((v) => v.message).join("; "),
					issues: allRestrictViolations.map((v) => ({
						field: "relationships",
						message: v.message,
					})),
				}),
			)
		}

		// 4. Process cascade operations for all entities
		const allCascadeResults: Record<string, { count: number; ids: string[] }> = {}

		for (const entity of matchingEntities) {
			for (const [field, relationship] of Object.entries(relationships)) {
				const targetCollection = getTargetCollection(relationship)
				if (!targetCollection) continue

				const targetConfig = dbConfig[targetCollection]
				const foreignKey = findForeignKey(relationship, field, collectionName, targetConfig)
				if (!foreignKey) continue

				const targetRef = stateRefs[targetCollection]
				if (!targetRef) continue

				const cascadeOption: CascadeOption =
					(options?.include as Record<string, CascadeOption> | undefined)?.[field] || "preserve"

				const relatedEntities = yield* findRelatedEntities(entity.id, foreignKey, targetRef)

				if (relatedEntities.length === 0) continue

				switch (cascadeOption) {
					case "cascade":
					case "cascade_soft": {
						const result = yield* cascadeDeleteEntities(
							relatedEntities,
							targetRef,
							cascadeOption === "cascade_soft" || options?.soft || false,
						)
						if (!allCascadeResults[targetCollection]) {
							allCascadeResults[targetCollection] = { count: 0, ids: [] }
						}
						allCascadeResults[targetCollection].count += result.count
						allCascadeResults[targetCollection].ids.push(...result.ids)
						break
					}

					case "set_null":
						yield* setForeignKeysToNull(relatedEntities, foreignKey, targetRef)
						break
				}
			}
		}

		// 5. Perform the deletes
		const deletedEntities: T[] = []
		const now = new Date().toISOString()

		if (options?.soft) {
			const updatedMap = new Map<string, T>()
			for (const entity of matchingEntities) {
				const softDeleted = {
					...entity,
					deletedAt: now,
					updatedAt: now,
				} as T
				updatedMap.set(entity.id, softDeleted)
				deletedEntities.push(softDeleted)
			}

			yield* Ref.update(ref, (map) => {
				const next = new Map(map)
				for (const [id, entity] of updatedMap) {
					next.set(id, entity)
				}
				return next
			})
		} else {
			deletedEntities.push(...matchingEntities)
			const deletedIds = new Set(matchingEntities.map((e) => e.id))

			yield* Ref.update(ref, (map) => {
				const next = new Map(map)
				for (const id of deletedIds) {
					next.delete(id)
				}
				return next
			})
		}

		// 6. Return result
		return {
			count: deletedEntities.length,
			deleted: deletedEntities,
			...(Object.keys(allCascadeResults).length > 0
				? { cascaded: allCascadeResults }
				: {}),
		}
	})

// ============================================================================
// Legacy Exports (backward compatibility for unmigrated factory)
// These will be removed when core/factories/database.ts is migrated (task 10)
// ============================================================================

export {
	createDeleteWithRelationshipsMethod,
	createDeleteManyWithRelationshipsMethod,
} from "./delete-with-relationships-legacy.js"
