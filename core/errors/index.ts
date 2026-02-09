// ============================================================================
// CRUD Errors (re-exported from crud-errors.ts)
// ============================================================================

export {
	NotFoundError,
	DuplicateKeyError,
	ForeignKeyError,
	ValidationError,
	UniqueConstraintError,
	ConcurrencyError,
	OperationError,
	TransactionError,
} from "./crud-errors.js"

export type { CrudError } from "./crud-errors.js"

// ============================================================================
// Query Errors
// ============================================================================

import { Data } from "effect"

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

// ============================================================================
// Storage Errors
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
// Union Types
// ============================================================================

import type { CrudError } from "./crud-errors.js"

export type QueryError =
	| DanglingReferenceError
	| CollectionNotFoundError

export type PersistenceError =
	| StorageError
	| SerializationError
	| UnsupportedFormatError

export type DatabaseError =
	| CrudError
	| QueryError
	| PersistenceError
