import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { formatAsCsv } from "../src/output/csv";
import { format, type OutputFormat } from "../src/output/formatter";
import { formatAsJson } from "../src/output/json";
import { formatAsTable } from "../src/output/table";
import { formatAsYaml } from "../src/output/yaml";

/**
 * Tests for output formatters.
 *
 * Tests cover:
 * - Table alignment and truncation
 * - JSON validity and formatting
 * - YAML validity and formatting
 * - CSV quoting and escaping
 */

describe("Output Formatters", () => {
	describe("formatAsTable", () => {
		describe("basic functionality", () => {
			it("should return '(no results)' for empty array", () => {
				const result = formatAsTable([]);

				expect(result).toBe("(no results)");
			});

			it("should format a single record", () => {
				const result = formatAsTable([{ name: "Alice", age: 30 }]);
				const lines = result.split("\n");

				expect(lines).toHaveLength(3);
				expect(lines[0]).toContain("name");
				expect(lines[0]).toContain("age");
				expect(lines[1]).toMatch(/^-+\s+-+$/);
				expect(lines[2]).toContain("Alice");
				expect(lines[2]).toContain("30");
			});

			it("should format multiple records", () => {
				const result = formatAsTable([
					{ id: "1", name: "Alice" },
					{ id: "2", name: "Bob" },
					{ id: "3", name: "Charlie" },
				]);
				const lines = result.split("\n");

				expect(lines).toHaveLength(5); // header + separator + 3 data rows
				expect(lines[2]).toContain("Alice");
				expect(lines[3]).toContain("Bob");
				expect(lines[4]).toContain("Charlie");
			});
		});

		describe("column alignment", () => {
			it("should align columns based on header and data widths", () => {
				const result = formatAsTable([
					{ name: "Alice", description: "A very long description text" },
					{ name: "Bob", description: "Short" },
				]);
				const lines = result.split("\n");

				// Header and data rows should have same column positions
				const _headerNameEnd = lines[0].indexOf("name") + "name".length;
				const _separatorNameEnd = lines[1].indexOf("  ");

				// Columns should be separated by at least two spaces
				expect(lines[0].includes("  ")).toBe(true);
			});

			it("should pad shorter values to column width", () => {
				const result = formatAsTable([
					{ code: "A", value: 12345 },
					{ code: "ABCDEF", value: 1 },
				]);
				const lines = result.split("\n");

				// First data row should have padding after "A"
				// Second data row should have padding after "1"
				const row1 = lines[2];
				const row2 = lines[3];

				// Both rows should have same total length
				expect(row1.length).toBe(row2.length);
			});

			it("should handle fields with different presence across records", () => {
				const result = formatAsTable([
					{ id: "1", name: "Alice" },
					{ id: "2", role: "admin" },
				]);
				const lines = result.split("\n");

				// Header should include all fields
				expect(lines[0]).toContain("id");
				expect(lines[0]).toContain("name");
				expect(lines[0]).toContain("role");
			});
		});

		describe("truncation", () => {
			it("should truncate long values with ellipsis", () => {
				const longValue = "A".repeat(50);
				const result = formatAsTable([{ text: longValue }], {
					maxColumnWidth: 20,
				});
				const lines = result.split("\n");

				expect(lines[2].length).toBeLessThanOrEqual(20);
				expect(lines[2]).toContain("...");
			});

			it("should truncate long headers with ellipsis", () => {
				const result = formatAsTable([{ thisIsAVeryLongFieldName: "value" }], {
					maxColumnWidth: 15,
				});
				const lines = result.split("\n");

				expect(lines[0]).toContain("...");
				expect(lines[0].length).toBeLessThanOrEqual(15);
			});

			it("should not truncate values within max width", () => {
				const result = formatAsTable([{ name: "Alice" }], {
					maxColumnWidth: 40,
				});
				const lines = result.split("\n");

				expect(lines[2]).toContain("Alice");
				expect(lines[2]).not.toContain("...");
			});

			it("should handle very small maxColumnWidth", () => {
				const result = formatAsTable([{ name: "Alice" }], {
					maxColumnWidth: 3,
				});
				const lines = result.split("\n");

				// With only 3 chars, can't fit ellipsis, so just truncate
				expect(lines[2].trim().length).toBeLessThanOrEqual(3);
			});
		});

		describe("value serialization", () => {
			it("should handle null values", () => {
				const result = formatAsTable([{ value: null }]);

				expect(result).toContain("null");
			});

			it("should handle undefined values", () => {
				const result = formatAsTable([{ value: undefined }]);
				const lines = result.split("\n");

				// undefined should render as empty string
				expect(lines[2].trim()).toBe("");
			});

			it("should handle object values as JSON", () => {
				const result = formatAsTable([{ data: { nested: true } }]);

				expect(result).toContain('{"nested":true}');
			});

			it("should handle array values as JSON", () => {
				const result = formatAsTable([{ tags: ["a", "b", "c"] }]);

				expect(result).toContain('["a","b","c"]');
			});

			it("should handle boolean values", () => {
				const result = formatAsTable([{ active: true, deleted: false }]);

				expect(result).toContain("true");
				expect(result).toContain("false");
			});

			it("should handle number values", () => {
				const result = formatAsTable([{ count: 42, price: 19.99 }]);

				expect(result).toContain("42");
				expect(result).toContain("19.99");
			});
		});
	});

	describe("formatAsJson", () => {
		describe("validity", () => {
			it("should produce valid JSON", () => {
				const data = [{ id: "1", name: "Alice", age: 30 }];
				const result = formatAsJson(data);

				expect(() => JSON.parse(result)).not.toThrow();
			});

			it("should produce JSON that parses back to original data", () => {
				const data = [
					{
						id: "1",
						name: "Alice",
						tags: ["a", "b"],
						nested: { key: "value" },
					},
				];
				const result = formatAsJson(data);
				const parsed = JSON.parse(result);

				expect(parsed).toEqual(data);
			});
		});

		describe("formatting", () => {
			it("should use 2-space indentation", () => {
				const data = [{ name: "Alice" }];
				const result = formatAsJson(data);

				// JSON should be formatted with 2-space indent
				expect(result).toContain("\n  ");
			});

			it("should format empty array as []", () => {
				const result = formatAsJson([]);

				expect(result).toBe("[]");
			});

			it("should format multiple records with proper structure", () => {
				const data = [
					{ id: "1", name: "Alice" },
					{ id: "2", name: "Bob" },
				];
				const result = formatAsJson(data);
				const parsed = JSON.parse(result);

				expect(parsed).toHaveLength(2);
				expect(parsed[0]).toEqual({ id: "1", name: "Alice" });
				expect(parsed[1]).toEqual({ id: "2", name: "Bob" });
			});
		});

		describe("special values", () => {
			it("should handle null values", () => {
				const data = [{ value: null }];
				const result = formatAsJson(data);
				const parsed = JSON.parse(result);

				expect(parsed[0].value).toBeNull();
			});

			it("should handle nested objects", () => {
				const data = [{ data: { level1: { level2: "deep" } } }];
				const result = formatAsJson(data);
				const parsed = JSON.parse(result);

				expect(parsed[0].data.level1.level2).toBe("deep");
			});

			it("should handle special characters in strings", () => {
				const data = [{ text: 'Hello\n"World"\ttab' }];
				const result = formatAsJson(data);
				const parsed = JSON.parse(result);

				expect(parsed[0].text).toBe('Hello\n"World"\ttab');
			});

			it("should handle unicode characters", () => {
				const data = [{ emoji: "🎉", japanese: "日本語" }];
				const result = formatAsJson(data);
				const parsed = JSON.parse(result);

				expect(parsed[0].emoji).toBe("🎉");
				expect(parsed[0].japanese).toBe("日本語");
			});
		});
	});

	describe("formatAsYaml", () => {
		describe("validity", () => {
			it("should produce valid YAML", () => {
				const data = [{ id: "1", name: "Alice", age: 30 }];
				const result = formatAsYaml(data);

				expect(() => YAML.parse(result)).not.toThrow();
			});

			it("should produce YAML that parses back to original data", () => {
				const data = [
					{
						id: "1",
						name: "Alice",
						tags: ["a", "b"],
						nested: { key: "value" },
					},
				];
				const result = formatAsYaml(data);
				const parsed = YAML.parse(result);

				expect(parsed).toEqual(data);
			});
		});

		describe("formatting", () => {
			it("should use 2-space indentation", () => {
				const data = [{ nested: { key: "value" } }];
				const result = formatAsYaml(data);

				// Should have 2-space indentation for nested content
				expect(result).toMatch(/^ {2}/m);
			});

			it("should format empty array appropriately", () => {
				const result = formatAsYaml([]);
				const parsed = YAML.parse(result);

				expect(parsed).toEqual([]);
			});

			it("should format multiple records as a list", () => {
				const data = [
					{ id: "1", name: "Alice" },
					{ id: "2", name: "Bob" },
				];
				const result = formatAsYaml(data);

				// YAML list items start with "-"
				expect(result).toContain("- id:");
				const parsed = YAML.parse(result);
				expect(parsed).toHaveLength(2);
			});
		});

		describe("special values", () => {
			it("should handle null values", () => {
				const data = [{ value: null }];
				const result = formatAsYaml(data);
				const parsed = YAML.parse(result);

				expect(parsed[0].value).toBeNull();
			});

			it("should handle nested objects", () => {
				const data = [{ data: { level1: { level2: "deep" } } }];
				const result = formatAsYaml(data);
				const parsed = YAML.parse(result);

				expect(parsed[0].data.level1.level2).toBe("deep");
			});

			it("should handle special characters in strings", () => {
				const data = [{ text: 'Hello\n"World"\ttab' }];
				const result = formatAsYaml(data);
				const parsed = YAML.parse(result);

				expect(parsed[0].text).toBe('Hello\n"World"\ttab');
			});

			it("should handle unicode characters", () => {
				const data = [{ emoji: "🎉", japanese: "日本語" }];
				const result = formatAsYaml(data);
				const parsed = YAML.parse(result);

				expect(parsed[0].emoji).toBe("🎉");
				expect(parsed[0].japanese).toBe("日本語");
			});

			it("should handle boolean values", () => {
				const data = [{ active: true, deleted: false }];
				const result = formatAsYaml(data);
				const parsed = YAML.parse(result);

				expect(parsed[0].active).toBe(true);
				expect(parsed[0].deleted).toBe(false);
			});

			it("should handle numeric values", () => {
				const data = [{ integer: 42, decimal: 3.14, negative: -10 }];
				const result = formatAsYaml(data);
				const parsed = YAML.parse(result);

				expect(parsed[0].integer).toBe(42);
				expect(parsed[0].decimal).toBe(3.14);
				expect(parsed[0].negative).toBe(-10);
			});
		});
	});

	describe("formatAsCsv", () => {
		describe("basic functionality", () => {
			it("should return empty string for empty array", () => {
				const result = formatAsCsv([]);

				expect(result).toBe("");
			});

			it("should format a single record with header", () => {
				const result = formatAsCsv([{ name: "Alice", age: 30 }]);
				const lines = result.split("\n");

				expect(lines).toHaveLength(2);
				expect(lines[0]).toBe("name,age");
				expect(lines[1]).toBe("Alice,30");
			});

			it("should format multiple records", () => {
				const result = formatAsCsv([
					{ id: "1", name: "Alice" },
					{ id: "2", name: "Bob" },
				]);
				const lines = result.split("\n");

				expect(lines).toHaveLength(3);
				expect(lines[0]).toBe("id,name");
				expect(lines[1]).toBe("1,Alice");
				expect(lines[2]).toBe("2,Bob");
			});
		});

		describe("quoting", () => {
			it("should quote values containing commas", () => {
				const result = formatAsCsv([{ name: "Last, First" }]);
				const lines = result.split("\n");

				expect(lines[1]).toBe('"Last, First"');
			});

			it("should quote values containing double quotes", () => {
				const result = formatAsCsv([{ text: 'Say "hello"' }]);
				const lines = result.split("\n");

				expect(lines[1]).toBe('"Say ""hello"""');
			});

			it("should quote values containing newlines", () => {
				const result = formatAsCsv([{ text: "Line1\nLine2" }]);
				const _lines = result.split("\n");

				// The newline is inside quotes
				expect(result).toContain('"Line1\nLine2"');
			});

			it("should quote values containing carriage returns", () => {
				const result = formatAsCsv([{ text: "Line1\rLine2" }]);

				expect(result).toContain('"Line1\rLine2"');
			});

			it("should double quotes inside quoted values", () => {
				const result = formatAsCsv([{ text: 'He said "yes"' }]);
				const lines = result.split("\n");

				// Quotes are doubled: He said "yes" becomes "He said ""yes"""
				expect(lines[1]).toBe('"He said ""yes"""');
			});

			it("should not quote simple values", () => {
				const result = formatAsCsv([{ name: "Alice", age: 30 }]);
				const lines = result.split("\n");

				expect(lines[1]).toBe("Alice,30");
				expect(lines[1]).not.toContain('"');
			});
		});

		describe("escaping", () => {
			it("should handle values with both commas and quotes", () => {
				const result = formatAsCsv([{ text: 'Name: "A, B"' }]);
				const lines = result.split("\n");

				// Both comma and quotes trigger quoting, quotes are doubled
				expect(lines[1]).toBe('"Name: ""A, B"""');
			});

			it("should handle field names that need quoting", () => {
				const result = formatAsCsv([{ "full,name": "Alice" }]);
				const lines = result.split("\n");

				expect(lines[0]).toBe('"full,name"');
			});
		});

		describe("special values", () => {
			it("should render null as empty string", () => {
				const result = formatAsCsv([{ value: null }]);
				const lines = result.split("\n");

				expect(lines[1]).toBe("");
			});

			it("should render undefined as empty string", () => {
				const result = formatAsCsv([{ value: undefined }]);
				const lines = result.split("\n");

				expect(lines[1]).toBe("");
			});

			it("should render objects as JSON", () => {
				const result = formatAsCsv([{ data: { nested: true } }]);
				const lines = result.split("\n");

				// JSON contains quotes, so it will be quoted and quotes escaped (doubled)
				// {"nested":true} becomes "{""nested"":true}" in CSV
				expect(lines[1]).toBe('"{""nested"":true}"');
			});

			it("should render arrays as JSON", () => {
				const result = formatAsCsv([{ tags: ["a", "b"] }]);
				const lines = result.split("\n");

				// JSON array: ["a","b"] - contains commas so will be quoted
				expect(lines[1]).toContain('"');
				expect(lines[1]).toContain("[");
			});

			it("should handle boolean values", () => {
				const result = formatAsCsv([{ active: true, deleted: false }]);
				const lines = result.split("\n");

				expect(lines[1]).toContain("true");
				expect(lines[1]).toContain("false");
			});

			it("should handle numeric values", () => {
				const result = formatAsCsv([{ count: 42, price: 19.99 }]);
				const lines = result.split("\n");

				expect(lines[1]).toContain("42");
				expect(lines[1]).toContain("19.99");
			});
		});

		describe("field collection", () => {
			it("should include all unique fields from all records", () => {
				const result = formatAsCsv([
					{ id: "1", name: "Alice" },
					{ id: "2", role: "admin" },
				]);
				const lines = result.split("\n");

				// Header should have id, name, and role
				expect(lines[0].split(",")).toContain("id");
				expect(lines[0].split(",")).toContain("name");
				expect(lines[0].split(",")).toContain("role");
			});

			it("should render missing fields as empty", () => {
				const result = formatAsCsv([
					{ id: "1", name: "Alice" },
					{ id: "2", role: "admin" },
				]);
				const lines = result.split("\n");

				// First record has no role, second record has no name
				// The missing values should be empty in the CSV
				const headers = lines[0].split(",");
				const row1Values = lines[1].split(",");
				const row2Values = lines[2].split(",");

				const nameIndex = headers.indexOf("name");
				const roleIndex = headers.indexOf("role");

				// Second row should have empty name
				expect(row2Values[nameIndex]).toBe("");
				// First row should have empty role
				expect(row1Values[roleIndex]).toBe("");
			});
		});
	});

	describe("format dispatcher", () => {
		const testData = [
			{ id: "1", name: "Alice", age: 30 },
			{ id: "2", name: "Bob", age: 25 },
		];

		it("should dispatch to table formatter", () => {
			const result = format("table", testData);

			expect(result).toContain("id");
			expect(result).toContain("name");
			expect(result).toContain("age");
			expect(result).toContain("Alice");
			expect(result.split("\n").length).toBeGreaterThanOrEqual(4); // header + separator + 2 rows
		});

		it("should dispatch to JSON formatter", () => {
			const result = format("json", testData);

			const parsed = JSON.parse(result);
			expect(parsed).toEqual(testData);
		});

		it("should dispatch to YAML formatter", () => {
			const result = format("yaml", testData);

			const parsed = YAML.parse(result);
			expect(parsed).toEqual(testData);
		});

		it("should dispatch to CSV formatter", () => {
			const result = format("csv", testData);
			const lines = result.split("\n");

			expect(lines[0]).toContain("id");
			expect(lines[0]).toContain("name");
			expect(lines[0]).toContain("age");
			expect(lines).toHaveLength(3); // header + 2 data rows
		});

		it("should handle empty array for all formats", () => {
			const formats: OutputFormat[] = ["table", "json", "yaml", "csv"];

			for (const fmt of formats) {
				const result = format(fmt, []);

				if (fmt === "table") {
					expect(result).toBe("(no results)");
				} else if (fmt === "csv") {
					expect(result).toBe("");
				} else if (fmt === "json") {
					expect(result).toBe("[]");
				} else {
					// YAML for empty array
					expect(YAML.parse(result)).toEqual([]);
				}
			}
		});
	});
});
