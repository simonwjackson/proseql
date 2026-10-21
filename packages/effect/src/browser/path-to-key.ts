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
 * Normalizations applied:
 * - Backslashes converted to forward slashes
 * - Multiple consecutive slashes collapsed to single slash
 * - Leading `./` patterns stripped (including multiple: `./././`)
 * - Leading `/` stripped for absolute paths (including multiple: `///`)
 * - Trailing slashes removed
 * - Standalone `.` (current directory) becomes empty string
 * - Prefix prepended (default `proseql:`)
 *
 * Edge cases:
 * - Empty string `""` → `proseql:`
 * - Single dot `.` → `proseql:`
 * - Only slashes `///` → `proseql:`
 * - Parent refs preserved: `../data` → `proseql:../data`
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
 * pathToKey('/absolute/path.yaml')
 * // => 'proseql:absolute/path.yaml'
 */
export function pathToKey(
	path: string,
	prefix: string = DEFAULT_STORAGE_KEY_PREFIX,
): string {
	// Normalize backslashes to forward slashes
	let normalized = path.replace(/\\/g, "/");

	// Collapse multiple consecutive slashes to single slash (e.g., 'a//b' -> 'a/b')
	normalized = normalized.replace(/\/+/g, "/");

	// Remove leading './' patterns repeatedly (handles './././data' -> 'data')
	// Also need to remove after leading slash normalization since we might have
	// patterns like './/./data' that become '././data' after slash collapse
	while (normalized.startsWith("./")) {
		normalized = normalized.slice(2);
	}

	// Strip leading '/' for absolute paths (handles '/', '/data', etc.)
	if (normalized.startsWith("/")) {
		normalized = normalized.slice(1);
	}

	// Handle case where we stripped './' and now have more './' (e.g., input was './/./data')
	while (normalized.startsWith("./")) {
		normalized = normalized.slice(2);
	}

	// Strip leading '/' again in case we had '././/data' -> '/data' after './' removal
	if (normalized.startsWith("/")) {
		normalized = normalized.slice(1);
	}

	// Remove trailing slashes (after collapse, at most one trailing slash remains)
	if (normalized.endsWith("/")) {
		normalized = normalized.slice(0, -1);
	}

	// Handle standalone dot (current directory reference) -> empty string
	if (normalized === ".") {
		normalized = "";
	}

	return prefix + normalized;
}
