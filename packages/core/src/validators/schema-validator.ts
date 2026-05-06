/**
 * Effect Schema decode/encode wrappers that map ParseError to ValidationError.
 *
 * These functions bridge Effect Schema's parse errors into the database's
 * ValidationError type for consistent error handling across CRUD operations.
 */

import { Effect, Schema } from "effect";
import { ValidationError } from "../errors/index.js";
import {
	type HasId,
	hydrateDerivedId,
	isDerivedIdConfig,
	requireHydratablePayload,
	stripDerivedIdField,
} from "../storage/derived-id.js";
import type { DerivedIdConfig } from "../types/database-config-types.js";

/**
 * Decode unknown data through an Effect Schema, producing a typed entity.
 * Maps Schema ParseError to the database's ValidationError.
 */
export const validateEntity = <A, I, R>(
	schema: Schema.Codec<A, I, R, R>,
	data: unknown,
): Effect.Effect<A, ValidationError, R> =>
	Schema.decodeUnknownEffect(schema)(data).pipe(
		Effect.mapError((parseError) => parseErrorToValidationError(parseError)),
	);

export const validateEntityWithDerivedId = <A extends HasId, I, R>(
	schema: Schema.Codec<unknown, I, R, R>,
	data: A,
	derivedId?: DerivedIdConfig,
): Effect.Effect<A, ValidationError, R> =>
	Effect.gen(function* () {
		if (!isDerivedIdConfig(derivedId)) {
			return yield* validateEntity(schema as Schema.Codec<A, I, R, R>, data);
		}

		const id = data[derivedId.field];
		if (typeof id !== "string") {
			return yield* Effect.fail(
				new ValidationError({
					message: `Derived id field '${derivedId.field}' must be a string`,
					issues: [
						{
							field: derivedId.field,
							message: `Derived id field '${derivedId.field}' must be a string`,
							value: id,
						},
					],
				}),
			);
		}

		const decoded = yield* validateEntity(
			schema,
			stripDerivedIdField(data, derivedId),
		);
		const hydratableError = requireHydratablePayload(
			id,
			decoded,
			derivedId,
			"entity",
		);
		if (hydratableError !== undefined) {
			return yield* Effect.fail(hydratableError);
		}
		return hydrateDerivedId<A>(id, decoded, derivedId);
	});

/**
 * Encode a typed entity through an Effect Schema, producing the encoded (on-disk) form.
 * Maps Schema ParseError to the database's ValidationError.
 */
export const encodeEntity = <A, I, R>(
	schema: Schema.Codec<A, I, R, R>,
	entity: A,
): Effect.Effect<I, ValidationError, R> =>
	Schema.encodeEffect(schema)(entity).pipe(
		Effect.mapError((parseError) => parseErrorToValidationError(parseError)),
	);

/**
 * Convert an Effect Schema ParseError into our ValidationError,
 * extracting structured issue details via ArrayFormatter.
 */
const parseErrorToValidationError = (
	parseError: Schema.SchemaError,
): ValidationError => {
	const message = String(parseError.issue);

	return new ValidationError({
		message,
		issues: [
			{
				field: "(root)",
				message,
			},
		],
	});
};
