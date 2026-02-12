/**
 * Factory functions for creating ChangeEvent objects.
 *
 * These functions provide a convenient and type-safe way to create change events
 * that are published by CRUD operations and file watchers to notify reactive subscriptions.
 */

import type { ChangeEvent } from "../types/reactive-types.js";

/**
 * Creates a ChangeEvent for a collection mutation.
 *
 * @param collection - The name of the collection that was modified
 * @param operation - The type of mutation: "create", "update", "delete", or "reload"
 * @returns A ChangeEvent object
 *
 * @example
 * ```ts
 * // After creating an entity
 * const event = createChangeEvent("books", "create")
 * yield* PubSub.publish(pubsub, event)
 *
 * // After updating an entity
 * const event = createChangeEvent("books", "update")
 * yield* PubSub.publish(pubsub, event)
 * ```
 */
export const createChangeEvent = (
	collection: string,
	operation: ChangeEvent["operation"],
): ChangeEvent => ({
	collection,
	operation,
});

/**
 * Creates a ChangeEvent for a file watcher reload.
 *
 * This is a convenience function for the common case of creating
 * a reload event after data is reloaded from disk.
 *
 * @param collection - The name of the collection that was reloaded
 * @returns A ChangeEvent with operation: "reload"
 *
 * @example
 * ```ts
 * // After reloading data from disk
 * const event = reloadEvent("books")
 * yield* PubSub.publish(pubsub, event)
 * ```
 */
export const reloadEvent = (collection: string): ChangeEvent => ({
	collection,
	operation: "reload",
});
