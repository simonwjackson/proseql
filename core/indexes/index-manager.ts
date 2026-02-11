/**
 * Index management for in-memory database.
 *
 * Provides functions for building and maintaining indexes that accelerate
 * equality queries. Supports both single-field and compound indexes.
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
 * Compute the index key for an entity given the index fields.
 *
 * For single-field indexes, returns the raw field value.
 * For compound indexes, returns a JSON.stringify'd array of field values.
 *
 * Returns undefined if any indexed field is null or undefined (entity should not be indexed).
 */
const computeIndexKey = <T extends HasId>(
	entity: T,
	fields: NormalizedIndex,
): unknown | undefined => {
	const values = fields.map((field) => (entity as Record<string, unknown>)[field]);

	// Skip if any indexed field is null or undefined
	if (values.some((v) => v === null || v === undefined)) {
		return undefined;
	}

	// Single-field: use raw value
	if (fields.length === 1) {
		return values[0];
	}

	// Compound: use JSON.stringify'd array
	return JSON.stringify(values);
};

/**
 * Build an IndexMap for a single index from initial data.
 *
 * @param fields - The normalized index fields
 * @param entities - All entities in the collection
 * @returns The populated IndexMap
 */
const buildSingleIndex = <T extends HasId>(
	fields: NormalizedIndex,
	entities: ReadonlyArray<T>,
): IndexMap => {
	const indexMap: IndexMap = new Map();

	for (const entity of entities) {
		const key = computeIndexKey(entity, fields);
		if (key === undefined) {
			continue;
		}

		const existing = indexMap.get(key);
		if (existing) {
			existing.add(entity.id);
		} else {
			indexMap.set(key, new Set([entity.id]));
		}
	}

	return indexMap;
};

/**
 * Build all indexes for a collection from initial data.
 *
 * For each normalized index, creates a Ref<IndexMap> containing the mapping
 * from field values to entity IDs. The returned CollectionIndexes map is keyed
 * by the JSON.stringify'd field array (e.g., '["email"]' or '["userId","category"]').
 *
 * @param normalizedIndexes - Array of normalized index definitions
 * @param initialData - Array of entities to build indexes from
 * @returns Effect producing a CollectionIndexes map
 */
export const buildIndexes = <T extends HasId>(
	normalizedIndexes: ReadonlyArray<NormalizedIndex>,
	initialData: ReadonlyArray<T>,
): Effect.Effect<CollectionIndexes> =>
	Effect.gen(function* () {
		const collectionIndexes: CollectionIndexes = new Map();

		for (const fields of normalizedIndexes) {
			const indexKey = JSON.stringify(fields);
			const indexMap = buildSingleIndex(fields, initialData);
			const indexRef = yield* Ref.make(indexMap);
			collectionIndexes.set(indexKey, indexRef);
		}

		return collectionIndexes;
	});

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

/**
 * Add an entity to all applicable indexes.
 *
 * For each index in the collection, computes the index key from the entity's
 * field values and adds the entity's ID to the corresponding Set in the index.
 *
 * Entities with null/undefined values in indexed fields are skipped for that index.
 *
 * @param indexes - The collection's indexes
 * @param entity - The entity to add
 * @returns Effect that updates all index Refs
 */
export const addToIndex = <T extends HasId>(
	indexes: CollectionIndexes,
	entity: T,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		for (const [indexKey, indexRef] of indexes) {
			const fields: NormalizedIndex = JSON.parse(indexKey);
			const key = computeIndexKey(entity, fields);

			if (key === undefined) {
				continue;
			}

			yield* Ref.update(indexRef, (indexMap) => {
				const newMap = new Map(indexMap);
				const existing = newMap.get(key);
				if (existing) {
					const newSet = new Set(existing);
					newSet.add(entity.id);
					newMap.set(key, newSet);
				} else {
					newMap.set(key, new Set([entity.id]));
				}
				return newMap;
			});
		}
	});
