/**
 * Utility functions for working with AsyncIterable types
 * These functions preserve type safety when collecting and processing async iterables
 */

/**
 * Collects all items from an AsyncIterable into a typed array
 * @param iterable The async iterable to collect from
 * @returns Promise of array containing all items with proper types
 */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const results: T[] = [];
	for await (const item of iterable) {
		results.push(item);
	}
	return results;
}

/**
 * Collects items from an AsyncIterable with a limit
 * @param iterable The async iterable to collect from
 * @param limit Maximum number of items to collect
 * @returns Promise of array containing collected items
 */
export async function collectLimit<T>(
	iterable: AsyncIterable<T>,
	limit: number,
): Promise<T[]> {
	const results: T[] = [];
	let count = 0;
	for await (const item of iterable) {
		results.push(item);
		count++;
		if (count >= limit) break;
	}
	return results;
}

/**
 * Counts the number of items in an AsyncIterable
 * @param iterable The async iterable to count
 * @returns Promise of the count
 */
export async function count<T>(iterable: AsyncIterable<T>): Promise<number> {
	let count = 0;
	for await (const _item of iterable) {
		count++;
	}
	return count;
}

/**
 * Gets the first item from an AsyncIterable
 * @param iterable The async iterable
 * @returns Promise of the first item or undefined
 */
export async function first<T>(
	iterable: AsyncIterable<T>,
): Promise<T | undefined> {
	for await (const item of iterable) {
		return item;
	}
	return undefined;
}

/**
 * Maps an AsyncIterable to extract specific fields
 * @param iterable The async iterable
 * @param selector Function to select fields from each item
 * @returns Promise of array with selected fields
 */
export async function map<T, U>(
	iterable: AsyncIterable<T>,
	selector: (item: T) => U,
): Promise<U[]> {
	const results: U[] = [];
	for await (const item of iterable) {
		results.push(selector(item));
	}
	return results;
}
