/**
 * Path-to-key mapping utilities for browser storage adapters.
 *
 * Browser storage APIs (localStorage, sessionStorage, IndexedDB) use flat string keys,
 * not hierarchical file paths. These utilities convert file paths into storage keys.
 */

/**
 * Default prefix for browser storage keys.
 * Used to namespace proseql data and avoid collisions with other applications.
 */
export const DEFAULT_STORAGE_KEY_PREFIX = "proseql:";

/**
 * Convert a file path to a flat browser storage key.
 *
 * - Strips leading `./` or `.\\`
 * - Normalizes backslashes to forward slashes
 * - Removes multiple leading `./` patterns
 * - Strips leading `/` for absolute paths
 * - Removes trailing slashes
 * - Prepends the configurable prefix (default `proseql:`)
 *
 * @param path - The file path to convert (e.g., `./data/books.yaml`)
 * @param prefix - Optional prefix to prepend (default `proseql:`)
 * @returns The storage key (e.g., `proseql:data/books.yaml`)
 *
 * @example
 * pathToKey('./data/books.yaml')
 * // => 'proseql:data/books.yaml'
 *
 * @example
 * pathToKey('./data/books.yaml', 'myapp:')
 * // => 'myapp:data/books.yaml'
 *
 * @example
 * pathToKey('.\\data\\books.yaml')
 * // => 'proseql:data/books.yaml'
 *
 * @example
 * pathToKey('data/books.yaml')
 * // => 'proseql:data/books.yaml'
 */
export function pathToKey(
	path: string,
	prefix: string = DEFAULT_STORAGE_KEY_PREFIX,
): string {
	// Normalize backslashes to forward slashes
	let normalized = path.replace(/\\/g, "/");

	// Remove multiple leading './' patterns (e.g., './././data' -> 'data')
	while (normalized.startsWith("./")) {
		normalized = normalized.slice(2);
	}

	// Strip leading '/' for absolute paths
	while (normalized.startsWith("/")) {
		normalized = normalized.slice(1);
	}

	// Remove trailing slashes
	while (normalized.endsWith("/") && normalized.length > 0) {
		normalized = normalized.slice(0, -1);
	}

	return prefix + normalized;
}
