// ============================================================================
// Migration Types
// ============================================================================

/**
 * A migration that transforms data from one schema version to the next.
 *
 * Migrations are pure synchronous functions that operate on raw deserialized
 * data (plain objects) before schema decoding. This is necessary because the
 * old data doesn't conform to the new schema.
 */
export interface Migration {
	/**
	 * Source version (the version being migrated from).
	 */
	readonly from: number

	/**
	 * Target version (must be `from + 1`).
	 */
	readonly to: number

	/**
	 * Transform function that converts the entity map from the source
	 * version to the target version.
	 *
	 * Receives the entire entity map (all entities keyed by ID) and returns
	 * the transformed map. This allows cross-entity transformations.
	 */
	readonly transform: (data: Record<string, unknown>) => Record<string, unknown>

	/**
	 * Optional human-readable description of what this migration does.
	 * Used in dry-run output.
	 */
	readonly description?: string
}

// ============================================================================
// Dry-Run Types
// ============================================================================

/**
 * Status of a collection in a dry-run result.
 */
export type DryRunStatus = "up-to-date" | "needs-migration" | "ahead" | "no-file"

/**
 * Information about a single migration that would be applied.
 */
export interface DryRunMigration {
	readonly from: number
	readonly to: number
	readonly description?: string
}

/**
 * Status of a single collection in a dry-run result.
 */
export interface DryRunCollectionResult {
	readonly name: string
	readonly filePath: string
	readonly currentVersion: number
	readonly targetVersion: number
	readonly migrationsToApply: ReadonlyArray<DryRunMigration>
	readonly status: DryRunStatus
}

/**
 * Result of a dry-run migration check.
 *
 * Contains status for each versioned collection, showing which migrations
 * would be applied without actually executing any transforms or writing files.
 */
export interface DryRunResult {
	readonly collections: ReadonlyArray<DryRunCollectionResult>
}
