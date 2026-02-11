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
