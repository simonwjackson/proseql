/**
 * Effect Schema decode/encode wrappers that map ParseError to ValidationError.
 *
 * These functions bridge Effect Schema's parse errors into the database's
 * ValidationError type for consistent error handling across CRUD operations.
 */

import { Effect, ParseResult, Schema } from "effect"
import { ValidationError } from "../errors/index.js"

/**
 * Decode unknown data through an Effect Schema, producing a typed entity.
 * Maps Schema ParseError to the database's ValidationError.
 */
export const validateEntity = <A, I, R>(
	schema: Schema.Schema<A, I, R>,
	data: unknown,
): Effect.Effect<A, ValidationError, R> =>
	Schema.decodeUnknown(schema)(data).pipe(
		Effect.mapError((parseError) => parseErrorToValidationError(parseError)),
	)

/**
 * Encode a typed entity through an Effect Schema, producing the encoded (on-disk) form.
 * Maps Schema ParseError to the database's ValidationError.
 */
export const encodeEntity = <A, I, R>(
	schema: Schema.Schema<A, I, R>,
	entity: A,
): Effect.Effect<I, ValidationError, R> =>
	Schema.encode(schema)(entity).pipe(
		Effect.mapError((parseError) => parseErrorToValidationError(parseError)),
	)

/**
 * Convert an Effect Schema ParseError into our ValidationError,
 * extracting structured issue details via ArrayFormatter.
 */
const parseErrorToValidationError = (
	parseError: ParseResult.ParseError,
): ValidationError => {
	const arrayIssues =
		ParseResult.ArrayFormatter.formatErrorSync(parseError)
	const message = ParseResult.TreeFormatter.formatErrorSync(parseError)

	return new ValidationError({
		message,
		issues: arrayIssues.map((issue) => ({
			field: issue.path.map(String).join(".") || "(root)",
			message: issue.message,
		})),
	})
}
