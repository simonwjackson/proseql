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
	HookError,
	UniqueConstraintError,
	ValidationError,
} from "../../errors/crud-errors.js"
import { validateEntity } from "../../validators/schema-validator.js"
import { generateId } from "../../utils/id-generator.js"
import {
	validateForeignKeysEffect,
} from "../../validators/foreign-key.js"
import type { CollectionIndexes } from "../../types/index-types.js"
import { addToIndex, addManyToIndex } from "../../indexes/index-manager.js"
import type { SearchIndexMap } from "../../types/search-types.js"
import { addToSearchIndex } from "../../indexes/search-index.js"
import type { HooksConfig } from "../../types/hook-types.js"
import { runBeforeCreateHooks, runAfterCreateHooks, runOnChangeHooks } from "../../hooks/hook-runner.js"
import { checkUniqueConstraints, checkEntityUniqueConstraints, addEntityToBatchIndex, type NormalizedConstraints } from "./unique-check.js"
import type { ComputedFieldsConfig } from "../../types/computed-types.js"

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
 * Strip computed field keys from an input object.
 * Used to remove computed field names from create/update input before schema validation.
 *
 * @param input - The input object (possibly with computed field keys)
 * @param computed - The computed fields configuration that defines which keys to strip
 * @returns A new object with computed field keys removed
 */
const stripComputedFromInput = <T>(
	input: T,
	computed: ComputedFieldsConfig<unknown> | undefined,
): T => {
	if (computed === undefined || Object.keys(computed).length === 0) {
		return input
	}

	const computedKeys = new Set(Object.keys(computed))
	const result: Record<string, unknown> = {}

	for (const key of Object.keys(input as Record<string, unknown>)) {
		if (!computedKeys.has(key)) {
			result[key] = (input as Record<string, unknown>)[key]
		}
	}

	return result as T
}

/**
 * Create a single entity with validation, hooks, and foreign key checks.
 *
 * Steps:
 * 1. Strip computed field keys from input (they are derived, not stored)
 * 2. Generate ID if not provided, add timestamps
 * 3. Validate through Effect Schema
 * 4. Run beforeCreate hooks (can transform entity)
 * 5. Check for duplicate ID in Ref state
 * 6. Validate foreign key constraints
 * 7. Atomically add to Ref state
 * 8. Update indexes if provided
 */
export const create = <T extends HasId, I = T>(
	collectionName: string,
	schema: Schema.Schema<T, I>,
	relationships: Record<string, RelationshipConfig>,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
	indexes?: CollectionIndexes,
	hooks?: HooksConfig<T>,
	uniqueFields: NormalizedConstraints = [],
	computed?: ComputedFieldsConfig<unknown>,
	searchIndexRef?: Ref.Ref<SearchIndexMap>,
	searchIndexFields?: ReadonlyArray<string>,
) =>
(input: CreateInput<T>): Effect.Effect<T, ValidationError | DuplicateKeyError | ForeignKeyError | HookError | UniqueConstraintError> =>
	Effect.gen(function* () {
		// Strip computed field keys from input (they are derived, not stored)
		const sanitizedInput = stripComputedFromInput(input, computed)

		const id = (sanitizedInput as Record<string, unknown>).id as string | undefined || generateId()
		const now = new Date().toISOString()

		// Build raw entity object for schema validation
		const raw = {
			...sanitizedInput,
			id,
			createdAt: now,
			updatedAt: now,
		}

		// Validate through Effect Schema
		const validated = yield* validateEntity(schema, raw)

		// Run beforeCreate hooks (can transform the entity)
		const entity = yield* runBeforeCreateHooks(hooks?.beforeCreate, {
			operation: "create",
			collection: collectionName,
			data: validated,
		})

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

		// Check unique constraints
		yield* checkUniqueConstraints(entity, currentMap, uniqueFields, collectionName)

		// Validate foreign keys
		yield* validateForeignKeysEffect(
			entity,
			collectionName,
			relationships,
			stateRefs,
		)

		// Atomically add to state
		yield* Ref.update(ref, (map) => {
			const next = new Map(map)
			next.set(id, entity)
			return next
		})

		// Update indexes if provided
		if (indexes && indexes.size > 0) {
			yield* addToIndex(indexes, entity)
		}

		// Update search index if configured
		if (searchIndexRef && searchIndexFields && searchIndexFields.length > 0) {
			yield* addToSearchIndex(searchIndexRef, entity, searchIndexFields)
		}

		// Run afterCreate hooks (fire-and-forget, errors swallowed)
		yield* runAfterCreateHooks(hooks?.afterCreate, {
			operation: "create",
			collection: collectionName,
			entity,
		})

		// Run onChange hooks with type: "create" (fire-and-forget, errors swallowed)
		yield* runOnChangeHooks(hooks?.onChange, {
			type: "create",
			collection: collectionName,
			entity,
		})

		return entity
	})

// ============================================================================
// Create Multiple Entities
// ============================================================================

/**
 * Create multiple entities with batch validation, hooks, and optional duplicate skipping.
 *
 * When `skipDuplicates` is true, entities that fail validation, have duplicate IDs,
 * or have a HookError are skipped and reported in the result. Otherwise, the first error
 * stops the operation.
 */
export const createMany = <T extends HasId, I = T>(
	collectionName: string,
	schema: Schema.Schema<T, I>,
	relationships: Record<string, RelationshipConfig>,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
	indexes?: CollectionIndexes,
	hooks?: HooksConfig<T>,
	uniqueFields: NormalizedConstraints = [],
	computed?: ComputedFieldsConfig<unknown>,
	searchIndexRef?: Ref.Ref<SearchIndexMap>,
	searchIndexFields?: ReadonlyArray<string>,
) =>
(
	inputs: ReadonlyArray<CreateInput<T>>,
	options?: CreateManyOptions,
): Effect.Effect<CreateManyResult<T>, ValidationError | DuplicateKeyError | ForeignKeyError | HookError | UniqueConstraintError> =>
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

		// Phase 1: Validate all entities and run beforeCreate hooks
		const validEntities: T[] = []

		for (const input of inputs) {
			// Strip computed field keys from input (they are derived, not stored)
			const sanitizedInput = stripComputedFromInput(input, computed)
			const id = (sanitizedInput as Record<string, unknown>).id as string | undefined || generateId()

			// Check for duplicate ID
			if (existingIds.has(id) || batchIds.has(id)) {
				if (skipOnError) {
					skipped.push({
						data: { ...sanitizedInput, id } as Partial<T>,
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

			const raw = { ...sanitizedInput, id, createdAt: now, updatedAt: now }

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
					data: { ...sanitizedInput, id } as Partial<T>,
					reason: `Validation failed: ${validationResult.error.issues[0]?.message ?? "unknown"}`,
				})
				continue
			}

			const validated = validationResult.validated

			// Run beforeCreate hooks (can transform or reject the entity)
			const hookResult = yield* runBeforeCreateHooks(hooks?.beforeCreate, {
				operation: "create",
				collection: collectionName,
				data: validated,
			}).pipe(
				Effect.map((entity) => ({ _tag: "ok" as const, entity })),
				Effect.catchTag("HookError", (err) =>
					skipOnError
						? Effect.succeed({ _tag: "skipped" as const, error: err })
						: Effect.fail(err),
				),
			)

			if (hookResult._tag === "skipped") {
				skipped.push({
					data: { ...sanitizedInput, id } as Partial<T>,
					reason: `Hook rejected: ${hookResult.error.message}`,
				})
				continue
			}

			batchIds.add(id)
			validEntities.push(hookResult.entity)
		}

		// Phase 2: Check unique constraints (with per-entity skipDuplicates handling)
		// We check incrementally to support skipDuplicates for unique violations
		const uniquePassedEntities: T[] = []
		// Track constraint values we've seen in this batch for inter-batch conflict detection
		// Key: constraintName + ":" + serialized values, Value: entity id
		const batchConstraintIndex = new Map<string, string>()

		for (const entity of validEntities) {
			const entityRecord = entity as Record<string, unknown>

			// Check this entity against existing map and batch index
			const uniqueResult = yield* checkEntityUniqueConstraints(
				entity,
				entityRecord,
				currentMap,
				uniqueFields,
				collectionName,
				batchConstraintIndex,
			).pipe(
				Effect.map(() => ({ _tag: "ok" as const })),
				Effect.catchTag("UniqueConstraintError", (err) =>
					skipOnError
						? Effect.succeed({ _tag: "skipped" as const, error: err })
						: Effect.fail(err),
				),
			)

			if (uniqueResult._tag === "skipped") {
				skipped.push({
					data: entity as Partial<T>,
					reason: `Unique constraint violation: ${uniqueResult.error.message}`,
				})
				continue
			}

			// Add this entity to the batch constraint index for subsequent checks
			addEntityToBatchIndex(entity, entityRecord, uniqueFields, batchConstraintIndex)
			uniquePassedEntities.push(entity)
		}

		// Phase 3: Validate foreign keys if requested
		if (options?.validateRelationships !== false) {
			const finalEntities: T[] = []

			for (let i = 0; i < uniquePassedEntities.length; i++) {
				const entity = uniquePassedEntities[i]!
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
			// No FK validation, add all unique-passed entities
			created.push(...uniquePassedEntities)
			if (uniquePassedEntities.length > 0) {
				yield* Ref.update(ref, (map) => {
					const next = new Map(map)
					for (const entity of uniquePassedEntities) {
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

		// Update search index for all created entities
		if (searchIndexRef && searchIndexFields && searchIndexFields.length > 0 && created.length > 0) {
			for (const entity of created) {
				yield* addToSearchIndex(searchIndexRef, entity, searchIndexFields)
			}
		}

		// Phase 3: Run afterCreate and onChange hooks for each created entity
		for (const entity of created) {
			yield* runAfterCreateHooks(hooks?.afterCreate, {
				operation: "create",
				collection: collectionName,
				entity,
			})

			yield* runOnChangeHooks(hooks?.onChange, {
				type: "create",
				collection: collectionName,
				entity,
			})
		}

		return {
			created,
			...(skipped.length > 0 ? { skipped } : {}),
		} as CreateManyResult<T>
	})

