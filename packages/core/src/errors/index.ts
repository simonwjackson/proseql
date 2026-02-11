// ============================================================================
// CRUD Errors (re-exported from crud-errors.ts)
// ============================================================================

export type { CrudError } from "./crud-errors.js";
export {
	ConcurrencyError,
	DuplicateKeyError,
	ForeignKeyError,
	NotFoundError,
	OperationError,
	TransactionError,
	UniqueConstraintError,
	ValidationError,
} from "./crud-errors.js";

// ============================================================================
// Query Errors (re-exported from query-errors.ts)
// ============================================================================

export type { QueryError } from "./query-errors.js";
export {
	CollectionNotFoundError,
	DanglingReferenceError,
	PopulationError,
} from "./query-errors.js";

// ============================================================================
// Storage Errors (re-exported from storage-errors.ts)
// ============================================================================

export type { PersistenceError } from "./storage-errors.js";
export {
	SerializationError,
	StorageError,
	UnsupportedFormatError,
} from "./storage-errors.js";

// ============================================================================
// Migration Errors (re-exported from migration-errors.ts)
// ============================================================================

export type { MigrationErrors } from "./migration-errors.js";
export { MigrationError } from "./migration-errors.js";

// ============================================================================
// Union Types
// ============================================================================

import type { CrudError } from "./crud-errors.js";
import type { MigrationErrors } from "./migration-errors.js";
import type { QueryError } from "./query-errors.js";
import type { PersistenceError } from "./storage-errors.js";

export type DatabaseError =
	| CrudError
	| QueryError
	| PersistenceError
	| MigrationErrors;
