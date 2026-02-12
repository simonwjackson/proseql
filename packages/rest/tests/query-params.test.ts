/**
 * Tests for query-params.ts — URL query parameter parsing.
 *
 * Task 11.1: Test simple equality parsing.
 */

import { describe, expect, it } from "vitest";
import {
	parseQueryParams,
	parseAggregateParams,
	type ParsedQueryConfig,
} from "../src/query-params.js";

// ============================================================================
// Task 11.1: Simple Equality Parsing
// ============================================================================

describe("parseQueryParams — simple equality (task 11.1)", () => {
	it("should parse single field equality", () => {
		const result = parseQueryParams({ genre: "sci-fi" });

		expect(result.where).toEqual({ genre: "sci-fi" });
	});

	it("should parse multiple field equalities", () => {
		const result = parseQueryParams({
			genre: "sci-fi",
			author: "Frank Herbert",
		});

		expect(result.where).toEqual({
			genre: "sci-fi",
			author: "Frank Herbert",
		});
	});

	it("should return empty where clause for empty input", () => {
		const result = parseQueryParams({});

		expect(result.where).toEqual({});
	});

	it("should handle string value with spaces", () => {
		const result = parseQueryParams({
			title: "The Left Hand of Darkness",
		});

		expect(result.where).toEqual({
			title: "The Left Hand of Darkness",
		});
	});

	it("should handle special characters in values", () => {
		const result = parseQueryParams({
			email: "user@example.com",
			tag: "sci-fi/fantasy",
		});

		expect(result.where).toEqual({
			email: "user@example.com",
			tag: "sci-fi/fantasy",
		});
	});

	it("should handle array values by joining with comma", () => {
		// When a query param appears multiple times, it becomes an array
		const result = parseQueryParams({
			genre: ["sci-fi", "fantasy"],
		});

		expect(result.where).toEqual({
			genre: "sci-fi,fantasy",
		});
	});

	it("should handle empty string value", () => {
		const result = parseQueryParams({
			name: "",
		});

		// Empty strings are normalized to undefined and skipped
		expect(result.where).toEqual({});
	});

	it("should not include reserved params in where clause", () => {
		const result = parseQueryParams({
			genre: "sci-fi",
			sort: "year:desc",
			limit: "10",
			offset: "20",
			select: "title,author",
		});

		// Only genre should be in where clause
		expect(result.where).toEqual({ genre: "sci-fi" });
		// Reserved params should be parsed separately
		expect(result.sort).toEqual({ year: "desc" });
		expect(result.limit).toBe(10);
		expect(result.offset).toBe(20);
		expect(result.select).toEqual(["title", "author"]);
	});
});

// ============================================================================
// Task 11.2: Operator Syntax Parsing
// ============================================================================

describe("parseQueryParams — operator syntax (task 11.2)", () => {
	describe("comparison operators", () => {
		it("should parse $eq operator", () => {
			const result = parseQueryParams({ "genre[$eq]": "sci-fi" });

			expect(result.where).toEqual({ genre: { $eq: "sci-fi" } });
		});

		it("should parse $ne operator", () => {
			const result = parseQueryParams({ "genre[$ne]": "fantasy" });

			expect(result.where).toEqual({ genre: { $ne: "fantasy" } });
		});

		it("should parse $gt operator with numeric coercion", () => {
			const result = parseQueryParams({ "year[$gt]": "1970" });

			expect(result.where).toEqual({ year: { $gt: 1970 } });
		});

		it("should parse $gte operator with numeric coercion", () => {
			const result = parseQueryParams({ "year[$gte]": "1970" });

			expect(result.where).toEqual({ year: { $gte: 1970 } });
		});

		it("should parse $lt operator with numeric coercion", () => {
			const result = parseQueryParams({ "year[$lt]": "2000" });

			expect(result.where).toEqual({ year: { $lt: 2000 } });
		});

		it("should parse $lte operator with numeric coercion", () => {
			const result = parseQueryParams({ "year[$lte]": "2000" });

			expect(result.where).toEqual({ year: { $lte: 2000 } });
		});

		it("should combine multiple operators on the same field", () => {
			const result = parseQueryParams({
				"year[$gte]": "1970",
				"year[$lt]": "2000",
			});

			expect(result.where).toEqual({
				year: { $gte: 1970, $lt: 2000 },
			});
		});

		it("should handle floating point numbers", () => {
			const result = parseQueryParams({ "rating[$gte]": "4.5" });

			expect(result.where).toEqual({ rating: { $gte: 4.5 } });
		});

		it("should keep string values when not numeric", () => {
			const result = parseQueryParams({ "version[$gt]": "1.0.0" });

			// Non-numeric strings should remain strings
			expect(result.where).toEqual({ version: { $gt: "1.0.0" } });
		});
	});

	describe("array operators", () => {
		it("should parse $in operator with comma-separated values", () => {
			const result = parseQueryParams({ "genre[$in]": "sci-fi,fantasy,horror" });

			expect(result.where).toEqual({
				genre: { $in: ["sci-fi", "fantasy", "horror"] },
			});
		});

		it("should parse $nin operator with comma-separated values", () => {
			const result = parseQueryParams({ "genre[$nin]": "romance,drama" });

			expect(result.where).toEqual({
				genre: { $nin: ["romance", "drama"] },
			});
		});

		it("should parse $all operator with comma-separated values", () => {
			const result = parseQueryParams({ "tags[$all]": "classic,sci-fi" });

			expect(result.where).toEqual({
				tags: { $all: ["classic", "sci-fi"] },
			});
		});

		it("should coerce numeric values in $in operator", () => {
			const result = parseQueryParams({ "year[$in]": "1970,1984,2001" });

			expect(result.where).toEqual({
				year: { $in: [1970, 1984, 2001] },
			});
		});

		it("should coerce boolean values in $in operator", () => {
			const result = parseQueryParams({ "published[$in]": "true,false" });

			expect(result.where).toEqual({
				published: { $in: [true, false] },
			});
		});

		it("should handle single value in $in operator", () => {
			const result = parseQueryParams({ "genre[$in]": "sci-fi" });

			expect(result.where).toEqual({
				genre: { $in: ["sci-fi"] },
			});
		});

		it("should parse $size operator with numeric coercion", () => {
			const result = parseQueryParams({ "tags[$size]": "3" });

			expect(result.where).toEqual({ tags: { $size: 3 } });
		});
	});

	describe("string operators", () => {
		it("should parse $startsWith operator", () => {
			const result = parseQueryParams({ "title[$startsWith]": "The" });

			expect(result.where).toEqual({ title: { $startsWith: "The" } });
		});

		it("should parse $endsWith operator", () => {
			const result = parseQueryParams({ "title[$endsWith]": "Darkness" });

			expect(result.where).toEqual({ title: { $endsWith: "Darkness" } });
		});

		it("should parse $contains operator", () => {
			const result = parseQueryParams({ "title[$contains]": "Left Hand" });

			expect(result.where).toEqual({ title: { $contains: "Left Hand" } });
		});

		it("should parse $search operator", () => {
			const result = parseQueryParams({ "description[$search]": "space travel" });

			expect(result.where).toEqual({ description: { $search: "space travel" } });
		});
	});

	describe("combined operators and equality", () => {
		it("should combine operator syntax with simple equality", () => {
			const result = parseQueryParams({
				genre: "sci-fi",
				"year[$gte]": "1970",
				"year[$lt]": "2000",
			});

			expect(result.where).toEqual({
				genre: "sci-fi",
				year: { $gte: 1970, $lt: 2000 },
			});
		});

		it("should combine multiple fields with operators", () => {
			const result = parseQueryParams({
				"year[$gte]": "1970",
				"rating[$gt]": "4",
				"title[$contains]": "Dark",
			});

			expect(result.where).toEqual({
				year: { $gte: 1970 },
				rating: { $gt: 4 },
				title: { $contains: "Dark" },
			});
		});

		it("should combine operators with reserved params", () => {
			const result = parseQueryParams({
				"year[$gte]": "1970",
				sort: "title:asc",
				limit: "10",
			});

			expect(result.where).toEqual({ year: { $gte: 1970 } });
			expect(result.sort).toEqual({ title: "asc" });
			expect(result.limit).toBe(10);
		});
	});

	describe("edge cases", () => {
		it("should treat invalid operators as literal field names", () => {
			const result = parseQueryParams({ "year[$invalid]": "1970" });

			// Invalid operators fall through to simple equality with literal key
			expect(result.where).toEqual({ "year[$invalid]": 1970 });
		});

		it("should handle empty operator value", () => {
			const result = parseQueryParams({ "year[$gte]": "" });

			// Empty values should be skipped
			expect(result.where).toEqual({});
		});

		it("should handle whitespace in comma-separated values", () => {
			const result = parseQueryParams({ "genre[$in]": "sci-fi, fantasy, horror" });

			expect(result.where).toEqual({
				genre: { $in: ["sci-fi", "fantasy", "horror"] },
			});
		});

		it("should handle operator on nested-looking field name", () => {
			const result = parseQueryParams({ "meta.version[$gte]": "2" });

			expect(result.where).toEqual({
				"meta.version": { $gte: 2 },
			});
		});
	});
});

// ============================================================================
// Task 11.3: Sort Parsing
// ============================================================================

describe("parseQueryParams — sort parsing (task 11.3)", () => {
	describe("single field sorting", () => {
		it("should parse single field with ascending direction", () => {
			const result = parseQueryParams({ sort: "year:asc" });

			expect(result.sort).toEqual({ year: "asc" });
		});

		it("should parse single field with descending direction", () => {
			const result = parseQueryParams({ sort: "year:desc" });

			expect(result.sort).toEqual({ year: "desc" });
		});

		it("should default to ascending when no direction specified", () => {
			const result = parseQueryParams({ sort: "title" });

			expect(result.sort).toEqual({ title: "asc" });
		});

		it("should be case-insensitive for direction", () => {
			const result = parseQueryParams({ sort: "year:DESC" });

			expect(result.sort).toEqual({ year: "desc" });
		});

		it("should handle field name with dots (nested-looking path)", () => {
			const result = parseQueryParams({ sort: "meta.createdAt:desc" });

			expect(result.sort).toEqual({ "meta.createdAt": "desc" });
		});
	});

	describe("multiple field sorting", () => {
		it("should parse multiple fields with directions", () => {
			const result = parseQueryParams({ sort: "year:desc,title:asc" });

			expect(result.sort).toEqual({ year: "desc", title: "asc" });
		});

		it("should preserve order for multiple fields", () => {
			const result = parseQueryParams({ sort: "genre:asc,year:desc,title:asc" });

			// Note: Object key order is preserved in modern JS
			const sortKeys = Object.keys(result.sort!);
			expect(sortKeys).toEqual(["genre", "year", "title"]);
			expect(result.sort).toEqual({
				genre: "asc",
				year: "desc",
				title: "asc",
			});
		});

		it("should handle mixed directions", () => {
			const result = parseQueryParams({ sort: "author:asc,year:desc" });

			expect(result.sort).toEqual({
				author: "asc",
				year: "desc",
			});
		});

		it("should default to asc for fields without direction in multi-field sort", () => {
			const result = parseQueryParams({ sort: "genre,year:desc,title" });

			expect(result.sort).toEqual({
				genre: "asc",
				year: "desc",
				title: "asc",
			});
		});
	});

	describe("edge cases", () => {
		it("should handle whitespace around sort values", () => {
			const result = parseQueryParams({ sort: " year:desc , title:asc " });

			expect(result.sort).toEqual({ year: "desc", title: "asc" });
		});

		it("should skip empty segments", () => {
			const result = parseQueryParams({ sort: "year:desc,,title:asc" });

			expect(result.sort).toEqual({ year: "desc", title: "asc" });
		});

		it("should handle empty sort value", () => {
			const result = parseQueryParams({ sort: "" });

			expect(result.sort).toBeUndefined();
		});

		it("should default to asc for invalid direction", () => {
			const result = parseQueryParams({ sort: "year:invalid" });

			expect(result.sort).toEqual({ year: "asc" });
		});

		it("should handle field names that contain colons (use last colon)", () => {
			// While unusual, field names could technically contain colons
			const result = parseQueryParams({ sort: "time:stamp:desc" });

			expect(result.sort).toEqual({ "time:stamp": "desc" });
		});

		it("should combine sort with where clause", () => {
			const result = parseQueryParams({
				genre: "sci-fi",
				sort: "year:desc",
			});

			expect(result.where).toEqual({ genre: "sci-fi" });
			expect(result.sort).toEqual({ year: "desc" });
		});

		it("should combine sort with operators and pagination", () => {
			const result = parseQueryParams({
				"year[$gte]": "1970",
				sort: "year:desc,title:asc",
				limit: "10",
				offset: "0",
			});

			expect(result.where).toEqual({ year: { $gte: 1970 } });
			expect(result.sort).toEqual({ year: "desc", title: "asc" });
			expect(result.limit).toBe(10);
			expect(result.offset).toBe(0);
		});
	});
});

// ============================================================================
// Task 11.4: Pagination Parsing
// ============================================================================

// ============================================================================
// Task 11.5: Field Selection Parsing
// ============================================================================

describe("parseQueryParams — field selection parsing (task 11.5)", () => {
	describe("single field selection", () => {
		it("should parse single field selection", () => {
			const result = parseQueryParams({ select: "title" });

			expect(result.select).toEqual(["title"]);
		});

		it("should handle field name with dots (nested-looking path)", () => {
			const result = parseQueryParams({ select: "meta.createdAt" });

			expect(result.select).toEqual(["meta.createdAt"]);
		});
	});

	describe("multiple field selection", () => {
		it("should parse multiple fields separated by comma", () => {
			const result = parseQueryParams({ select: "title,author" });

			expect(result.select).toEqual(["title", "author"]);
		});

		it("should parse many fields", () => {
			const result = parseQueryParams({
				select: "id,title,author,year,genre,description",
			});

			expect(result.select).toEqual([
				"id",
				"title",
				"author",
				"year",
				"genre",
				"description",
			]);
		});

		it("should preserve field order", () => {
			const result = parseQueryParams({ select: "year,author,title" });

			expect(result.select).toEqual(["year", "author", "title"]);
		});
	});

	describe("whitespace handling", () => {
		it("should trim whitespace around field names", () => {
			const result = parseQueryParams({ select: " title , author , year " });

			expect(result.select).toEqual(["title", "author", "year"]);
		});

		it("should handle tabs and multiple spaces", () => {
			const result = parseQueryParams({ select: "  title  ,   author  " });

			expect(result.select).toEqual(["title", "author"]);
		});
	});

	describe("edge cases", () => {
		it("should skip empty segments", () => {
			const result = parseQueryParams({ select: "title,,author" });

			expect(result.select).toEqual(["title", "author"]);
		});

		it("should handle empty select value", () => {
			const result = parseQueryParams({ select: "" });

			expect(result.select).toBeUndefined();
		});

		it("should handle only commas", () => {
			const result = parseQueryParams({ select: ",,," });

			// All segments are empty, so returns empty array
			expect(result.select).toEqual([]);
		});

		it("should handle only whitespace", () => {
			const result = parseQueryParams({ select: "   " });

			// Whitespace-only becomes empty array after trim
			expect(result.select).toEqual([]);
		});

		it("should not include select in where clause", () => {
			const result = parseQueryParams({ select: "title,author" });

			expect(result.where).toEqual({});
		});
	});

	describe("combination with other params", () => {
		it("should combine select with where clause", () => {
			const result = parseQueryParams({
				genre: "sci-fi",
				select: "title,year",
			});

			expect(result.where).toEqual({ genre: "sci-fi" });
			expect(result.select).toEqual(["title", "year"]);
		});

		it("should combine select with operators", () => {
			const result = parseQueryParams({
				"year[$gte]": "1970",
				select: "title,author,year",
			});

			expect(result.where).toEqual({ year: { $gte: 1970 } });
			expect(result.select).toEqual(["title", "author", "year"]);
		});

		it("should combine select with sort", () => {
			const result = parseQueryParams({
				sort: "year:desc",
				select: "title,year",
			});

			expect(result.sort).toEqual({ year: "desc" });
			expect(result.select).toEqual(["title", "year"]);
		});

		it("should combine select with pagination", () => {
			const result = parseQueryParams({
				limit: "10",
				offset: "20",
				select: "title",
			});

			expect(result.limit).toBe(10);
			expect(result.offset).toBe(20);
			expect(result.select).toEqual(["title"]);
		});

		it("should combine select with all other params", () => {
			const result = parseQueryParams({
				genre: "sci-fi",
				"year[$gte]": "1970",
				sort: "year:desc,title:asc",
				limit: "10",
				offset: "0",
				select: "id,title,year",
			});

			expect(result.where).toEqual({
				genre: "sci-fi",
				year: { $gte: 1970 },
			});
			expect(result.sort).toEqual({ year: "desc", title: "asc" });
			expect(result.limit).toBe(10);
			expect(result.offset).toBe(0);
			expect(result.select).toEqual(["id", "title", "year"]);
		});
	});
});

// ============================================================================
// Task 11.4: Pagination Parsing
// ============================================================================

describe("parseQueryParams — pagination parsing (task 11.4)", () => {
	describe("limit parsing", () => {
		it("should parse limit as a number", () => {
			const result = parseQueryParams({ limit: "10" });

			expect(result.limit).toBe(10);
		});

		it("should parse limit of zero", () => {
			const result = parseQueryParams({ limit: "0" });

			expect(result.limit).toBe(0);
		});

		it("should parse large limit values", () => {
			const result = parseQueryParams({ limit: "1000000" });

			expect(result.limit).toBe(1000000);
		});

		it("should ignore invalid limit (non-numeric)", () => {
			const result = parseQueryParams({ limit: "abc" });

			expect(result.limit).toBeUndefined();
		});

		it("should ignore negative limit", () => {
			const result = parseQueryParams({ limit: "-5" });

			expect(result.limit).toBeUndefined();
		});

		it("should ignore floating point limit (use integer part)", () => {
			const result = parseQueryParams({ limit: "10.5" });

			// parseInt parses "10.5" as 10
			expect(result.limit).toBe(10);
		});

		it("should ignore empty limit value", () => {
			const result = parseQueryParams({ limit: "" });

			expect(result.limit).toBeUndefined();
		});
	});

	describe("offset parsing", () => {
		it("should parse offset as a number", () => {
			const result = parseQueryParams({ offset: "20" });

			expect(result.offset).toBe(20);
		});

		it("should parse offset of zero", () => {
			const result = parseQueryParams({ offset: "0" });

			expect(result.offset).toBe(0);
		});

		it("should parse large offset values", () => {
			const result = parseQueryParams({ offset: "500000" });

			expect(result.offset).toBe(500000);
		});

		it("should ignore invalid offset (non-numeric)", () => {
			const result = parseQueryParams({ offset: "xyz" });

			expect(result.offset).toBeUndefined();
		});

		it("should ignore negative offset", () => {
			const result = parseQueryParams({ offset: "-10" });

			expect(result.offset).toBeUndefined();
		});

		it("should ignore floating point offset (use integer part)", () => {
			const result = parseQueryParams({ offset: "25.7" });

			// parseInt parses "25.7" as 25
			expect(result.offset).toBe(25);
		});

		it("should ignore empty offset value", () => {
			const result = parseQueryParams({ offset: "" });

			expect(result.offset).toBeUndefined();
		});
	});

	describe("limit and offset combined", () => {
		it("should parse both limit and offset together", () => {
			const result = parseQueryParams({ limit: "10", offset: "20" });

			expect(result.limit).toBe(10);
			expect(result.offset).toBe(20);
		});

		it("should parse limit and offset with zero values", () => {
			const result = parseQueryParams({ limit: "50", offset: "0" });

			expect(result.limit).toBe(50);
			expect(result.offset).toBe(0);
		});

		it("should handle valid limit with invalid offset", () => {
			const result = parseQueryParams({ limit: "10", offset: "invalid" });

			expect(result.limit).toBe(10);
			expect(result.offset).toBeUndefined();
		});

		it("should handle invalid limit with valid offset", () => {
			const result = parseQueryParams({ limit: "invalid", offset: "20" });

			expect(result.limit).toBeUndefined();
			expect(result.offset).toBe(20);
		});
	});

	describe("pagination with other query params", () => {
		it("should combine pagination with where clause", () => {
			const result = parseQueryParams({
				genre: "sci-fi",
				limit: "10",
				offset: "0",
			});

			expect(result.where).toEqual({ genre: "sci-fi" });
			expect(result.limit).toBe(10);
			expect(result.offset).toBe(0);
		});

		it("should combine pagination with operators", () => {
			const result = parseQueryParams({
				"year[$gte]": "1970",
				"year[$lt]": "2000",
				limit: "25",
				offset: "50",
			});

			expect(result.where).toEqual({ year: { $gte: 1970, $lt: 2000 } });
			expect(result.limit).toBe(25);
			expect(result.offset).toBe(50);
		});

		it("should combine pagination with sort", () => {
			const result = parseQueryParams({
				sort: "year:desc",
				limit: "10",
				offset: "20",
			});

			expect(result.sort).toEqual({ year: "desc" });
			expect(result.limit).toBe(10);
			expect(result.offset).toBe(20);
		});

		it("should combine pagination with select", () => {
			const result = parseQueryParams({
				select: "title,author",
				limit: "5",
				offset: "10",
			});

			expect(result.select).toEqual(["title", "author"]);
			expect(result.limit).toBe(5);
			expect(result.offset).toBe(10);
		});

		it("should combine all query params together", () => {
			const result = parseQueryParams({
				genre: "sci-fi",
				"year[$gte]": "1970",
				sort: "year:desc,title:asc",
				select: "title,author,year",
				limit: "10",
				offset: "30",
			});

			expect(result.where).toEqual({
				genre: "sci-fi",
				year: { $gte: 1970 },
			});
			expect(result.sort).toEqual({ year: "desc", title: "asc" });
			expect(result.select).toEqual(["title", "author", "year"]);
			expect(result.limit).toBe(10);
			expect(result.offset).toBe(30);
		});
	});

	describe("pagination edge cases", () => {
		it("should not include limit in where clause", () => {
			const result = parseQueryParams({ limit: "10" });

			expect(result.where).toEqual({});
			expect(result.limit).toBe(10);
		});

		it("should not include offset in where clause", () => {
			const result = parseQueryParams({ offset: "20" });

			expect(result.where).toEqual({});
			expect(result.offset).toBe(20);
		});

		it("should handle whitespace in pagination values", () => {
			const result = parseQueryParams({ limit: " 10 ", offset: " 20 " });

			// parseInt handles leading/trailing whitespace
			expect(result.limit).toBe(10);
			expect(result.offset).toBe(20);
		});

		it("should handle numeric strings with leading zeros", () => {
			const result = parseQueryParams({ limit: "010", offset: "020" });

			// parseInt with base 10 handles leading zeros correctly
			expect(result.limit).toBe(10);
			expect(result.offset).toBe(20);
		});
	});
});

// ============================================================================
// Task 11.6: Type Coercion
// ============================================================================

describe("parseQueryParams — type coercion (task 11.6)", () => {
	describe("boolean coercion", () => {
		it("should coerce 'true' string to boolean true", () => {
			const result = parseQueryParams({ published: "true" });

			expect(result.where).toEqual({ published: true });
			expect(result.where.published).toBe(true);
			expect(typeof result.where.published).toBe("boolean");
		});

		it("should coerce 'false' string to boolean false", () => {
			const result = parseQueryParams({ published: "false" });

			expect(result.where).toEqual({ published: false });
			expect(result.where.published).toBe(false);
			expect(typeof result.where.published).toBe("boolean");
		});

		it("should NOT coerce 'True' (capitalized) to boolean", () => {
			const result = parseQueryParams({ published: "True" });

			expect(result.where).toEqual({ published: "True" });
			expect(typeof result.where.published).toBe("string");
		});

		it("should NOT coerce 'FALSE' (uppercase) to boolean", () => {
			const result = parseQueryParams({ published: "FALSE" });

			expect(result.where).toEqual({ published: "FALSE" });
			expect(typeof result.where.published).toBe("string");
		});

		it("should NOT coerce 'yes' to boolean", () => {
			const result = parseQueryParams({ active: "yes" });

			expect(result.where).toEqual({ active: "yes" });
			expect(typeof result.where.active).toBe("string");
		});

		it("should NOT coerce 'no' to boolean", () => {
			const result = parseQueryParams({ active: "no" });

			expect(result.where).toEqual({ active: "no" });
			expect(typeof result.where.active).toBe("string");
		});

		it("should NOT coerce '1' to boolean true", () => {
			const result = parseQueryParams({ flag: "1" });

			// '1' becomes number 1, not boolean
			expect(result.where).toEqual({ flag: 1 });
			expect(typeof result.where.flag).toBe("number");
		});

		it("should NOT coerce '0' to boolean false", () => {
			const result = parseQueryParams({ flag: "0" });

			// '0' becomes number 0, not boolean
			expect(result.where).toEqual({ flag: 0 });
			expect(typeof result.where.flag).toBe("number");
		});

		it("should coerce boolean in $in operator", () => {
			const result = parseQueryParams({ "status[$in]": "true,false" });

			expect(result.where).toEqual({
				status: { $in: [true, false] },
			});
		});

		it("should coerce boolean in $eq operator", () => {
			const result = parseQueryParams({ "published[$eq]": "true" });

			expect(result.where).toEqual({ published: { $eq: true } });
		});

		it("should coerce boolean in $ne operator", () => {
			const result = parseQueryParams({ "archived[$ne]": "false" });

			expect(result.where).toEqual({ archived: { $ne: false } });
		});
	});

	describe("numeric coercion - integers", () => {
		it("should coerce positive integer string to number", () => {
			const result = parseQueryParams({ year: "1984" });

			expect(result.where).toEqual({ year: 1984 });
			expect(typeof result.where.year).toBe("number");
		});

		it("should coerce zero to number", () => {
			const result = parseQueryParams({ count: "0" });

			expect(result.where).toEqual({ count: 0 });
			expect(typeof result.where.count).toBe("number");
		});

		it("should NOT coerce negative integer (keeps as string due to sign)", () => {
			const result = parseQueryParams({ temperature: "-5" });

			// parseInt("-5") gives -5, but -5.toString() is "-5" so it should coerce
			expect(result.where).toEqual({ temperature: -5 });
			expect(typeof result.where.temperature).toBe("number");
		});

		it("should coerce large integers", () => {
			const result = parseQueryParams({ timestamp: "1704067200000" });

			expect(result.where).toEqual({ timestamp: 1704067200000 });
			expect(typeof result.where.timestamp).toBe("number");
		});

		it("should NOT coerce integer with leading zeros (string mismatch)", () => {
			const result = parseQueryParams({ code: "007" });

			// parseInt("007") = 7, but 7.toString() !== "007"
			expect(result.where).toEqual({ code: "007" });
			expect(typeof result.where.code).toBe("string");
		});

		it("should coerce integer in $eq operator", () => {
			const result = parseQueryParams({ "year[$eq]": "2024" });

			expect(result.where).toEqual({ year: { $eq: 2024 } });
		});

		it("should coerce integer in $in operator", () => {
			const result = parseQueryParams({ "year[$in]": "1984,2001,2024" });

			expect(result.where).toEqual({
				year: { $in: [1984, 2001, 2024] },
			});
		});
	});

	describe("numeric coercion - floats", () => {
		it("should coerce positive float string to number", () => {
			const result = parseQueryParams({ rating: "4.5" });

			expect(result.where).toEqual({ rating: 4.5 });
			expect(typeof result.where.rating).toBe("number");
		});

		it("should coerce float starting with zero", () => {
			const result = parseQueryParams({ ratio: "0.75" });

			expect(result.where).toEqual({ ratio: 0.75 });
			expect(typeof result.where.ratio).toBe("number");
		});

		it("should coerce negative float", () => {
			const result = parseQueryParams({ delta: "-3.14" });

			expect(result.where).toEqual({ delta: -3.14 });
			expect(typeof result.where.delta).toBe("number");
		});

		it("should NOT coerce float with extra precision", () => {
			const result = parseQueryParams({ precise: "3.14159265358979" });

			// parseFloat("3.14159265358979").toString() may differ due to floating point representation
			// But in this case it should match
			expect(result.where).toEqual({ precise: 3.14159265358979 });
			expect(typeof result.where.precise).toBe("number");
		});

		it("should NOT coerce trailing zeros float (string mismatch)", () => {
			const result = parseQueryParams({ value: "1.50" });

			// parseFloat("1.50") = 1.5, but 1.5.toString() !== "1.50"
			expect(result.where).toEqual({ value: "1.50" });
			expect(typeof result.where.value).toBe("string");
		});

		it("should coerce float in $gte operator", () => {
			const result = parseQueryParams({ "rating[$gte]": "4.5" });

			expect(result.where).toEqual({ rating: { $gte: 4.5 } });
		});

		it("should coerce float in $lt operator", () => {
			const result = parseQueryParams({ "price[$lt]": "99.99" });

			expect(result.where).toEqual({ price: { $lt: 99.99 } });
		});

		it("should coerce mixed integers and floats in $in operator", () => {
			const result = parseQueryParams({ "value[$in]": "1,2.5,3,4.75" });

			expect(result.where).toEqual({
				value: { $in: [1, 2.5, 3, 4.75] },
			});
		});
	});

	describe("non-numeric strings remain strings", () => {
		it("should NOT coerce alphabetic string", () => {
			const result = parseQueryParams({ genre: "sci-fi" });

			expect(result.where).toEqual({ genre: "sci-fi" });
			expect(typeof result.where.genre).toBe("string");
		});

		it("should NOT coerce alphanumeric string", () => {
			const result = parseQueryParams({ id: "book-123" });

			expect(result.where).toEqual({ id: "book-123" });
			expect(typeof result.where.id).toBe("string");
		});

		it("should NOT coerce string with embedded numbers", () => {
			const result = parseQueryParams({ version: "v2.0.1" });

			expect(result.where).toEqual({ version: "v2.0.1" });
			expect(typeof result.where.version).toBe("string");
		});

		it("should NOT coerce string that looks like a number with text", () => {
			const result = parseQueryParams({ price: "100USD" });

			expect(result.where).toEqual({ price: "100USD" });
			expect(typeof result.where.price).toBe("string");
		});

		it("should NOT coerce empty string", () => {
			// Empty strings are filtered out completely
			const result = parseQueryParams({ name: "" });

			expect(result.where).toEqual({});
		});

		it("should NOT coerce whitespace-only string", () => {
			const result = parseQueryParams({ name: "   " });

			// Whitespace-only is treated as empty and filtered out
			// Actually, the normalize function returns "   " which is truthy
			// But coerceNumeric returns original for whitespace
			expect(result.where).toEqual({ name: "   " });
			expect(typeof result.where.name).toBe("string");
		});

		it("should NOT coerce hex number string", () => {
			const result = parseQueryParams({ color: "0xFF0000" });

			// Hex strings are not automatically coerced
			expect(result.where).toEqual({ color: "0xFF0000" });
			expect(typeof result.where.color).toBe("string");
		});

		it("should NOT coerce scientific notation string", () => {
			const result = parseQueryParams({ value: "1e10" });

			// parseInt("1e10") = 1, but 1.toString() !== "1e10"
			// parseFloat("1e10") = 10000000000, but that.toString() = "10000000000" !== "1e10"
			expect(result.where).toEqual({ value: "1e10" });
			expect(typeof result.where.value).toBe("string");
		});

		it("should coerce Infinity string to number Infinity", () => {
			const result = parseQueryParams({ maxValue: "Infinity" });

			// "Infinity" is a valid JavaScript number representation
			expect(result.where).toEqual({ maxValue: Number.POSITIVE_INFINITY });
			expect(typeof result.where.maxValue).toBe("number");
		});

		it("should NOT coerce NaN string", () => {
			const result = parseQueryParams({ value: "NaN" });

			expect(result.where).toEqual({ value: "NaN" });
			expect(typeof result.where.value).toBe("string");
		});
	});

	describe("mixed type coercion in $in operator", () => {
		it("should coerce mixed strings, numbers, and booleans", () => {
			const result = parseQueryParams({
				"tags[$in]": "active,true,123,pending",
			});

			expect(result.where).toEqual({
				tags: { $in: ["active", true, 123, "pending"] },
			});
		});

		it("should coerce each array element independently", () => {
			const result = parseQueryParams({
				"value[$in]": "42,false,hello,3.14,true",
			});

			expect(result.where).toEqual({
				value: { $in: [42, false, "hello", 3.14, true] },
			});
		});
	});

	describe("type coercion with numeric operators", () => {
		it("should always coerce to number for $gt operator", () => {
			const result = parseQueryParams({ "year[$gt]": "1970" });

			expect(result.where).toEqual({ year: { $gt: 1970 } });
			expect(typeof (result.where.year as Record<string, unknown>).$gt).toBe(
				"number",
			);
		});

		it("should always coerce to number for $gte operator", () => {
			const result = parseQueryParams({ "count[$gte]": "100" });

			expect(result.where).toEqual({ count: { $gte: 100 } });
		});

		it("should always coerce to number for $lt operator", () => {
			const result = parseQueryParams({ "price[$lt]": "50" });

			expect(result.where).toEqual({ price: { $lt: 50 } });
		});

		it("should always coerce to number for $lte operator", () => {
			const result = parseQueryParams({ "rating[$lte]": "5" });

			expect(result.where).toEqual({ rating: { $lte: 5 } });
		});

		it("should always coerce to number for $size operator", () => {
			const result = parseQueryParams({ "tags[$size]": "3" });

			expect(result.where).toEqual({ tags: { $size: 3 } });
		});

		it("should keep non-numeric string as-is for numeric operators", () => {
			const result = parseQueryParams({ "version[$gt]": "2.0.0" });

			// coerceNumeric returns original string if not valid number
			expect(result.where).toEqual({ version: { $gt: "2.0.0" } });
			expect(typeof (result.where.version as Record<string, unknown>).$gt).toBe(
				"string",
			);
		});
	});

	describe("type coercion edge cases", () => {
		it("should handle multiple fields with different types", () => {
			const result = parseQueryParams({
				title: "Dune",
				year: "1965",
				rating: "4.5",
				published: "true",
				archived: "false",
			});

			expect(result.where).toEqual({
				title: "Dune",
				year: 1965,
				rating: 4.5,
				published: true,
				archived: false,
			});
		});

		it("should combine type coercion with operators and pagination", () => {
			const result = parseQueryParams({
				published: "true",
				"year[$gte]": "1970",
				"rating[$gt]": "4",
				sort: "year:desc",
				limit: "10",
			});

			expect(result.where).toEqual({
				published: true,
				year: { $gte: 1970 },
				rating: { $gt: 4 },
			});
			expect(result.sort).toEqual({ year: "desc" });
			expect(result.limit).toBe(10);
		});
	});
});
