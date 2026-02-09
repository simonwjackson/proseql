import type { UnknownRecord } from "../../types/types";

// Type guard for checking if value is a record
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Type guard for checking if value is a UnknownRecord
function isUnknownRecord(value: unknown): value is UnknownRecord {
	return isRecord(value);
}

// Type guard for checking if value is a selection config
function isSelectionConfig(value: unknown): value is Record<string, unknown> {
	return isRecord(value);
}

/**
 * Type helper to handle object-based field selections with nested support
 */
type SelectedTypeFromObject<T, Selection extends Record<string, unknown>> = {
	[K in keyof Selection & keyof T]: Selection[K] extends true
		? T[K]
		: Selection[K] extends Record<string, unknown>
			? T[K] extends Record<string, unknown>
				? SelectedTypeFromObject<T[K], Selection[K]>
				: never
			: never;
};

/**
 * Apply object-based field selection to a single object
 * @param data - The object to select fields from
 * @param selection - Object with true values for fields to select
 * @returns Object with only the selected fields
 */
export function applyObjectSelection<
	T extends UnknownRecord,
	const Selection extends Record<string, unknown>,
>(data: T, selection: Selection): SelectedTypeFromObject<T, Selection> {
	// Handle edge cases
	if (!isUnknownRecord(data)) {
		// Return empty object for invalid data
		return {} as SelectedTypeFromObject<T, Selection>;
	}

	// If no selection specified, return empty object
	if (!selection || Object.keys(selection).length === 0) {
		return {} as SelectedTypeFromObject<T, Selection>;
	}

	// Create new object with only selected fields
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(selection)) {
		if (value === true && key in data) {
			result[key] = data[key];
		} else if (isSelectionConfig(value) && key in data) {
			// Handle nested selection for populated fields
			const nestedData = data[key];
			if (Array.isArray(nestedData)) {
				result[key] = nestedData
					.filter(isUnknownRecord)
					.map((item) => applyObjectSelection(item, value));
			} else if (isUnknownRecord(nestedData)) {
				result[key] = applyObjectSelection(nestedData, value);
			}
		}
	}

	return result as SelectedTypeFromObject<T, Selection>;
}

/**
 * Apply field selection to an array of objects
 * @param data - Array of objects to select fields from
 * @param selection - Object with true values for fields to select
 * @returns Array of objects with only the selected fields
 */
export function applySelectionToArray<
	T extends UnknownRecord,
	const Selection extends Record<string, unknown>,
>(
	data: T[],
	selection: Selection,
): Array<SelectedTypeFromObject<T, Selection>> {
	if (!Array.isArray(data)) {
		return [];
	}

	return data.map((item) => applyObjectSelection(item, selection));
}

/**
 * Apply field selection with null/undefined handling
 * @param data - The object to select fields from (can be null/undefined)
 * @param selection - Object with true values for fields to select
 * @returns Object with selected fields or null/undefined
 */
export function applySelectionSafe<
	T extends UnknownRecord,
	const Selection extends Record<string, unknown>,
>(
	data: T | null | undefined,
	selection: Selection,
): SelectedTypeFromObject<T, Selection> | null | undefined {
	if (data === null) return null;
	if (data === undefined) return undefined;

	return applyObjectSelection(data, selection);
}

/**
 * Check if a field should be selected based on selection criteria
 * @param field - The field name to check
 * @param selection - Object with true values or undefined for all fields
 * @returns Whether the field should be included
 */
export function shouldSelectField<T extends UnknownRecord>(
	field: keyof T,
	selection: Record<string, unknown> | undefined,
): boolean {
	// If no selection specified, include all fields
	if (!selection) {
		return true;
	}

	// Handle object-based selection
	const fieldStr = String(field);
	return fieldStr in selection && selection[fieldStr] === true;
}

/**
 * Type guard to check if a value has selected fields
 */
export function hasSelectedFields<
	T extends UnknownRecord,
	const Selection extends Record<string, unknown>,
>(
	value: unknown,
	selection: Selection,
): value is SelectedTypeFromObject<T, Selection> {
	if (!value || typeof value !== "object") {
		return false;
	}

	if (!isUnknownRecord(value)) {
		return false;
	}
	const obj = value;

	// Handle object-based selection
	return Object.entries(selection).every(([key, val]) => {
		if (val === true) {
			return key in obj;
		}
		return true; // Skip non-true values
	});
}

/**
 * Merge object-based field selections from multiple sources
 * Useful for combining field selections from different query parts
 */
export function mergeObjectFieldSelections<T extends UnknownRecord>(
	...selections: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
	// Filter out undefined selections
	const validSelections = selections.filter(
		(sel): sel is Record<string, unknown> => sel !== undefined,
	);

	// If no valid selections, return undefined (select all)
	if (validSelections.length === 0) {
		return undefined;
	}

	// Merge all selections with deep merge for nested objects
	const merged: Record<string, unknown> = {};
	for (const selection of validSelections) {
		for (const [key, value] of Object.entries(selection)) {
			if (value === true) {
				merged[key] = true;
			} else if (typeof value === "object" && value !== null) {
				// Deep merge nested selections
				const existing = merged[key];
				if (
					typeof existing === "object" &&
					existing !== null &&
					!Array.isArray(existing)
				) {
					merged[key] = { ...existing, ...value };
				} else {
					merged[key] = { ...value };
				}
			}
		}
	}

	return merged;
}

/**
 * Create a field selector function for use in pipelines
 */
export function createFieldSelector<
	T extends UnknownRecord,
	const Selection extends Record<string, unknown>,
>(selection: Selection) {
	return (data: T): SelectedTypeFromObject<T, Selection> => {
		return applyObjectSelection(data, selection);
	};
}

/**
 * Create a field selector for arrays
 */
export function createArrayFieldSelector<
	T extends UnknownRecord,
	const Selection extends Record<string, unknown>,
>(selection: Selection) {
	return (data: T[]): Array<SelectedTypeFromObject<T, Selection>> => {
		return applySelectionToArray(data, selection);
	};
}
