/**
 * Core watch() implementation for reactive queries.
 *
 * Creates a Stream that emits result sets whenever the underlying collection data changes.
 * Subscribes to the PubSub for change notifications, filters events by collection name,
 * re-evaluates the query pipeline on each change, and emits the new result set.
 */

import { Effect, PubSub, Queue, Ref, Stream } from "effect";
import type { ChangeEvent } from "../types/reactive-types.js";
import { applyFilter } from "../operations/query/filter-stream.js";
import { applySort } from "../operations/query/sort-stream.js";
import { applySelect } from "../operations/query/select-stream.js";
import { applyPagination } from "../operations/query/paginate-stream.js";

/**
 * Configuration for the watch query.
 * Mirrors the subset of QueryConfig that applies to reactive queries.
 */
export interface WatchQueryConfig {
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
 * Reads all entities from the Ref, applies the query pipeline (filter, sort, select, paginate),
 * and returns the result as a ReadonlyArray.
 *
 * @param ref - The collection Ref containing entities keyed by ID
 * @param config - Query configuration (where, sort, select, limit, offset)
 * @returns Effect producing the query result as a ReadonlyArray
 */
const evaluateQuery = <T extends HasId>(
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	config: WatchQueryConfig = {},
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

/**
 * Creates a reactive watch stream that emits query results whenever the collection changes.
 *
 * The stream:
 * 1. Subscribes to the PubSub for change notifications (scoped - auto-cleanup)
 * 2. Filters events to only those matching the specified collection
 * 3. Re-evaluates the query pipeline on each relevant change
 * 4. Emits the new result set as a ReadonlyArray
 *
 * Note: Initial emission and deduplication are handled by separate tasks (3.2, 3.4).
 * Note: Debouncing is handled by a separate task (8.1).
 *
 * @param pubsub - The PubSub broadcasting ChangeEvents from mutations
 * @param ref - The collection Ref containing entities keyed by ID
 * @param collectionName - Name of the collection to watch (for filtering events)
 * @param config - Optional query configuration (where, sort, select, limit, offset)
 * @returns Scoped Effect producing a Stream of result arrays
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const pubsub = yield* createChangePubSub()
 *   const ref = yield* createCollectionState<Book>([])
 *
 *   const stream = yield* watch(pubsub, ref, "books", {
 *     where: { genre: "sci-fi" },
 *     sort: { year: "desc" },
 *     limit: 10,
 *   })
 *
 *   // Consume the stream
 *   yield* Stream.runForEach(stream, (results) =>
 *     Effect.log(`Got ${results.length} results`)
 *   )
 * }).pipe(Effect.scoped)
 * ```
 */
export const watch = <T extends HasId>(
	pubsub: PubSub.PubSub<ChangeEvent>,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	collectionName: string,
	config: WatchQueryConfig = {},
): Effect.Effect<Stream.Stream<ReadonlyArray<T>>, never, import("effect").Scope.Scope> =>
	Effect.gen(function* () {
		// Subscribe to the PubSub - this is automatically cleaned up when scope closes
		const subscription = yield* PubSub.subscribe(pubsub);

		// Create a stream from the subscription queue
		const changeStream = Stream.fromQueue(subscription);

		// Filter to only events for this collection
		const filteredStream = Stream.filter(
			changeStream,
			(event) => event.collection === collectionName,
		);

		// Map each change event to a re-evaluation of the query
		// This transforms Stream<ChangeEvent> into Stream<ReadonlyArray<T>>
		const resultStream = Stream.mapEffect(filteredStream, () =>
			evaluateQuery(ref, config),
		);

		return resultStream;
	});
