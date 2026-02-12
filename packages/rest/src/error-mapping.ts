/**
 * Error-to-HTTP-status mapping for REST API responses.
 *
 * Maps proseql tagged errors to appropriate HTTP status codes and
 * structured error response bodies. Each error's _tag is the discriminant,
 * and the response includes the error's fields for debugging.
 *
 * @module
 */

import { Cause, Option, Runtime } from "effect";

// ============================================================================
// Types
// ============================================================================

/**
 * Structured error response returned by mapErrorToResponse.
 * Contains the HTTP status code and the response body to send.
 */
export interface ErrorResponse {
	/** HTTP status code (e.g., 400, 404, 409, 422, 500) */
	readonly status: number;

	/** Response body containing error details */
	readonly body: {
		/** Error tag identifying the error type */
		readonly _tag: string;
		/** Human-readable error message */
		readonly error: string;
		/** Additional error fields for debugging */
		readonly details?: Record<string, unknown>;
	};
}

/**
 * Extract a tagged error from an unknown error value.
 *
 * Effect.runPromise throws a FiberFailure when the Effect fails.
 * This function extracts the underlying tagged error from the FiberFailure
 * or returns the error directly if it's already a tagged error.
 */
const extractTaggedError = (
	error: unknown,
): { readonly _tag: string; [key: string]: unknown } | null => {
	// Check if it's a FiberFailure (from Effect.runPromise)
	if (Runtime.isFiberFailure(error)) {
		// Get the cause from the FiberFailure using the well-known symbol
		const causeSymbol = Symbol.for("effect/Runtime/FiberFailure/Cause");
		const cause = (error as unknown as Record<symbol, unknown>)[
			causeSymbol
		] as Cause.Cause<unknown>;

		// Extract the failure from the cause
		const failure = Cause.failureOption(cause);
		if (Option.isSome(failure)) {
			const value = failure.value;
			if (value !== null && typeof value === "object" && "_tag" in value) {
				return value as { readonly _tag: string; [key: string]: unknown };
			}
		}
	}

	// Check if it's already a tagged error
	if (error !== null && typeof error === "object" && "_tag" in error) {
		return error as { readonly _tag: string; [key: string]: unknown };
	}

	return null;
};

/**
 * Type guard for tagged errors.
 * Checks if an unknown value is an object with a _tag property.
 * Handles both direct tagged errors and FiberFailure wrappers.
 */
const _isTaggedError = (
	error: unknown,
): error is { readonly _tag: string; readonly message?: string } => {
	return extractTaggedError(error) !== null;
};

// ============================================================================
// Status Code Mapping
// ============================================================================

/**
 * Static mapping from error _tag values to HTTP status codes.
 *
 * Mapping rationale:
 * - 400 Bad Request: ValidationError (invalid input data)
 * - 404 Not Found: NotFoundError (entity doesn't exist)
 * - 409 Conflict: DuplicateKeyError, UniqueConstraintError (resource conflict)
 * - 422 Unprocessable Entity: ForeignKeyError, HookError, DanglingReferenceError (semantic errors)
 * - 500 Internal Server Error: TransactionError, and unknown errors
 */
const ERROR_STATUS_MAP: Record<string, number> = {
	// CRUD Errors
	NotFoundError: 404,
	ValidationError: 400,
	DuplicateKeyError: 409,
	UniqueConstraintError: 409,
	ForeignKeyError: 422,
	HookError: 422,
	TransactionError: 500,
	ConcurrencyError: 409,
	OperationError: 400,

	// Query Errors
	DanglingReferenceError: 422,
	CollectionNotFoundError: 404,
	PopulationError: 422,

	// Storage Errors
	StorageError: 500,
	SerializationError: 500,
	UnsupportedFormatError: 400,

	// Migration Errors
	MigrationError: 500,

	// Plugin Errors
	PluginError: 500,
};

/**
 * Human-readable error messages for each error type.
 */
const ERROR_MESSAGES: Record<string, string> = {
	NotFoundError: "Not found",
	ValidationError: "Validation error",
	DuplicateKeyError: "Duplicate key",
	UniqueConstraintError: "Unique constraint violation",
	ForeignKeyError: "Foreign key violation",
	HookError: "Hook error",
	TransactionError: "Transaction error",
	ConcurrencyError: "Concurrency error",
	OperationError: "Operation error",
	DanglingReferenceError: "Dangling reference",
	CollectionNotFoundError: "Collection not found",
	PopulationError: "Population error",
	StorageError: "Storage error",
	SerializationError: "Serialization error",
	UnsupportedFormatError: "Unsupported format",
	MigrationError: "Migration error",
	PluginError: "Plugin error",
};

// ============================================================================
// Error Mapping Function
// ============================================================================

/**
 * Map a proseql tagged error to an HTTP response.
 *
 * Matches on the error's `_tag` property and returns the appropriate HTTP
 * status code along with a structured error body. Unknown errors default
 * to 500 Internal Server Error.
 *
 * @param error - The error to map (typically a proseql tagged error)
 * @returns An ErrorResponse with status code and body
 *
 * @example
 * ```typescript
 * import { mapErrorToResponse } from "@proseql/rest"
 * import { NotFoundError } from "@proseql/core"
 *
 * const error = new NotFoundError({
 *   collection: "books",
 *   id: "123",
 *   message: "Book not found"
 * })
 *
 * const response = mapErrorToResponse(error)
 * // response = {
 * //   status: 404,
 * //   body: {
 * //     _tag: "NotFoundError",
 * //     error: "Not found",
 * //     details: { collection: "books", id: "123", message: "Book not found" }
 * //   }
 * // }
 * ```
 */
export const mapErrorToResponse = (error: unknown): ErrorResponse => {
	// Extract tagged error from FiberFailure or direct tagged error
	const taggedError = extractTaggedError(error);

	// Handle tagged errors
	if (taggedError !== null) {
		const tag = taggedError._tag;
		const status = ERROR_STATUS_MAP[tag] ?? 500;
		const errorMessage = ERROR_MESSAGES[tag] ?? "Internal server error";

		// Extract all fields except _tag for the details object
		const { _tag, ...fields } = taggedError;

		return {
			status,
			body: {
				_tag: tag,
				error: errorMessage,
				details: Object.keys(fields).length > 0 ? fields : undefined,
			},
		};
	}

	// Handle standard Error instances
	if (error instanceof Error) {
		return {
			status: 500,
			body: {
				_tag: "UnknownError",
				error: "Internal server error",
				details: {
					message: error.message,
					name: error.name,
				},
			},
		};
	}

	// Handle unknown error types
	return {
		status: 500,
		body: {
			_tag: "UnknownError",
			error: "Internal server error",
		},
	};
};
