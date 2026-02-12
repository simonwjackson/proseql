import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
	FilterParseError,
	parseFilter,
	parseFilters,
} from "../src/parsers/filter-parser"

/**
 * Tests for the filter parser module.
 *
 * Tests cover:
 * - All comparison operators (=, !=, >, <, >=, <=)
 * - All word operators (contains, startsWith, endsWith)
 * - Type coercion (numbers, booleans, strings)
 * - Malformed input errors
 * - Multiple filter parsing and merging
 */

describe("Filter Parser", () => {
	describe("parseFilter", () => {
		describe("comparison operators", () => {
			it("should parse equals operator (=)", async () => {
				const result = await Effect.runPromise(parseFilter("status = active"))

				expect(result).toEqual({
					status: { $eq: "active" },
				})
			})

			it("should parse not equals operator (!=)", async () => {
				const result = await Effect.runPromise(parseFilter("status != deleted"))

				expect(result).toEqual({
					status: { $ne: "deleted" },
				})
			})

			it("should parse greater than operator (>)", async () => {
				const result = await Effect.runPromise(parseFilter("year > 1970"))

				expect(result).toEqual({
					year: { $gt: 1970 },
				})
			})

			it("should parse less than operator (<)", async () => {
				const result = await Effect.runPromise(parseFilter("year < 2000"))

				expect(result).toEqual({
					year: { $lt: 2000 },
				})
			})

			it("should parse greater than or equals operator (>=)", async () => {
				const result = await Effect.runPromise(parseFilter("price >= 10.99"))

				expect(result).toEqual({
					price: { $gte: 10.99 },
				})
			})

			it("should parse less than or equals operator (<=)", async () => {
				const result = await Effect.runPromise(parseFilter("count <= 100"))

				expect(result).toEqual({
					count: { $lte: 100 },
				})
			})

			it("should handle operators without spaces", async () => {
				const result = await Effect.runPromise(parseFilter("year>1970"))

				expect(result).toEqual({
					year: { $gt: 1970 },
				})
			})

			it("should handle extra whitespace around operator", async () => {
				const result = await Effect.runPromise(parseFilter("year   >=    1970"))

				expect(result).toEqual({
					year: { $gte: 1970 },
				})
			})

			it("should handle leading/trailing whitespace", async () => {
				const result = await Effect.runPromise(parseFilter("  year > 1970  "))

				expect(result).toEqual({
					year: { $gt: 1970 },
				})
			})
		})

		describe("word operators", () => {
			it("should parse contains operator", async () => {
				const result = await Effect.runPromise(parseFilter("title contains War"))

				expect(result).toEqual({
					title: { $contains: "War" },
				})
			})

			it("should parse startsWith operator", async () => {
				const result = await Effect.runPromise(
					parseFilter("title startsWith The"),
				)

				expect(result).toEqual({
					title: { $startsWith: "The" },
				})
			})

			it("should parse endsWith operator", async () => {
				const result = await Effect.runPromise(parseFilter("email endsWith .com"))

				expect(result).toEqual({
					email: { $endsWith: ".com" },
				})
			})

			it("should handle case-insensitive word operators", async () => {
				const containsResult = await Effect.runPromise(
					parseFilter("title CONTAINS War"),
				)
				const startsResult = await Effect.runPromise(
					parseFilter("title STARTSWITH The"),
				)
				const endsResult = await Effect.runPromise(
					parseFilter("email ENDSWITH .org"),
				)

				expect(containsResult).toEqual({ title: { $contains: "War" } })
				expect(startsResult).toEqual({ title: { $startsWith: "The" } })
				expect(endsResult).toEqual({ email: { $endsWith: ".org" } })
			})

			it("should handle mixed case word operators", async () => {
				const result = await Effect.runPromise(
					parseFilter("title Contains test"),
				)

				expect(result).toEqual({
					title: { $contains: "test" },
				})
			})

			it("should handle values with spaces for word operators", async () => {
				const result = await Effect.runPromise(
					parseFilter("title contains The Great"),
				)

				expect(result).toEqual({
					title: { $contains: "The Great" },
				})
			})
		})

		describe("type coercion", () => {
			describe("numbers", () => {
				it("should coerce integer values to numbers", async () => {
					const result = await Effect.runPromise(parseFilter("year = 2024"))

					expect(result).toEqual({
						year: { $eq: 2024 },
					})
					expect(typeof result.year.$eq).toBe("number")
				})

				it("should coerce decimal values to numbers", async () => {
					const result = await Effect.runPromise(parseFilter("price = 19.99"))

					expect(result).toEqual({
						price: { $eq: 19.99 },
					})
					expect(typeof result.price.$eq).toBe("number")
				})

				it("should coerce negative numbers", async () => {
					const result = await Effect.runPromise(parseFilter("offset = -10"))

					expect(result).toEqual({
						offset: { $eq: -10 },
					})
					expect(typeof result.offset.$eq).toBe("number")
				})

				it("should coerce zero", async () => {
					const result = await Effect.runPromise(parseFilter("count = 0"))

					expect(result).toEqual({
						count: { $eq: 0 },
					})
					expect(typeof result.count.$eq).toBe("number")
				})

				it("should coerce scientific notation", async () => {
					const result = await Effect.runPromise(parseFilter("value = 1e5"))

					expect(result).toEqual({
						value: { $eq: 100000 },
					})
					expect(typeof result.value.$eq).toBe("number")
				})
			})

			describe("booleans", () => {
				it("should coerce true boolean", async () => {
					const result = await Effect.runPromise(parseFilter("active = true"))

					expect(result).toEqual({
						active: { $eq: true },
					})
					expect(typeof result.active.$eq).toBe("boolean")
				})

				it("should coerce false boolean", async () => {
					const result = await Effect.runPromise(parseFilter("deleted = false"))

					expect(result).toEqual({
						deleted: { $eq: false },
					})
					expect(typeof result.deleted.$eq).toBe("boolean")
				})

				it("should handle case-insensitive boolean TRUE", async () => {
					const result = await Effect.runPromise(parseFilter("enabled = TRUE"))

					expect(result).toEqual({
						enabled: { $eq: true },
					})
					expect(typeof result.enabled.$eq).toBe("boolean")
				})

				it("should handle case-insensitive boolean False", async () => {
					const result = await Effect.runPromise(parseFilter("visible = False"))

					expect(result).toEqual({
						visible: { $eq: false },
					})
					expect(typeof result.visible.$eq).toBe("boolean")
				})
			})

			describe("strings", () => {
				it("should keep non-numeric non-boolean values as strings", async () => {
					const result = await Effect.runPromise(parseFilter("name = Alice"))

					expect(result).toEqual({
						name: { $eq: "Alice" },
					})
					expect(typeof result.name.$eq).toBe("string")
				})

				it("should strip double quotes from string values", async () => {
					const result = await Effect.runPromise(
						parseFilter('title = "Hello World"'),
					)

					expect(result).toEqual({
						title: { $eq: "Hello World" },
					})
				})

				it("should strip single quotes from string values", async () => {
					const result = await Effect.runPromise(
						parseFilter("title = 'Hello World'"),
					)

					expect(result).toEqual({
						title: { $eq: "Hello World" },
					})
				})

				it("should preserve strings that look like numbers when quoted", async () => {
					const result = await Effect.runPromise(parseFilter('code = "007"'))

					expect(result).toEqual({
						code: { $eq: "007" },
					})
					expect(typeof result.code.$eq).toBe("string")
				})

				it("should handle empty quoted strings", async () => {
					const result = await Effect.runPromise(parseFilter('value = ""'))

					expect(result).toEqual({
						value: { $eq: "" },
					})
				})

				it("should handle strings with special characters", async () => {
					const result = await Effect.runPromise(
						parseFilter("email = user@example.com"),
					)

					expect(result).toEqual({
						email: { $eq: "user@example.com" },
					})
				})
			})
		})

		describe("malformed input errors", () => {
			it("should fail on empty expression", async () => {
				const error = await Effect.runPromise(
					parseFilter("").pipe(Effect.flip),
				)

				expect(error).toBeInstanceOf(FilterParseError)
				expect(error._tag).toBe("FilterParseError")
				expect(error.reason).toContain("Empty expression")
			})

			it("should fail on whitespace-only expression", async () => {
				const error = await Effect.runPromise(
					parseFilter("   ").pipe(Effect.flip),
				)

				expect(error).toBeInstanceOf(FilterParseError)
				expect(error.reason).toContain("Empty expression")
			})

			it("should fail on expression without operator", async () => {
				const error = await Effect.runPromise(
					parseFilter("year 1970").pipe(Effect.flip),
				)

				expect(error).toBeInstanceOf(FilterParseError)
				expect(error.reason).toContain("No valid operator found")
				expect(error.reason).toContain("Supported operators")
			})

			it("should fail on expression with only field name", async () => {
				const error = await Effect.runPromise(
					parseFilter("year").pipe(Effect.flip),
				)

				expect(error).toBeInstanceOf(FilterParseError)
				expect(error.reason).toContain("No valid operator found")
			})

			it("should fail on expression with only operator", async () => {
				const error = await Effect.runPromise(
					parseFilter(">").pipe(Effect.flip),
				)

				expect(error).toBeInstanceOf(FilterParseError)
			})

			it("should fail on expression with missing value", async () => {
				const error = await Effect.runPromise(
					parseFilter("year >").pipe(Effect.flip),
				)

				expect(error).toBeInstanceOf(FilterParseError)
			})

			it("should fail on expression with missing field", async () => {
				const error = await Effect.runPromise(
					parseFilter("> 1970").pipe(Effect.flip),
				)

				expect(error).toBeInstanceOf(FilterParseError)
			})

			it("should include original expression in error", async () => {
				const badExpression = "invalid filter expression"
				const error = await Effect.runPromise(
					parseFilter(badExpression).pipe(Effect.flip),
				)

				expect(error.expression).toBe(badExpression)
				expect(error.message).toContain(badExpression)
			})

			it("should have descriptive error message", async () => {
				const error = await Effect.runPromise(
					parseFilter("no operator here").pipe(Effect.flip),
				)

				expect(error.message).toContain("Failed to parse filter")
				expect(error.message).toContain("no operator here")
			})
		})

		describe("edge cases", () => {
			it("should handle field names with underscores", async () => {
				const result = await Effect.runPromise(
					parseFilter("created_at > 2024-01-01"),
				)

				expect(result).toEqual({
					created_at: { $gt: "2024-01-01" },
				})
			})

			it("should handle field names with dots", async () => {
				const result = await Effect.runPromise(
					parseFilter("user.name = Alice"),
				)

				expect(result).toEqual({
					"user.name": { $eq: "Alice" },
				})
			})

			it("should handle values containing equals sign", async () => {
				// This is a tricky case - "key=value" format in the value
				// The parser should find the first = operator
				const result = await Effect.runPromise(parseFilter("query = a=b"))

				expect(result).toEqual({
					query: { $eq: "a=b" },
				})
			})

			it("should handle values containing comparison operators after first match", async () => {
				// Note: The parser finds the first operator, so "formula = a>b" actually parses
				// as "formula" equals "a>b" because "=" comes before ">" in operator precedence.
				// But "formula > a=b" would parse as "formula" > "a=b"
				const result = await Effect.runPromise(parseFilter("formula > a=b"))

				expect(result).toEqual({
					formula: { $gt: "a=b" },
				})
			})

			it("should handle ISO date strings as values", async () => {
				const result = await Effect.runPromise(
					parseFilter("date = 2024-01-15T10:30:00Z"),
				)

				expect(result).toEqual({
					date: { $eq: "2024-01-15T10:30:00Z" },
				})
			})

			it("should handle URL-like values", async () => {
				const result = await Effect.runPromise(
					parseFilter("url = https://example.com"),
				)

				expect(result).toEqual({
					url: { $eq: "https://example.com" },
				})
			})

			it("should handle values with colons", async () => {
				const result = await Effect.runPromise(parseFilter("time = 14:30:00"))

				expect(result).toEqual({
					time: { $eq: "14:30:00" },
				})
			})
		})
	})

	describe("parseFilters", () => {
		it("should return empty object for empty array", async () => {
			const result = await Effect.runPromise(parseFilters([]))

			expect(result).toEqual({})
		})

		it("should parse a single filter", async () => {
			const result = await Effect.runPromise(parseFilters(["year > 1970"]))

			expect(result).toEqual({
				year: { $gt: 1970 },
			})
		})

		it("should combine multiple filters on different fields", async () => {
			const result = await Effect.runPromise(
				parseFilters(["year > 1970", "status = active", "count >= 10"]),
			)

			expect(result).toEqual({
				year: { $gt: 1970 },
				status: { $eq: "active" },
				count: { $gte: 10 },
			})
		})

		it("should merge multiple conditions on the same field", async () => {
			const result = await Effect.runPromise(
				parseFilters(["year >= 1970", "year <= 2000"]),
			)

			expect(result).toEqual({
				year: { $gte: 1970, $lte: 2000 },
			})
		})

		it("should handle mixed field and same-field filters", async () => {
			const result = await Effect.runPromise(
				parseFilters([
					"year >= 1970",
					"year <= 2000",
					"status = active",
					"genre = fiction",
				]),
			)

			expect(result).toEqual({
				year: { $gte: 1970, $lte: 2000 },
				status: { $eq: "active" },
				genre: { $eq: "fiction" },
			})
		})

		it("should fail if any filter is invalid", async () => {
			const error = await Effect.runPromise(
				parseFilters(["year > 1970", "invalid filter", "status = active"]).pipe(
					Effect.flip,
				),
			)

			expect(error).toBeInstanceOf(FilterParseError)
			expect(error.expression).toBe("invalid filter")
		})

		it("should fail on first invalid filter in the array", async () => {
			const error = await Effect.runPromise(
				parseFilters(["bad one", "also bad"]).pipe(Effect.flip),
			)

			expect(error).toBeInstanceOf(FilterParseError)
		})

		it("should handle a complex real-world example", async () => {
			const result = await Effect.runPromise(
				parseFilters([
					"price >= 10",
					"price <= 100",
					"category = electronics",
					"inStock = true",
					"name contains phone",
				]),
			)

			expect(result).toEqual({
				price: { $gte: 10, $lte: 100 },
				category: { $eq: "electronics" },
				inStock: { $eq: true },
				name: { $contains: "phone" },
			})
		})
	})
})
