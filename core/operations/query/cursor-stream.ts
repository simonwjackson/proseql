import { Chunk, Effect, Stream } from "effect"
import type { CursorConfig, CursorPageResult } from "../../types/cursor-types.js"
import { ValidationError } from "../../errors/crud-errors.js"

/**
 * Get a nested value from a record using dot notation.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
	const parts = path.split(".")
	let current: unknown = obj

	for (const part of parts) {
		if (current === null || current === undefined) {
			return undefined
		}

		if (typeof current === "object") {
			current = (current as Record<string, unknown>)[part]
		} else {
			return undefined
		}
	}

	return current
}

/**
 * Extract cursor value from a record using the cursor key.
 * Cursor values are string representations of the sort key value via String().
 */
function extractCursorValue<T extends Record<string, unknown>>(
	record: T,
	key: string,
): string {
	const value = getNestedValue(record, key)
	return String(value)
}

/**
 * Apply cursor-based pagination to a sorted stream.
 *
 * Unlike offset/limit pagination which is a lazy Stream combinator,
 * cursor pagination terminates the stream into a concrete CursorPageResult
 * because cursor metadata (hasNextPage, hasPreviousPage, cursors) requires
 * collecting items.
 *
 * The input stream MUST be sorted by the cursor key (ascending).
 *
 * @param config - The cursor configuration specifying key, after/before, and limit
 * @returns A function that takes a sorted stream and produces a CursorPageResult Effect
 */
export const applyCursor = (config: CursorConfig) =>
	<T extends Record<string, unknown>, E, R>(
		stream: Stream.Stream<T, E, R>,
	): Effect.Effect<CursorPageResult<T>, E | ValidationError, R> => {
		const { key, after, before, limit } = config

		// --- Validation (stub for task 2.6) ---
		// Validation will be implemented in task 2.6

		// --- Cursor boundary filtering ---
		let filteredStream = stream

		if (after !== undefined) {
			// Forward pagination: filter to records where key > after
			filteredStream = Stream.filter(
				filteredStream,
				(record: T) => extractCursorValue(record, key) > after,
			)
		} else if (before !== undefined) {
			// Backward pagination: filter to records where key < before
			filteredStream = Stream.filter(
				filteredStream,
				(record: T) => extractCursorValue(record, key) < before,
			)
		}

		// --- Fetch limit + 1 for has-more detection ---
		// For forward/first-page: take first limit + 1
		// For backward: take last limit + 1 (need to reverse, take, reverse back)

		if (before !== undefined) {
			// Backward pagination: need the last N+1 items
			// Use takeRight to get the last items
			const limitedStream = Stream.takeRight(filteredStream, limit + 1)

			return Effect.gen(function* () {
				const chunk = yield* Stream.runCollect(limitedStream)
				const items = Chunk.toReadonlyArray(chunk) as ReadonlyArray<T>

				// Handle empty results: return empty items, null cursors, both has-flags false
				if (items.length === 0) {
					return {
						items: [],
						pageInfo: {
							startCursor: null,
							endCursor: null,
							hasNextPage: false,
							hasPreviousPage: false,
						},
					} as CursorPageResult<T>
				}

				// Check if we have overflow (more items than limit)
				const hasOverflow = items.length > limit
				const hasPreviousPage = hasOverflow

				// hasNextPage = true when using "before" (items exist after this page)
				const hasNextPage = true

				// Slice off the extra item if we have overflow
				// For backward, the extra item is at the beginning
				const pageItems = hasOverflow ? items.slice(1) : items

				// Extract cursors from first and last items
				const startCursor = extractCursorValue(pageItems[0] as T, key)
				const endCursor = extractCursorValue(
					pageItems[pageItems.length - 1] as T,
					key,
				)

				return {
					items: pageItems,
					pageInfo: {
						startCursor,
						endCursor,
						hasNextPage,
						hasPreviousPage,
					},
				} as CursorPageResult<T>
			})
		} else {
			// Forward pagination or first page: take first N+1 items
			const limitedStream = Stream.take(filteredStream, limit + 1)

			return Effect.gen(function* () {
				const chunk = yield* Stream.runCollect(limitedStream)
				const items = Chunk.toReadonlyArray(chunk) as ReadonlyArray<T>

				// Handle empty results: return empty items, null cursors, both has-flags false
				if (items.length === 0) {
					return {
						items: [],
						pageInfo: {
							startCursor: null,
							endCursor: null,
							hasNextPage: false,
							hasPreviousPage: false,
						},
					} as CursorPageResult<T>
				}

				// Check if we have overflow (more items than limit)
				const hasOverflow = items.length > limit
				const hasNextPage = hasOverflow

				// hasPreviousPage = true when using "after" (items exist before this page)
				const hasPreviousPage = after !== undefined

				// Slice off the extra item if we have overflow
				// For forward, the extra item is at the end
				const pageItems = hasOverflow ? items.slice(0, limit) : items

				// Extract cursors from first and last items
				const startCursor = extractCursorValue(pageItems[0] as T, key)
				const endCursor = extractCursorValue(
					pageItems[pageItems.length - 1] as T,
					key,
				)

				return {
					items: pageItems,
					pageInfo: {
						startCursor,
						endCursor,
						hasNextPage,
						hasPreviousPage,
					},
				} as CursorPageResult<T>
			})
		}
	}
