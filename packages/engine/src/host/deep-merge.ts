/**
 * Pure overlay merge used to collapse ordered document-graph fragments into one
 * effective document. Later fragments win.
 *
 * Merge rules (deterministic, no delete/tombstone semantics):
 * - Two plain objects at the same key merge recursively.
 * - Arrays, scalars, and `null` replace the prior value wholesale.
 * - A plain object overwrites a scalar, and a scalar overwrites a plain object.
 *
 * Inputs are never mutated; new objects are returned.
 */

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge two plain objects, with `overlay` winning on conflicts. Neither input is
 * mutated.
 */
export function deepMerge(
	base: PlainObject,
	overlay: PlainObject,
): PlainObject {
	const result: PlainObject = { ...base };
	for (const key of Object.keys(overlay)) {
		const overlayValue = overlay[key];
		const baseValue = result[key];
		if (isPlainObject(baseValue) && isPlainObject(overlayValue)) {
			result[key] = deepMerge(baseValue, overlayValue);
		} else if (isPlainObject(overlayValue)) {
			// Clone so the result never shares structure with the input.
			result[key] = deepMerge({}, overlayValue);
		} else {
			result[key] = overlayValue;
		}
	}
	return result;
}

/**
 * Merge an ordered list of plain-object fragments. Earlier fragments are the
 * base; later fragments overlay them. An empty list yields an empty object; a
 * single fragment yields an equivalent (deeply copied) object.
 */
export function deepMergeAll(
	fragments: ReadonlyArray<PlainObject>,
): PlainObject {
	return fragments.reduce<PlainObject>(
		(acc, fragment) => deepMerge(acc, fragment),
		{},
	);
}
