/**
 * Index management for in-memory database.
 *
 * Provides functions for building and maintaining indexes that accelerate
 * equality queries. Supports both single-field and compound indexes.
 */

import type { NormalizedIndex } from "../types/index-types.js";

/**
 * Normalize index definitions from user config format to internal format.
 *
 * User config can specify indexes as:
 * - Single field: "email"
 * - Compound: ["userId", "category"]
 *
 * This function normalizes all indexes to arrays:
 * - "email" -> ["email"]
 * - ["userId", "category"] -> ["userId", "category"]
 *
 * @param indexes - Raw index definitions from collection config
 * @returns Normalized array of index field arrays
 */
export const normalizeIndexes = (
	indexes: ReadonlyArray<string | ReadonlyArray<string>> | undefined,
): ReadonlyArray<NormalizedIndex> => {
	if (indexes === undefined || indexes.length === 0) {
		return [];
	}

	return indexes.map((index): NormalizedIndex => {
		if (typeof index === "string") {
			return [index];
		}
		return index;
	});
};
