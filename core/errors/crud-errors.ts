import { Data } from "effect"

// ============================================================================
// Effect TaggedError CRUD Error Types
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
// Effect CRUD Error Union
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

// ============================================================================
// Legacy Types (used by existing CRUD operations, will be removed in task 3.4)
// ============================================================================

interface LegacyBaseError {
	readonly code: string
	readonly timestamp: string
	context?: Record<string, unknown>
}

interface LegacyNotFoundError<TEntity = unknown> extends LegacyBaseError {
	readonly code: "NOT_FOUND"
	readonly entity: string
	readonly id: string
	readonly message: string
	readonly _phantom?: TEntity
}

interface LegacyDuplicateKeyError extends LegacyBaseError {
	readonly code: "DUPLICATE_KEY"
	readonly field: string
	readonly value: unknown
	readonly existingId: string
	readonly message: string
	constraint?: string
}

interface LegacyForeignKeyError extends LegacyBaseError {
	readonly code: "FOREIGN_KEY_VIOLATION"
	readonly field: string
	readonly value: unknown
	readonly targetCollection: string
	readonly message: string
	constraint?: string
}

interface LegacyValidationError extends LegacyBaseError {
	readonly code: "VALIDATION_ERROR"
	readonly message: string
	readonly errors: ReadonlyArray<{
		readonly field: string
		readonly message: string
		readonly value?: unknown
		readonly expected?: string
		readonly received?: string
	}>
}

interface LegacyUniqueConstraintError extends LegacyBaseError {
	readonly code: "UNIQUE_CONSTRAINT"
	readonly fields: ReadonlyArray<string>
	readonly values: Record<string, unknown>
	readonly existingId: string
	readonly message: string
	readonly constraint: string
}

interface LegacyOperationNotAllowedError extends LegacyBaseError {
	readonly code: "OPERATION_NOT_ALLOWED"
	readonly operation: string
	readonly reason: string
	readonly message: string
}

interface LegacyTransactionError extends LegacyBaseError {
	readonly code: "TRANSACTION_ERROR"
	readonly operation: "begin" | "commit" | "rollback"
	readonly reason: string
	readonly message: string
}

interface LegacyUnknownError extends LegacyBaseError {
	readonly code: "UNKNOWN"
	readonly message: string
	originalError?: unknown
}

/** @deprecated Use CrudError (Effect TaggedError union) instead. Will be removed in task 3.4. */
export type LegacyCrudError<TEntity = unknown> =
	| LegacyNotFoundError<TEntity>
	| LegacyDuplicateKeyError
	| LegacyForeignKeyError
	| LegacyValidationError
	| LegacyUniqueConstraintError
	| LegacyOperationNotAllowedError
	| LegacyTransactionError
	| LegacyUnknownError

// ============================================================================
// Legacy Result Type (will be removed in task 3.4)
// ============================================================================

/** @deprecated Use Effect<T, E> instead. Will be removed in task 3.4. */
export type Result<T, E = LegacyCrudError> =
	| { success: true; data: T }
	| { success: false; error: E }

export function ok<T>(data: T): Result<T, never> {
	return { success: true, data }
}

export function err<E>(error: E): Result<never, E> {
	return { success: false, error }
}

export function isOk<T, E>(
	result: Result<T, E>,
): result is { success: true; data: T } {
	return result.success === true
}

export function isErr<T, E>(
	result: Result<T, E>,
): result is { success: false; error: E } {
	return result.success === false
}

export function mapResult<T, U, E>(
	result: Result<T, E>,
	fn: (value: T) => U,
): Result<U, E> {
	if (isOk(result)) {
		return ok(fn(result.data))
	}
	return result
}

export function mapError<T, E, F>(
	result: Result<T, E>,
	fn: (error: E) => F,
): Result<T, F> {
	if (isErr(result)) {
		return err(fn(result.error))
	}
	return result
}

export async function chainResult<T, U, E>(
	result: Result<T, E>,
	fn: (value: T) => Promise<Result<U, E>>,
): Promise<Result<U, E>> {
	if (isOk(result)) {
		return fn(result.data)
	}
	return result
}

// ============================================================================
// Legacy Type Guards (will be removed in task 3.4)
// ============================================================================

export function isNotFoundError<T>(
	error: LegacyCrudError<T>,
): error is LegacyNotFoundError<T> {
	return error.code === "NOT_FOUND"
}

export function isDuplicateKeyError(
	error: LegacyCrudError,
): error is LegacyDuplicateKeyError {
	return error.code === "DUPLICATE_KEY"
}

export function isForeignKeyError(error: LegacyCrudError): error is LegacyForeignKeyError {
	return error.code === "FOREIGN_KEY_VIOLATION"
}

export function isValidationError(error: LegacyCrudError): error is LegacyValidationError {
	return error.code === "VALIDATION_ERROR"
}

export function isUniqueConstraintError(
	error: LegacyCrudError,
): error is LegacyUniqueConstraintError {
	return error.code === "UNIQUE_CONSTRAINT"
}

export function isOperationNotAllowedError(
	error: LegacyCrudError,
): error is LegacyOperationNotAllowedError {
	return error.code === "OPERATION_NOT_ALLOWED"
}

export function isTransactionError(
	error: LegacyCrudError,
): error is LegacyTransactionError {
	return error.code === "TRANSACTION_ERROR"
}

export function isUnknownError(error: LegacyCrudError): error is LegacyUnknownError {
	return error.code === "UNKNOWN"
}

export function isCrudError(value: unknown): value is LegacyCrudError {
	if (typeof value !== "object" || value === null) return false
	const error = value as Record<string, unknown>
	return (
		typeof error.code === "string" &&
		typeof error.message === "string" &&
		typeof error.timestamp === "string"
	)
}

// ============================================================================
// Legacy Factory Functions (will be removed in task 3.4)
// ============================================================================

export function createNotFoundError<TEntity>(
	entity: string,
	id: string,
	context?: Record<string, unknown>,
): LegacyNotFoundError<TEntity> {
	const error: LegacyNotFoundError<TEntity> = {
		code: "NOT_FOUND",
		entity,
		id,
		message: `${entity} with id '${id}' not found`,
		timestamp: new Date().toISOString(),
	}
	if (context !== undefined) {
		error.context = context
	}
	return error
}

export function createDuplicateKeyError(
	field: string,
	value: unknown,
	existingId: string,
	constraint?: string,
): LegacyDuplicateKeyError {
	const error: LegacyDuplicateKeyError = {
		code: "DUPLICATE_KEY",
		field,
		value,
		existingId,
		message: `Duplicate value for field '${field}': ${JSON.stringify(value)}`,
		timestamp: new Date().toISOString(),
	}
	if (constraint !== undefined) {
		error.constraint = constraint
	}
	return error
}

export function createForeignKeyError(
	field: string,
	value: unknown,
	targetCollection: string,
	constraint?: string,
): LegacyForeignKeyError {
	const error: LegacyForeignKeyError = {
		code: "FOREIGN_KEY_VIOLATION",
		field,
		value,
		targetCollection,
		message: `Foreign key constraint violated: '${field}' references non-existent ${targetCollection} '${value}'`,
		timestamp: new Date().toISOString(),
	}
	if (constraint !== undefined) {
		error.constraint = constraint
	}
	return error
}

export function createValidationError(
	errors: Array<{
		field: string
		message: string
		value?: unknown
		expected?: string
		received?: string
	}>,
	message?: string,
): LegacyValidationError {
	const defaultMessage = `Validation failed: ${errors.length} error(s)`
	return {
		code: "VALIDATION_ERROR",
		message: message || defaultMessage,
		errors,
		timestamp: new Date().toISOString(),
	}
}

export function createUniqueConstraintError(
	constraint: string,
	fields: string[],
	values: Record<string, unknown>,
	existingId: string,
): LegacyUniqueConstraintError {
	const fieldList = fields.join(", ")
	return {
		code: "UNIQUE_CONSTRAINT",
		fields,
		values,
		existingId,
		constraint,
		message: `Unique constraint '${constraint}' violated on fields: ${fieldList}`,
		timestamp: new Date().toISOString(),
	}
}

export function createOperationNotAllowedError(
	operation: string,
	reason: string,
): LegacyOperationNotAllowedError {
	return {
		code: "OPERATION_NOT_ALLOWED",
		operation,
		reason,
		message: `Operation '${operation}' not allowed: ${reason}`,
		timestamp: new Date().toISOString(),
	}
}

export function createTransactionError(
	operation: "begin" | "commit" | "rollback",
	reason: string,
): LegacyTransactionError {
	return {
		code: "TRANSACTION_ERROR",
		operation,
		reason,
		message: `Transaction ${operation} failed: ${reason}`,
		timestamp: new Date().toISOString(),
	}
}

export function createUnknownError(
	message: string,
	originalError?: unknown,
): LegacyUnknownError {
	const error: LegacyUnknownError = {
		code: "UNKNOWN",
		message,
		timestamp: new Date().toISOString(),
	}
	if (originalError !== undefined) {
		error.originalError = originalError
	}
	return error
}

export function toCrudError(error: unknown, context?: string): LegacyCrudError {
	if (isCrudError(error)) {
		return error
	}

	if (error instanceof Error) {
		return createUnknownError(
			context ? `${context}: ${error.message}` : error.message,
			error,
		)
	}

	return createUnknownError(
		context ? `${context}: Unknown error occurred` : "Unknown error occurred",
		error,
	)
}

export function handleCrudError<T>(
	error: LegacyCrudError<T>,
	handlers: {
		notFound: (error: LegacyNotFoundError<T>) => void
		duplicateKey: (error: LegacyDuplicateKeyError) => void
		foreignKey: (error: LegacyForeignKeyError) => void
		validation: (error: LegacyValidationError) => void
		uniqueConstraint: (error: LegacyUniqueConstraintError) => void
		operationNotAllowed: (error: LegacyOperationNotAllowedError) => void
		transaction: (error: LegacyTransactionError) => void
		unknown: (error: LegacyUnknownError) => void
	},
): void {
	switch (error.code) {
		case "NOT_FOUND":
			return handlers.notFound(error)
		case "DUPLICATE_KEY":
			return handlers.duplicateKey(error)
		case "FOREIGN_KEY_VIOLATION":
			return handlers.foreignKey(error)
		case "VALIDATION_ERROR":
			return handlers.validation(error)
		case "UNIQUE_CONSTRAINT":
			return handlers.uniqueConstraint(error)
		case "OPERATION_NOT_ALLOWED":
			return handlers.operationNotAllowed(error)
		case "TRANSACTION_ERROR":
			return handlers.transaction(error)
		case "UNKNOWN":
			return handlers.unknown(error)
		default: {
			const _exhaustive: never = error
			throw new Error(`Unhandled error type: ${(error as LegacyCrudError).code}`)
		}
	}
}
