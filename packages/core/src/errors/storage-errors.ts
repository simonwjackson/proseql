import { Data } from "effect"

// ============================================================================
// Effect TaggedError Storage Error Types
// ============================================================================

export class StorageError extends Data.TaggedError("StorageError")<{
	readonly path: string
	readonly operation: "read" | "write" | "watch" | "delete"
	readonly message: string
	readonly cause?: unknown
}> {}

export class SerializationError extends Data.TaggedError("SerializationError")<{
	readonly format: string
	readonly message: string
	readonly cause?: unknown
}> {}

export class UnsupportedFormatError extends Data.TaggedError("UnsupportedFormatError")<{
	readonly format: string
	readonly message: string
}> {}

// ============================================================================
// Storage Error Union
// ============================================================================

export type PersistenceError =
	| StorageError
	| SerializationError
	| UnsupportedFormatError
