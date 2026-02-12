/**
 * REST Query Parameter Parsing for proseql databases.
 *
 * Converts URL query parameters into proseql-compatible query configurations.
 * Supports simple equality, operator syntax, sorting, pagination, and field selection.
 *
 * @module
 */

import type { AggregateConfig } from "@proseql/core";

// ============================================================================
// Types
// ============================================================================

/**
 * Parsed query configuration compatible with proseql's query method.
 * Contains where clauses, sort configuration, pagination, and field selection.
 */
export interface ParsedQueryConfig {
	/** Where clause with field filters */
	readonly where: Record<string, unknown>;

	/** Sort configuration (field -> "asc" | "desc") */
	readonly sort?: Record<string, "asc" | "desc">;

	/** Maximum number of results to return */
	readonly limit?: number;

	/** Number of results to skip */
	readonly offset?: number;

	/** Fields to include in results */
	readonly select?: ReadonlyArray<string>;
}

/**
 * Input query parameters from URL.
 * Values can be strings or arrays of strings for repeated parameters.
 */
export type QueryParams = Record<string, string | ReadonlyArray<string>>;

// ============================================================================
// Constants
// ============================================================================

/**
 * Reserved parameter names that are not field filters.
 */
const RESERVED_PARAMS = new Set(["sort", "limit", "offset", "select"]);

/**
 * Valid comparison operators for filter syntax.
 */
const VALID_OPERATORS = new Set([
	"$eq",
	"$ne",
	"$gt",
	"$gte",
	"$lt",
	"$lte",
	"$in",
	"$nin",
	"$startsWith",
	"$endsWith",
	"$contains",
	"$search",
	"$all",
	"$size",
]);

// ============================================================================
// Main Parser
// ============================================================================

/**
 * Parse URL query parameters into a proseql-compatible query configuration.
 *
 * Supports the following syntax:
 *
 * - Simple equality: `?genre=sci-fi` becomes `where: { genre: "sci-fi" }`
 * - Operator syntax: `?year[$gte]=1970&year[$lt]=2000` becomes `where: { year: { $gte: 1970, $lt: 2000 } }`
 * - Sorting: `?sort=year:desc` or `?sort=year:desc,title:asc` becomes `sort: { year: "desc", title: "asc" }`
 * - Pagination: `?limit=10&offset=20` becomes `limit: 10, offset: 20`
 * - Field selection: `?select=title,year` becomes `select: ["title", "year"]`
 *
 * Type coercion is applied:
 * - Numeric strings become numbers when used with numeric operators ($gt, $gte, $lt, $lte, $size)
 * - "true" and "false" become booleans
 * - Comma-separated values in $in/$nin become arrays
 *
 * @param query - URL query parameters as key-value pairs
 * @returns Parsed query configuration for proseql's query method
 *
 * @example
 * ```typescript
 * // Simple equality
 * parseQueryParams({ genre: "sci-fi" })
 * // → { where: { genre: "sci-fi" } }
 *
 * // Operator syntax
 * parseQueryParams({ "year[$gte]": "1970", "year[$lt]": "2000" })
 * // → { where: { year: { $gte: 1970, $lt: 2000 } } }
 *
 * // Combined
 * parseQueryParams({
 *   genre: "sci-fi",
 *   "year[$gte]": "1970",
 *   sort: "year:desc",
 *   limit: "10",
 *   select: "title,year"
 * })
 * // → {
 * //     where: { genre: "sci-fi", year: { $gte: 1970 } },
 * //     sort: { year: "desc" },
 * //     limit: 10,
 * //     select: ["title", "year"]
 * //   }
 * ```
 */
export const parseQueryParams = (query: QueryParams): ParsedQueryConfig => {
	const where: Record<string, unknown> = {};
	let sort: Record<string, "asc" | "desc"> | undefined;
	let limit: number | undefined;
	let offset: number | undefined;
	let select: ReadonlyArray<string> | undefined;

	for (const [key, value] of Object.entries(query)) {
		const strValue = normalizeValue(value);

		// Handle reserved parameters
		if (key === "sort" && strValue) {
			sort = parseSortParam(strValue);
			continue;
		}

		if (key === "limit" && strValue) {
			const parsed = Number.parseInt(strValue, 10);
			if (!Number.isNaN(parsed) && parsed >= 0) {
				limit = parsed;
			}
			continue;
		}

		if (key === "offset" && strValue) {
			const parsed = Number.parseInt(strValue, 10);
			if (!Number.isNaN(parsed) && parsed >= 0) {
				offset = parsed;
			}
			continue;
		}

		if (key === "select" && strValue) {
			select = parseSelectParam(strValue);
			continue;
		}

		// Skip reserved params that were handled above
		if (RESERVED_PARAMS.has(key)) {
			continue;
		}

		// Check for operator syntax: field[$op]=value
		const operatorMatch = key.match(/^(.+)\[(\$[a-zA-Z]+)\]$/);
		if (operatorMatch) {
			const [, field, operator] = operatorMatch;
			if (field && operator && VALID_OPERATORS.has(operator)) {
				parseOperatorFilter(where, field, operator, strValue);
				continue;
			}
		}

		// Simple equality filter
		if (strValue !== undefined) {
			where[key] = coerceValue(strValue);
		}
	}

	const result: ParsedQueryConfig = { where };

	if (sort !== undefined) {
		result.sort = sort;
	}

	if (limit !== undefined) {
		result.limit = limit;
	}

	if (offset !== undefined) {
		result.offset = offset;
	}

	if (select !== undefined) {
		result.select = select;
	}

	return result;
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalize a query parameter value to a string or undefined.
 * Arrays are joined with commas (for $in syntax or multi-value params).
 */
const normalizeValue = (
	value: string | ReadonlyArray<string>,
): string | undefined => {
	if (Array.isArray(value)) {
		return value.length > 0 ? value.join(",") : undefined;
	}
	return value || undefined;
};

/**
 * Parse the sort parameter into a sort configuration.
 *
 * Supports single field (`year:desc`) or multiple fields (`year:desc,title:asc`).
 * Defaults to ascending if direction is not specified.
 */
const parseSortParam = (value: string): Record<string, "asc" | "desc"> => {
	const sort: Record<string, "asc" | "desc"> = {};
	const parts = value.split(",");

	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed) continue;

		const colonIndex = trimmed.lastIndexOf(":");
		if (colonIndex === -1) {
			// No direction specified, default to asc
			sort[trimmed] = "asc";
		} else {
			const field = trimmed.slice(0, colonIndex);
			const direction = trimmed.slice(colonIndex + 1).toLowerCase();

			if (field && (direction === "asc" || direction === "desc")) {
				sort[field] = direction;
			} else if (field) {
				// Invalid direction, default to asc
				sort[field] = "asc";
			}
		}
	}

	return sort;
};

/**
 * Parse the select parameter into an array of field names.
 */
const parseSelectParam = (value: string): ReadonlyArray<string> => {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
};

/**
 * Parse an operator filter and add it to the where clause.
 *
 * Handles type coercion based on the operator:
 * - $gt, $gte, $lt, $lte, $size: numeric coercion
 * - $in, $nin: array coercion (comma-separated values)
 * - $all: array coercion
 */
const parseOperatorFilter = (
	where: Record<string, unknown>,
	field: string,
	operator: string,
	value: string | undefined,
): void => {
	if (value === undefined) return;

	// Get or create the operator object for this field
	const existing = where[field];
	const operatorObj: Record<string, unknown> =
		typeof existing === "object" && existing !== null
			? (existing as Record<string, unknown>)
			: {};

	// Coerce value based on operator
	let coercedValue: unknown;

	switch (operator) {
		case "$gt":
		case "$gte":
		case "$lt":
		case "$lte":
		case "$size":
			// Numeric operators - attempt numeric coercion
			coercedValue = coerceNumeric(value);
			break;

		case "$in":
		case "$nin":
		case "$all":
			// Array operators - split by comma and coerce each element
			coercedValue = value.split(",").map((v) => coerceValue(v.trim()));
			break;

		default:
			// String operators and others - coerce as regular value
			coercedValue = coerceValue(value);
	}

	operatorObj[operator] = coercedValue;
	where[field] = operatorObj;
};

/**
 * Coerce a string value to its appropriate type.
 *
 * - Numeric strings become numbers
 * - "true" and "false" become booleans
 * - Everything else remains a string
 */
const coerceValue = (value: string): string | number | boolean => {
	// Boolean coercion
	if (value === "true") return true;
	if (value === "false") return false;

	// Numeric coercion (only for values that look numeric)
	const numValue = coerceNumeric(value);
	if (typeof numValue === "number") return numValue;

	return value;
};

/**
 * Attempt to coerce a string to a number.
 * Returns the original string if it's not a valid number.
 */
const coerceNumeric = (value: string): number | string => {
	// Don't coerce empty strings or whitespace-only strings
	if (!value.trim()) return value;

	// Try integer first
	const intValue = Number.parseInt(value, 10);
	if (!Number.isNaN(intValue) && intValue.toString() === value) {
		return intValue;
	}

	// Try float
	const floatValue = Number.parseFloat(value);
	if (!Number.isNaN(floatValue) && floatValue.toString() === value) {
		return floatValue;
	}

	return value;
};

// ============================================================================
// Aggregate Parameter Parsing
// ============================================================================

/**
 * Parsed aggregate configuration compatible with proseql's aggregate method.
 * Contains aggregation options and optional where clause.
 */
export interface ParsedAggregateConfig {
	/** Count entities */
	readonly count?: true;

	/** Field(s) to sum */
	readonly sum?: string | ReadonlyArray<string>;

	/** Field(s) to average */
	readonly avg?: string | ReadonlyArray<string>;

	/** Field(s) to find minimum */
	readonly min?: string | ReadonlyArray<string>;

	/** Field(s) to find maximum */
	readonly max?: string | ReadonlyArray<string>;

	/** Field(s) to group by */
	readonly groupBy?: string | ReadonlyArray<string>;

	/** Where clause with field filters */
	readonly where?: Record<string, unknown>;
}

/**
 * Reserved parameter names for aggregate queries.
 */
const AGGREGATE_PARAMS = new Set([
	"count",
	"sum",
	"avg",
	"min",
	"max",
	"groupBy",
]);

/**
 * Parse URL query parameters into a proseql-compatible aggregate configuration.
 *
 * Supports the following syntax:
 *
 * - Count: `?count=true` becomes `{ count: true }`
 * - Sum: `?sum=pages` or `?sum=pages,price` becomes `{ sum: "pages" }` or `{ sum: ["pages", "price"] }`
 * - Avg: `?avg=rating` becomes `{ avg: "rating" }`
 * - Min/Max: `?min=year&max=year` becomes `{ min: "year", max: "year" }`
 * - GroupBy: `?groupBy=genre` or `?groupBy=genre,year` becomes `{ groupBy: "genre" }` or `{ groupBy: ["genre", "year"] }`
 * - Filters: Same as query params - `?genre=sci-fi` or `?year[$gte]=1970`
 *
 * @param query - URL query parameters as key-value pairs
 * @returns Parsed aggregate configuration for proseql's aggregate method
 *
 * @example
 * ```typescript
 * // Simple count
 * parseAggregateParams({ count: "true" })
 * // → { count: true }
 *
 * // Count with filter
 * parseAggregateParams({ count: "true", genre: "sci-fi" })
 * // → { count: true, where: { genre: "sci-fi" } }
 *
 * // Grouped aggregate
 * parseAggregateParams({ count: "true", groupBy: "genre" })
 * // → { count: true, groupBy: "genre" }
 *
 * // Multiple aggregations
 * parseAggregateParams({ count: "true", sum: "pages", avg: "rating", groupBy: "genre" })
 * // → { count: true, sum: "pages", avg: "rating", groupBy: "genre" }
 * ```
 */
export const parseAggregateParams = (query: QueryParams): AggregateConfig => {
	const result: Record<string, unknown> = {};
	const where: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(query)) {
		const strValue = normalizeValue(value);
		if (strValue === undefined) continue;

		// Handle aggregate-specific parameters
		if (key === "count" && strValue.toLowerCase() === "true") {
			result.count = true;
			continue;
		}

		if (key === "sum" || key === "avg" || key === "min" || key === "max") {
			const fields = parseFieldListParam(strValue);
			result[key] = fields.length === 1 ? fields[0] : fields;
			continue;
		}

		if (key === "groupBy") {
			const fields = parseFieldListParam(strValue);
			result.groupBy = fields.length === 1 ? fields[0] : fields;
			continue;
		}

		// Skip aggregate params that were handled above
		if (AGGREGATE_PARAMS.has(key)) {
			continue;
		}

		// Check for operator syntax: field[$op]=value
		const operatorMatch = key.match(/^(.+)\[(\$[a-zA-Z]+)\]$/);
		if (operatorMatch) {
			const [, field, operator] = operatorMatch;
			if (field && operator && VALID_OPERATORS.has(operator)) {
				parseOperatorFilter(where, field, operator, strValue);
				continue;
			}
		}

		// Simple equality filter
		where[key] = coerceValue(strValue);
	}

	// Add where clause if any filters were specified
	if (Object.keys(where).length > 0) {
		result.where = where;
	}

	// If no aggregations were specified, default to count
	if (
		result.count === undefined &&
		result.sum === undefined &&
		result.avg === undefined &&
		result.min === undefined &&
		result.max === undefined
	) {
		result.count = true;
	}

	return result as AggregateConfig;
};

/**
 * Parse a comma-separated field list parameter.
 */
const parseFieldListParam = (value: string): ReadonlyArray<string> => {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
};
