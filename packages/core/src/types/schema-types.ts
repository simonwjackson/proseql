/**
 * Effect Schema type utilities for the database.
 *
 * Provides helper types for working with Effect Schema in entity definitions.
 * All entity schemas are Schema.Struct-based and support bidirectional encode/decode.
 */

import type { Schema } from "effect";

/**
 * Constraint for entity schemas: the decoded Type must include `{ readonly id: string }`.
 * The Encoded and Context parameters are left open so schemas with transformations
 * (e.g., DateFromString) or context requirements are accepted.
 *
 * Usage:
 * ```ts
 * const UserSchema = Schema.Struct({
 *   id: Schema.String,
 *   name: Schema.String,
 *   age: Schema.Number,
 * })
 *
 * // Satisfies EntitySchema because Type includes { id: string }
 * type Check = typeof UserSchema extends EntitySchema<Schema.Schema.Type<typeof UserSchema>> ? true : false
 * ```
 */
export type EntitySchema<T extends { readonly id: string }> = Schema.Schema<
	T,
	unknown,
	never
>;

/**
 * Extract the runtime (decoded) type from a schema.
 * This is the type that queries return and CRUD operations work with.
 *
 * Usage:
 * ```ts
 * const UserSchema = Schema.Struct({ id: Schema.String, name: Schema.String })
 * type User = InferEntity<typeof UserSchema>
 * // => { readonly id: string; readonly name: string }
 * ```
 */
export type InferEntity<S extends Schema.Schema.All> = Schema.Schema.Type<S>;

/**
 * Extract the encoded (on-disk) type from a schema.
 * This is the type stored in JSON/YAML files.
 *
 * For simple schemas (String, Number, etc.) this matches the runtime type.
 * For schemas with transformations (e.g., Schema.DateFromSelf) the encoded
 * type may differ (e.g., string on disk vs Date at runtime).
 *
 * Usage:
 * ```ts
 * const UserSchema = Schema.Struct({ id: Schema.String, name: Schema.String })
 * type UserEncoded = InferEncoded<typeof UserSchema>
 * // => { readonly id: string; readonly name: string }
 * ```
 */
export type InferEncoded<S extends Schema.Schema.All> =
	Schema.Schema.Encoded<S>;
