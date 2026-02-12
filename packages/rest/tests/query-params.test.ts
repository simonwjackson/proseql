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
