/**
 * watchById() implementation for reactive single-entity queries.
 *
 * Thin wrapper over watch() that filters by ID and maps results to T | null.
 * Emits the entity when it exists, or null when it's deleted or doesn't exist.
 */

import { Effect, PubSub, Ref, Stream } from "effect";
import type { ChangeEvent } from "../types/reactive-types.js";
import { watch, type WatchQueryConfig } from "./watch.js";

/**
 * Entity constraint: must have a readonly string `id` field.
 */
type HasId = { readonly id: string };

/**
 * Creates a reactive watch stream for a single entity by ID.
 *
 * This is a thin wrapper over watch() that:
 * 1. Filters by `where: { id }` to only match the specific entity
 * 2. Maps the result array to `T | null` (first element or null if empty)
 *
 * The stream:
 * - Emits the entity immediately if it exists, or null if not
 * - Re-emits when the entity is created, updated, or deleted
 * - Emits null when the entity is deleted (result array becomes empty)
 * - Is scoped: auto-cleanup when scope closes or stream is interrupted
 *
 * @param pubsub - The PubSub broadcasting ChangeEvents from mutations
 * @param ref - The collection Ref containing entities keyed by ID
 * @param collectionName - Name of the collection to watch (for filtering events)
 * @param id - The entity ID to watch
 * @param config - Optional additional watch configuration (debounceMs)
 * @returns Scoped Effect producing a Stream of T | null
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const pubsub = yield* createChangePubSub()
 *   const ref = yield* createCollectionState<Book>([
 *     { id: "1", title: "Dune", author: "Frank Herbert" }
 *   ])
 *
 *   const stream = yield* watchById(pubsub, ref, "books", "1")
 *
 *   // Emits: { id: "1", title: "Dune", author: "Frank Herbert" }
 *   // After delete: emits null
 * }).pipe(Effect.scoped)
 * ```
 */
export const watchById = <T extends HasId>(
	pubsub: PubSub.PubSub<ChangeEvent>,
	ref: Ref.Ref<ReadonlyMap<string, T>>,
	collectionName: string,
	id: string,
	config: Pick<WatchQueryConfig, "debounceMs"> = {},
): Effect.Effect<Stream.Stream<T | null>, never, import("effect").Scope.Scope> =>
	Effect.gen(function* () {
		// Use watch() with a where clause filtering by ID
		const watchStream = yield* watch(pubsub, ref, collectionName, {
			...config,
			where: { id },
		});

		// Map the result array to T | null
		// - results[0] when the entity exists
		// - null when the entity is deleted or doesn't exist
		return Stream.map(watchStream, (results) => results[0] ?? null);
	});
