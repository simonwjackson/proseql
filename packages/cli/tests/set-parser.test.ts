import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	parseMultipleSets,
	parseSet,
	parseSets,
	SetParseError,
} from "../src/parsers/set-parser";

/**
 * Tests for the set parser module.
 *
 * Tests cover:
 * - Key=value parsing
 * - Multiple assignments (comma-separated)
 * - Type coercion (numbers, booleans, strings)
 * - Edge cases (values containing '=', quoted values, etc.)
 * - Malformed input errors
 */

describe("Set Parser", () => {
	describe("parseSet", () => {
		describe("basic key=value parsing", () => {
			it("should parse simple string assignment", async () => {
				const result = await Effect.runPromise(parseSet("title=Hello"));

				expect(result).toEqual({
					title: "Hello",
				});
			});

			it("should parse assignment with spaces in value", async () => {
				const result = await Effect.runPromise(parseSet("title=Hello World"));

				expect(result).toEqual({
					title: "Hello World",
				});
			});

			it("should handle leading/trailing whitespace around assignment", async () => {
				const result = await Effect.runPromise(parseSet("  title=Hello  "));

				expect(result).toEqual({
					title: "Hello",
				});
			});

			it("should handle whitespace around key", async () => {
				const result = await Effect.runPromise(parseSet("  title  =value"));

				expect(result).toEqual({
					title: "value",
				});
			});

			it("should handle keys with underscores", async () => {
				const result = await Effect.runPromise(
					parseSet("created_at=2024-01-01"),
				);

				expect(result).toEqual({
					created_at: "2024-01-01",
				});
			});

			it("should handle keys starting with underscore", async () => {
				const result = await Effect.runPromise(parseSet("_private=secret"));

				expect(result).toEqual({
					_private: "secret",
				});
			});

			it("should handle keys with numbers", async () => {
				const result = await Effect.runPromise(parseSet("field1=value"));

				expect(result).toEqual({
					field1: "value",
				});
			});
		});

		describe("type coercion", () => {
			describe("numbers", () => {
				it("should coerce integer values to numbers", async () => {
					const result = await Effect.runPromise(parseSet("year=2024"));

					expect(result).toEqual({
						year: 2024,
					});
					expect(typeof result.year).toBe("number");
				});

				it("should coerce decimal values to numbers", async () => {
					const result = await Effect.runPromise(parseSet("price=19.99"));

					expect(result).toEqual({
						price: 19.99,
					});
					expect(typeof result.price).toBe("number");
				});

				it("should coerce negative numbers", async () => {
					const result = await Effect.runPromise(parseSet("offset=-10"));

					expect(result).toEqual({
						offset: -10,
					});
					expect(typeof result.offset).toBe("number");
				});

				it("should coerce zero", async () => {
					const result = await Effect.runPromise(parseSet("count=0"));

					expect(result).toEqual({
						count: 0,
					});
					expect(typeof result.count).toBe("number");
				});

				it("should coerce scientific notation", async () => {
					const result = await Effect.runPromise(parseSet("value=1e5"));

					expect(result).toEqual({
						value: 100000,
					});
					expect(typeof result.value).toBe("number");
				});

				it("should coerce negative scientific notation", async () => {
					const result = await Effect.runPromise(parseSet("tiny=1e-3"));

					expect(result).toEqual({
						tiny: 0.001,
					});
					expect(typeof result.tiny).toBe("number");
				});
			});

			describe("booleans", () => {
				it("should coerce true boolean (lowercase)", async () => {
					const result = await Effect.runPromise(parseSet("active=true"));

					expect(result).toEqual({
						active: true,
					});
					expect(typeof result.active).toBe("boolean");
				});

				it("should coerce false boolean (lowercase)", async () => {
					const result = await Effect.runPromise(parseSet("deleted=false"));

					expect(result).toEqual({
						deleted: false,
					});
					expect(typeof result.deleted).toBe("boolean");
				});

				it("should handle case-insensitive boolean TRUE", async () => {
					const result = await Effect.runPromise(parseSet("enabled=TRUE"));

					expect(result).toEqual({
						enabled: true,
					});
					expect(typeof result.enabled).toBe("boolean");
				});

				it("should handle case-insensitive boolean False", async () => {
					const result = await Effect.runPromise(parseSet("visible=False"));

					expect(result).toEqual({
						visible: false,
					});
					expect(typeof result.visible).toBe("boolean");
				});

				it("should handle mixed case boolean TrUe", async () => {
					const result = await Effect.runPromise(parseSet("flag=TrUe"));

					expect(result).toEqual({
						flag: true,
					});
					expect(typeof result.flag).toBe("boolean");
				});
			});

			describe("strings", () => {
				it("should keep non-numeric non-boolean values as strings", async () => {
					const result = await Effect.runPromise(parseSet("name=Alice"));

					expect(result).toEqual({
						name: "Alice",
					});
					expect(typeof result.name).toBe("string");
				});

				it("should strip double quotes from string values", async () => {
					const result = await Effect.runPromise(
						parseSet('title="Hello World"'),
					);

					expect(result).toEqual({
						title: "Hello World",
					});
				});

				it("should strip single quotes from string values", async () => {
					const result = await Effect.runPromise(
						parseSet("title='Hello World'"),
					);

					expect(result).toEqual({
						title: "Hello World",
					});
				});

				it("should preserve strings that look like numbers when quoted", async () => {
					const result = await Effect.runPromise(parseSet('code="007"'));

					expect(result).toEqual({
						code: "007",
					});
					expect(typeof result.code).toBe("string");
				});

				it("should preserve strings that look like booleans when quoted", async () => {
					const result = await Effect.runPromise(parseSet('answer="true"'));

					expect(result).toEqual({
						answer: "true",
					});
					expect(typeof result.answer).toBe("string");
				});

				it("should handle empty quoted strings", async () => {
					const result = await Effect.runPromise(parseSet('value=""'));

					expect(result).toEqual({
						value: "",
					});
				});

				it("should handle strings with special characters", async () => {
					const result = await Effect.runPromise(
						parseSet("email=user@example.com"),
					);

					expect(result).toEqual({
						email: "user@example.com",
					});
				});
			});
		});

		describe("edge cases with equals sign in value", () => {
			it("should handle value containing equals sign", async () => {
				const result = await Effect.runPromise(
					parseSet("url=https://example.com/a=b"),
				);

				expect(result).toEqual({
					url: "https://example.com/a=b",
				});
			});

			it("should handle value with multiple equals signs", async () => {
				const result = await Effect.runPromise(parseSet("query=a=b=c"));

				expect(result).toEqual({
					query: "a=b=c",
				});
			});

			it("should handle value starting with equals sign", async () => {
				const result = await Effect.runPromise(parseSet("expr==value"));

				expect(result).toEqual({
					expr: "=value",
				});
			});

			it("should handle URL with query parameters", async () => {
				const result = await Effect.runPromise(
					parseSet("redirect=https://example.com?foo=bar&baz=qux"),
				);

				expect(result).toEqual({
					redirect: "https://example.com?foo=bar&baz=qux",
				});
			});
		});

		describe("malformed input errors", () => {
			it("should fail on empty expression", async () => {
				const error = await Effect.runPromise(parseSet("").pipe(Effect.flip));

				expect(error).toBeInstanceOf(SetParseError);
				expect(error._tag).toBe("SetParseError");
				expect(error.reason).toContain("Empty assignment");
			});

			it("should fail on whitespace-only expression", async () => {
				const error = await Effect.runPromise(
					parseSet("   ").pipe(Effect.flip),
				);

				expect(error).toBeInstanceOf(SetParseError);
				expect(error.reason).toContain("Empty assignment");
			});

			it("should fail on expression without equals sign", async () => {
				const error = await Effect.runPromise(
					parseSet("year2025").pipe(Effect.flip),
				);

				expect(error).toBeInstanceOf(SetParseError);
				expect(error.reason).toContain("Missing '='");
			});

			it("should fail on expression with missing key", async () => {
				const error = await Effect.runPromise(
					parseSet("=value").pipe(Effect.flip),
				);

				expect(error).toBeInstanceOf(SetParseError);
				expect(error.reason).toContain("Missing key");
			});

			it("should fail on invalid key starting with number", async () => {
				const error = await Effect.runPromise(
					parseSet("1field=value").pipe(Effect.flip),
				);

				expect(error).toBeInstanceOf(SetParseError);
				expect(error.reason).toContain("Invalid key");
			});

			it("should fail on key with invalid characters", async () => {
				const error = await Effect.runPromise(
					parseSet("field-name=value").pipe(Effect.flip),
				);

				expect(error).toBeInstanceOf(SetParseError);
				expect(error.reason).toContain("Invalid key");
			});

			it("should fail on key with spaces", async () => {
				const error = await Effect.runPromise(
					parseSet("field name=value").pipe(Effect.flip),
				);

				expect(error).toBeInstanceOf(SetParseError);
				expect(error.reason).toContain("Invalid key");
			});

			it("should include original expression in error", async () => {
				const badExpression = "bad-key=value";
				const error = await Effect.runPromise(
					parseSet(badExpression).pipe(Effect.flip),
				);

				expect(error.expression).toBe(badExpression);
				expect(error.message).toContain(badExpression);
			});

			it("should have descriptive error message", async () => {
				const error = await Effect.runPromise(
					parseSet("no equals here").pipe(Effect.flip),
				);

				expect(error.message).toContain("Failed to parse set expression");
			});
		});
	});

	describe("parseSets", () => {
		describe("single assignment", () => {
			it("should parse a single assignment", async () => {
				const result = await Effect.runPromise(parseSets("year=2025"));

				expect(result).toEqual({
					year: 2025,
				});
			});
		});

		describe("multiple assignments", () => {
			it("should parse comma-separated assignments", async () => {
				const result = await Effect.runPromise(
					parseSets("year=2025,title=New Title"),
				);

				expect(result).toEqual({
					year: 2025,
					title: "New Title",
				});
			});

			it("should parse three assignments", async () => {
				const result = await Effect.runPromise(
					parseSets("year=2025,title=Test,active=true"),
				);

				expect(result).toEqual({
					year: 2025,
					title: "Test",
					active: true,
				});
			});

			it("should handle whitespace around commas", async () => {
				const result = await Effect.runPromise(
					parseSets("year=2025 , title=Test , active=true"),
				);

				expect(result).toEqual({
					year: 2025,
					title: "Test",
					active: true,
				});
			});

			it("should handle trailing comma gracefully", async () => {
				const result = await Effect.runPromise(parseSets("year=2025,"));

				expect(result).toEqual({
					year: 2025,
				});
			});

			it("should later assignment override earlier for same key", async () => {
				const result = await Effect.runPromise(
					parseSets("title=First,title=Second"),
				);

				expect(result).toEqual({
					title: "Second",
				});
			});
		});

		describe("quoted values with commas", () => {
			it("should handle double-quoted values containing commas", async () => {
				const result = await Effect.runPromise(
					parseSets('name="Last, First",age=30'),
				);

				expect(result).toEqual({
					name: "Last, First",
					age: 30,
				});
			});

			it("should handle single-quoted values containing commas", async () => {
				const result = await Effect.runPromise(
					parseSets("name='Last, First',age=30"),
				);

				expect(result).toEqual({
					name: "Last, First",
					age: 30,
				});
			});

			it("should handle multiple quoted values", async () => {
				const result = await Effect.runPromise(
					parseSets('first="A, B",second="C, D"'),
				);

				expect(result).toEqual({
					first: "A, B",
					second: "C, D",
				});
			});
		});

		describe("complex real-world examples", () => {
			it("should handle mixed types", async () => {
				const result = await Effect.runPromise(
					parseSets("title=New Book,year=2024,price=29.99,published=true"),
				);

				expect(result).toEqual({
					title: "New Book",
					year: 2024,
					price: 29.99,
					published: true,
				});
			});

			it("should handle URL with query params as value", async () => {
				const result = await Effect.runPromise(
					parseSets("url=https://example.com/a=b,name=Test"),
				);

				expect(result).toEqual({
					url: "https://example.com/a=b",
					name: "Test",
				});
			});
		});

		describe("malformed input errors", () => {
			it("should fail on empty input", async () => {
				const error = await Effect.runPromise(parseSets("").pipe(Effect.flip));

				expect(error).toBeInstanceOf(SetParseError);
				expect(error.reason).toContain("Empty input");
			});

			it("should fail on whitespace-only input", async () => {
				const error = await Effect.runPromise(
					parseSets("   ").pipe(Effect.flip),
				);

				expect(error).toBeInstanceOf(SetParseError);
				expect(error.reason).toContain("Empty input");
			});

			it("should fail if any assignment is invalid", async () => {
				const error = await Effect.runPromise(
					parseSets("year=2025,invalid,title=Test").pipe(Effect.flip),
				);

				expect(error).toBeInstanceOf(SetParseError);
			});
		});
	});

	describe("parseMultipleSets", () => {
		it("should return empty object for empty array", async () => {
			const result = await Effect.runPromise(parseMultipleSets([]));

			expect(result).toEqual({});
		});

		it("should parse a single input", async () => {
			const result = await Effect.runPromise(parseMultipleSets(["year=2025"]));

			expect(result).toEqual({
				year: 2025,
			});
		});

		it("should combine multiple inputs", async () => {
			const result = await Effect.runPromise(
				parseMultipleSets(["year=2025", "title=Test"]),
			);

			expect(result).toEqual({
				year: 2025,
				title: "Test",
			});
		});

		it("should combine inputs with comma-separated values", async () => {
			const result = await Effect.runPromise(
				parseMultipleSets(["year=2025,month=12", "title=Test,active=true"]),
			);

			expect(result).toEqual({
				year: 2025,
				month: 12,
				title: "Test",
				active: true,
			});
		});

		it("should later inputs override earlier for same key", async () => {
			const result = await Effect.runPromise(
				parseMultipleSets(["title=First", "title=Second"]),
			);

			expect(result).toEqual({
				title: "Second",
			});
		});

		it("should handle mixed single and multiple assignments", async () => {
			const result = await Effect.runPromise(
				parseMultipleSets(["year=2025", "title=Test,author=Alice"]),
			);

			expect(result).toEqual({
				year: 2025,
				title: "Test",
				author: "Alice",
			});
		});

		it("should fail if any input is invalid", async () => {
			const error = await Effect.runPromise(
				parseMultipleSets(["year=2025", "invalid"]).pipe(Effect.flip),
			);

			expect(error).toBeInstanceOf(SetParseError);
		});

		it("should handle complex real-world scenario with multiple --set flags", async () => {
			const result = await Effect.runPromise(
				parseMultipleSets([
					"title=The Great Gatsby",
					"year=1925,genre=fiction",
					"author=F. Scott Fitzgerald,published=true",
				]),
			);

			expect(result).toEqual({
				title: "The Great Gatsby",
				year: 1925,
				genre: "fiction",
				author: "F. Scott Fitzgerald",
				published: true,
			});
		});
	});
});
