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
// Query Errors (re-exported from query-errors.ts)
// ============================================================================

export {
	DanglingReferenceError,
	CollectionNotFoundError,
	PopulationError,
} from "./query-errors.js"

export type { QueryError } from "./query-errors.js"

// ============================================================================
// Storage Errors
// ============================================================================

import { Data } from "effect"

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
import type { QueryError } from "./query-errors.js"

export type PersistenceError =
	| StorageError
	| SerializationError
	| UnsupportedFormatError

export type DatabaseError =
	| CrudError
	| QueryError
	| PersistenceError
