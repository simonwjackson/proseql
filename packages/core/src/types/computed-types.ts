/**
 * Type definitions for computed fields.
 *
 * Computed fields are derived at query time from stored entity data.
 * They are never persisted to disk - only materialized in the query pipeline.
 */

/**
 * A computed field derivation function.
 * Takes the full entity (with populated relationships if applicable) and returns the computed value.
 *
 * @template T - The entity type (may include populated relationship data)
 * @template R - The return type of the computed field
 */
export type ComputedFieldDefinition<T, R> = (entity: T) => R;

/**
 * Configuration object mapping computed field names to their derivation functions.
 *
 * @template T - The entity type that computed fields derive from
 *
 * @example
 * ```ts
 * const computed = {
 *   displayName: (book) => `${book.title} (${book.year})`,
 *   isClassic: (book) => book.year < 1980,
 * } satisfies ComputedFieldsConfig<Book>
 * ```
 */
export type ComputedFieldsConfig<T> = Record<
	string,
	ComputedFieldDefinition<T, unknown>
>;

/**
 * Infer the shape of computed fields from a config object.
 * Maps each key in the config to the return type of its derivation function.
 *
 * @template C - The computed fields config object type
 *
 * @example
 * ```ts
 * type Config = {
 *   displayName: (b: Book) => string;
 *   isClassic: (b: Book) => boolean;
 * }
 * type Computed = InferComputedFields<Config>
 * // { displayName: string; isClassic: boolean }
 * ```
 */
export type InferComputedFields<C> = C extends ComputedFieldsConfig<infer _>
	? {
			readonly [K in keyof C]: C[K] extends ComputedFieldDefinition<
				infer _T,
				infer R
			>
				? R
				: never;
		}
	: Record<string, never>;

/**
 * Merge stored entity type with inferred computed fields.
 * The result is the full entity shape as seen in query results.
 *
 * @template T - The stored entity type
 * @template C - The computed fields config
 *
 * @example
 * ```ts
 * type Book = { id: string; title: string; year: number }
 * type Config = { displayName: (b: Book) => string }
 * type Full = WithComputed<Book, Config>
 * // { id: string; title: string; year: number; readonly displayName: string }
 * ```
 */
export type WithComputed<T, C> = T & InferComputedFields<C>;

/**
 * Extract computed field keys from a config object.
 * Useful for checking if a select clause includes computed fields.
 *
 * @template C - The computed fields config object type
 */
export type ComputedFieldKeys<C> = C extends ComputedFieldsConfig<infer _>
	? keyof C
	: never;
