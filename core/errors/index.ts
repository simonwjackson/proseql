import { Data } from "effect"

// ============================================================================
// CRUD Errors
// ============================================================================

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
	readonly collection: string
	readonly id: string
	readonly message: string
}> {}

export class DuplicateKeyError extends Data.TaggedError("DuplicateKeyError")<{
	readonly collection: string
	readonly field: string
	readonly value: string
	readonly existingId: string
	readonly message: string
}> {}

export class ForeignKeyError extends Data.TaggedError("ForeignKeyError")<{
	readonly collection: string
	readonly field: string
	readonly value: string
	readonly targetCollection: string
	readonly message: string
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
	readonly message: string
	readonly issues: ReadonlyArray<{
		readonly field: string
		readonly message: string
		readonly value?: unknown
		readonly expected?: string
		readonly received?: string
	}>
}> {}

export class UniqueConstraintError extends Data.TaggedError("UniqueConstraintError")<{
	readonly collection: string
	readonly constraint: string
	readonly fields: ReadonlyArray<string>
	readonly values: Readonly<Record<string, unknown>>
	readonly existingId: string
	readonly message: string
}> {}

export class ConcurrencyError extends Data.TaggedError("ConcurrencyError")<{
	readonly collection: string
	readonly id: string
	readonly message: string
}> {}

export class OperationError extends Data.TaggedError("OperationError")<{
	readonly operation: string
	readonly reason: string
	readonly message: string
}> {}

export class TransactionError extends Data.TaggedError("TransactionError")<{
	readonly operation: "begin" | "commit" | "rollback"
	readonly reason: string
	readonly message: string
}> {}

// ============================================================================
// Query Errors
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

export type CrudError =
	| NotFoundError
	| DuplicateKeyError
	| ForeignKeyError
	| ValidationError
	| UniqueConstraintError
	| ConcurrencyError
	| OperationError
	| TransactionError

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
