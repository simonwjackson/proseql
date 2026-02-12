/**
 * Core watch() implementation for reactive queries.
 *
 * Creates a Stream that emits result sets whenever the underlying collection data changes.
 * Subscribes to the PubSub for change notifications, filters events by collection name,
 * re-evaluates the query pipeline on each change, deduplicates identical consecutive results,
 * and emits the new result set.
 */

import { Effect, PubSub, Ref, Stream } from "effect";
import type { ChangeEvent } from "../types/reactive-types.js";
import {
	evaluateQuery,
	type EvaluateQueryConfig,
} from "./evaluate-query.js";

/**
 * Configuration for the watch query.
 * Re-exports EvaluateQueryConfig for backward compatibility.
 */
export type WatchQueryConfig = EvaluateQueryConfig;

/**
 * Entity constraint: must have a readonly string `id` field.
 */
type HasId = { readonly id: string };

/**
 * Compares two result arrays for structural equality.
 *
 * Uses JSON serialization for deep comparison. This is simple and correct for
 * comparing arrays of plain objects (which is what query results are).
 *
 * @param a - First result array
 * @param b - Second result array
 * @returns true if the arrays are structurally equal
 */
const resultsAreEqual = <T>(
	a: ReadonlyArray<T>,
	b: ReadonlyArray<T>,
): boolean => {
	// Fast path: same reference
	if (a === b) return true;

	// Fast path: different lengths
	if (a.length !== b.length) return false;

	// Compare by serialization for deep structural equality
	return JSON.stringify(a) === JSON.stringify(b);
};

/**
 * Creates a reactive watch stream that emits query results whenever the collection changes.
 *
 * The stream:
 * 1. Emits the current result set immediately upon subscription
 * 2. Subscribes to the PubSub for change notifications (scoped - auto-cleanup)
 * 3. Filters events to only those matching the specified collection
 * 4. Re-evaluates the query pipeline on each relevant change
 * 5. Deduplicates consecutive identical result sets to avoid spurious emissions
 * 6. Emits the new result set as a ReadonlyArray
 *
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
		const changeResultStream = Stream.mapEffect(filteredStream, () =>
			evaluateQuery(ref, config),
		);

		// Create the initial emission stream: emit current result set immediately
		const initialStream = Stream.fromEffect(evaluateQuery(ref, config));

		// Concatenate initial emission with the change-driven stream
		// This ensures subscribers receive the current state immediately,
		// then receive updates as changes occur
		const combinedStream = Stream.concat(initialStream, changeResultStream);

		// Deduplicate consecutive identical result sets to avoid spurious emissions.
		// This prevents re-emitting the same result set when a change event occurs
		// but doesn't actually affect the query results (e.g., inserting an entity
		// that doesn't match the where clause).
		const resultStream = Stream.changesWith(combinedStream, resultsAreEqual);

		return resultStream;
	});
