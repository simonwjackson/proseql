/**
 * Effect-based create operations for entities.
 *
 * Uses Ref<ReadonlyMap> for atomic state mutation, Effect Schema for validation,
 * and typed errors (ValidationError, DuplicateKeyError, ForeignKeyError).
 */

import { Effect, Ref, Schema } from "effect"
import type {
	CreateInput,
	CreateManyOptions,
	CreateManyResult,
} from "../../types/crud-types.js"
import {
	DuplicateKeyError,
	ForeignKeyError,
	ValidationError,
} from "../../errors/crud-errors.js"
import { validateEntity } from "../../validators/schema-validator.js"
import { generateId } from "../../utils/id-generator.js"
import {
	validateForeignKeysEffect,
} from "../../validators/foreign-key.js"
import type { CollectionIndexes } from "../../types/index-types.js"
import { addToIndex, addManyToIndex } from "../../indexes/index-manager.js"

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
// Create Single Entity
// ============================================================================

/**
 * Create a single entity with validation and foreign key checks.
 *
 * Steps:
 * 1. Generate ID if not provided, add timestamps
 * 2. Validate through Effect Schema
 * 3. Check for duplicate ID in Ref state
 * 4. Validate foreign key constraints
 * 5. Atomically add to Ref state
 * 6. Update indexes if provided
 */
export const create = <T extends HasId, I = T>(
	collectionName: string,
	schema: Schema.Schema<T, I>,
	relationships: Record<string, RelationshipConfig>,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
	indexes?: CollectionIndexes,
) =>
(input: CreateInput<T>): Effect.Effect<T, ValidationError | DuplicateKeyError | ForeignKeyError> =>
	Effect.gen(function* () {
		const id = (input as Record<string, unknown>).id as string | undefined || generateId()
		const now = new Date().toISOString()

		// Build raw entity object for schema validation
		const raw = {
			...input,
			id,
			createdAt: now,
			updatedAt: now,
		}

		// Validate through Effect Schema
		const validated = yield* validateEntity(schema, raw)

		// Check for duplicate ID atomically
		const currentMap = yield* Ref.get(ref)
		if (currentMap.has(id)) {
			return yield* Effect.fail(
				new DuplicateKeyError({
					collection: collectionName,
					field: "id",
					value: id,
					existingId: id,
					message: `Duplicate value for field 'id': "${id}"`,
				}),
			)
		}

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

		// Update indexes if provided
		if (indexes && indexes.size > 0) {
			yield* addToIndex(indexes, validated)
		}

		return validated
	})

// ============================================================================
// Create Multiple Entities
// ============================================================================

/**
 * Create multiple entities with batch validation and optional duplicate skipping.
 *
 * When `skipDuplicates` is true, entities that fail validation or have duplicate IDs
 * are skipped and reported in the result. Otherwise, the first error stops the operation.
 */
export const createMany = <T extends HasId, I = T>(
	collectionName: string,
	schema: Schema.Schema<T, I>,
	relationships: Record<string, RelationshipConfig>,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
	indexes?: CollectionIndexes,
) =>
(
	inputs: ReadonlyArray<CreateInput<T>>,
	options?: CreateManyOptions,
): Effect.Effect<CreateManyResult<T>, ValidationError | DuplicateKeyError | ForeignKeyError> =>
	Effect.gen(function* () {
		const created: T[] = []
		const skipped: Array<{ data: Partial<T>; reason: string }> = []
		const now = new Date().toISOString()
		const skipOnError = options?.skipDuplicates === true

		// Get current state once for duplicate checking
		const currentMap = yield* Ref.get(ref)
		const existingIds = new Set(currentMap.keys())
		// Track IDs we're adding in this batch
		const batchIds = new Set<string>()

		// Phase 1: Validate all entities and collect valid ones
		const validEntities: T[] = []

		for (const input of inputs) {
			const id = (input as Record<string, unknown>).id as string | undefined || generateId()

			// Check for duplicate ID
			if (existingIds.has(id) || batchIds.has(id)) {
				if (skipOnError) {
					skipped.push({
						data: { ...input, id } as Partial<T>,
						reason: `Duplicate ID: ${id}`,
					})
					continue
				}
				return yield* Effect.fail(
					new DuplicateKeyError({
						collection: collectionName,
						field: "id",
						value: id,
						existingId: id,
						message: `Duplicate value for field 'id': "${id}"`,
					}),
				)
			}

			const raw = { ...input, id, createdAt: now, updatedAt: now }

			// Validate through schema
			const validationResult = yield* validateEntity(schema, raw).pipe(
				Effect.map((validated) => ({ _tag: "ok" as const, validated })),
				Effect.catchTag("ValidationError", (err) =>
					skipOnError
						? Effect.succeed({ _tag: "skipped" as const, error: err })
						: Effect.fail(err),
				),
			)

			if (validationResult._tag === "skipped") {
				skipped.push({
					data: { ...input, id } as Partial<T>,
					reason: `Validation failed: ${validationResult.error.issues[0]?.message ?? "unknown"}`,
				})
				continue
			}

			const validated = validationResult.validated
			batchIds.add(id)
			validEntities.push(validated)
		}

		// Phase 2: Validate foreign keys if requested
		if (options?.validateRelationships !== false) {
			const finalEntities: T[] = []

			for (let i = 0; i < validEntities.length; i++) {
				const entity = validEntities[i]!
				const fkResult = yield* validateForeignKeysEffect(
					entity,
					collectionName,
					relationships,
					stateRefs,
				).pipe(
					Effect.map(() => ({ _tag: "ok" as const })),
					Effect.catchTag("ForeignKeyError", (err) =>
						skipOnError
							? Effect.succeed({ _tag: "skipped" as const, error: err })
							: Effect.fail(err),
					),
				)

				if (fkResult._tag === "skipped") {
					skipped.push({
						data: entity as Partial<T>,
						reason: `Foreign key violation: ${fkResult.error.message}`,
					})
				} else {
					finalEntities.push(entity)
					created.push(entity)
				}
			}

			// Atomically add all valid entities to state
			if (finalEntities.length > 0) {
				yield* Ref.update(ref, (map) => {
					const next = new Map(map)
					for (const entity of finalEntities) {
						next.set(entity.id, entity)
					}
					return next
				})
			}
		} else {
			// No FK validation, add all validated entities
			created.push(...validEntities)
			if (validEntities.length > 0) {
				yield* Ref.update(ref, (map) => {
					const next = new Map(map)
					for (const entity of validEntities) {
						next.set(entity.id, entity)
					}
					return next
				})
			}
		}

		// Update indexes for all created entities using batch operation
		if (indexes && indexes.size > 0 && created.length > 0) {
			yield* addManyToIndex(indexes, created)
		}

		return {
			created,
			...(skipped.length > 0 ? { skipped } : {}),
		} as CreateManyResult<T>
	})

// ============================================================================
// Helper Functions
// ============================================================================


/**
 * Check for unique constraint violations against existing data in a Ref.
 */
export const checkUniqueConstraints = <T extends HasId>(
	entity: T,
	existingMap: ReadonlyMap<string, T>,
	uniqueFields: ReadonlyArray<string>,
): { readonly valid: boolean; readonly field?: string; readonly value?: unknown; readonly existingId?: string } => {
	for (const field of uniqueFields) {
		const value = (entity as Record<string, unknown>)[field]
		if (value === undefined || value === null) continue

		for (const [existingId, existing] of existingMap) {
			if (
				(existing as Record<string, unknown>)[field] === value &&
				existingId !== entity.id
			) {
				return { valid: false, field, value, existingId }
			}
		}
	}

	return { valid: true }
}
