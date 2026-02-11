import { Data } from "effect"

// ============================================================================
// Effect TaggedError Query Error Types
// ============================================================================

export class DanglingReferenceError extends Data.TaggedError("DanglingReferenceError")<{
	readonly collection: string
	readonly field: string
	readonly targetId: string
	readonly message: string
}> {}

export class CollectionNotFoundError extends Data.TaggedError("CollectionNotFoundError")<{
	readonly collection: string
	readonly message: string
}> {}

export class PopulationError extends Data.TaggedError("PopulationError")<{
	readonly collection: string
	readonly relationship: string
	readonly message: string
	readonly cause?: unknown
}> {}

// ============================================================================
// Query Error Union
// ============================================================================

export type QueryError =
	| DanglingReferenceError
	| CollectionNotFoundError
	| PopulationError
