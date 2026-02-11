/**
 * Effect-based update operations for entities.
 *
 * Uses Ref<ReadonlyMap> for atomic state mutation, Effect Schema for validation,
 * and typed errors (ValidationError, NotFoundError, ForeignKeyError).
 *
 * Preserves all update operators: $increment, $decrement, $multiply,
 * $append, $prepend, $remove, $toggle, $set.
 */

import { Effect, Ref, Schema } from "effect"
import type {
	MinimalEntity,
	UpdateWithOperators,
	UpdateManyResult,
} from "../../types/crud-types.js"
import {
	NotFoundError,
	ForeignKeyError,
	ValidationError,
	HookError,
} from "../../errors/crud-errors.js"
import { validateEntity } from "../../validators/schema-validator.js"
import {
	validateForeignKeysEffect,
} from "../../validators/foreign-key.js"
import type { CollectionIndexes } from "../../types/index-types.js"
import { updateInIndex } from "../../indexes/index-manager.js"
import type { HooksConfig } from "../../types/hook-types.js"
import { runBeforeUpdateHooks, runAfterUpdateHooks, runOnChangeHooks } from "../../hooks/hook-runner.js"

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
// Update Operators Implementation
// ============================================================================

/**
 * Apply update operators to a value.
 * Supports: $increment, $decrement, $multiply (number),
 *           $append, $prepend (string/array), $remove (array),
 *           $toggle (boolean), $set (all types).
 */
function applyOperator<T>(
	currentValue: T,
	operator: Record<string, unknown>,
): T {
	// Number operators
	if (typeof currentValue === "number") {
		if ("$increment" in operator && typeof operator.$increment === "number") {
			return (currentValue + operator.$increment) as T
		}
		if ("$decrement" in operator && typeof operator.$decrement === "number") {
			return (currentValue - operator.$decrement) as T
		}
		if ("$multiply" in operator && typeof operator.$multiply === "number") {
			return (currentValue * operator.$multiply) as T
		}
		if ("$set" in operator) {
			return operator.$set as T
		}
	}

	// String operators
	if (typeof currentValue === "string") {
		if ("$append" in operator && typeof operator.$append === "string") {
			return (currentValue + operator.$append) as T
		}
		if ("$prepend" in operator && typeof operator.$prepend === "string") {
			return (operator.$prepend + currentValue) as T
		}
		if ("$set" in operator) {
			return operator.$set as T
		}
	}

	// Array operators
	if (Array.isArray(currentValue)) {
		if ("$append" in operator) {
			const toAppend = Array.isArray(operator.$append)
				? operator.$append
				: [operator.$append]
			return [...currentValue, ...toAppend] as T
		}
		if ("$prepend" in operator) {
			const toPrepend = Array.isArray(operator.$prepend)
				? operator.$prepend
				: [operator.$prepend]
			return [...toPrepend, ...currentValue] as T
		}
		if ("$remove" in operator) {
			if (typeof operator.$remove === "function") {
				return currentValue.filter(
					(item) => !(operator.$remove as (item: unknown) => boolean)(item),
				) as T
			}
			return currentValue.filter((item) => item !== operator.$remove) as T
		}
		if ("$set" in operator) {
			return operator.$set as T
		}
	}

	// Boolean operators
	if (typeof currentValue === "boolean") {
		if ("$toggle" in operator && operator.$toggle === true) {
			return !currentValue as T
		}
		if ("$set" in operator) {
			return operator.$set as T
		}
	}

	// Default: just set the value
	if ("$set" in operator) {
		return operator.$set as T
	}

	// If no operator matched, return current value
	return currentValue
}

/**
 * Apply update operations to an entity.
 * Handles both direct value assignments and operator objects.
 * Automatically sets updatedAt timestamp.
 */
export function applyUpdates<T extends MinimalEntity>(
	entity: T,
	updates: UpdateWithOperators<T>,
): T {
	const updated = { ...entity }
	const now = new Date().toISOString()

	for (const [key, value] of Object.entries(updates)) {
		if (key === "updatedAt" && !value) {
			// Auto-set updatedAt if not provided
			(updated as Record<string, unknown>).updatedAt = now
		} else if (value !== undefined || value === null) {
			// Check if it's an operator
			if (
				typeof value === "object" &&
				value !== null &&
				!Array.isArray(value)
			) {
				const hasOperator = Object.keys(value).some((k) => k.startsWith("$"))
				if (hasOperator) {
					const currentValue = (entity as Record<string, unknown>)[key]
					;(updated as Record<string, unknown>)[key] = applyOperator(
						currentValue,
						value,
					)
				} else {
					// Direct assignment (for nested objects)
					(updated as Record<string, unknown>)[key] = value
				}
			} else {
				// Direct assignment (including null values)
				(updated as Record<string, unknown>)[key] = value
			}
		}
	}

	// Ensure updatedAt is set
	if (!("updatedAt" in updates)) {
		(updated as Record<string, unknown>).updatedAt = now
	}

	return updated
}

/**
 * Validate that an update doesn't violate immutable fields (id, createdAt).
 */
export function validateImmutableFields<T extends MinimalEntity>(
	updates: UpdateWithOperators<T>,
): { readonly valid: boolean; readonly field?: string } {
	const immutableFields = ["id", "createdAt"] as const

	for (const field of immutableFields) {
		if (field in updates) {
			return { valid: false, field }
		}
	}

	return { valid: true }
}

// ============================================================================
// Update Single Entity
// ============================================================================

/**
 * Update a single entity by ID with validation, hooks, and foreign key checks.
 *
 * Steps:
 * 1. Validate immutable fields are not being modified
 * 2. Look up entity by ID in Ref state (O(1)) - capture as previous
 * 3. Run beforeUpdate hooks (can transform update payload)
 * 4. Apply update operators to produce new entity
 * 5. Validate through Effect Schema
 * 6. Validate foreign key constraints if relationship fields changed
 * 7. Atomically update in Ref state
 * 8. Update indexes if provided
 */
export const update = <T extends HasId, I = T>(
	collectionName: string,
	schema: Schema.Schema<T, I>,
	relationships: Record<string, RelationshipConfig>,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
	indexes?: CollectionIndexes,
	hooks?: HooksConfig<T>,
) =>
(id: string, updates: UpdateWithOperators<T & MinimalEntity>): Effect.Effect<T, ValidationError | NotFoundError | ForeignKeyError | HookError> =>
	Effect.gen(function* () {
		// Validate immutable fields
		const immutableCheck = validateImmutableFields(updates)
		if (!immutableCheck.valid) {
			return yield* Effect.fail(
				new ValidationError({
					message: `Cannot update immutable field: ${immutableCheck.field}`,
					issues: [{
						field: immutableCheck.field!,
						message: `Cannot update immutable field: ${immutableCheck.field}`,
					}],
				}),
			)
		}

		// Look up entity by ID (O(1)) - capture as previous for hooks
		const currentMap = yield* Ref.get(ref)
		const previous = currentMap.get(id)
		if (previous === undefined) {
			return yield* Effect.fail(
				new NotFoundError({
					collection: collectionName,
					id,
					message: `Entity '${id}' not found in collection '${collectionName}'`,
				}),
			)
		}

		// Run beforeUpdate hooks (can transform the update payload)
		const transformedUpdates = yield* runBeforeUpdateHooks(hooks?.beforeUpdate, {
			operation: "update",
			collection: collectionName,
			id,
			existing: previous,
			update: updates,
		})

		// Apply update operators with (possibly transformed) updates
		const updated = applyUpdates(previous as T & MinimalEntity, transformedUpdates as UpdateWithOperators<T & MinimalEntity>)

		// Validate through Effect Schema
		const validated = yield* validateEntity(schema, updated)

		// Validate foreign keys if any relationship fields were updated
		const relationshipFields = Object.keys(relationships).map(
			(field) => relationships[field].foreignKey || `${field}Id`,
		)
		const hasRelationshipUpdate = Object.keys(transformedUpdates).some((key) =>
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
			next.set(id, validated)
			return next
		})

		// Update indexes if provided
		if (indexes && indexes.size > 0) {
			yield* updateInIndex(indexes, previous, validated)
		}

		// Run afterUpdate hooks (fire-and-forget, errors swallowed)
		yield* runAfterUpdateHooks(hooks?.afterUpdate, {
			operation: "update",
			collection: collectionName,
			id,
			previous,
			current: validated,
			update: transformedUpdates,
		})

		// Run onChange hooks with type: "update" (fire-and-forget, errors swallowed)
		yield* runOnChangeHooks(hooks?.onChange, {
			type: "update",
			collection: collectionName,
			id,
			previous,
			current: validated,
		})

		return validated
	})

// ============================================================================
// Update Multiple Entities
// ============================================================================

/**
 * Update multiple entities matching a filter predicate.
 *
 * Uses a predicate function to select which entities to update.
 * The caller (database factory) can use the Stream-based filter pipeline
 * to build the predicate from a WhereClause.
 *
 * All matching entities are updated atomically in a single Ref.update call.
 */
export const updateMany = <T extends HasId, I = T>(
	collectionName: string,
	schema: Schema.Schema<T, I>,
	relationships: Record<string, RelationshipConfig>,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
	indexes?: CollectionIndexes,
) =>
(
	predicate: (entity: T) => boolean,
	updates: UpdateWithOperators<T & MinimalEntity>,
): Effect.Effect<UpdateManyResult<T>, ValidationError | ForeignKeyError> =>
	Effect.gen(function* () {
		// Validate immutable fields
		const immutableCheck = validateImmutableFields(updates)
		if (!immutableCheck.valid) {
			return yield* Effect.fail(
				new ValidationError({
					message: `Cannot update immutable field: ${immutableCheck.field}`,
					issues: [{
						field: immutableCheck.field!,
						message: `Cannot update immutable field: ${immutableCheck.field}`,
					}],
				}),
			)
		}

		// Get current state and find matching entities
		const currentMap = yield* Ref.get(ref)
		const matchingEntities: T[] = []
		for (const entity of currentMap.values()) {
			if (predicate(entity)) {
				matchingEntities.push(entity)
			}
		}

		if (matchingEntities.length === 0) {
			return { count: 0, updated: [] }
		}

		// Apply updates and validate each entity
		const validatedEntities: T[] = []

		for (const entity of matchingEntities) {
			const updated = applyUpdates(entity as T & MinimalEntity, updates)
			const validated = yield* validateEntity(schema, updated)
			validatedEntities.push(validated)
		}

		// Validate foreign keys if relationship fields were updated
		const relationshipFields = Object.keys(relationships).map(
			(field) => relationships[field].foreignKey || `${field}Id`,
		)
		const hasRelationshipUpdate = Object.keys(updates).some((key) =>
			relationshipFields.includes(key),
		)

		if (hasRelationshipUpdate) {
			for (const entity of validatedEntities) {
				yield* validateForeignKeysEffect(
					entity,
					collectionName,
					relationships,
					stateRefs,
				)
			}
		}

		// Atomically update all matching entities in state
		yield* Ref.update(ref, (map) => {
			const next = new Map(map)
			for (const entity of validatedEntities) {
				next.set((entity as HasId).id, entity)
			}
			return next
		})

		// Update indexes if provided
		if (indexes && indexes.size > 0) {
			for (let i = 0; i < matchingEntities.length; i++) {
				yield* updateInIndex(indexes, matchingEntities[i]!, validatedEntities[i]!)
			}
		}

		return {
			count: validatedEntities.length,
			updated: validatedEntities,
		}
	})

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract fields that were actually changed between two entity versions.
 */
export function getChangedFields<T extends MinimalEntity>(
	original: T,
	updated: T,
): string[] {
	const changed: string[] = []

	for (const key of Object.keys(updated) as Array<keyof T>) {
		if (original[key] !== updated[key]) {
			changed.push(String(key))
		}
	}

	return changed
}

