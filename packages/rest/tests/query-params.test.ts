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
