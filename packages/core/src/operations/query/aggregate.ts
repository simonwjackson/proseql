/**
 * Aggregate operations for computing scalar values from entity collections.
 *
 * Implements count, sum, avg, min, max aggregations in a single pass.
 * All aggregates are computed simultaneously for efficiency.
 */

import type {
	AggregateResult,
	GroupedAggregateConfig,
	GroupedAggregateResult,
	GroupResult,
	ScalarAggregateConfig,
} from "../../types/aggregate-types.js";
import { getNestedValue } from "../../utils/nested-path.js";

/**
 * Normalize a field spec (string or array) to an array.
 */
const normalizeFields = (
	fields: string | ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => {
	if (fields === undefined) return [];
	if (typeof fields === "string") return [fields];
	return fields;
};

/**
 * Sentinel value to distinguish undefined from null in group keys.
 * JSON.stringify converts both null and undefined to "null", so we need
 * a custom approach to maintain strict equality semantics (null !== undefined).
 */
const UNDEFINED_SENTINEL = "__PTDB_UNDEFINED__";

/**
 * Create a group key from field values that distinguishes null from undefined.
 * Uses a sentinel value to represent undefined since JSON.stringify([undefined])
 * produces "[null]" which would collide with JSON.stringify([null]).
 */
const createGroupKey = (values: ReadonlyArray<unknown>): string => {
	const mapped = values.map((v) => (v === undefined ? UNDEFINED_SENTINEL : v));
	return JSON.stringify(mapped);
};

/**
 * Parse a group key back into field values, restoring undefined from sentinel.
 */
const parseGroupKey = (key: string): ReadonlyArray<unknown> => {
	const values = JSON.parse(key) as Array<unknown>;
	return values.map((v) => (v === UNDEFINED_SENTINEL ? undefined : v));
};

/**
 * Check if a value is numeric (finite number, not NaN).
 */
const isNumeric = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

/**
 * Check if a value is valid for comparison (not null/undefined).
 */
const isComparable = (value: unknown): boolean =>
	value !== null && value !== undefined;

/**
 * Accumulators for tracking aggregate state during single-pass reduction.
 */
interface Accumulators {
	readonly count: number;
	readonly sum: Record<string, number>;
	readonly avg: Record<string, { sum: number; count: number }>;
	readonly min: Record<string, unknown>;
	readonly max: Record<string, unknown>;
}

/**
 * Create initial accumulators based on config.
 */
const createAccumulators = (config: ScalarAggregateConfig): Accumulators => {
	const sumFields = normalizeFields(config.sum);
	const avgFields = normalizeFields(config.avg);
	const minFields = normalizeFields(config.min);
	const maxFields = normalizeFields(config.max);

	const sum: Record<string, number> = {};
	for (const field of sumFields) {
		sum[field] = 0;
	}

	const avg: Record<string, { sum: number; count: number }> = {};
	for (const field of avgFields) {
		avg[field] = { sum: 0, count: 0 };
	}

	const min: Record<string, unknown> = {};
	for (const field of minFields) {
		min[field] = undefined;
	}

	const max: Record<string, unknown> = {};
	for (const field of maxFields) {
		max[field] = undefined;
	}

	return { count: 0, sum, avg, min, max };
};

/**
 * Update accumulators with a single entity.
 */
const updateAccumulators = (
	acc: Accumulators,
	entity: Record<string, unknown>,
	config: ScalarAggregateConfig,
): Accumulators => {
	const sumFields = normalizeFields(config.sum);
	const avgFields = normalizeFields(config.avg);
	const minFields = normalizeFields(config.min);
	const maxFields = normalizeFields(config.max);

	// Count
	const newCount = config.count ? acc.count + 1 : acc.count;

	// Sum: accumulate numeric values, skip non-numeric
	const newSum = { ...acc.sum };
	for (const field of sumFields) {
		const value = getNestedValue(entity, field);
		if (isNumeric(value)) {
			newSum[field] = (newSum[field] ?? 0) + value;
		}
	}

	// Avg: track sum and count of numeric values
	const newAvg = { ...acc.avg };
	for (const field of avgFields) {
		const value = getNestedValue(entity, field);
		if (isNumeric(value)) {
			const current = newAvg[field] ?? { sum: 0, count: 0 };
			newAvg[field] = {
				sum: current.sum + value,
				count: current.count + 1,
			};
		}
	}

	// Min: track minimum comparable value
	const newMin = { ...acc.min };
	for (const field of minFields) {
		const value = getNestedValue(entity, field);
		if (isComparable(value)) {
			const current = newMin[field];
			// Type-safe comparison: we check current is undefined or compare as primitives
			if (
				current === undefined ||
				(value as string | number) < (current as string | number)
			) {
				newMin[field] = value;
			}
		}
	}

	// Max: track maximum comparable value
	const newMax = { ...acc.max };
	for (const field of maxFields) {
		const value = getNestedValue(entity, field);
		if (isComparable(value)) {
			const current = newMax[field];
			// Type-safe comparison: we check current is undefined or compare as primitives
			if (
				current === undefined ||
				(value as string | number) > (current as string | number)
			) {
				newMax[field] = value;
			}
		}
	}

	return {
		count: newCount,
		sum: newSum,
		avg: newAvg,
		min: newMin,
		max: newMax,
	};
};

/**
 * Convert accumulators to final result.
 */
const accumulatorsToResult = (
	acc: Accumulators,
	config: ScalarAggregateConfig,
): AggregateResult => {
	const result: {
		count?: number;
		sum?: Record<string, number>;
		avg?: Record<string, number | null>;
		min?: Record<string, unknown>;
		max?: Record<string, unknown>;
	} = {};

	// Include only requested aggregations
	if (config.count) {
		result.count = acc.count;
	}

	if (config.sum !== undefined) {
		result.sum = acc.sum;
	}

	if (config.avg !== undefined) {
		const avgResult: Record<string, number | null> = {};
		for (const [field, { sum, count }] of Object.entries(acc.avg)) {
			avgResult[field] = count > 0 ? sum / count : null;
		}
		result.avg = avgResult;
	}

	if (config.min !== undefined) {
		result.min = acc.min;
	}

	if (config.max !== undefined) {
		result.max = acc.max;
	}

	return result;
};

/**
 * Compute scalar aggregates over an array of entities.
 *
 * Performs a single-pass reduction computing all requested aggregates simultaneously.
 * This is O(n * k) where n is entities and k is aggregate operations — effectively O(n).
 *
 * @param entities - Array of entities to aggregate
 * @param config - Aggregate configuration specifying which operations to perform
 * @returns AggregateResult with only the requested aggregations
 */
export const computeAggregates = (
	entities: ReadonlyArray<Record<string, unknown>>,
	config: ScalarAggregateConfig,
): AggregateResult => {
	const initialAcc = createAccumulators(config);

	const finalAcc = entities.reduce(
		(acc, entity) => updateAccumulators(acc, entity, config),
		initialAcc,
	);

	return accumulatorsToResult(finalAcc, config);
};

/**
 * Compute grouped aggregates over an array of entities.
 *
 * Partitions entities into groups based on groupBy fields, then applies
 * computeAggregates within each group. Groups are ordered by first encounter.
 *
 * @param entities - Array of entities to aggregate
 * @param config - Grouped aggregate configuration specifying groupBy and operations
 * @returns GroupedAggregateResult array with group objects
 */
export const computeGroupedAggregates = (
	entities: ReadonlyArray<Record<string, unknown>>,
	config: GroupedAggregateConfig,
): GroupedAggregateResult => {
	// Normalize groupBy to array
	const groupByFields = normalizeFields(config.groupBy);

	// Partition entities into groups using Map for first-encounter ordering
	const groups = new Map<string, Array<Record<string, unknown>>>();

	for (const entity of entities) {
		// Build group key from grouping field values
		const groupKey = createGroupKey(
			groupByFields.map((f) => getNestedValue(entity, f)),
		);

		const existing = groups.get(groupKey);
		if (existing !== undefined) {
			existing.push(entity);
		} else {
			groups.set(groupKey, [entity]);
		}
	}

	// Build result for each group
	const result: Array<GroupResult> = [];

	for (const [groupKey, groupEntities] of groups) {
		// Parse back the group values
		const groupValues = parseGroupKey(groupKey);

		// Build the group field object
		const group: Record<string, unknown> = {};
		for (let i = 0; i < groupByFields.length; i++) {
			group[groupByFields[i]] = groupValues[i];
		}

		// Compute aggregates for this group (exclude groupBy from config passed to computeAggregates)
		const { groupBy: _, ...scalarConfig } = config;
		const aggregates = computeAggregates(groupEntities, scalarConfig);

		// Combine group info with aggregates
		result.push({
			group,
			...aggregates,
		});
	}

	return result;
};
