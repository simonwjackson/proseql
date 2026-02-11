import type { FilterOperators } from "./types.js";
import { tokenize } from "../operations/query/search.js";

// ============================================================================
// Modular Operator Checking Functions
// ============================================================================

// Universal operators that work with all types
function checkUniversalOperator<T>(
	value: T,
	operator: "$eq" | "$ne" | "$in" | "$nin",
	operand: T | T[] | undefined,
	hasOperator: boolean,
): boolean | null {
	// If operator is not present in the object, return null
	if (!hasOperator) return null;

	switch (operator) {
		case "$eq":
			return value === operand;
		case "$ne":
			return value !== operand;
		case "$in":
			return Array.isArray(operand) && operand.includes(value);
		case "$nin":
			return Array.isArray(operand) && !operand.includes(value);
	}
}

// String-specific operators
function checkStringOperator(
	value: string | undefined,
	operator: "$startsWith" | "$endsWith" | "$contains",
	operand: string | undefined,
	hasOperator: boolean,
): boolean | null {
	if (!hasOperator) return null;
	if (operand === undefined) return false; // String operators require a value
	if (value === undefined) return false; // Can't perform string operations on undefined

	switch (operator) {
		case "$startsWith":
			return value.startsWith(operand);
		case "$endsWith":
			return value.endsWith(operand);
		case "$contains":
			return value.includes(operand);
	}
}

// Number-specific operators
function checkNumberOperator(
	value: number,
	operator: "$gt" | "$gte" | "$lt" | "$lte",
	operand: number | undefined,
	hasOperator: boolean,
): boolean | null {
	if (!hasOperator) return null;
	if (operand === undefined) return false; // Number operators require a value

	switch (operator) {
		case "$gt":
			return value > operand;
		case "$gte":
			return value >= operand;
		case "$lt":
			return value < operand;
		case "$lte":
			return value <= operand;
	}
}

// Array-specific operators
function checkArrayOperator<T>(
	value: T[],
	operator: "$contains" | "$all" | "$size",
	operand: T | T[] | number | undefined,
	hasOperator: boolean,
): boolean | null {
	if (!hasOperator) return null;
	if (operand === undefined) return false; // Array operators require a value

	switch (operator) {
		case "$contains":
			// Check if array contains the single value
			return value.includes(operand as T);
		case "$all":
			// Check if array contains all values
			if (!Array.isArray(operand)) return false;
			return (operand as T[]).every((item) => value.includes(item));
		case "$size":
			// Check array length
			return value.length === operand;
	}
}

// Type guard to check if a value is a filter operator object
export function isFilterOperatorObject<T>(
	filter: T | FilterOperators<T>,
): filter is FilterOperators<T> {
	if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
		return false;
	}

	const operatorKeys = [
		"$eq",
		"$ne",
		"$in",
		"$nin",
		"$gt",
		"$gte",
		"$lt",
		"$lte",
		"$startsWith",
		"$endsWith",
		"$contains",
		"$all",
		"$size",
		"$search",
	];
	const filterKeys = Object.keys(filter);
	return (
		filterKeys.length > 0 &&
		filterKeys.some((key) => operatorKeys.includes(key))
	);
}

// Helper function to check if a value matches a filter operator
export function matchesFilter<T>(
	value: T,
	filter: T | FilterOperators<T>,
): boolean {
	// Check if filter is an object with operators
	if (isFilterOperatorObject(filter)) {
		// Type-safe operator access using type guards and explicit property checks
		const ops = filter as Record<string, unknown>;
		const results: boolean[] = [];

		// Check universal operators that exist on all FilterOperators variants
		if ("$eq" in ops) {
			const result = checkUniversalOperator(
				value,
				"$eq",
				ops.$eq as T | undefined,
				true,
			);
			if (result !== null) results.push(result);
		}

		if ("$ne" in ops) {
			const result = checkUniversalOperator(
				value,
				"$ne",
				ops.$ne as T | undefined,
				true,
			);
			if (result !== null) results.push(result);
		}

		if ("$in" in ops) {
			const result = checkUniversalOperator(
				value,
				"$in",
				ops.$in as T[] | undefined,
				true,
			);
			if (result !== null) results.push(result);
		}

		if ("$nin" in ops) {
			const result = checkUniversalOperator(
				value,
				"$nin",
				ops.$nin as T[] | undefined,
				true,
			);
			if (result !== null) results.push(result);
		}

		// Check string-specific operators only for string values
		if (typeof value === "string") {
			if ("$startsWith" in ops) {
				const result = checkStringOperator(
					value,
					"$startsWith",
					ops.$startsWith as string | undefined,
					true,
				);
				if (result !== null) results.push(result);
			}

			if ("$endsWith" in ops) {
				const result = checkStringOperator(
					value,
					"$endsWith",
					ops.$endsWith as string | undefined,
					true,
				);
				if (result !== null) results.push(result);
			}

			if ("$contains" in ops) {
				const result = checkStringOperator(
					value,
					"$contains",
					ops.$contains as string | undefined,
					true,
				);
				if (result !== null) results.push(result);
			}

			if ("$search" in ops) {
				const searchQuery = ops.$search as string | undefined;
				if (searchQuery !== undefined) {
					// Empty search string matches everything
					if (searchQuery === "") {
						results.push(true);
					} else {
						const queryTokens = tokenize(searchQuery);
						const fieldTokens = tokenize(value);

						// All query tokens must match at least one field token (exact or prefix)
						const allTokensMatch = queryTokens.every((queryToken) =>
							fieldTokens.some(
								(fieldToken) =>
									fieldToken === queryToken ||
									fieldToken.startsWith(queryToken),
							),
						);
						results.push(allTokensMatch);
					}
				}
			}
		} else if (value === undefined || value === null || value === "") {
			// For non-string values (undefined, null, empty), string operators should fail
			if ("$startsWith" in ops || "$endsWith" in ops || "$contains" in ops) {
				return false;
			}
		}

		// Check number-specific operators only for number values
		if (typeof value === "number") {
			if ("$gt" in ops) {
				const result = checkNumberOperator(
					value,
					"$gt",
					ops.$gt as number | undefined,
					true,
				);
				if (result !== null) results.push(result);
			}

			if ("$gte" in ops) {
				const result = checkNumberOperator(
					value,
					"$gte",
					ops.$gte as number | undefined,
					true,
				);
				if (result !== null) results.push(result);
			}

			if ("$lt" in ops) {
				const result = checkNumberOperator(
					value,
					"$lt",
					ops.$lt as number | undefined,
					true,
				);
				if (result !== null) results.push(result);
			}

			if ("$lte" in ops) {
				const result = checkNumberOperator(
					value,
					"$lte",
					ops.$lte as number | undefined,
					true,
				);
				if (result !== null) results.push(result);
			}
		}

		// Also allow comparison operators on strings (for ISO date strings, etc.)
		if (typeof value === "string") {
			if ("$gt" in ops) {
				const operand = ops.$gt;
				if (typeof operand === "string") {
					results.push(value > operand);
				}
			}

			if ("$gte" in ops) {
				const operand = ops.$gte;
				if (typeof operand === "string") {
					results.push(value >= operand);
				}
			}

			if ("$lt" in ops) {
				const operand = ops.$lt;
				if (typeof operand === "string") {
					results.push(value < operand);
				}
			}

			if ("$lte" in ops) {
				const operand = ops.$lte;
				if (typeof operand === "string") {
					results.push(value <= operand);
				}
			}
		}

		// Check array-specific operators only for array values
		if (Array.isArray(value)) {
			// Note: For arrays, $contains checks if the array contains a value
			if ("$contains" in ops) {
				const result = checkArrayOperator(
					value,
					"$contains",
					ops.$contains,
					true,
				);
				if (result !== null) results.push(result);
			}

			if ("$all" in ops) {
				const result = checkArrayOperator(value, "$all", ops.$all, true);
				if (result !== null) results.push(result);
			}

			if ("$size" in ops) {
				const result = checkArrayOperator(
					value,
					"$size",
					ops.$size as number | undefined,
					true,
				);
				if (result !== null) results.push(result);
			}
		} else if (value === undefined || value === null) {
			// For undefined/null values, array operators should fail
			if ("$contains" in ops || "$all" in ops || "$size" in ops) {
				return false;
			}
		}

		// Check if comparison operators are being used on incompatible types
		if (typeof value !== "number" && typeof value !== "string") {
			if ("$gt" in ops || "$gte" in ops || "$lt" in ops || "$lte" in ops) {
				return false;
			}
		}

		// If no operators were specified, this shouldn't happen due to isFilterOperatorObject check
		if (results.length === 0) return true;

		// All specified operators must match (AND logic)
		return results.every((result) => result === true);
	}

	// Direct equality check
	return value === filter;
}
