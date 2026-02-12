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
