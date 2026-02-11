import type { Effect } from "effect"

// ============================================================================
// Cursor Pagination Types
// ============================================================================

/**
 * Configuration for cursor-based pagination.
 *
 * Cursor pagination anchors page boundaries to a specific record's sort key
 * value rather than a numeric position, eliminating duplicates/skips when
 * data changes between page fetches.
 */
export interface CursorConfig {
	/** The field used as the cursor (sort key), e.g. "createdAt", "id" */
	readonly key: string
	/** Fetch items after this cursor value (forward pagination) */
	readonly after?: string
	/** Fetch items before this cursor value (backward pagination) */
	readonly before?: string
	/** Maximum items per page (required, no default) */
	readonly limit: number
}

/**
 * Metadata about page boundaries for cursor pagination.
 */
export interface CursorPageInfo {
	/** Cursor of the first item in the page (null if empty) */
	readonly startCursor: string | null
	/** Cursor of the last item in the page (null if empty) */
	readonly endCursor: string | null
	/** Whether more items exist after this page */
	readonly hasNextPage: boolean
	/** Whether more items exist before this page */
	readonly hasPreviousPage: boolean
}

/**
 * Result of a cursor-paginated query.
 *
 * Contains the page items and metadata about page boundaries.
 */
export interface CursorPageResult<T> {
	/** The items in this page */
	readonly items: ReadonlyArray<T>
	/** Page boundary metadata */
	readonly pageInfo: CursorPageInfo
}

/**
 * An Effect returning a CursorPageResult with a lazy `.runPromise` getter
 * for non-Effect consumers.
 *
 * Accessing `.runPromise` runs the effect and returns a Promise.
 */
export type RunnableCursorPage<T, E> = Effect.Effect<CursorPageResult<T>, E, never> & {
	readonly runPromise: Promise<CursorPageResult<T>>
}
