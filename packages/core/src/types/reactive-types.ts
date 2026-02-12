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
