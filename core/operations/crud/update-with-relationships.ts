/**
 * Effect-based update operations with relationship support.
 *
 * Uses Ref<ReadonlyMap> for atomic state mutation, Effect Schema for validation,
 * and typed errors. Supports $disconnect, $connect, $update, $delete, and $set
 * operations for both ref (single) and inverse (many) relationship types.
 */

import { Effect, Ref, Schema } from "effect"
import type { UpdateInput } from "../../types/crud-types.js"
import type { RelationshipDef } from "../../types/types.js"
import type {
	UpdateWithRelationshipsInput,
	ConnectInput,
	SingleRelationshipInput,
	ManyRelationshipInput,
} from "../../types/crud-relationship-types.js"
import { isRelationshipOperation } from "../../types/crud-relationship-types.js"
import {
	NotFoundError,
	ForeignKeyError,
	ValidationError,
	OperationError,
} from "../../errors/crud-errors.js"
import { validateEntity } from "../../validators/schema-validator.js"
import { extractForeignKeyConfigs } from "../../validators/foreign-key.js"

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
	readonly schema: Schema.Schema<HasId, unknown>
	readonly relationships: Record<string, RelationshipConfig>
}

type DatabaseConfig = Record<string, CollectionConfig>

type UpdateOperations = {
	readonly disconnect: ReadonlyArray<{ readonly field: string; readonly targetCollection: string }>
	readonly connect: ReadonlyArray<{ readonly field: string; readonly targetId: string; readonly targetCollection: string }>
	readonly update: ReadonlyArray<{
		readonly field: string
		readonly data: UpdateInput<unknown>
		readonly targetCollection: string
		readonly targetId?: string
	}>
	readonly delete: ReadonlyArray<{ readonly field: string; readonly targetId?: string; readonly targetCollection: string }>
	readonly set: ReadonlyArray<{ readonly field: string; readonly targetIds: ReadonlyArray<string>; readonly targetCollection: string }>
}

// ============================================================================
// Helpers
// ============================================================================

const getTargetCollection = (rel: RelationshipConfig): string | undefined =>
	rel.target || rel.__targetCollection

/**
 * Resolve a connect input to a target entity's ID by looking up the Ref state.
 */
const resolveConnectInput = (
	input: ConnectInput<unknown>,
	targetCollection: string,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
): Effect.Effect<string, ForeignKeyError> =>
	Effect.gen(function* () {
		const targetRef = stateRefs[targetCollection]
		if (targetRef === undefined) {
			return yield* Effect.fail(
				new ForeignKeyError({
					collection: targetCollection,
					field: "",
					value: "",
					targetCollection,
					message: `Target collection '${targetCollection}' not found`,
				}),
			)
		}

		const targetMap = yield* Ref.get(targetRef)

		// If input has id, use it directly
		if ("id" in input && typeof (input as Record<string, unknown>).id === "string") {
			const id = (input as { readonly id: string }).id
			if (targetMap.has(id)) {
				return id
			}
			return yield* Effect.fail(
				new ForeignKeyError({
					collection: targetCollection,
					field: "id",
					value: id,
					targetCollection,
					message: `Entity with ID '${id}' not found in '${targetCollection}'`,
				}),
			)
		}

		// Otherwise, find by matching fields
		const inputEntries = Object.entries(input as Record<string, unknown>)
		for (const [, entity] of targetMap) {
			const entityRecord = entity as Record<string, unknown>
			const matches = inputEntries.every(([key, value]) => entityRecord[key] === value)
			if (matches) {
				return entity.id
			}
		}

		return yield* Effect.fail(
			new ForeignKeyError({
				collection: targetCollection,
				field: "",
				value: JSON.stringify(input),
				targetCollection,
				message: `No matching entity found in '${targetCollection}'`,
			}),
		)
	})

/**
 * Find the inverse relationship field name in the target collection
 * that points back to the source collection.
 */
const findInverseRelationship = (
	sourceCollection: string,
	targetRelationships: Record<string, RelationshipConfig>,
): string | null => {
	for (const [field, rel] of Object.entries(targetRelationships)) {
		const target = getTargetCollection(rel)
		if (target === sourceCollection) {
			return field
		}
	}
	return null
}

// ============================================================================
// Relationship Processing
// ============================================================================

/**
 * Process a single (ref) relationship update input into operations.
 */
const processSingleRelationshipUpdate = (
	field: string,
	value: SingleRelationshipInput<unknown> | ConnectInput<unknown>,
	targetCollection: string,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
): Effect.Effect<UpdateOperations, ForeignKeyError> =>
	Effect.gen(function* () {
		const disconnect: Array<{ field: string; targetCollection: string }> = []
		const connect: Array<{ field: string; targetId: string; targetCollection: string }> = []
		const update: Array<{ field: string; data: UpdateInput<unknown>; targetCollection: string; targetId?: string }> = []
		const del: Array<{ field: string; targetId?: string; targetCollection: string }> = []
		const set: Array<{ field: string; targetIds: string[]; targetCollection: string }> = []

		// Direct connect (shorthand syntax)
		if (!isRelationshipOperation(value)) {
			const targetId = yield* resolveConnectInput(
				value as ConnectInput<unknown>,
				targetCollection,
				stateRefs,
			)
			connect.push({ field, targetId, targetCollection })
			return { disconnect, connect, update, delete: del, set }
		}

		const ops = value as SingleRelationshipInput<unknown>

		if (ops.$disconnect) {
			disconnect.push({ field, targetCollection })
		}

		if (ops.$connect) {
			const targetId = yield* resolveConnectInput(
				ops.$connect,
				targetCollection,
				stateRefs,
			)
			connect.push({ field, targetId, targetCollection })
		}

		if (ops.$update) {
			update.push({ field, data: ops.$update, targetCollection })
		}

		if (ops.$delete) {
			del.push({ field, targetCollection })
		}

		return { disconnect, connect, update, delete: del, set }
	})

/**
 * Process a many (inverse) relationship update input into operations.
 */
const processManyRelationshipUpdate = (
	field: string,
	value: ManyRelationshipInput<unknown>,
	targetCollection: string,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
): Effect.Effect<UpdateOperations, ForeignKeyError> =>
	Effect.gen(function* () {
		const disconnect: Array<{ field: string; targetCollection: string }> = []
		const connect: Array<{ field: string; targetId: string; targetCollection: string }> = []
		const update: Array<{ field: string; data: UpdateInput<unknown>; targetCollection: string; targetId?: string }> = []
		const del: Array<{ field: string; targetId?: string; targetCollection: string }> = []
		const set: Array<{ field: string; targetIds: string[]; targetCollection: string }> = []

		// Process $set (replace all) — takes priority over other operations
		if (value.$set) {
			const targetIds: string[] = []
			for (const item of value.$set) {
				const targetId = yield* resolveConnectInput(item, targetCollection, stateRefs)
				targetIds.push(targetId)
			}
			set.push({ field, targetIds, targetCollection })
			return { disconnect, connect, update, delete: del, set }
		}

		// Process $disconnect
		if (value.$disconnect) {
			if (value.$disconnect === true) {
				disconnect.push({ field, targetCollection })
			} else {
				const disconnects = Array.isArray(value.$disconnect)
					? value.$disconnect
					: [value.$disconnect]
				for (const disc of disconnects) {
					const targetId = yield* resolveConnectInput(disc, targetCollection, stateRefs).pipe(
						Effect.catchTag("ForeignKeyError", () => Effect.succeed("")),
					)
					if (targetId) {
						del.push({ field, targetId, targetCollection })
					}
				}
			}
		}

		// Process $connect
		if (value.$connect) {
			const connects = Array.isArray(value.$connect)
				? value.$connect
				: [value.$connect]
			for (const conn of connects) {
				const targetId = yield* resolveConnectInput(conn, targetCollection, stateRefs)
				connect.push({ field, targetId, targetCollection })
			}
		}

		// Process $update
		if (value.$update) {
			const updates = Array.isArray(value.$update)
				? value.$update
				: [value.$update]
			for (const u of updates) {
				const targetId = yield* resolveConnectInput(u.where, targetCollection, stateRefs).pipe(
					Effect.catchTag("ForeignKeyError", () => Effect.succeed("")),
				)
				if (targetId) {
					update.push({ field, data: u.data, targetCollection, targetId })
				}
			}
		}

		// Process $delete
		if (value.$delete) {
			const deletes = Array.isArray(value.$delete)
				? value.$delete
				: [value.$delete]
			for (const d of deletes) {
				const targetId = yield* resolveConnectInput(d, targetCollection, stateRefs).pipe(
					Effect.catchTag("ForeignKeyError", () => Effect.succeed("")),
				)
				if (targetId) {
					del.push({ field, targetId, targetCollection })
				}
			}
		}

		return { disconnect, connect, update, delete: del, set }
	})

/**
 * Process all relationship operations from the update input.
 */
const processRelationshipOperations = (
	input: Record<string, unknown>,
	relationships: Record<string, RelationshipConfig>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
): Effect.Effect<UpdateOperations, ForeignKeyError> =>
	Effect.gen(function* () {
		const allDisconnect: Array<{ field: string; targetCollection: string }> = []
		const allConnect: Array<{ field: string; targetId: string; targetCollection: string }> = []
		const allUpdate: Array<{ field: string; data: UpdateInput<unknown>; targetCollection: string; targetId?: string }> = []
		const allDelete: Array<{ field: string; targetId?: string; targetCollection: string }> = []
		const allSet: Array<{ field: string; targetIds: string[]; targetCollection: string }> = []

		for (const [field, value] of Object.entries(input)) {
			const rel = relationships[field]
			if (!rel || value === undefined || value === null) continue

			const targetCollection = getTargetCollection(rel)
			if (!targetCollection) continue

			let ops: UpdateOperations

			if (rel.type === "ref") {
				ops = yield* processSingleRelationshipUpdate(
					field,
					value as SingleRelationshipInput<unknown> | ConnectInput<unknown>,
					targetCollection,
					stateRefs,
				)
			} else {
				ops = yield* processManyRelationshipUpdate(
					field,
					value as ManyRelationshipInput<unknown>,
					targetCollection,
					stateRefs,
				)
			}

			allDisconnect.push(...ops.disconnect)
			allConnect.push(...ops.connect)
			allUpdate.push(...ops.update)
			allDelete.push(...ops.delete)
			allSet.push(...ops.set)
		}

		return {
			disconnect: allDisconnect,
			connect: allConnect,
			update: allUpdate,
			delete: allDelete,
			set: allSet,
		}
	})

// ============================================================================
// Validate foreign keys using Ref-based state
// ============================================================================

const validateForeignKeysEffect = <T extends HasId>(
	entity: T,
	collectionName: string,
	relationships: Record<string, RelationshipConfig>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
): Effect.Effect<void, ForeignKeyError> => {
	const configs = extractForeignKeyConfigs(
		relationships as Record<string, { type: "ref" | "inverse"; foreignKey?: string; target?: string }>,
	)

	if (configs.length === 0) {
		return Effect.void
	}

	return Effect.forEach(configs, (config) => {
		const value = (entity as Record<string, unknown>)[config.foreignKey]
		if (value === undefined || value === null) {
			return Effect.void
		}

		const targetRef = stateRefs[config.targetCollection]
		if (targetRef === undefined) {
			return Effect.fail(
				new ForeignKeyError({
					collection: collectionName,
					field: config.foreignKey,
					value: String(value),
					targetCollection: config.targetCollection,
					message: `Foreign key constraint violated: '${config.foreignKey}' references non-existent collection '${config.targetCollection}'`,
				}),
			)
		}

		return Ref.get(targetRef).pipe(
			Effect.flatMap((targetMap) => {
				if (targetMap.has(String(value))) {
					return Effect.void
				}
				return Effect.fail(
					new ForeignKeyError({
						collection: collectionName,
						field: config.foreignKey,
						value: String(value),
						targetCollection: config.targetCollection,
						message: `Foreign key constraint violated: '${config.foreignKey}' references non-existent ${config.targetCollection} '${value}'`,
					}),
				)
			}),
		)
	}, { discard: true })
}

// ============================================================================
// Update with Relationships
// ============================================================================

/**
 * Update a single entity with relationship support.
 *
 * Steps:
 * 1. Look up existing entity by ID
 * 2. Parse relationship operations from input
 * 3. Extract base entity updates (non-relationship fields)
 * 4. Process $disconnect: set FK to null (ref) or update inverse entities
 * 5. Process $connect: set FK (ref) or update inverse entity FKs
 * 6. Process $update: update related entities in target collections
 * 7. Process $delete: disconnect specific inverse entities
 * 8. Process $set: replace all inverse relationships
 * 9. Merge base updates, validate, and update the entity
 */
export const updateWithRelationships = <T extends HasId, I = T>(
	collectionName: string,
	schema: Schema.Schema<T, I>,
	relationships: Record<string, RelationshipConfig>,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
	dbConfig: DatabaseConfig,
) =>
(
	id: string,
	input: UpdateWithRelationshipsInput<T, Record<string, RelationshipDef>>,
): Effect.Effect<T, ValidationError | NotFoundError | ForeignKeyError | OperationError> =>
	Effect.gen(function* () {
		// 1. Look up existing entity
		const currentMap = yield* Ref.get(ref)
		const existing = currentMap.get(id)
		if (existing === undefined) {
			return yield* Effect.fail(
				new NotFoundError({
					collection: collectionName,
					id,
					message: `Entity '${id}' not found in collection '${collectionName}'`,
				}),
			)
		}

		const now = new Date().toISOString()

		// 2. Process relationship operations
		const relationshipOps = yield* processRelationshipOperations(
			input as Record<string, unknown>,
			relationships,
			stateRefs,
		)

		// 3. Extract base entity updates (non-relationship fields)
		const baseUpdate: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
			if (!(key in relationships)) {
				baseUpdate[key] = value
			}
		}

		// Start with a copy of existing entity
		const updatedEntity: Record<string, unknown> = { ...existing as Record<string, unknown> }

		// 4. Process disconnects
		for (const op of relationshipOps.disconnect) {
			const relationship = relationships[op.field]
			if (!relationship) continue

			if (relationship.type === "ref") {
				// Set FK to null on the entity being updated
				const foreignKey = relationship.foreignKey || `${op.field}Id`
				updatedEntity[foreignKey] = null
			} else if (relationship.type === "inverse") {
				// Update inverse entities: set their FK to null
				const targetConfig = dbConfig[op.targetCollection]
				if (!targetConfig) continue

				const inverseField = findInverseRelationship(
					collectionName,
					targetConfig.relationships,
				)
				if (!inverseField) continue

				const inverseRel = targetConfig.relationships[inverseField]
				if (!inverseRel) continue
				const foreignKey = inverseRel.foreignKey || `${inverseField}Id`

				const targetRef = stateRefs[op.targetCollection]
				if (!targetRef) continue

				yield* Ref.update(targetRef, (map) => {
					const next = new Map(map)
					for (const [entityId, entity] of map) {
						if ((entity as Record<string, unknown>)[foreignKey] === id) {
							next.set(entityId, {
								...entity,
								[foreignKey]: null,
								updatedAt: now,
							} as HasId)
						}
					}
					return next
				})
			}
		}

		// 5. Process connects
		for (const op of relationshipOps.connect) {
			const relationship = relationships[op.field]
			if (!relationship) continue

			if (relationship.type === "ref") {
				// Set FK on the entity being updated
				const foreignKey = relationship.foreignKey || `${op.field}Id`
				updatedEntity[foreignKey] = op.targetId
			} else if (relationship.type === "inverse") {
				// Update the target entity's FK to point to this entity
				const targetConfig = dbConfig[op.targetCollection]
				if (!targetConfig) continue

				const inverseField = findInverseRelationship(
					collectionName,
					targetConfig.relationships,
				)
				if (!inverseField) continue

				const inverseRel = targetConfig.relationships[inverseField]
				if (!inverseRel) continue
				const foreignKey = inverseRel.foreignKey || `${inverseField}Id`

				const targetRef = stateRefs[op.targetCollection]
				if (!targetRef) continue

				yield* Ref.update(targetRef, (map) => {
					const target = map.get(op.targetId)
					if (!target) return map

					const next = new Map(map)
					next.set(op.targetId, {
						...target,
						[foreignKey]: id,
						updatedAt: now,
					} as HasId)
					return next
				})
			}
		}

		// 6. Process nested updates on related entities
		for (const op of relationshipOps.update) {
			const targetRef = stateRefs[op.targetCollection]
			if (!targetRef) continue

			const targetConfig = dbConfig[op.targetCollection]
			if (!targetConfig) continue

			// Determine which target entity to update
			let targetId = op.targetId
			if (!targetId) {
				// For ref relationships, look up the FK on the current entity
				const relationship = relationships[op.field]
				if (relationship && relationship.type === "ref") {
					const foreignKey = relationship.foreignKey || `${op.field}Id`
					const fkValue = updatedEntity[foreignKey]
					if (typeof fkValue === "string") {
						targetId = fkValue
					}
				}
			}

			if (!targetId) continue

			const targetMap = yield* Ref.get(targetRef)
			const targetEntity = targetMap.get(targetId)
			if (!targetEntity) continue

			const updateData = op.data as Record<string, unknown>
			const updatedTarget = {
				...targetEntity,
				...updateData,
				updatedAt: now,
			}

			// Validate updated target
			const validated = yield* validateEntity(targetConfig.schema, updatedTarget).pipe(
				Effect.mapError((ve) => new ValidationError({
					message: `Nested update in '${op.targetCollection}' failed: ${ve.message}`,
					issues: ve.issues,
				})),
			)

			yield* Ref.update(targetRef, (map) => {
				const next = new Map(map)
				next.set(targetId!, validated)
				return next
			})
		}

		// 7. Process delete operations (disconnect specific inverse entities)
		for (const op of relationshipOps.delete) {
			const relationship = relationships[op.field]
			if (!relationship || relationship.type !== "inverse") continue

			const targetConfig = dbConfig[op.targetCollection]
			if (!targetConfig) continue

			const inverseField = findInverseRelationship(
				collectionName,
				targetConfig.relationships,
			)
			if (!inverseField) continue

			const inverseRel = targetConfig.relationships[inverseField]
			if (!inverseRel) continue
			const foreignKey = inverseRel.foreignKey || `${inverseField}Id`

			if (!op.targetId) continue

			const targetRef = stateRefs[op.targetCollection]
			if (!targetRef) continue

			yield* Ref.update(targetRef, (map) => {
				const target = map.get(op.targetId!)
				if (!target) return map
				if ((target as Record<string, unknown>)[foreignKey] !== id) return map

				const next = new Map(map)
				next.set(op.targetId!, {
					...target,
					[foreignKey]: null,
					updatedAt: now,
				} as HasId)
				return next
			})
		}

		// 8. Process set operations (replace all inverse relationships)
		for (const op of relationshipOps.set) {
			const relationship = relationships[op.field]
			if (!relationship || relationship.type !== "inverse") continue

			const targetConfig = dbConfig[op.targetCollection]
			if (!targetConfig) continue

			const inverseField = findInverseRelationship(
				collectionName,
				targetConfig.relationships,
			)
			if (!inverseField) continue

			const inverseRel = targetConfig.relationships[inverseField]
			if (!inverseRel) continue
			const foreignKey = inverseRel.foreignKey || `${inverseField}Id`

			const targetRef = stateRefs[op.targetCollection]
			if (!targetRef) continue

			const targetIdsSet = new Set(op.targetIds)

			yield* Ref.update(targetRef, (map) => {
				const next = new Map(map)
				for (const [entityId, entity] of map) {
					const entityRecord = entity as Record<string, unknown>
					if (entityRecord[foreignKey] === id && !targetIdsSet.has(entityId)) {
						// Remove current relationship
						next.set(entityId, {
							...entity,
							[foreignKey]: null,
							updatedAt: now,
						} as HasId)
					} else if (targetIdsSet.has(entityId)) {
						// Set new relationship
						next.set(entityId, {
							...entity,
							[foreignKey]: id,
							updatedAt: now,
						} as HasId)
					}
				}
				return next
			})
		}

		// 9. Merge base updates, validate, and update
		Object.assign(updatedEntity, baseUpdate)
		updatedEntity.updatedAt = now

		const validated = yield* validateEntity(schema, updatedEntity)

		// Validate foreign keys
		yield* validateForeignKeysEffect(
			validated,
			collectionName,
			relationships,
			stateRefs,
		)

		// Atomically update in state
		yield* Ref.update(ref, (map) => {
			const next = new Map(map)
			next.set(id, validated)
			return next
		})

		return validated
	})

// ============================================================================
// Legacy Exports (backward compatibility for unmigrated factory)
// These will be removed when core/factories/database.ts is migrated (task 10)
// ============================================================================

export { createUpdateWithRelationshipsMethod } from "./update-with-relationships-legacy.js"
