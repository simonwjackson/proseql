/**
 * Search index management for full-text search.
 *
 * Provides functions for building and maintaining an inverted index
 * that maps tokens to entity IDs for fast text search queries.
 *
 * Follows the same Ref-based pattern as index-manager.ts for consistency.
 */

import { Effect, Ref } from "effect";
import { tokenize } from "../operations/query/search.js";
import type { SearchIndexMap } from "../types/search-types.js";
import { getNestedValue } from "../utils/nested-path.js";

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
			addEntityToIndexMut(searchIndex, entity, fields);
		}

		return yield* Ref.make(searchIndex);
	});

/**
 * Lookup candidate entity IDs from the search index for a given query.
 *
 * For each query token:
 * - Finds exact matches in the index
 * - Finds prefix matches (index tokens that start with the query token)
 *
 * Returns the intersection of ID sets across all query tokens (AND semantics).
 * If a query token has no matches, returns an empty set.
 * If queryTokens is empty, returns an empty set.
 *
 * @param indexRef - Ref containing the SearchIndexMap
 * @param queryTokens - Tokenized query terms to search for
 * @returns Effect producing a Set of candidate entity IDs
 *
 * @example
 * ```ts
 * // Index: "dune" -> Set(["1"]), "frank" -> Set(["1"]), "neuromancer" -> Set(["2"])
 *
 * // Exact match
 * const ids = yield* lookupSearchIndex(indexRef, ["dune"])
 * // → Set(["1"])
 *
 * // Prefix match
 * const ids = yield* lookupSearchIndex(indexRef, ["neuro"])
 * // → Set(["2"]) (matches "neuromancer")
 *
 * // Multi-token (AND semantics)
 * const ids = yield* lookupSearchIndex(indexRef, ["dune", "frank"])
 * // → Set(["1"]) (intersection)
 *
 * // No match
 * const ids = yield* lookupSearchIndex(indexRef, ["xyz"])
 * // → Set([])
 * ```
 */
export const lookupSearchIndex = (
	indexRef: Ref.Ref<SearchIndexMap>,
	queryTokens: ReadonlyArray<string>,
): Effect.Effect<Set<string>> =>
	Effect.gen(function* () {
		// Empty query returns empty set
		if (queryTokens.length === 0) {
			return new Set<string>();
		}

		const index = yield* Ref.get(indexRef);

		// For each query token, find all matching IDs (exact + prefix)
		const tokenMatchSets: Array<Set<string>> = [];

		for (const queryToken of queryTokens) {
			const matchingIds = new Set<string>();

			// Check each token in the index for exact or prefix match
			for (const [indexToken, entityIds] of index) {
				if (indexToken === queryToken || indexToken.startsWith(queryToken)) {
					// Union all matching entity IDs for this query token
					for (const id of entityIds) {
						matchingIds.add(id);
					}
				}
			}

			tokenMatchSets.push(matchingIds);
		}

		// Intersect all token match sets (AND semantics)
		// If any token has no matches, the result is empty
		if (tokenMatchSets.length === 0) {
			return new Set<string>();
		}

		// Start with the first set and intersect with the rest
		const result = new Set<string>(tokenMatchSets[0]);

		for (let i = 1; i < tokenMatchSets.length; i++) {
			const currentSet = tokenMatchSets[i];
			for (const id of result) {
				if (!currentSet.has(id)) {
					result.delete(id);
				}
			}
		}

		return result;
	});

/**
 * Resolve candidate entities using the search index when a search query is present.
 *
 * Checks if the where clause contains a $search operator (field-level or top-level).
 * If found and the search index covers the queried fields, uses the index to
 * narrow the candidate set before full filtering.
 *
 * Returns undefined if:
 * - No $search operator is present
 * - The search index doesn't cover the queried fields
 * - The search index is empty
 *
 * @param where - The where clause from the query
 * @param searchIndexRef - The search index Ref (or undefined if not configured)
 * @param searchIndexFields - The fields covered by the search index (or undefined)
 * @param map - The entity data map (id -> entity)
 * @returns Effect producing Array<T> if index was used, undefined if no usable index
 */
export const resolveWithSearchIndex = <T extends HasId>(
	where: Record<string, unknown> | undefined,
	searchIndexRef: Ref.Ref<SearchIndexMap> | undefined,
	searchIndexFields: ReadonlyArray<string> | undefined,
	map: ReadonlyMap<string, T>,
): Effect.Effect<ReadonlyArray<T> | undefined> =>
	Effect.gen(function* () {
		// No where clause or no search index configured
		if (
			!where ||
			!searchIndexRef ||
			!searchIndexFields ||
			searchIndexFields.length === 0
		) {
			return undefined;
		}

		// Extract search query from where clause
		const searchInfo = extractSearchFromWhere(where, searchIndexFields);
		if (!searchInfo) {
			return undefined;
		}

		const { queryTokens, queriedFields } = searchInfo;

		// Check if the search index covers all queried fields
		const indexCovered = queriedFields.every((field) =>
			searchIndexFields.includes(field),
		);
		if (!indexCovered) {
			return undefined;
		}

		// Use the search index to get candidate entity IDs
		const candidateIds = yield* lookupSearchIndex(searchIndexRef, queryTokens);

		// Empty result set means no candidates
		if (candidateIds.size === 0) {
			return [];
		}

		// Load candidate entities from the map
		const entities: Array<T> = [];
		for (const id of candidateIds) {
			const entity = map.get(id);
			if (entity !== undefined) {
				entities.push(entity);
			}
		}

		return entities;
	});

/**
 * Extract search query info from a where clause.
 *
 * Looks for:
 * 1. Top-level $search: { query: "...", fields?: [...] }
 * 2. Field-level $search: { fieldName: { $search: "..." } }
 *
 * Returns the tokenized query and the fields being searched, or undefined if no search.
 */
const extractSearchFromWhere = (
	where: Record<string, unknown>,
	defaultFields: ReadonlyArray<string>,
):
	| { queryTokens: ReadonlyArray<string>; queriedFields: ReadonlyArray<string> }
	| undefined => {
	// Check for top-level $search
	if ("$search" in where) {
		const searchValue = where.$search;
		if (searchValue !== null && typeof searchValue === "object") {
			const config = searchValue as {
				query?: string;
				fields?: ReadonlyArray<string>;
			};
			if (typeof config.query === "string") {
				const queryTokens = tokenize(config.query);
				if (queryTokens.length === 0) {
					return undefined; // Empty query matches everything, no index help
				}
				const queriedFields =
					config.fields && config.fields.length > 0
						? config.fields
						: defaultFields;
				return { queryTokens, queriedFields };
			}
		}
	}

	// Check for field-level $search on any field
	for (const [field, value] of Object.entries(where)) {
		// Skip logical operators
		if (
			field === "$or" ||
			field === "$and" ||
			field === "$not" ||
			field === "$search"
		) {
			continue;
		}

		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			const obj = value as Record<string, unknown>;
			if ("$search" in obj && typeof obj.$search === "string") {
				const queryTokens = tokenize(obj.$search);
				if (queryTokens.length === 0) {
					continue; // Empty query, skip
				}
				// Field-level search applies to just this field
				return { queryTokens, queriedFields: [field] };
			}
		}
	}

	return undefined;
};

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
const addEntityToIndexMut = <T extends HasId>(
	index: SearchIndexMap,
	entity: T,
	fields: ReadonlyArray<string>,
): void => {
	const entityRecord = entity as Record<string, unknown>;
	const entityId = entity.id;

	for (const field of fields) {
		const fieldValue = getNestedValue(entityRecord, field);

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

/**
 * Add an entity to the search index.
 *
 * Tokenizes the entity's indexed fields and adds the entity ID to each
 * token's set in the inverted index. This should be called after creating
 * a new entity to keep the search index up to date.
 *
 * @param indexRef - Ref containing the SearchIndexMap
 * @param entity - The entity to add to the index
 * @param fields - The fields to index for full-text search
 * @returns Effect that completes when the entity is added
 *
 * @example
 * ```ts
 * const newBook = { id: "5", title: "Snow Crash", author: "Neal Stephenson" }
 * yield* addToSearchIndex(indexRef, newBook, ["title", "author"])
 * // Index now contains:
 * // "snow" -> Set([..., "5"])
 * // "crash" -> Set([..., "5"])
 * // "neal" -> Set([..., "5"])
 * // "stephenson" -> Set([..., "5"])
 * ```
 */
export const addToSearchIndex = <T extends HasId>(
	indexRef: Ref.Ref<SearchIndexMap>,
	entity: T,
	fields: ReadonlyArray<string>,
): Effect.Effect<void> =>
	Ref.update(indexRef, (index) => {
		// Clone the index to avoid mutating the original
		const newIndex: SearchIndexMap = new Map(index);
		addEntityToIndexMut(newIndex, entity, fields);
		return newIndex;
	});

/**
 * Helper function to remove a single entity from a search index map.
 *
 * Tokenizes the values of the specified fields and removes the entity's ID
 * from each token's set in the index. Cleans up empty sets.
 *
 * @param index - The search index map to mutate
 * @param entity - The entity to remove
 * @param fields - The fields that were indexed
 */
const removeEntityFromIndexMut = <T extends HasId>(
	index: SearchIndexMap,
	entity: T,
	fields: ReadonlyArray<string>,
): void => {
	const entityRecord = entity as Record<string, unknown>;
	const entityId = entity.id;

	for (const field of fields) {
		const fieldValue = entityRecord[field];

		// Only process string fields
		if (typeof fieldValue !== "string") {
			continue;
		}

		// Tokenize the field value and remove from index
		const tokens = tokenize(fieldValue);
		for (const token of tokens) {
			const existingSet = index.get(token);
			if (existingSet) {
				existingSet.delete(entityId);
				// Clean up empty sets
				if (existingSet.size === 0) {
					index.delete(token);
				}
			}
		}
	}
};

/**
 * Remove an entity from the search index.
 *
 * Tokenizes the entity's indexed fields and removes the entity ID from each
 * token's set in the inverted index. Cleans up empty sets to avoid memory
 * leaks. This should be called after deleting an entity to keep the search
 * index up to date.
 *
 * @param indexRef - Ref containing the SearchIndexMap
 * @param entity - The entity to remove from the index
 * @param fields - The fields that were indexed for full-text search
 * @returns Effect that completes when the entity is removed
 *
 * @example
 * ```ts
 * const bookToDelete = { id: "5", title: "Snow Crash", author: "Neal Stephenson" }
 * yield* removeFromSearchIndex(indexRef, bookToDelete, ["title", "author"])
 * // Index now has entity "5" removed from:
 * // "snow", "crash", "neal", "stephenson" sets
 * // Empty sets are deleted from the index
 * ```
 */
export const removeFromSearchIndex = <T extends HasId>(
	indexRef: Ref.Ref<SearchIndexMap>,
	entity: T,
	fields: ReadonlyArray<string>,
): Effect.Effect<void> =>
	Ref.update(indexRef, (index) => {
		// Clone the index to avoid mutating the original
		const newIndex: SearchIndexMap = new Map(index);
		// Also clone the sets that we'll modify to maintain immutability
		for (const [token, idSet] of index) {
			newIndex.set(token, new Set(idSet));
		}
		removeEntityFromIndexMut(newIndex, entity, fields);
		return newIndex;
	});

/**
 * Update an entity in the search index.
 *
 * Efficiently handles updates by only reindexing fields that have changed.
 * For changed fields, removes old tokens and adds new tokens. This should
 * be called after updating an entity to keep the search index up to date.
 *
 * Optimization: If a field's value hasn't changed, no index operations are
 * performed for that field. This is more efficient than a full remove+add
 * when only some indexed fields are modified.
 *
 * @param indexRef - Ref containing the SearchIndexMap
 * @param oldEntity - The entity before the update
 * @param newEntity - The entity after the update
 * @param fields - The fields that are indexed for full-text search
 * @returns Effect that completes when the index is updated
 *
 * @example
 * ```ts
 * const oldBook = { id: "5", title: "Snow Crash", author: "Neal Stephenson" }
 * const newBook = { id: "5", title: "Snow Crash (Revised)", author: "Neal Stephenson" }
 * yield* updateInSearchIndex(indexRef, oldBook, newBook, ["title", "author"])
 * // Only "title" changed, so:
 * // - Removes "5" from "snow", "crash"
 * // - Adds "5" to "snow", "crash", "revised"
 * // - "author" field is unchanged, no operations needed
 * ```
 */
export const updateInSearchIndex = <T extends HasId>(
	indexRef: Ref.Ref<SearchIndexMap>,
	oldEntity: T,
	newEntity: T,
	fields: ReadonlyArray<string>,
): Effect.Effect<void> =>
	Ref.update(indexRef, (index) => {
		const oldRecord = oldEntity as Record<string, unknown>;
		const newRecord = newEntity as Record<string, unknown>;

		// Find which fields have actually changed
		const changedFields: Array<string> = [];
		for (const field of fields) {
			const oldValue = oldRecord[field];
			const newValue = newRecord[field];
			if (oldValue !== newValue) {
				changedFields.push(field);
			}
		}

		// If no indexed fields changed, return the original index unchanged
		if (changedFields.length === 0) {
			return index;
		}

		// Clone the index to avoid mutating the original
		const newIndex: SearchIndexMap = new Map(index);
		// Also clone the sets that we'll modify to maintain immutability
		for (const [token, idSet] of index) {
			newIndex.set(token, new Set(idSet));
		}

		// Remove old tokens and add new tokens for changed fields only
		removeEntityFromIndexMut(newIndex, oldEntity, changedFields);
		addEntityToIndexMut(newIndex, newEntity, changedFields);

		return newIndex;
	});
