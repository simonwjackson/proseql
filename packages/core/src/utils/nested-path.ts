/**
 * Utilities for resolving and mutating nested object paths using dot notation.
 */

/**
 * Check if a string is a dot-notation path (contains at least one ".").
 *
 * @param key - The string to check
 * @returns true if the key contains a dot
 */
export function isDotPath(key: string): boolean {
	return key.includes(".");
}

/**
 * Get a nested value from an object using dot notation.
 * Handles single-segment paths (no ".") as direct property access with no overhead.
 *
 * @param obj - The object to get the value from
 * @param path - The dot-separated path to the value (e.g., "metadata.views")
 * @returns The value at the path, or undefined if not found
 *
 * @example
 * getNestedValue({ a: { b: 1 } }, "a.b") // returns 1
 * getNestedValue({ a: { b: 1 } }, "a") // returns { b: 1 }
 * getNestedValue({ a: { b: 1 } }, "a.c") // returns undefined
 * getNestedValue({ name: "foo" }, "name") // returns "foo" (single-segment, direct access)
 */
export function getNestedValue(
	obj: Record<string, unknown>,
	path: string,
): unknown {
	// Fast path: single-segment path (no dot) - direct property access
	if (!isDotPath(path)) {
		return obj[path];
	}

	// Multi-segment path: traverse the object
	const parts = path.split(".");
	let current: unknown = obj;

	for (const part of parts) {
		if (current === null || current === undefined) {
			return undefined;
		}

		if (typeof current === "object") {
			current = (current as Record<string, unknown>)[part];
		} else {
			return undefined;
		}
	}

	return current;
}

/**
 * Recursively collect all paths in an object that have string values.
 * Used for auto-discovering searchable fields when no explicit fields are specified.
 *
 * @param obj - The object to traverse
 * @param prefix - The current path prefix (used during recursion)
 * @returns An array of dot-notation paths pointing to string values
 *
 * @example
 * collectStringPaths({ name: "foo", metadata: { description: "bar", count: 5 } })
 * // returns ["name", "metadata.description"]
 */
export function collectStringPaths(
	obj: Record<string, unknown>,
	prefix = "",
): ReadonlyArray<string> {
	const paths: string[] = [];

	for (const [key, value] of Object.entries(obj)) {
		const path = prefix ? `${prefix}.${key}` : key;

		if (typeof value === "string") {
			paths.push(path);
		} else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			// Recurse into nested objects (but not arrays)
			paths.push(...collectStringPaths(value as Record<string, unknown>, path));
		}
	}

	return paths;
}

/**
 * Set a nested value on an object using dot notation, returning a new object (immutable).
 * Creates intermediate objects along the path if they don't exist.
 * Handles single-segment paths (no ".") as direct property set with no overhead.
 *
 * @param obj - The source object
 * @param path - The dot-separated path where to set the value (e.g., "metadata.views")
 * @param value - The value to set
 * @returns A new object with the value set at the path
 *
 * @example
 * setNestedValue({ a: { b: 1 } }, "a.b", 2) // returns { a: { b: 2 } }
 * setNestedValue({ a: { b: 1 } }, "a.c", 3) // returns { a: { b: 1, c: 3 } }
 * setNestedValue({}, "a.b.c", 1) // returns { a: { b: { c: 1 } } }
 * setNestedValue({ name: "foo" }, "name", "bar") // returns { name: "bar" } (single-segment)
 */
export function setNestedValue(
	obj: Record<string, unknown>,
	path: string,
	value: unknown,
): Record<string, unknown> {
	// Fast path: single-segment path (no dot) - direct property set
	if (!isDotPath(path)) {
		return { ...obj, [path]: value };
	}

	// Multi-segment path: build the nested structure
	const parts = path.split(".");
	const result = { ...obj };
	let current: Record<string, unknown> = result;

	// Navigate/create to the parent of the leaf
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		const existing = current[part];

		// Copy or create the intermediate object
		if (existing !== null && typeof existing === "object") {
			current[part] = { ...(existing as Record<string, unknown>) };
		} else {
			current[part] = {};
		}

		current = current[part] as Record<string, unknown>;
	}

	// Set the leaf value
	const leafKey = parts[parts.length - 1];
	current[leafKey] = value;

	return result;
}
