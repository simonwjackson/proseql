/**
 * Reactive query types for live subscriptions to data changes.
 * Enables watch() and watchById() methods that emit streams of results
 * whenever the underlying data changes.
 */

import type {
	PopulateConfig,
	SelectConfig,
	SortConfig,
	WhereClause,
} from "./types.js";

// ============================================================================
// Change Event Types
// ============================================================================

/**
 * Represents a mutation event that occurred on a collection.
 * Published by CRUD operations and file watchers to notify reactive subscriptions.
 *
 * - "create": One or more entities were created
 * - "update": One or more entities were updated
 * - "delete": One or more entities were deleted
 * - "reload": Data was reloaded from disk (file watcher detected external change)
 */
export interface ChangeEvent {
	readonly collection: string;
	readonly operation: "create" | "update" | "delete" | "reload";
}

// ============================================================================
// Watch Configuration Types
// ============================================================================

/**
 * Configuration for reactive watch queries.
 * Mirrors QueryConfig but excludes cursor pagination (watches are continuous streams).
 *
 * @template T - The entity type being watched
 * @template Relations - Relationship definitions for the collection
 * @template DB - The full database type (for cross-collection type resolution)
 */
export type WatchConfig<
	T,
	Relations extends Record<string, unknown> = Record<string, never>,
	DB = unknown,
> =
	// Without populate
	| {
			readonly where?: WhereClause<T, Relations, DB>;
			readonly sort?: SortConfig<T, Relations, Record<string, never>, DB>;
			readonly select?: SelectConfig<T, Relations, DB>;
			readonly limit?: number;
			readonly offset?: number;
	  }
	// With populate
	| {
			readonly populate: PopulateConfig<Relations, DB>;
			readonly where?: WhereClause<T, Relations, DB>;
			readonly sort?: SortConfig<
				T,
				Relations,
				{ populate: PopulateConfig<Relations, DB> },
				DB
			>;
			readonly select?: SelectConfig<T, Relations, DB>;
			readonly limit?: number;
			readonly offset?: number;
	  };

// ============================================================================
// Watch Method Signatures
// ============================================================================

/**
 * Signature for the watch() method on collections.
 *
 * Creates a reactive subscription that emits the current result set immediately,
 * then re-emits whenever the underlying data changes (create/update/delete/reload).
 *
 * The stream is scoped: it subscribes to change notifications on creation and
 * automatically unsubscribes when the scope closes or the stream is interrupted.
 *
 * @template T - The entity type being watched
 * @template Relations - Relationship definitions for the collection
 * @template DB - The full database type (for cross-collection type resolution)
 * @param config - Optional query configuration (where, sort, select, limit, offset, populate)
 * @returns A scoped Effect that produces a Stream of result arrays
 */
export type WatchMethod<
	T,
	Relations extends Record<string, unknown> = Record<string, never>,
	DB = unknown,
> = <C extends WatchConfig<T, Relations, DB>>(
	config?: C,
) => import("effect").Effect.Effect<
	import("effect").Stream.Stream<ReadonlyArray<T>, never, never>,
	never,
	import("effect").Scope.Scope
>;

/**
 * Signature for the watchById() method on collections.
 *
 * Creates a reactive subscription for a single entity by ID.
 * Emits the entity immediately if it exists (or null if not), then re-emits
 * whenever the entity is created, updated, or deleted.
 *
 * The stream is scoped: it subscribes to change notifications on creation and
 * automatically unsubscribes when the scope closes or the stream is interrupted.
 *
 * @template T - The entity type being watched
 * @param id - The entity ID to watch
 * @returns A scoped Effect that produces a Stream of T | null
 */
export type WatchByIdMethod<T> = (
	id: string,
) => import("effect").Effect.Effect<
	import("effect").Stream.Stream<T | null, never, never>,
	never,
	import("effect").Scope.Scope
>;
