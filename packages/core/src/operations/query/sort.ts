import type { SortOrder } from "../../types/types";
import { getNestedValue } from "../../utils/nested-path";

/**
 * Sort an array of data based on sort configuration
 * @param data The data to sort
 * @param sortConfig The sort configuration (field -> order mapping)
 * @returns The sorted data
 */
export function sortData<T extends Record<string, unknown>>(
	data: T[],
	sortConfig?: Partial<Record<string, SortOrder>>,
): T[] {
	if (!sortConfig || Object.keys(sortConfig).length === 0) {
		return data;
	}

	// Create a copy to avoid mutating the original array
	const sorted = [...data];

	// Get sort fields in order
	const sortFields = Object.entries(sortConfig);

	sorted.sort((a, b) => {
		for (const [field, order] of sortFields) {
			const aValue = getNestedValue(a, field);
			const bValue = getNestedValue(b, field);

			// Handle undefined/null values - they always sort to the end
			if (aValue === undefined || aValue === null) {
				if (bValue === undefined || bValue === null) {
					continue; // Both undefined/null, check next field
				}
				return 1; // a is undefined/null, b is not - a goes after b
			}
			if (bValue === undefined || bValue === null) {
				return -1; // b is undefined/null, a is not - a goes before b
			}

			// Compare values
			let comparison = 0;

			if (typeof aValue === "string" && typeof bValue === "string") {
				comparison = aValue.localeCompare(bValue);
			} else if (typeof aValue === "number" && typeof bValue === "number") {
				comparison = aValue - bValue;
			} else if (typeof aValue === "boolean" && typeof bValue === "boolean") {
				// false < true in ascending order
				comparison = (aValue ? 1 : 0) - (bValue ? 1 : 0);
			} else if (aValue instanceof Date && bValue instanceof Date) {
				comparison = aValue.getTime() - bValue.getTime();
			} else {
				// For other types, convert to string for comparison
				comparison = String(aValue).localeCompare(String(bValue));
			}

			// Apply sort order
			if (comparison !== 0) {
				return order === "desc" ? -comparison : comparison;
			}
		}

		return 0; // All fields are equal
	});

	return sorted;
}
