/**
 * PubSub for broadcasting change events to reactive query subscribers.
 *
 * Uses Effect's unbounded PubSub to ensure all change events are delivered
 * to subscribers - dropping events would break subscription correctness.
 */

import { Effect, PubSub } from "effect";
import type { ChangeEvent } from "../types/reactive-types.js";

/**
 * Creates an unbounded PubSub for broadcasting ChangeEvents.
 *
 * The PubSub is unbounded because:
 * - Dropping change events would cause subscriptions to miss mutations
 * - This could lead to stale result sets being displayed
 * - Back-pressure is handled by debouncing at the subscription level
 *
 * @returns Effect that produces a PubSub for ChangeEvents
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const pubsub = yield* createChangePubSub()
 *   // Publishers can publish events
 *   yield* pubsub.publish({ collection: "books", operation: "create" })
 *   // Subscribers receive events via subscription queues
 *   const subscription = yield* pubsub.subscribe
 *   const event = yield* Queue.take(subscription)
 * })
 * ```
 */
export const createChangePubSub = (): Effect.Effect<
	PubSub.PubSub<ChangeEvent>
> => PubSub.unbounded<ChangeEvent>();
