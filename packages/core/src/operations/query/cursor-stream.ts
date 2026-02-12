import { Chunk, Effect, Stream } from "effect";
import { ValidationError } from "../../errors/crud-errors.js";
import type {
	CursorConfig,
	CursorPageResult,
} from "../../types/cursor-types.js";
import { getNestedValue } from "../../utils/nested-path.js";

/**
 * Check if a key exists on a record (returns undefined only if property doesn't exist).
 */
function keyExistsOnRecord(
	record: Record<string, unknown>,
	key: string,
): boolean {
	const parts = key.split(".");
	let current: unknown = record;

	for (const part of parts) {
		if (current === null || current === undefined) {
			return false;
		}

		if (typeof current === "object" && part in (current as object)) {
			current = (current as Record<string, unknown>)[part];
		} else {
			return false;
		}
	}

	return true;
}

/**
 * Extract cursor value from a record using the cursor key.
 * Cursor values are string representations of the sort key value via String().
 */
function extractCursorValue<T extends Record<string, unknown>>(
	record: T,
	key: string,
): string {
	const value = getNestedValue(record, key);
	return String(value);
}

/**
 * Validate that the cursor key exists on the items.
 * Returns a ValidationError if the key doesn't exist.
 */
function validateKeyExists<T extends Record<string, unknown>>(
	items: ReadonlyArray<T>,
	key: string,
): ValidationError | null {
	if (items.length === 0) {
		return null;
	}

	// Check the first item to validate the key exists
	const firstItem = items[0];
	if (!keyExistsOnRecord(firstItem as Record<string, unknown>, key)) {
		return new ValidationError({
			message: "Invalid cursor configuration",
			issues: [
				{
					field: "cursor.key",
					message: `key '${key}' does not exist on entity`,
				},
			],
		});
	}

	return null;
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
export const applyCursor =
	(config: CursorConfig) =>
	<T extends Record<string, unknown>, E, R>(
		stream: Stream.Stream<T, E, R>,
	): Effect.Effect<CursorPageResult<T>, E | ValidationError, R> => {
		const { key, after, before, limit } = config;

		// --- Validation ---
		// Reject after + before both set
		if (after !== undefined && before !== undefined) {
			return Effect.fail(
				new ValidationError({
					message: "Invalid cursor configuration",
					issues: [
						{
							field: "cursor",
							message: "after and before are mutually exclusive",
						},
					],
				}),
			);
		}

		// Reject limit <= 0
		if (limit <= 0) {
			return Effect.fail(
				new ValidationError({
					message: "Invalid cursor configuration",
					issues: [
						{
							field: "cursor.limit",
							message: "limit must be a positive integer",
						},
					],
				}),
			);
		}

		// --- Cursor boundary filtering ---
		let filteredStream = stream;

		if (after !== undefined) {
			// Forward pagination: filter to records where key > after
			filteredStream = Stream.filter(
				filteredStream,
				(record: T) => extractCursorValue(record, key) > after,
			);
		} else if (before !== undefined) {
			// Backward pagination: filter to records where key < before
			filteredStream = Stream.filter(
				filteredStream,
				(record: T) => extractCursorValue(record, key) < before,
			);
		}

		// --- Fetch limit + 1 for has-more detection ---
		// For forward/first-page: take first limit + 1
		// For backward: take last limit + 1 (need to reverse, take, reverse back)

		if (before !== undefined) {
			// Backward pagination: need the last N+1 items
			// Use takeRight to get the last items
			const limitedStream = Stream.takeRight(filteredStream, limit + 1);

			return Effect.gen(function* () {
				const chunk = yield* Stream.runCollect(limitedStream);
				const items = Chunk.toReadonlyArray(chunk) as ReadonlyArray<T>;

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
					} as CursorPageResult<T>;
				}

				// Validate cursor key exists on items
				const keyError = validateKeyExists(items, key);
				if (keyError !== null) {
					return yield* Effect.fail(keyError);
				}

				// Check if we have overflow (more items than limit)
				const hasOverflow = items.length > limit;
				const hasPreviousPage = hasOverflow;

				// hasNextPage = true when using "before" (items exist after this page)
				const hasNextPage = true;

				// Slice off the extra item if we have overflow
				// For backward, the extra item is at the beginning
				const pageItems = hasOverflow ? items.slice(1) : items;

				// Extract cursors from first and last items
				const startCursor = extractCursorValue(pageItems[0] as T, key);
				const endCursor = extractCursorValue(
					pageItems[pageItems.length - 1] as T,
					key,
				);

				return {
					items: pageItems,
					pageInfo: {
						startCursor,
						endCursor,
						hasNextPage,
						hasPreviousPage,
					},
				} as CursorPageResult<T>;
			});
		} else {
			// Forward pagination or first page: take first N+1 items
			const limitedStream = Stream.take(filteredStream, limit + 1);

			return Effect.gen(function* () {
				const chunk = yield* Stream.runCollect(limitedStream);
				const items = Chunk.toReadonlyArray(chunk) as ReadonlyArray<T>;

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
					} as CursorPageResult<T>;
				}

				// Validate cursor key exists on items
				const keyError = validateKeyExists(items, key);
				if (keyError !== null) {
					return yield* Effect.fail(keyError);
				}

				// Check if we have overflow (more items than limit)
				const hasOverflow = items.length > limit;
				const hasNextPage = hasOverflow;

				// hasPreviousPage = true when using "after" (items exist before this page)
				const hasPreviousPage = after !== undefined;

				// Slice off the extra item if we have overflow
				// For forward, the extra item is at the end
				const pageItems = hasOverflow ? items.slice(0, limit) : items;

				// Extract cursors from first and last items
				const startCursor = extractCursorValue(pageItems[0] as T, key);
				const endCursor = extractCursorValue(
					pageItems[pageItems.length - 1] as T,
					key,
				);

				return {
					items: pageItems,
					pageInfo: {
						startCursor,
						endCursor,
						hasNextPage,
						hasPreviousPage,
					},
				} as CursorPageResult<T>;
			});
		}
	};
