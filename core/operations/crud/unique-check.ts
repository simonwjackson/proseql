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
import { UniqueConstraintError } from "../../errors/crud-errors.js"

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
