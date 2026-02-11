/**
 * Search index management for full-text search.
 *
 * Provides functions for building and maintaining an inverted index
 * that maps tokens to entity IDs for fast text search queries.
 *
 * Follows the same Ref-based pattern as index-manager.ts for consistency.
 */

import { Effect, Ref } from "effect";
import type { SearchIndexMap } from "../types/search-types.js";
import { tokenize } from "../operations/query/search.js";

/**
 * Entity constraint: must have a readonly string `id` field.
 */
type HasId = { readonly id: string };

/**
 * Build a search index from entities for the specified fields.
 *
 * Creates an inverted index mapping tokens to sets of entity IDs.
 * For each entity, tokenizes the values of the specified fields
 * and adds the entity's ID to each token's set.
 *
 * @param fields - The fields to index for full-text search
 * @param entities - All entities in the collection
 * @returns Effect producing a Ref containing the SearchIndexMap
 *
 * @example
 * ```ts
 * const books = [
 *   { id: "1", title: "Dune", author: "Frank Herbert" },
 *   { id: "2", title: "Neuromancer", author: "William Gibson" },
 * ]
 *
 * const indexRef = yield* buildSearchIndex(["title", "author"], books)
 * // Index structure:
 * // "dune" -> Set(["1"])
 * // "frank" -> Set(["1"])
 * // "herbert" -> Set(["1"])
 * // "neuromancer" -> Set(["2"])
 * // "william" -> Set(["2"])
 * // "gibson" -> Set(["2"])
 * ```
 */
export const buildSearchIndex = <T extends HasId>(
	fields: ReadonlyArray<string>,
	entities: ReadonlyArray<T>,
): Effect.Effect<Ref.Ref<SearchIndexMap>> =>
	Effect.gen(function* () {
		const searchIndex: SearchIndexMap = new Map();

		for (const entity of entities) {
			addEntityToIndex(searchIndex, entity, fields);
		}

		return yield* Ref.make(searchIndex);
	});

/**
 * Helper function to add a single entity to a search index map.
 *
 * Tokenizes the values of the specified fields and adds the entity's ID
 * to each token's set in the index.
 *
 * @param index - The search index map to mutate
 * @param entity - The entity to add
 * @param fields - The fields to index
 */
const addEntityToIndex = <T extends HasId>(
	index: SearchIndexMap,
	entity: T,
	fields: ReadonlyArray<string>,
): void => {
	const entityRecord = entity as Record<string, unknown>;
	const entityId = entity.id;

	for (const field of fields) {
		const fieldValue = entityRecord[field];

		// Only index string fields
		if (typeof fieldValue !== "string") {
			continue;
		}

		// Tokenize the field value and add to index
		const tokens = tokenize(fieldValue);
		for (const token of tokens) {
			const existingSet = index.get(token);
			if (existingSet) {
				existingSet.add(entityId);
			} else {
				index.set(token, new Set([entityId]));
			}
		}
	}
};
