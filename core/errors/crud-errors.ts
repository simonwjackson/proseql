/**
 * Tagged union error types for CRUD operations with exhaustive type checking
 */

// ============================================================================
// Error Type Definitions
// ============================================================================

/**
 * Base error type with common properties
 */
interface BaseError {
	readonly code: string;
	readonly timestamp: string;
	context?: Record<string, unknown>;
}

/**
 * Entity not found error
 */
export interface NotFoundError<TEntity = unknown> extends BaseError {
	readonly code: "NOT_FOUND";
	readonly entity: string;
	readonly id: string;
	readonly message: string;
	readonly _phantom?: TEntity; // Phantom type for type inference
}

/**
 * Duplicate key constraint violation
 */
export interface DuplicateKeyError extends BaseError {
	readonly code: "DUPLICATE_KEY";
	readonly field: string;
	readonly value: unknown;
	readonly existingId: string;
	readonly message: string;
	constraint?: string;
}

/**
 * Foreign key constraint violation
 */
export interface ForeignKeyError extends BaseError {
	readonly code: "FOREIGN_KEY_VIOLATION";
	readonly field: string;
	readonly value: unknown;
	readonly targetCollection: string;
	readonly message: string;
	constraint?: string;
}

/**
 * Validation error with field-level details
 */
export interface ValidationError extends BaseError {
	readonly code: "VALIDATION_ERROR";
	readonly message: string;
	readonly errors: ReadonlyArray<{
		readonly field: string;
		readonly message: string;
		readonly value?: unknown;
		readonly expected?: string;
		readonly received?: string;
	}>;
}

/**
 * Unique constraint violation (different from duplicate key)
 */
export interface UniqueConstraintError extends BaseError {
	readonly code: "UNIQUE_CONSTRAINT";
	readonly fields: ReadonlyArray<string>;
	readonly values: Record<string, unknown>;
	readonly existingId: string;
	readonly message: string;
	readonly constraint: string;
}

/**
 * Operation not allowed error
 */
export interface OperationNotAllowedError extends BaseError {
	readonly code: "OPERATION_NOT_ALLOWED";
	readonly operation: string;
	readonly reason: string;
	readonly message: string;
}

/**
 * Transaction error
 */
export interface TransactionError extends BaseError {
	readonly code: "TRANSACTION_ERROR";
	readonly operation: "begin" | "commit" | "rollback";
	readonly reason: string;
	readonly message: string;
}

/**
 * Unknown/unexpected error
 */
export interface UnknownError extends BaseError {
	readonly code: "UNKNOWN";
	readonly message: string;
	originalError?: unknown;
}

/**
 * Tagged union of all CRUD errors
 */
export type CrudError<TEntity = unknown> =
	| NotFoundError<TEntity>
	| DuplicateKeyError
	| ForeignKeyError
	| ValidationError
	| UniqueConstraintError
	| OperationNotAllowedError
	| TransactionError
	| UnknownError;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for NotFoundError
 */
export function isNotFoundError<T>(
	error: CrudError<T>,
): error is NotFoundError<T> {
	return error.code === "NOT_FOUND";
}

/**
 * Type guard for DuplicateKeyError
 */
export function isDuplicateKeyError(
	error: CrudError,
): error is DuplicateKeyError {
	return error.code === "DUPLICATE_KEY";
}

/**
 * Type guard for ForeignKeyError
 */
export function isForeignKeyError(error: CrudError): error is ForeignKeyError {
	return error.code === "FOREIGN_KEY_VIOLATION";
}

/**
 * Type guard for ValidationError
 */
export function isValidationError(error: CrudError): error is ValidationError {
	return error.code === "VALIDATION_ERROR";
}

/**
 * Type guard for UniqueConstraintError
 */
export function isUniqueConstraintError(
	error: CrudError,
): error is UniqueConstraintError {
	return error.code === "UNIQUE_CONSTRAINT";
}

/**
 * Type guard for OperationNotAllowedError
 */
export function isOperationNotAllowedError(
	error: CrudError,
): error is OperationNotAllowedError {
	return error.code === "OPERATION_NOT_ALLOWED";
}

/**
 * Type guard for TransactionError
 */
export function isTransactionError(
	error: CrudError,
): error is TransactionError {
	return error.code === "TRANSACTION_ERROR";
}

/**
 * Type guard for UnknownError
 */
export function isUnknownError(error: CrudError): error is UnknownError {
	return error.code === "UNKNOWN";
}

/**
 * Type guard to check if a value is a CrudError
 */
export function isCrudError(value: unknown): value is CrudError {
	if (typeof value !== "object" || value === null) return false;
	const error = value as Record<string, unknown>;
	return (
		typeof error.code === "string" &&
		typeof error.message === "string" &&
		typeof error.timestamp === "string"
	);
}

// ============================================================================
// Error Factory Functions
// ============================================================================

/**
 * Create a NotFoundError
 */
export function createNotFoundError<TEntity>(
	entity: string,
	id: string,
	context?: Record<string, unknown>,
): NotFoundError<TEntity> {
	const error: NotFoundError<TEntity> = {
		code: "NOT_FOUND",
		entity,
		id,
		message: `${entity} with id '${id}' not found`,
		timestamp: new Date().toISOString(),
	};
	if (context !== undefined) {
		error.context = context;
	}
	return error;
}

/**
 * Create a DuplicateKeyError
 */
export function createDuplicateKeyError(
	field: string,
	value: unknown,
	existingId: string,
	constraint?: string,
): DuplicateKeyError {
	const error: DuplicateKeyError = {
		code: "DUPLICATE_KEY",
		field,
		value,
		existingId,
		message: `Duplicate value for field '${field}': ${JSON.stringify(value)}`,
		timestamp: new Date().toISOString(),
	};
	if (constraint !== undefined) {
		error.constraint = constraint;
	}
	return error;
}

/**
 * Create a ForeignKeyError
 */
export function createForeignKeyError(
	field: string,
	value: unknown,
	targetCollection: string,
	constraint?: string,
): ForeignKeyError {
	const error: ForeignKeyError = {
		code: "FOREIGN_KEY_VIOLATION",
		field,
		value,
		targetCollection,
		message: `Foreign key constraint violated: '${field}' references non-existent ${targetCollection} '${value}'`,
		timestamp: new Date().toISOString(),
	};
	if (constraint !== undefined) {
		error.constraint = constraint;
	}
	return error;
}

/**
 * Create a ValidationError from Zod errors or custom validation
 */
export function createValidationError(
	errors: Array<{
		field: string;
		message: string;
		value?: unknown;
		expected?: string;
		received?: string;
	}>,
	message?: string,
): ValidationError {
	const defaultMessage = `Validation failed: ${errors.length} error(s)`;
	return {
		code: "VALIDATION_ERROR",
		message: message || defaultMessage,
		errors,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Create a UniqueConstraintError
 */
export function createUniqueConstraintError(
	constraint: string,
	fields: string[],
	values: Record<string, unknown>,
	existingId: string,
): UniqueConstraintError {
	const fieldList = fields.join(", ");
	return {
		code: "UNIQUE_CONSTRAINT",
		fields,
		values,
		existingId,
		constraint,
		message: `Unique constraint '${constraint}' violated on fields: ${fieldList}`,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Create an OperationNotAllowedError
 */
export function createOperationNotAllowedError(
	operation: string,
	reason: string,
): OperationNotAllowedError {
	return {
		code: "OPERATION_NOT_ALLOWED",
		operation,
		reason,
		message: `Operation '${operation}' not allowed: ${reason}`,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Create a TransactionError
 */
export function createTransactionError(
	operation: "begin" | "commit" | "rollback",
	reason: string,
): TransactionError {
	return {
		code: "TRANSACTION_ERROR",
		operation,
		reason,
		message: `Transaction ${operation} failed: ${reason}`,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Create an UnknownError
 */
export function createUnknownError(
	message: string,
	originalError?: unknown,
): UnknownError {
	const error: UnknownError = {
		code: "UNKNOWN",
		message,
		timestamp: new Date().toISOString(),
	};
	if (originalError !== undefined) {
		error.originalError = originalError;
	}
	return error;
}

// ============================================================================
// Result Type for Operations
// ============================================================================

/**
 * Result type that can be either success or error
 * This enables railway-oriented programming
 */
export type Result<T, E = CrudError> =
	| { success: true; data: T }
	| { success: false; error: E };

/**
 * Create a success result
 */
export function ok<T>(data: T): Result<T, never> {
	return { success: true, data };
}

/**
 * Create an error result
 */
export function err<E>(error: E): Result<never, E> {
	return { success: false, error };
}

/**
 * Type guard for success result
 */
export function isOk<T, E>(
	result: Result<T, E>,
): result is { success: true; data: T } {
	return result.success === true;
}

/**
 * Type guard for error result
 */
export function isErr<T, E>(
	result: Result<T, E>,
): result is { success: false; error: E } {
	return result.success === false;
}

/**
 * Map a result value
 */
export function mapResult<T, U, E>(
	result: Result<T, E>,
	fn: (value: T) => U,
): Result<U, E> {
	if (isOk(result)) {
		return ok(fn(result.data));
	}
	return result;
}

/**
 * Map a result error
 */
export function mapError<T, E, F>(
	result: Result<T, E>,
	fn: (error: E) => F,
): Result<T, F> {
	if (isErr(result)) {
		return err(fn(result.error));
	}
	return result;
}

/**
 * Chain results together
 */
export async function chainResult<T, U, E>(
	result: Result<T, E>,
	fn: (value: T) => Promise<Result<U, E>>,
): Promise<Result<U, E>> {
	if (isOk(result)) {
		return fn(result.data);
	}
	return result;
}

// ============================================================================
// Error Handling Utilities
// ============================================================================

/**
 * Convert unknown errors to CrudError
 */
export function toCrudError(error: unknown, context?: string): CrudError {
	if (isCrudError(error)) {
		return error;
	}

	if (error instanceof Error) {
		return createUnknownError(
			context ? `${context}: ${error.message}` : error.message,
			error,
		);
	}

	return createUnknownError(
		context ? `${context}: Unknown error occurred` : "Unknown error occurred",
		error,
	);
}

/**
 * Exhaustive error handler with type safety
 */
export function handleCrudError<T>(
	error: CrudError<T>,
	handlers: {
		notFound: (error: NotFoundError<T>) => void;
		duplicateKey: (error: DuplicateKeyError) => void;
		foreignKey: (error: ForeignKeyError) => void;
		validation: (error: ValidationError) => void;
		uniqueConstraint: (error: UniqueConstraintError) => void;
		operationNotAllowed: (error: OperationNotAllowedError) => void;
		transaction: (error: TransactionError) => void;
		unknown: (error: UnknownError) => void;
	},
): void {
	switch (error.code) {
		case "NOT_FOUND":
			return handlers.notFound(error);
		case "DUPLICATE_KEY":
			return handlers.duplicateKey(error);
		case "FOREIGN_KEY_VIOLATION":
			return handlers.foreignKey(error);
		case "VALIDATION_ERROR":
			return handlers.validation(error);
		case "UNIQUE_CONSTRAINT":
			return handlers.uniqueConstraint(error);
		case "OPERATION_NOT_ALLOWED":
			return handlers.operationNotAllowed(error);
		case "TRANSACTION_ERROR":
			return handlers.transaction(error);
		case "UNKNOWN":
			return handlers.unknown(error);
		default:
			// This ensures exhaustive checking at compile time
			const _exhaustive: never = error;
			throw new Error(`Unhandled error type: ${(error as CrudError).code}`);
	}
}
