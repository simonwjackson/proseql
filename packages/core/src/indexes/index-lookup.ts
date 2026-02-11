/**
 * Index lookup for query acceleration.
 *
 * Provides functions for resolving entities using indexes when the query's
 * where clause contains equality conditions on indexed fields.
 */

import { Effect, Ref } from "effect";
import type {
	CollectionIndexes,
	IndexMap,
	NormalizedIndex,
} from "../types/index-types.js";

/**
 * Entity constraint: must have a readonly string `id` field.
 */
type HasId = { readonly id: string };

/**
 * Resolve entities using an index if the where clause is eligible.
 *
 * Checks the where clause for equality conditions (direct value, $eq, or $in)
 * on indexed fields. If a usable index is found, returns the matching entities.
 * Otherwise returns undefined, signaling that the caller should fall back to
 * a full scan.
 *
 * The where clause is NOT modified — the filter stage should still run on the
 * returned entities to apply any remaining conditions.
 *
 * @param where - The where clause from the query (may be undefined)
 * @param indexes - The collection's indexes
 * @param map - The entity data map (id -> entity)
 * @returns Effect producing Array<T> if index was used, undefined if no usable index
 */
export const resolveWithIndex = <T extends HasId>(
	where: Record<string, unknown> | undefined,
	indexes: CollectionIndexes,
	map: ReadonlyMap<string, T>,
): Effect.Effect<ReadonlyArray<T> | undefined> =>
	Effect.gen(function* () {
		// No where clause means no index can help
		if (where === undefined || Object.keys(where).length === 0) {
			return undefined;
		}

		// Skip if where contains logical operators at top level
		if ("$or" in where || "$and" in where || "$not" in where) {
			return undefined;
		}

		// No indexes configured
		if (indexes.size === 0) {
			return undefined;
		}

		// Find the best usable index
		const eligibleIndex = findEligibleIndex(where, indexes);
		if (eligibleIndex === undefined) {
			return undefined;
		}

		const { indexKey, fields, conditions } = eligibleIndex;
		const indexRef = indexes.get(indexKey);
		if (indexRef === undefined) {
			return undefined;
		}

		// Get the current index state
		const indexMap = yield* Ref.get(indexRef);

		// Resolve entity IDs from the index
		const entityIds = resolveEntityIds(fields, conditions, indexMap);

		// Load entities from the map
		const entities: Array<T> = [];
		for (const id of entityIds) {
			const entity = map.get(id);
			if (entity !== undefined) {
				entities.push(entity);
			}
		}

		return entities;
	});

/**
 * Condition extracted from a where clause field.
 * Represents the type of equality condition and the value(s) to match.
 */
type FieldCondition = {
	readonly type: "direct" | "$eq" | "$in";
	readonly values: ReadonlyArray<unknown>;
};

/**
 * Extract the equality condition from a where clause field value.
 *
 * Returns undefined if the field value is not an equality condition
 * (e.g., it uses $ne, $gt, etc.).
 */
const extractEqualityCondition = (
	fieldValue: unknown,
): FieldCondition | undefined => {
	// Direct equality: { email: "alice@example.com" }
	if (
		fieldValue === null ||
		typeof fieldValue !== "object" ||
		Array.isArray(fieldValue)
	) {
		return { type: "direct", values: [fieldValue] };
	}

	const obj = fieldValue as Record<string, unknown>;

	// Check for $eq: { email: { $eq: "alice@example.com" } }
	if ("$eq" in obj && Object.keys(obj).length === 1) {
		return { type: "$eq", values: [obj.$eq] };
	}

	// Check for $in: { email: { $in: ["a@b.com", "c@d.com"] } }
	if ("$in" in obj && Object.keys(obj).length === 1 && Array.isArray(obj.$in)) {
		return { type: "$in", values: obj.$in };
	}

	// Other operators ($ne, $gt, etc.) are not index-eligible
	return undefined;
};

/**
 * Result of finding an eligible index.
 */
type EligibleIndex = {
	readonly indexKey: string;
	readonly fields: NormalizedIndex;
	readonly conditions: ReadonlyArray<FieldCondition>;
};

/**
 * Find the best index that can serve the given where clause.
 *
 * An index is eligible when all its fields have equality conditions
 * (direct, $eq, or $in) in the where clause.
 *
 * When multiple indexes match, prefer the one with more fields (compound
 * over single-field) as it narrows the result set more aggressively.
 */
const findEligibleIndex = (
	where: Record<string, unknown>,
	indexes: CollectionIndexes,
): EligibleIndex | undefined => {
	let bestMatch: EligibleIndex | undefined = undefined;

	for (const indexKey of indexes.keys()) {
		const fields: NormalizedIndex = JSON.parse(indexKey);

		// Check if all fields in this index have equality conditions
		const conditions: Array<FieldCondition> = [];
		let allFieldsMatch = true;

		for (const field of fields) {
			if (!(field in where)) {
				allFieldsMatch = false;
				break;
			}

			const condition = extractEqualityCondition(where[field]);
			if (condition === undefined) {
				allFieldsMatch = false;
				break;
			}

			conditions.push(condition);
		}

		if (!allFieldsMatch) {
			continue;
		}

		// This index is eligible
		// Prefer indexes with more fields (compound over single)
		if (bestMatch === undefined || fields.length > bestMatch.fields.length) {
			bestMatch = { indexKey, fields, conditions };
		}
	}

	return bestMatch;
};

/**
 * Resolve entity IDs from the index using the extracted conditions.
 *
 * For single-field indexes with direct/$eq, returns the Set from the index.
 * For $in conditions, returns the union of Sets for each value.
 * For compound indexes, computes the Cartesian product of $in values.
 */
const resolveEntityIds = (
	fields: NormalizedIndex,
	conditions: ReadonlyArray<FieldCondition>,
	indexMap: IndexMap,
): Set<string> => {
	const result = new Set<string>();

	if (fields.length === 1) {
		// Single-field index
		const condition = conditions[0];
		for (const value of condition.values) {
			const ids = indexMap.get(value);
			if (ids !== undefined) {
				for (const id of ids) {
					result.add(id);
				}
			}
		}
	} else {
		// Compound index — compute Cartesian product of all condition values
		const allValueCombinations = cartesianProduct(
			conditions.map((c) => c.values),
		);

		for (const combination of allValueCombinations) {
			const compoundKey = JSON.stringify(combination);
			const ids = indexMap.get(compoundKey);
			if (ids !== undefined) {
				for (const id of ids) {
					result.add(id);
				}
			}
		}
	}

	return result;
};

/**
 * Compute the Cartesian product of arrays.
 *
 * cartesianProduct([["a", "b"], [1, 2]]) => [["a", 1], ["a", 2], ["b", 1], ["b", 2]]
 */
const cartesianProduct = (
	arrays: ReadonlyArray<ReadonlyArray<unknown>>,
): ReadonlyArray<ReadonlyArray<unknown>> => {
	if (arrays.length === 0) {
		return [[]];
	}

	const [first, ...rest] = arrays;
	const restProduct = cartesianProduct(rest);

	const result: Array<Array<unknown>> = [];
	for (const value of first) {
		for (const restCombination of restProduct) {
			result.push([value, ...restCombination]);
		}
	}

	return result;
};
