/**
 * Effect-based update operations for entities.
 *
 * Uses Ref<ReadonlyMap> for atomic state mutation, Effect Schema for validation,
 * and typed errors (ValidationError, NotFoundError, ForeignKeyError).
 *
 * Preserves all update operators: $increment, $decrement, $multiply,
 * $append, $prepend, $remove, $toggle, $set.
 */

import { Effect, PubSub, Ref, type Schema } from "effect";
import {
	type ForeignKeyError,
	type HookError,
	NotFoundError,
	type UniqueConstraintError,
	ValidationError,
} from "../../errors/crud-errors.js";
import {
	runAfterUpdateHooks,
	runBeforeUpdateHooks,
	runOnChangeHooks,
} from "../../hooks/hook-runner.js";
import { updateInIndex } from "../../indexes/index-manager.js";
import { updateInSearchIndex } from "../../indexes/search-index.js";
import type { ComputedFieldsConfig } from "../../types/computed-types.js";
import type {
	MinimalEntity,
	UpdateManyResult,
	UpdateWithOperators,
} from "../../types/crud-types.js";
import type { HooksConfig } from "../../types/hook-types.js";
import type { CollectionIndexes } from "../../types/index-types.js";
import type { ChangeEvent } from "../../types/reactive-types.js";
import type { SearchIndexMap } from "../../types/search-types.js";
import { validateForeignKeysEffect } from "../../validators/foreign-key.js";
import { validateEntity } from "../../validators/schema-validator.js";
import {
	checkUniqueConstraints,
	type NormalizedConstraints,
} from "./unique-check.js";

// ============================================================================
// Types
// ============================================================================

type HasId = { readonly id: string };

type RelationshipConfig = {
	readonly type: "ref" | "inverse";
	readonly target: string;
	readonly foreignKey?: string;
};

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
			return (currentValue + operator.$increment) as T;
		}
		if ("$decrement" in operator && typeof operator.$decrement === "number") {
			return (currentValue - operator.$decrement) as T;
		}
		if ("$multiply" in operator && typeof operator.$multiply === "number") {
			return (currentValue * operator.$multiply) as T;
		}
		if ("$set" in operator) {
			return operator.$set as T;
		}
	}

	// String operators
	if (typeof currentValue === "string") {
		if ("$append" in operator && typeof operator.$append === "string") {
			return (currentValue + operator.$append) as T;
		}
		if ("$prepend" in operator && typeof operator.$prepend === "string") {
			return (operator.$prepend + currentValue) as T;
		}
		if ("$set" in operator) {
			return operator.$set as T;
		}
	}

	// Array operators
	if (Array.isArray(currentValue)) {
		if ("$append" in operator) {
			const toAppend = Array.isArray(operator.$append)
				? operator.$append
				: [operator.$append];
			return [...currentValue, ...toAppend] as T;
		}
		if ("$prepend" in operator) {
			const toPrepend = Array.isArray(operator.$prepend)
				? operator.$prepend
				: [operator.$prepend];
			return [...toPrepend, ...currentValue] as T;
		}
		if ("$remove" in operator) {
			if (typeof operator.$remove === "function") {
				return currentValue.filter(
					(item) => !(operator.$remove as (item: unknown) => boolean)(item),
				) as T;
			}
			return currentValue.filter((item) => item !== operator.$remove) as T;
		}
		if ("$set" in operator) {
			return operator.$set as T;
		}
	}

	// Boolean operators
	if (typeof currentValue === "boolean") {
		if ("$toggle" in operator && operator.$toggle === true) {
			return !currentValue as T;
		}
		if ("$set" in operator) {
			return operator.$set as T;
		}
	}

	// Default: just set the value
	if ("$set" in operator) {
		return operator.$set as T;
	}

	// If no operator matched, return current value
	return currentValue;
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
	const updated = { ...entity };
	const now = new Date().toISOString();

	for (const [key, value] of Object.entries(updates)) {
		if (key === "updatedAt" && !value) {
			// Auto-set updatedAt if not provided
			(updated as Record<string, unknown>).updatedAt = now;
		} else if (value !== undefined || value === null) {
			// Check if it's an operator
			if (
				typeof value === "object" &&
				value !== null &&
				!Array.isArray(value)
			) {
				const hasOperator = Object.keys(value).some((k) => k.startsWith("$"));
				if (hasOperator) {
					const currentValue = (entity as Record<string, unknown>)[key];
					(updated as Record<string, unknown>)[key] = applyOperator(
						currentValue,
						value,
					);
				} else {
					// Direct assignment (for nested objects)
					(updated as Record<string, unknown>)[key] = value;
				}
			} else {
				// Direct assignment (including null values)
				(updated as Record<string, unknown>)[key] = value;
			}
		}
	}

	// Ensure updatedAt is set
	if (!("updatedAt" in updates)) {
		(updated as Record<string, unknown>).updatedAt = now;
	}

	return updated;
}

/**
 * Validate that an update doesn't violate immutable fields (id, createdAt).
 */
export function validateImmutableFields<T extends MinimalEntity>(
	updates: UpdateWithOperators<T>,
): { readonly valid: boolean; readonly field?: string } {
	const immutableFields = ["id", "createdAt"] as const;

	for (const field of immutableFields) {
		if (field in updates) {
			return { valid: false, field };
		}
	}

	return { valid: true };
}

// ============================================================================
// Computed Field Stripping
// ============================================================================

/**
 * Strip computed field keys from an update input object.
 * Used to remove computed field names from update input before schema validation.
 *
 * @param updates - The update payload (possibly with computed field keys)
 * @param computed - The computed fields configuration that defines which keys to strip
 * @returns A new object with computed field keys removed
 */
const stripComputedFromUpdates = <T>(
	updates: UpdateWithOperators<T & MinimalEntity>,
	computed: ComputedFieldsConfig<unknown> | undefined,
): UpdateWithOperators<T & MinimalEntity> => {
	if (computed === undefined || Object.keys(computed).length === 0) {
		return updates;
	}

	const computedKeys = new Set(Object.keys(computed));
	const result: Record<string, unknown> = {};

	for (const key of Object.keys(updates as Record<string, unknown>)) {
		if (!computedKeys.has(key)) {
			result[key] = (updates as Record<string, unknown>)[key];
		}
	}

	return result as UpdateWithOperators<T & MinimalEntity>;
};

// ============================================================================
// Unique Constraint Helpers
// ============================================================================

/**
 * Check if an update operation touches any unique fields.
 *
 * Extracts the update keys (handling $set operators) and checks if any
 * intersect with the fields in the unique constraints.
 *
 * @param updates - The update payload (may contain direct values or operators)
 * @param constraints - Normalized unique constraints
 * @returns True if the update modifies any field that's part of a unique constraint
 */
function updateTouchesUniqueFields<T>(
	updates: UpdateWithOperators<T & MinimalEntity>,
	constraints: NormalizedConstraints,
): boolean {
	if (constraints.length === 0) {
		return false;
	}

	// Extract the fields being updated
	const updateKeys = new Set<string>();
	for (const [key, value] of Object.entries(updates)) {
		// Check if it's a $set operator
		if (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			"$set" in value
		) {
			updateKeys.add(key);
		} else if (value !== undefined) {
			// Direct value assignment or other operators
			updateKeys.add(key);
		}
	}

	// Check if any update key is in any constraint
	for (const constraintFields of constraints) {
		for (const field of constraintFields) {
			if (updateKeys.has(field)) {
				return true;
			}
		}
	}

	return false;
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
export const update =
	<T extends HasId, I = T>(
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
		changePubSub?: PubSub.PubSub<ChangeEvent>,
	) =>
	(
		id: string,
		updates: UpdateWithOperators<T & MinimalEntity>,
	): Effect.Effect<
		T,
		| ValidationError
		| NotFoundError
		| ForeignKeyError
		| HookError
		| UniqueConstraintError
	> =>
		Effect.gen(function* () {
			// Strip computed field keys from updates (they are derived, not stored)
			const sanitizedUpdates = stripComputedFromUpdates(updates, computed);

			// Validate immutable fields
			const immutableCheck = validateImmutableFields(sanitizedUpdates);
			if (!immutableCheck.valid) {
				return yield* Effect.fail(
					new ValidationError({
						message: `Cannot update immutable field: ${immutableCheck.field}`,
						issues: [
							{
								field: immutableCheck.field!,
								message: `Cannot update immutable field: ${immutableCheck.field}`,
							},
						],
					}),
				);
			}

			// Look up entity by ID (O(1)) - capture as previous for hooks
			const currentMap = yield* Ref.get(ref);
			const previous = currentMap.get(id);
			if (previous === undefined) {
				return yield* Effect.fail(
					new NotFoundError({
						collection: collectionName,
						id,
						message: `Entity '${id}' not found in collection '${collectionName}'`,
					}),
				);
			}

			// Run beforeUpdate hooks (can transform the update payload)
			const transformedUpdates = yield* runBeforeUpdateHooks(
				hooks?.beforeUpdate,
				{
					operation: "update",
					collection: collectionName,
					id,
					existing: previous,
					update: sanitizedUpdates,
				},
			);

			// Apply update operators with (possibly transformed) updates
			const updated = applyUpdates(
				previous as T & MinimalEntity,
				transformedUpdates as UpdateWithOperators<T & MinimalEntity>,
			);

			// Validate through Effect Schema
			const validated = yield* validateEntity(schema, updated);

			// Validate foreign keys if any relationship fields were updated
			const relationshipFields = Object.keys(relationships).map(
				(field) => relationships[field].foreignKey || `${field}Id`,
			);
			const hasRelationshipUpdate = Object.keys(transformedUpdates).some(
				(key) => relationshipFields.includes(key),
			);

			if (hasRelationshipUpdate) {
				yield* validateForeignKeysEffect(
					validated,
					collectionName,
					relationships,
					stateRefs,
				);
			}

			// Check unique constraints if the update touches any unique fields
			if (
				updateTouchesUniqueFields(
					transformedUpdates as UpdateWithOperators<T & MinimalEntity>,
					uniqueFields,
				)
			) {
				yield* checkUniqueConstraints(
					validated,
					currentMap,
					uniqueFields,
					collectionName,
				);
			}

			// Atomically update in state
			yield* Ref.update(ref, (map) => {
				const next = new Map(map);
				next.set(id, validated);
				return next;
			});

			// Update indexes if provided
			if (indexes && indexes.size > 0) {
				yield* updateInIndex(indexes, previous, validated);
			}

			// Update search index if configured
			if (searchIndexRef && searchIndexFields && searchIndexFields.length > 0) {
				yield* updateInSearchIndex(
					searchIndexRef,
					previous,
					validated,
					searchIndexFields,
				);
			}

			// Run afterUpdate hooks (fire-and-forget, errors swallowed)
			yield* runAfterUpdateHooks(hooks?.afterUpdate, {
				operation: "update",
				collection: collectionName,
				id,
				previous,
				current: validated,
				update: transformedUpdates,
			});

			// Run onChange hooks with type: "update" (fire-and-forget, errors swallowed)
			yield* runOnChangeHooks(hooks?.onChange, {
				type: "update",
				collection: collectionName,
				id,
				previous,
				current: validated,
			});

			// Publish change event to reactive subscribers
			if (changePubSub) {
				yield* PubSub.publish(changePubSub, {
					collection: collectionName,
					operation: "update",
				});
			}

			return validated;
		});

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
 * Runs hooks per entity: beforeUpdate can transform the update payload,
 * afterUpdate and onChange run after state mutation.
 *
 * All matching entities are updated atomically in a single Ref.update call.
 */
export const updateMany =
	<T extends HasId, I = T>(
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
		changePubSub?: PubSub.PubSub<ChangeEvent>,
	) =>
	(
		predicate: (entity: T) => boolean,
		updates: UpdateWithOperators<T & MinimalEntity>,
	): Effect.Effect<
		UpdateManyResult<T>,
		ValidationError | ForeignKeyError | HookError | UniqueConstraintError
	> =>
		Effect.gen(function* () {
			// Strip computed field keys from updates (they are derived, not stored)
			const sanitizedUpdates = stripComputedFromUpdates(updates, computed);

			// Validate immutable fields
			const immutableCheck = validateImmutableFields(sanitizedUpdates);
			if (!immutableCheck.valid) {
				return yield* Effect.fail(
					new ValidationError({
						message: `Cannot update immutable field: ${immutableCheck.field}`,
						issues: [
							{
								field: immutableCheck.field!,
								message: `Cannot update immutable field: ${immutableCheck.field}`,
							},
						],
					}),
				);
			}

			// Get current state and find matching entities
			const currentMap = yield* Ref.get(ref);
			const matchingEntities: T[] = [];
			for (const entity of currentMap.values()) {
				if (predicate(entity)) {
					matchingEntities.push(entity);
				}
			}

			if (matchingEntities.length === 0) {
				return { count: 0, updated: [] };
			}

			// Apply updates, run beforeUpdate hooks, and validate each entity
			// We need to track both previous and validated for hooks later
			const entityPairs: Array<{
				previous: T;
				validated: T;
				transformedUpdates: UpdateWithOperators<T & MinimalEntity>;
			}> = [];

			for (const entity of matchingEntities) {
				// Run beforeUpdate hooks (can transform the update payload)
				const transformedUpdates = yield* runBeforeUpdateHooks(
					hooks?.beforeUpdate,
					{
						operation: "update",
						collection: collectionName,
						id: (entity as HasId).id,
						existing: entity,
						update: sanitizedUpdates,
					},
				);

				const updated = applyUpdates(
					entity as T & MinimalEntity,
					transformedUpdates as UpdateWithOperators<T & MinimalEntity>,
				);
				const validated = yield* validateEntity(schema, updated);
				entityPairs.push({
					previous: entity,
					validated,
					transformedUpdates: transformedUpdates as UpdateWithOperators<
						T & MinimalEntity
					>,
				});
			}

			// Validate foreign keys if relationship fields were updated
			const relationshipFields = Object.keys(relationships).map(
				(field) => relationships[field].foreignKey || `${field}Id`,
			);
			const hasRelationshipUpdate = Object.keys(sanitizedUpdates).some((key) =>
				relationshipFields.includes(key),
			);

			if (hasRelationshipUpdate) {
				for (const { validated } of entityPairs) {
					yield* validateForeignKeysEffect(
						validated,
						collectionName,
						relationships,
						stateRefs,
					);
				}
			}

			// Check unique constraints if the update touches any unique fields
			if (updateTouchesUniqueFields(sanitizedUpdates, uniqueFields)) {
				// For updateMany, we need to check each entity against:
				// 1. Existing entities (excluding entities being updated)
				// 2. Other entities in the batch (they might conflict with each other)

				// Create a temporary map that includes our updates for checking
				const checkMap = new Map(currentMap);
				for (const { validated } of entityPairs) {
					checkMap.set((validated as HasId).id, validated);
				}

				for (const { validated } of entityPairs) {
					// Check against all other entities (excluding self)
					yield* checkUniqueConstraints(
						validated,
						checkMap,
						uniqueFields,
						collectionName,
					);
				}
			}

			// Atomically update all matching entities in state
			yield* Ref.update(ref, (map) => {
				const next = new Map(map);
				for (const { validated } of entityPairs) {
					next.set((validated as HasId).id, validated);
				}
				return next;
			});

			// Update indexes if provided
			if (indexes && indexes.size > 0) {
				for (const { previous, validated } of entityPairs) {
					yield* updateInIndex(indexes, previous, validated);
				}
			}

			// Update search index if configured
			if (searchIndexRef && searchIndexFields && searchIndexFields.length > 0) {
				for (const { previous, validated } of entityPairs) {
					yield* updateInSearchIndex(
						searchIndexRef,
						previous,
						validated,
						searchIndexFields,
					);
				}
			}

			// Run afterUpdate and onChange hooks for each updated entity
			for (const { previous, validated, transformedUpdates } of entityPairs) {
				// Run afterUpdate hooks (fire-and-forget, errors swallowed)
				yield* runAfterUpdateHooks(hooks?.afterUpdate, {
					operation: "update",
					collection: collectionName,
					id: (validated as HasId).id,
					previous,
					current: validated,
					update: transformedUpdates,
				});

				// Run onChange hooks with type: "update" (fire-and-forget, errors swallowed)
				yield* runOnChangeHooks(hooks?.onChange, {
					type: "update",
					collection: collectionName,
					id: (validated as HasId).id,
					previous,
					current: validated,
				});
			}

			// Publish a single change event after all updates are complete
			if (changePubSub && entityPairs.length > 0) {
				yield* PubSub.publish(changePubSub, {
					collection: collectionName,
					operation: "update",
				});
			}

			return {
				count: entityPairs.length,
				updated: entityPairs.map((p) => p.validated),
			};
		});

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
	const changed: string[] = [];

	for (const key of Object.keys(updated) as Array<keyof T>) {
		if (original[key] !== updated[key]) {
			changed.push(String(key));
		}
	}

	return changed;
}
