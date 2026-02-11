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
// Storage Errors (re-exported from storage-errors.ts)
// ============================================================================

export {
	StorageError,
	SerializationError,
	UnsupportedFormatError,
} from "./storage-errors.js"

export type { PersistenceError } from "./storage-errors.js"

// ============================================================================
// Migration Errors (re-exported from migration-errors.ts)
// ============================================================================

export { MigrationError } from "./migration-errors.js"

export type { MigrationErrors } from "./migration-errors.js"

// ============================================================================
// Union Types
// ============================================================================

import type { CrudError } from "./crud-errors.js"
import type { QueryError } from "./query-errors.js"
import type { PersistenceError } from "./storage-errors.js"
import type { MigrationErrors } from "./migration-errors.js"

export type DatabaseError =
	| CrudError
	| QueryError
	| PersistenceError
	| MigrationErrors
