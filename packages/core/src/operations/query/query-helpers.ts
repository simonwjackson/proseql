/**
 * Helper functions for working with query results
 */

/**
 * Collect all results from an AsyncIterable into an array
 */
export async function toArray<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const results: T[] = [];
	for await (const item of iterable) {
		results.push(item);
	}
	return results;
}

/**
 * Add toArray method to an AsyncIterable
 */
export function withToArray<T>(
	iterable: AsyncIterable<T>,
): AsyncIterable<T> & { toArray: () => Promise<T[]> } {
	return Object.assign(iterable, {
		toArray: () => toArray(iterable),
	});
}
