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
