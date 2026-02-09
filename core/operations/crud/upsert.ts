/**
 * Effect-based upsert operations for entities.
 *
 * Uses Ref<ReadonlyMap> for atomic state mutation, Effect Schema for validation,
 * and typed errors (ValidationError, ForeignKeyError).
 *
 * Upsert = find by `where` clause → update if exists, create if not.
 */

import { Effect, Ref, Schema } from "effect"
import type {
	CreateInput,
	UpdateWithOperators,
	MinimalEntity,
	UpsertInput,
	UpsertResult,
	UpsertManyResult,
} from "../../types/crud-types.js"
import {
	ForeignKeyError,
	ValidationError,
} from "../../errors/crud-errors.js"
import { validateEntity } from "../../validators/schema-validator.js"
import { generateId } from "../../utils/id-generator.js"
import { applyUpdates } from "./update.js"
import {
	extractForeignKeyConfigs,
} from "../../validators/foreign-key.js"

// ============================================================================
// Types
// ============================================================================

type HasId = { readonly id: string }

type RelationshipConfig = {
	readonly type: "ref" | "inverse"
	readonly target: string
	readonly foreignKey?: string
}

// ============================================================================
// Foreign Key Validation (Effect-based bridge)
// ============================================================================

/**
 * Validate foreign keys for an entity using Ref-based state.
 * Returns Effect that fails with ForeignKeyError if a violation is found.
 */
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
// Find by Where Clause
// ============================================================================

/**
 * Find an entity in a ReadonlyMap matching all fields in the where clause.
 * If `where` contains `id`, uses O(1) lookup. Otherwise scans all values.
 */
const findByWhere = <T extends HasId>(
	map: ReadonlyMap<string, T>,
	where: Record<string, unknown>,
): T | undefined => {
	// Fast path: if where has `id`, use direct lookup
	if ("id" in where && typeof where.id === "string") {
		const candidate = map.get(where.id)
		if (candidate === undefined) return undefined
		// Verify all other where fields match
		for (const [key, value] of Object.entries(where)) {
			if ((candidate as Record<string, unknown>)[key] !== value) {
				return undefined
			}
		}
		return candidate
	}

	// Slow path: scan all entities
	for (const entity of map.values()) {
		let matches = true
		for (const [key, value] of Object.entries(where)) {
			if ((entity as Record<string, unknown>)[key] !== value) {
				matches = false
				break
			}
		}
		if (matches) return entity
	}

	return undefined
}

// ============================================================================
// Upsert Single Entity
// ============================================================================

/**
 * Upsert a single entity: find by `where`, update if exists, create if not.
 *
 * Steps:
 * 1. Look up entity by where clause in Ref state
 * 2a. If found: apply update operators, validate, update in state
 * 2b. If not found: merge where + create data, generate ID/timestamps, validate, add to state
 * 3. Validate foreign key constraints
 * 4. Return entity with __action metadata
 */
export const upsert = <T extends HasId, I = T>(
	collectionName: string,
	schema: Schema.Schema<T, I>,
	relationships: Record<string, RelationshipConfig>,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
) =>
(input: UpsertInput<T>): Effect.Effect<UpsertResult<T>, ValidationError | ForeignKeyError> =>
	Effect.gen(function* () {
		const currentMap = yield* Ref.get(ref)
		const where = input.where as Record<string, unknown>
		const existing = findByWhere(currentMap, where)

		if (existing !== undefined) {
			// === UPDATE PATH ===
			const updated = applyUpdates(
				existing as T & MinimalEntity,
				input.update as UpdateWithOperators<T & MinimalEntity>,
			)

			// Validate through Effect Schema
			const validated = yield* validateEntity(schema, updated)

			// Validate foreign keys if relationship fields were updated
			const relationshipFields = Object.keys(relationships).map(
				(field) => relationships[field].foreignKey || `${field}Id`,
			)
			const hasRelationshipUpdate = Object.keys(input.update).some((key) =>
				relationshipFields.includes(key),
			)

			if (hasRelationshipUpdate) {
				yield* validateForeignKeysEffect(
					validated,
					collectionName,
					relationships,
					stateRefs,
				)
			}

			// Atomically update in state
			yield* Ref.update(ref, (map) => {
				const next = new Map(map)
				next.set(existing.id, validated)
				return next
			})

			return { ...validated, __action: "updated" as const }
		}

		// === CREATE PATH ===
		const id = (typeof where.id === "string" ? where.id : undefined) || generateId()
		const now = new Date().toISOString()

		const createData = {
			...where,
			...input.create,
			id,
			createdAt: now,
			updatedAt: now,
		}

		// Validate through Effect Schema
		const validated = yield* validateEntity(schema, createData)

		// Validate foreign keys
		yield* validateForeignKeysEffect(
			validated,
			collectionName,
			relationships,
			stateRefs,
		)

		// Atomically add to state
		yield* Ref.update(ref, (map) => {
			const next = new Map(map)
			next.set(id, validated)
			return next
		})

		return { ...validated, __action: "created" as const }
	})

// ============================================================================
// Upsert Multiple Entities
// ============================================================================

/**
 * Upsert multiple entities efficiently.
 *
 * For each input:
 * - If entity matches where clause: apply updates (or skip if unchanged)
 * - If no match: create new entity
 *
 * All changes validated and applied atomically.
 * Returns categorized results: created, updated, unchanged.
 */
export const upsertMany = <T extends HasId, I = T>(
	collectionName: string,
	schema: Schema.Schema<T, I>,
	relationships: Record<string, RelationshipConfig>,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
) =>
(inputs: ReadonlyArray<UpsertInput<T>>): Effect.Effect<UpsertManyResult<T>, ValidationError | ForeignKeyError> =>
	Effect.gen(function* () {
		const currentMap = yield* Ref.get(ref)
		const created: T[] = []
		const updated: T[] = []
		const unchanged: T[] = []
		const now = new Date().toISOString()

		// Phase 1: Process all inputs, validate, and categorize
		const toCreate: T[] = []
		const toUpdate: T[] = []

		for (let i = 0; i < inputs.length; i++) {
			const input = inputs[i]!
			const where = input.where as Record<string, unknown>
			const existing = findByWhere(currentMap, where)

			if (existing !== undefined) {
				// Check if update would change anything
				const wouldChange = Object.keys(input.update).some((key) => {
					const updateValue = (input.update as Record<string, unknown>)[key]
					const currentValue = (existing as Record<string, unknown>)[key]

					// Operator-based updates always cause a change
					if (
						typeof updateValue === "object" &&
						updateValue !== null &&
						!Array.isArray(updateValue)
					) {
						return true
					}

					return updateValue !== currentValue
				})

				if (!wouldChange) {
					unchanged.push(existing)
					continue
				}

				// Apply updates
				const updatedEntity = applyUpdates(
					existing as T & MinimalEntity,
					input.update as UpdateWithOperators<T & MinimalEntity>,
				)

				// Validate
				const validated = yield* validateEntity(schema, updatedEntity)
				toUpdate.push(validated)
			} else {
				// Create new entity
				const id = (typeof where.id === "string" ? where.id : undefined) || generateId()

				const createData = {
					...where,
					...input.create,
					id,
					createdAt: now,
					updatedAt: now,
				}

				// Validate
				const validated = yield* validateEntity(schema, createData)
				toCreate.push(validated)
			}
		}

		// Phase 2: Validate foreign keys for all entities being created or updated
		for (const entity of [...toCreate, ...toUpdate]) {
			yield* validateForeignKeysEffect(
				entity,
				collectionName,
				relationships,
				stateRefs,
			)
		}

		// Phase 3: Atomically apply all changes to state
		if (toCreate.length > 0 || toUpdate.length > 0) {
			yield* Ref.update(ref, (map) => {
				const next = new Map(map)
				for (const entity of toCreate) {
					next.set(entity.id, entity)
				}
				for (const entity of toUpdate) {
					next.set(entity.id, entity)
				}
				return next
			})
		}

		created.push(...toCreate)
		updated.push(...toUpdate)

		return { created, updated, unchanged }
	})

// ============================================================================
// Legacy Exports (backward compatibility for unmigrated factory)
// These will be removed when core/factories/database.ts is migrated (task 10)
// ============================================================================

export { createUpsertMethod, createUpsertManyMethod, extractUniqueFieldsFromSchema, validateUniqueWhere, createCompoundKey } from "./upsert-legacy.js"
