/**
 * Unique constraint checking utilities for CRUD operations.
 *
 * Handles both single-field constraints (e.g., "email") and compound constraints
 * (e.g., ["userId", "settingKey"]). All constraints are normalized to arrays internally.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Unique fields configuration as declared in collection config.
 * Can be single field names or arrays of field names for compound constraints.
 *
 * Example: ["email", ["userId", "settingKey"]]
 */
export type UniqueFieldsConfig = ReadonlyArray<string | ReadonlyArray<string>>

/**
 * Normalized constraints where all entries are arrays of field names.
 *
 * Example: [["email"], ["userId", "settingKey"]]
 */
export type NormalizedConstraints = ReadonlyArray<ReadonlyArray<string>>

// ============================================================================
// Constraint Normalization
// ============================================================================

/**
 * Normalize unique fields configuration to a consistent array-of-arrays format.
 *
 * Converts:
 *   ["email", ["userId", "settingKey"]]
 * To:
 *   [["email"], ["userId", "settingKey"]]
 *
 * This allows a single code path to handle both single and compound constraints.
 *
 * @param uniqueFields - Configuration from CollectionConfig.uniqueFields
 * @returns Normalized constraints where each constraint is an array of field names
 */
export const normalizeConstraints = (
	uniqueFields: UniqueFieldsConfig | undefined,
): NormalizedConstraints => {
	if (!uniqueFields || uniqueFields.length === 0) {
		return []
	}

	return uniqueFields.map((constraint) =>
		typeof constraint === "string" ? [constraint] : constraint,
	)
}

// ============================================================================
// Unique Constraint Checking
// ============================================================================

import { Effect } from "effect"
import { UniqueConstraintError, ValidationError } from "../../errors/crud-errors.js"

type HasId = { readonly id: string }

/**
 * Check for unique constraint violations when creating or updating an entity.
 *
 * For each normalized constraint (array of field names):
 * 1. Extract the values for all fields in the constraint from the entity
 * 2. Skip if any field value is null or undefined (nulls are not unique-checked)
 * 3. Check if any existing entity (excluding the same ID) has matching values for ALL fields
 * 4. Fail-fast on first violation with UniqueConstraintError
 *
 * @param entity - The entity being created or updated
 * @param existingMap - Current state of the collection
 * @param constraints - Normalized constraints (array of field name arrays)
 * @param collectionName - Name of the collection for error messages
 * @returns Effect that succeeds with void or fails with UniqueConstraintError
 */
export const checkUniqueConstraints = <T extends HasId>(
	entity: T,
	existingMap: ReadonlyMap<string, T>,
	constraints: NormalizedConstraints,
	collectionName: string,
): Effect.Effect<void, UniqueConstraintError> => {
	// No constraints configured — nothing to check
	if (constraints.length === 0) {
		return Effect.void
	}

	const entityRecord = entity as Record<string, unknown>

	for (const constraintFields of constraints) {
		// Extract values for this constraint
		const constraintValues: Record<string, unknown> = {}
		let hasNullOrUndefined = false

		for (const field of constraintFields) {
			const value = entityRecord[field]
			if (value === null || value === undefined) {
				hasNullOrUndefined = true
				break
			}
			constraintValues[field] = value
		}

		// Skip constraint if any field is null/undefined
		if (hasNullOrUndefined) {
			continue
		}

		// Check against existing entities
		for (const [existingId, existing] of existingMap) {
			// Exclude the entity itself (for updates)
			if (existingId === entity.id) {
				continue
			}

			const existingRecord = existing as Record<string, unknown>

			// Check if ALL fields in the constraint match
			let allFieldsMatch = true
			for (const field of constraintFields) {
				if (existingRecord[field] !== constraintValues[field]) {
					allFieldsMatch = false
					break
				}
			}

			if (allFieldsMatch) {
				// Generate constraint name: "unique_" + fields joined by "_"
				const constraintName = `unique_${constraintFields.join("_")}`

				return Effect.fail(
					new UniqueConstraintError({
						collection: collectionName,
						constraint: constraintName,
						fields: constraintFields,
						values: constraintValues,
						existingId,
						message: `Unique constraint violation on ${collectionName}: ${constraintName} (${constraintFields.join(", ")}) = ${JSON.stringify(constraintValues)} already exists (id: ${existingId})`,
					}),
				)
			}
		}
	}

	return Effect.void
}

/**
 * Check for unique constraint violations when creating multiple entities in a batch.
 *
 * This function performs two types of checks:
 * 1. Each entity against the existing map (same as checkUniqueConstraints)
 * 2. Each entity against other entities in the batch (inter-batch check)
 *
 * The inter-batch check ensures that if entities at index 3 and 7 both have
 * email: "alice@example.com", entity 7 fails (the later one in the batch).
 *
 * @param entities - The entities being created in the batch
 * @param existingMap - Current state of the collection
 * @param constraints - Normalized constraints (array of field name arrays)
 * @param collectionName - Name of the collection for error messages
 * @returns Effect that succeeds with void or fails with UniqueConstraintError
 */
export const checkBatchUniqueConstraints = <T extends HasId>(
	entities: ReadonlyArray<T>,
	existingMap: ReadonlyMap<string, T>,
	constraints: NormalizedConstraints,
	collectionName: string,
): Effect.Effect<void, UniqueConstraintError> => {
	// No constraints configured — nothing to check
	if (constraints.length === 0) {
		return Effect.void
	}

	// No entities to check
	if (entities.length === 0) {
		return Effect.void
	}

	// Build a lookup index from entities processed so far in the batch
	// Key: constraintName + ":" + serialized values, Value: entity id
	const batchIndex = new Map<string, string>()

	for (const entity of entities) {
		const entityRecord = entity as Record<string, unknown>

		for (const constraintFields of constraints) {
			// Extract values for this constraint
			const constraintValues: Record<string, unknown> = {}
			let hasNullOrUndefined = false

			for (const field of constraintFields) {
				const value = entityRecord[field]
				if (value === null || value === undefined) {
					hasNullOrUndefined = true
					break
				}
				constraintValues[field] = value
			}

			// Skip constraint if any field is null/undefined
			if (hasNullOrUndefined) {
				continue
			}

			const constraintName = `unique_${constraintFields.join("_")}`

			// Create a stable key for this constraint+values combination
			const valuesKey = constraintFields.map((f) => constraintValues[f]).join("\0")
			const indexKey = `${constraintName}:${valuesKey}`

			// Check against existing entities in the collection
			for (const [existingId, existing] of existingMap) {
				// Exclude the entity itself (for updates)
				if (existingId === entity.id) {
					continue
				}

				const existingRecord = existing as Record<string, unknown>

				// Check if ALL fields in the constraint match
				let allFieldsMatch = true
				for (const field of constraintFields) {
					if (existingRecord[field] !== constraintValues[field]) {
						allFieldsMatch = false
						break
					}
				}

				if (allFieldsMatch) {
					return Effect.fail(
						new UniqueConstraintError({
							collection: collectionName,
							constraint: constraintName,
							fields: constraintFields,
							values: constraintValues,
							existingId,
							message: `Unique constraint violation on ${collectionName}: ${constraintName} (${constraintFields.join(", ")}) = ${JSON.stringify(constraintValues)} already exists (id: ${existingId})`,
						}),
					)
				}
			}

			// Check against entities already processed in this batch
			const conflictingId = batchIndex.get(indexKey)
			if (conflictingId !== undefined && conflictingId !== entity.id) {
				return Effect.fail(
					new UniqueConstraintError({
						collection: collectionName,
						constraint: constraintName,
						fields: constraintFields,
						values: constraintValues,
						existingId: conflictingId,
						message: `Unique constraint violation on ${collectionName}: ${constraintName} (${constraintFields.join(", ")}) = ${JSON.stringify(constraintValues)} already exists in batch (id: ${conflictingId})`,
					}),
				)
			}

			// Add this entity to the batch index
			batchIndex.set(indexKey, entity.id)
		}
	}

	return Effect.void
}

// ============================================================================
// Per-Entity Unique Constraint Checking (for skipDuplicates support)
// ============================================================================

/**
 * Check a single entity against unique constraints, including a batch index of
 * previously-checked entities. Used by createMany with skipDuplicates.
 *
 * @param entity - The entity being checked
 * @param entityRecord - The entity as a record for field access
 * @param existingMap - Current state of the collection
 * @param constraints - Normalized constraints
 * @param collectionName - Name of the collection for error messages
 * @param batchIndex - Map of constraint keys to entity IDs from prior entities in the batch
 * @returns Effect that succeeds with void or fails with UniqueConstraintError
 */
export const checkEntityUniqueConstraints = <T extends HasId>(
	entity: T,
	entityRecord: Record<string, unknown>,
	existingMap: ReadonlyMap<string, T>,
	constraints: NormalizedConstraints,
	collectionName: string,
	batchIndex: Map<string, string>,
): Effect.Effect<void, UniqueConstraintError> => {
	// No constraints configured — nothing to check
	if (constraints.length === 0) {
		return Effect.void
	}

	for (const constraintFields of constraints) {
		// Extract values for this constraint
		const constraintValues: Record<string, unknown> = {}
		let hasNullOrUndefined = false

		for (const field of constraintFields) {
			const value = entityRecord[field]
			if (value === null || value === undefined) {
				hasNullOrUndefined = true
				break
			}
			constraintValues[field] = value
		}

		// Skip constraint if any field is null/undefined
		if (hasNullOrUndefined) {
			continue
		}

		const constraintName = `unique_${constraintFields.join("_")}`

		// Create a stable key for this constraint+values combination
		const valuesKey = constraintFields.map((f) => constraintValues[f]).join("\0")
		const indexKey = `${constraintName}:${valuesKey}`

		// Check against existing entities in the collection
		for (const [existingId, existing] of existingMap) {
			// Exclude the entity itself (for updates)
			if (existingId === entity.id) {
				continue
			}

			const existingRecord = existing as Record<string, unknown>

			// Check if ALL fields in the constraint match
			let allFieldsMatch = true
			for (const field of constraintFields) {
				if (existingRecord[field] !== constraintValues[field]) {
					allFieldsMatch = false
					break
				}
			}

			if (allFieldsMatch) {
				return Effect.fail(
					new UniqueConstraintError({
						collection: collectionName,
						constraint: constraintName,
						fields: constraintFields,
						values: constraintValues,
						existingId,
						message: `Unique constraint violation on ${collectionName}: ${constraintName} (${constraintFields.join(", ")}) = ${JSON.stringify(constraintValues)} already exists (id: ${existingId})`,
					}),
				)
			}
		}

		// Check against entities already processed in this batch
		const conflictingId = batchIndex.get(indexKey)
		if (conflictingId !== undefined && conflictingId !== entity.id) {
			return Effect.fail(
				new UniqueConstraintError({
					collection: collectionName,
					constraint: constraintName,
					fields: constraintFields,
					values: constraintValues,
					existingId: conflictingId,
					message: `Unique constraint violation on ${collectionName}: ${constraintName} (${constraintFields.join(", ")}) = ${JSON.stringify(constraintValues)} already exists in batch (id: ${conflictingId})`,
				}),
			)
		}
	}

	return Effect.void
}

/**
 * Add an entity's unique constraint values to the batch index.
 * Called after an entity passes unique constraint checks.
 *
 * @param entity - The entity to add
 * @param entityRecord - The entity as a record for field access
 * @param constraints - Normalized constraints
 * @param batchIndex - Map to populate with constraint keys -> entity IDs
 */
export const addEntityToBatchIndex = <T extends HasId>(
	entity: T,
	entityRecord: Record<string, unknown>,
	constraints: NormalizedConstraints,
	batchIndex: Map<string, string>,
): void => {
	for (const constraintFields of constraints) {
		// Extract values for this constraint
		const constraintValues: Record<string, unknown> = {}
		let hasNullOrUndefined = false

		for (const field of constraintFields) {
			const value = entityRecord[field]
			if (value === null || value === undefined) {
				hasNullOrUndefined = true
				break
			}
			constraintValues[field] = value
		}

		// Skip constraint if any field is null/undefined
		if (hasNullOrUndefined) {
			continue
		}

		const constraintName = `unique_${constraintFields.join("_")}`
		const valuesKey = constraintFields.map((f) => constraintValues[f]).join("\0")
		const indexKey = `${constraintName}:${valuesKey}`

		// Add this entity to the batch index
		batchIndex.set(indexKey, entity.id)
	}
}

// ============================================================================
// Upsert Where Clause Validation
// ============================================================================

/**
 * Validate that an upsert where clause targets a declared unique field or id.
 *
 * The where clause must fully cover at least one declared constraint:
 * - `{ id: "..." }` — always valid (id is implicitly unique)
 * - `{ email: "..." }` — valid if `[["email"]]` is in constraints
 * - `{ userId: "u1", settingKey: "theme" }` — valid if `[["userId", "settingKey"]]` is in constraints
 * - Extra fields beyond the constraint are allowed (for additional filtering)
 *
 * If no constraint is fully covered by the where clause, fail with ValidationError
 * listing the valid unique fields.
 *
 * @param where - The where clause object from upsert
 * @param constraints - Normalized constraints (array of field name arrays)
 * @param collectionName - Name of the collection for error messages
 * @returns Effect that succeeds with void or fails with ValidationError
 */
export const validateUpsertWhere = (
	where: Readonly<Record<string, unknown>>,
	constraints: NormalizedConstraints,
	collectionName: string,
): Effect.Effect<void, ValidationError> => {
	const whereKeys = Object.keys(where)

	// `id` is always a valid constraint (implicitly unique)
	if (whereKeys.includes("id")) {
		return Effect.void
	}

	// Check if where keys cover at least one declared constraint
	for (const constraintFields of constraints) {
		// All fields in the constraint must be present in where keys
		const coversConstraint = constraintFields.every((field) =>
			whereKeys.includes(field),
		)
		if (coversConstraint) {
			return Effect.void
		}
	}

	// No constraint is covered — build error message
	const validFields = buildValidFieldsDescription(constraints)

	return Effect.fail(
		new ValidationError({
			message: `Upsert where clause must target a unique field or id`,
			issues: [
				{
					field: "where",
					message: `Where clause does not match any declared unique field in collection '${collectionName}'. Valid unique fields: ${validFields}`,
					value: where,
				},
			],
		}),
	)
}

/**
 * Build a human-readable description of valid unique fields for error messages.
 *
 * @param constraints - Normalized constraints
 * @returns String like "email, username" or "(userId, settingKey)" for compounds
 */
const buildValidFieldsDescription = (
	constraints: NormalizedConstraints,
): string => {
	if (constraints.length === 0) {
		return "id"
	}

	const descriptions = constraints.map((constraintFields) => {
		if (constraintFields.length === 1) {
			return constraintFields[0]
		}
		// Compound constraint: show as tuple notation
		return `(${constraintFields.join(", ")})`
	})

	// Always include id as valid
	return [...descriptions, "id"].join(", ")
}
