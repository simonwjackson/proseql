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
export const resolveComputedStream =
	<T extends Record<string, unknown>, C extends ComputedFieldsConfig<T>>(
		config: C | undefined,
	) =>
	<E, R>(
		stream: Stream.Stream<T, E, R>,
	): Stream.Stream<WithComputed<T, C>, E, R> => {
		// When config is empty or undefined, return stream unchanged
		if (config === undefined || Object.keys(config).length === 0) {
			return stream as unknown as Stream.Stream<WithComputed<T, C>, E, R>;
		}

		return Stream.map(stream, (entity: T) =>
			resolveComputedFields(entity, config),
		);
	};

/**
 * Strip computed field keys from an entity object.
 * Used as a safety net before persistence to ensure computed fields
 * are never written to storage.
 *
 * @template T - The original entity type (stored fields only)
 * @template C - The computed fields config type
 *
 * @param entity - The entity (possibly with computed fields attached)
 * @param config - The computed fields configuration that defines which keys to strip
 * @returns A new object with only stored fields (computed fields removed)
 *
 * @example
 * ```ts
 * const entityWithComputed = {
 *   id: "1",
 *   title: "Dune",
 *   year: 1965,
 *   displayName: "Dune (1965)",  // computed
 *   isClassic: true,              // computed
 * }
 * const config = {
 *   displayName: (b) => `${b.title} (${b.year})`,
 *   isClassic: (b) => b.year < 1980,
 * }
 * const stored = stripComputedFields(entityWithComputed, config)
 * // { id: "1", title: "Dune", year: 1965 }
 * ```
 */
export const stripComputedFields = <
	T extends Record<string, unknown>,
	C extends ComputedFieldsConfig<T>,
>(
	entity: Record<string, unknown>,
	config: C | undefined,
): T => {
	// When config is empty or undefined, return entity unchanged
	if (config === undefined || Object.keys(config).length === 0) {
		return entity as T;
	}

	const computedKeys = new Set(Object.keys(config));
	const result: Record<string, unknown> = {};

	for (const key of Object.keys(entity)) {
		if (!computedKeys.has(key)) {
			result[key] = entity[key];
		}
	}

	return result as T;
};

/**
 * Check if any computed fields are selected based on the select configuration.
 *
 * @param computedConfig - The computed fields configuration
 * @param select - The select configuration (object with true values for selected fields)
 * @returns true if any computed field is selected (or select is undefined meaning all fields)
 *
 * @example
 * ```ts
 * const computedConfig = {
 *   displayName: (b) => `${b.title} (${b.year})`,
 *   isClassic: (b) => b.year < 1980,
 * }
 *
 * // No select = all fields including computed
 * hasSelectedComputedFields(computedConfig, undefined) // true
 *
 * // Select includes computed field
 * hasSelectedComputedFields(computedConfig, { title: true, displayName: true }) // true
 *
 * // Select excludes all computed fields
 * hasSelectedComputedFields(computedConfig, { title: true, year: true }) // false
 * ```
 */
export const hasSelectedComputedFields = (
	computedConfig: ComputedFieldsConfig<Record<string, unknown>> | undefined,
	select: Record<string, unknown> | undefined,
): boolean => {
	// No computed config means no computed fields to select
	if (
		computedConfig === undefined ||
		Object.keys(computedConfig).length === 0
	) {
		return false;
	}

	// No select means all fields are selected (including computed)
	if (select === undefined) {
		return true;
	}

	// Check if any computed field key is in the select config
	const computedKeys = Object.keys(computedConfig);
	const selectKeys = Object.keys(select);

	for (const computedKey of computedKeys) {
		if (selectKeys.includes(computedKey) && select[computedKey] === true) {
			return true;
		}
	}

	return false;
};

/**
 * Apply computed field resolution with lazy skip optimization.
 *
 * When `select` is provided and has no intersection with computed field keys,
 * bypasses resolution entirely by returning the stream unchanged. This avoids
 * unnecessary computation when only stored fields are needed.
 *
 * @template T - The entity type (stored fields, possibly with populated relationships)
 * @template C - The computed fields config type
 *
 * @param config - The computed fields configuration (field name → derivation function), or undefined
 * @param select - The select configuration (object with true values for selected fields), or undefined
 * @returns A stream combinator function
 *
 * @example
 * ```ts
 * const config = {
 *   displayName: (b) => `${b.title} (${b.year})`,
 *   isClassic: (b) => b.year < 1980,
 * }
 *
 * // When select includes computed fields, resolution is applied
 * const enrichedStream = stream.pipe(
 *   resolveComputedStreamWithLazySkip(config, { title: true, displayName: true })
 * )
 *
 * // When select excludes all computed fields, resolution is skipped
 * const storedOnlyStream = stream.pipe(
 *   resolveComputedStreamWithLazySkip(config, { title: true, year: true })
 * )
 * // → stream returned unchanged, no resolution overhead
 * ```
 */
export const resolveComputedStreamWithLazySkip =
	<T extends Record<string, unknown>, C extends ComputedFieldsConfig<T>>(
		config: C | undefined,
		select: Record<string, unknown> | undefined,
	) =>
	<E, R>(
		stream: Stream.Stream<T, E, R>,
	): Stream.Stream<WithComputed<T, C>, E, R> => {
		// Check if any computed fields are selected
		// Cast to unknown first to bypass contravariance check - we're only checking keys
		if (
			!hasSelectedComputedFields(
				config as unknown as
					| ComputedFieldsConfig<Record<string, unknown>>
					| undefined,
				select,
			)
		) {
			// No computed fields selected, return stream unchanged
			return stream as unknown as Stream.Stream<WithComputed<T, C>, E, R>;
		}

		// Computed fields are selected, apply resolution
		return Stream.map(stream, (entity: T) =>
			resolveComputedFields(entity, config as C),
		);
	};
