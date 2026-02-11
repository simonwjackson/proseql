import { Stream } from "effect";
import { matchesFilter } from "../../types/operators.js";
import type { SearchConfig } from "../../types/search-types.js";
import { tokenize } from "./search.js";

/**
 * Type guard to check if a where clause is a valid object (not null, not array).
 */
function isValidWhereClause(where: unknown): where is Record<string, unknown> {
	return where !== null && typeof where === "object" && !Array.isArray(where);
}

/**
 * Check if a single item matches a where clause.
 * Handles field-level operators, $or, $and, $not logical operators.
 * Does NOT handle relationship filtering ($some/$every/$none) — that is handled by the populate stage.
 */
function matchesWhere<T extends Record<string, unknown>>(
	item: T,
	where: Record<string, unknown>,
): boolean {
	for (const [key, value] of Object.entries(where)) {
		if (key === "$or") {
			if (!Array.isArray(value)) return false;
			if ((value as unknown[]).length === 0) return false;
			const anyMatch = (value as unknown[]).some((condition) => {
				if (!isValidWhereClause(condition)) return false;
				return matchesWhere(item, condition);
			});
			if (!anyMatch) return false;
		} else if (key === "$and") {
			if (!Array.isArray(value)) return false;
			if ((value as unknown[]).length === 0) continue;
			const allMatch = (value as unknown[]).every((condition) => {
				if (!isValidWhereClause(condition)) return false;
				return matchesWhere(item, condition);
			});
			if (!allMatch) return false;
		} else if (key === "$not") {
			if (!isValidWhereClause(value)) return false;
			if (matchesWhere(item, value)) return false;
		} else if (key === "$search") {
			// Top-level multi-field search: check if entity matches across specified fields
			if (value === null || typeof value !== "object") {
				return false;
			}
			const searchConfig = value as SearchConfig;
			const query = searchConfig.query;

			// Empty query matches everything
			if (!query || query.trim() === "") {
				continue;
			}

			const queryTokens = tokenize(query);
			if (queryTokens.length === 0) {
				// After tokenization, no tokens means match all
				continue;
			}

			// Determine target fields: explicit or all string fields on the entity
			let targetFields: ReadonlyArray<string>;
			if (searchConfig.fields && searchConfig.fields.length > 0) {
				targetFields = searchConfig.fields;
			} else {
				// Find all string fields on the entity
				targetFields = Object.keys(item).filter(
					(k) => typeof item[k] === "string",
				);
			}

			// Check if all query tokens are found across the target fields
			// Each query token must match in at least one field (exact or prefix)
			const allTokensMatch = queryTokens.every((qt) => {
				// Check if this query token matches in any of the target fields
				return targetFields.some((field) => {
					const fieldValue = item[field];
					if (typeof fieldValue !== "string") {
						return false;
					}
					const fieldTokens = tokenize(fieldValue);
					// Check if any field token matches (exact or prefix)
					return fieldTokens.some((ft) => ft === qt || ft.startsWith(qt));
				});
			});

			if (!allTokensMatch) return false;
		} else if (key in item) {
			if (!matchesFilter(item[key], value)) return false;
		} else {
			// Field doesn't exist in item
			if (isValidWhereClause(value)) {
				const ops = value;
				if ("$eq" in ops && ops.$eq === undefined) {
					continue;
				} else if ("$ne" in ops && ops.$ne === undefined) {
					return false;
				}
				const operatorKeys = [
					"$eq",
					"$ne",
					"$in",
					"$nin",
					"$gt",
					"$gte",
					"$lt",
					"$lte",
					"$startsWith",
					"$endsWith",
					"$contains",
					"$all",
					"$size",
					"$search",
				];
				const logicalOperatorKeys = ["$or", "$and", "$not"];
				const hasOperators = Object.keys(ops).some((k) =>
					operatorKeys.includes(k),
				);
				const hasLogicalOperators = Object.keys(ops).some((k) =>
					logicalOperatorKeys.includes(k),
				);
				if (hasOperators || hasLogicalOperators) return false;
			}
			if (value !== undefined) return false;
		}
	}
	return true;
}

/**
 * Apply a where clause filter as a Stream combinator.
 * Returns a function that transforms Stream<T> → Stream<T>, keeping only items matching the where clause.
 *
 * Supports all field-level operators ($eq, $ne, $gt, $gte, $lt, $lte, $in, $nin,
 * $startsWith, $endsWith, $contains, $all, $size) and logical operators ($or, $and, $not).
 */
export const applyFilter =
	<T extends Record<string, unknown>>(
		where: Record<string, unknown> | undefined,
	) =>
	<E, R>(stream: Stream.Stream<T, E, R>): Stream.Stream<T, E, R> => {
		if (!where || !isValidWhereClause(where)) return stream;
		return Stream.filter(stream, (item: T) => matchesWhere(item, where));
	};
