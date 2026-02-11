import { Data } from "effect"

// ============================================================================
// Migration Errors
// ============================================================================

/**
 * Error thrown when a schema migration fails.
 *
 * The `step` field indicates where the failure occurred:
 * - `step >= 0`: The transform at that index in the migration chain failed
 * - `step === -1`: Post-migration schema validation failed
 */
export class MigrationError extends Data.TaggedError("MigrationError")<{
	readonly collection: string
	readonly fromVersion: number
	readonly toVersion: number
	readonly step: number
	readonly reason: string
	readonly message: string
}> {}

// ============================================================================
// Migration Error Union
// ============================================================================

export type MigrationErrors = MigrationError
