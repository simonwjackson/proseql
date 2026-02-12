/**
 * Reusable query evaluation function for reactive queries.
 *
 * Reads the current state from a Ref and applies the query pipeline
 * (filter, sort, select, paginate) to produce a result array.
 *
 * Used by watch() for initial emission and re-evaluation on change events.
 */

import { Effect, Ref, Stream } from "effect";
import { applyFilter } from "../operations/query/filter-stream.js";
import { applyPagination } from "../operations/query/paginate-stream.js";
import { applySelect } from "../operations/query/select-stream.js";
import { applySort } from "../operations/query/sort-stream.js";

/**
 * Configuration for query evaluation.
 * Mirrors the subset of QueryConfig that applies to reactive queries.
 */
export interface EvaluateQueryConfig {
	readonly where?: Record<string, unknown>;
	readonly sort?: Record<string, "asc" | "desc">;
	readonly select?: Record<string, unknown> | ReadonlyArray<string>;
	readonly limit?: number;
	readonly offset?: number;
}

/**
 * Entity constraint: must have a readonly string `id` field.
 */
type HasId = { readonly id: string };

/**
 * Evaluates a query against the current state in the Ref.
 *
 * Reads all entities from the Ref, applies the query pipeline (filter, sort,
 * select, paginate), and returns the result as a ReadonlyArray.
 *
 * This is a pure function that:
 * - Does NOT emit multiple values over time (unlike a Stream)
 * - Does NOT provide cursor-based pagination (returns complete result snapshot)
 * - Returns the entire result set as a single ReadonlyArray
 *
 * @param ref - The collection Ref containing entities keyed by ID
 * @param config - Query configuration (where, sort, select, limit, offset)
 * @returns Effect producing the query result as a ReadonlyArray
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const ref = yield* createCollectionState<Book>([
 *     { id: "1", title: "Dune", year: 1965, genre: "sci-fi" },
 *     { id: "2", title: "Neuromancer", year: 1984, genre: "sci-fi" },
 *     { id: "3", title: "The Hobbit", year: 1937, genre: "fantasy" },
 *   ])
 *
 *   const results = yield* evaluateQuery(ref, {
 *     where: { genre: "sci-fi" },
 *     sort: { year: "desc" },
 *     limit: 1,
 *   })
 *   // results: [{ id: "2", title: "Neuromancer", year: 1984, genre: "sci-fi" }]
 * })
 * ```
 */
export const evaluateQuery = <T extends HasId>(
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	config: EvaluateQueryConfig = {},
): Effect.Effect<ReadonlyArray<T>> =>
	Effect.gen(function* () {
		// Read current state from Ref
		const map = yield* Ref.get(ref);
		const entities = Array.from(map.values());

		// Build and execute the query pipeline
		const stream = Stream.fromIterable(entities).pipe(
			applyFilter(config.where),
			applySort(config.sort),
			applyPagination(config.offset, config.limit),
			applySelect(config.select),
		);

		// Collect results into an array
		const chunk = yield* Stream.runCollect(stream);
		return Array.from(chunk) as ReadonlyArray<T>;
	});
