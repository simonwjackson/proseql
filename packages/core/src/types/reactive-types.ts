/**
 * Reactive query types for live subscriptions to data changes.
 * Enables watch() and watchById() methods that emit streams of results
 * whenever the underlying data changes.
 */

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
