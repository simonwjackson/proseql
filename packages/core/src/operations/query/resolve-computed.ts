import { Stream } from "effect";
import type {
	ComputedFieldsConfig,
	WithComputed,
} from "../../types/computed-types.js";

/**
 * Resolve computed fields for a single entity.
 *
 * Iterates over the computed config, calling each derivation function with the entity,
 * and returns a new object with the original entity fields plus computed field values.
 *
 * @template T - The entity type (stored fields, possibly with populated relationships)
 * @template C - The computed fields config type
 *
 * @param entity - The entity to resolve computed fields for
 * @param config - The computed fields configuration (field name → derivation function)
 * @returns A new object with entity fields plus computed fields attached
 *
 * @example
 * ```ts
 * const book = { id: "1", title: "Dune", year: 1965 }
 * const config = {
 *   displayName: (b) => `${b.title} (${b.year})`,
 *   isClassic: (b) => b.year < 1980,
 * }
 * const result = resolveComputedFields(book, config)
 * // { id: "1", title: "Dune", year: 1965, displayName: "Dune (1965)", isClassic: true }
 * ```
 */
export const resolveComputedFields = <
	T extends Record<string, unknown>,
	C extends ComputedFieldsConfig<T>,
>(
	entity: T,
	config: C,
): WithComputed<T, C> => {
	const computedValues: Record<string, unknown> = {};

	for (const key of Object.keys(config)) {
		const derivationFn = config[key];
		if (typeof derivationFn === "function") {
			computedValues[key] = derivationFn(entity);
		}
	}

	return { ...entity, ...computedValues } as WithComputed<T, C>;
};

/**
 * Apply computed field resolution as a Stream combinator.
 * Returns a function that transforms Stream<T> → Stream<WithComputed<T, C>>,
 * mapping the resolution function over each entity.
 *
 * When the config is undefined or has no keys, returns the stream unchanged
 * (no resolution overhead).
 *
 * @template T - The entity type (stored fields, possibly with populated relationships)
 * @template C - The computed fields config type
 *
 * @param config - The computed fields configuration (field name → derivation function), or undefined
 * @returns A stream combinator function
 *
 * @example
 * ```ts
 * const config = {
 *   displayName: (b) => `${b.title} (${b.year})`,
 *   isClassic: (b) => b.year < 1980,
 * }
 * const enrichedStream = stream.pipe(resolveComputedStream(config))
 * // Each entity in the resulting stream has displayName and isClassic attached
 * ```
 */
export const resolveComputedStream = <
	T extends Record<string, unknown>,
	C extends ComputedFieldsConfig<T>,
>(
	config: C | undefined,
) =>
	<E, R>(stream: Stream.Stream<T, E, R>): Stream.Stream<WithComputed<T, C>, E, R> => {
		// When config is empty or undefined, return stream unchanged
		if (config === undefined || Object.keys(config).length === 0) {
			return stream as unknown as Stream.Stream<WithComputed<T, C>, E, R>;
		}

		return Stream.map(stream, (entity: T) =>
			resolveComputedFields(entity, config),
		);
	};
