import { describe, expect, it } from "vitest";
import {
	type CompiledTemplate,
	compileOverflowTemplates,
	compileTemplate,
	type ProseSegment,
} from "../src/serializers/codecs/prose.js";

/**
 * Tests for prose template compilation.
 * Task 1.5: simple template, leading literal, trailing literal, adjacent fields error, unclosed brace error
 */

describe("compileTemplate", () => {
	describe("simple template parsing", () => {
		it("parses a simple template with field placeholders", () => {
			const result = compileTemplate('#{id} "{title}" by {author}');

			expect(result.fields).toEqual(["id", "title", "author"]);
			expect(result.segments).toEqual([
				{ type: "literal", text: "#" },
				{ type: "field", name: "id" },
				{ type: "literal", text: ' "' },
				{ type: "field", name: "title" },
				{ type: "literal", text: '" by ' },
				{ type: "field", name: "author" },
			]);
		});

		it("parses template with single field", () => {
			const result = compileTemplate("{name}");

			expect(result.fields).toEqual(["name"]);
			expect(result.segments).toEqual([{ type: "field", name: "name" }]);
		});

		it("parses template with multiple fields separated by literals", () => {
			const result = compileTemplate("{first} - {second} - {third}");

			expect(result.fields).toEqual(["first", "second", "third"]);
			expect(result.segments).toEqual([
				{ type: "field", name: "first" },
				{ type: "literal", text: " - " },
				{ type: "field", name: "second" },
				{ type: "literal", text: " - " },
				{ type: "field", name: "third" },
			]);
		});
	});

	describe("leading literal", () => {
		it("handles template starting with literal text", () => {
			const result = compileTemplate("Book: {title}");

			expect(result.fields).toEqual(["title"]);
			expect(result.segments).toEqual([
				{ type: "literal", text: "Book: " },
				{ type: "field", name: "title" },
			]);
		});

		it("handles template with longer leading literal", () => {
			const result = compileTemplate("The book titled {title} is available");

			expect(result.fields).toEqual(["title"]);
			expect(result.segments).toEqual([
				{ type: "literal", text: "The book titled " },
				{ type: "field", name: "title" },
				{ type: "literal", text: " is available" },
			]);
		});
	});

	describe("trailing literal", () => {
		it("handles template ending with literal text", () => {
			const result = compileTemplate("{title} (end)");

			expect(result.fields).toEqual(["title"]);
			expect(result.segments).toEqual([
				{ type: "field", name: "title" },
				{ type: "literal", text: " (end)" },
			]);
		});

		it("handles template with both leading and trailing literals", () => {
			const result = compileTemplate("[{id}]");

			expect(result.fields).toEqual(["id"]);
			expect(result.segments).toEqual([
				{ type: "literal", text: "[" },
				{ type: "field", name: "id" },
				{ type: "literal", text: "]" },
			]);
		});
	});

	describe("adjacent fields error", () => {
		it("throws error for adjacent fields with no separator", () => {
			expect(() => compileTemplate("{first}{second}")).toThrow(
				/Adjacent fields with no literal separator/,
			);
		});

		it("throws error for multiple adjacent fields", () => {
			expect(() => compileTemplate("{a}{b}{c}")).toThrow(
				/Adjacent fields with no literal separator/,
			);
		});

		it("throws error for adjacent fields after literal", () => {
			expect(() => compileTemplate("prefix {a}{b}")).toThrow(
				/Adjacent fields with no literal separator/,
			);
		});

		it("includes position in error message", () => {
			try {
				compileTemplate("{first}{second}");
				expect.fail("Should have thrown");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain("position");
			}
		});
	});

	describe("unclosed brace error", () => {
		it("throws error for unclosed opening brace", () => {
			expect(() => compileTemplate("{title")).toThrow(/Unclosed brace/);
		});

		it("throws error for unclosed brace mid-template", () => {
			expect(() => compileTemplate("Book: {title by author")).toThrow(
				/Unclosed brace/,
			);
		});

		it("throws error for multiple unclosed braces", () => {
			expect(() => compileTemplate("{first {second")).toThrow(/Unclosed brace/);
		});

		it("includes position in error message", () => {
			try {
				compileTemplate("prefix {unclosed");
				expect.fail("Should have thrown");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain("position");
			}
		});
	});

	describe("empty field name error", () => {
		it("throws error for empty field name", () => {
			expect(() => compileTemplate("{}")).toThrow(/Empty field name/);
		});

		it("throws error for empty field name with surrounding text", () => {
			expect(() => compileTemplate("prefix {} suffix")).toThrow(
				/Empty field name/,
			);
		});
	});

	describe("edge cases", () => {
		it("handles literal-only template (no fields)", () => {
			const result = compileTemplate("just literal text");

			expect(result.fields).toEqual([]);
			expect(result.segments).toEqual([
				{ type: "literal", text: "just literal text" },
			]);
		});

		it("handles empty template", () => {
			const result = compileTemplate("");

			expect(result.fields).toEqual([]);
			expect(result.segments).toEqual([]);
		});

		it("handles field names with underscores", () => {
			const result = compileTemplate("{first_name} {last_name}");

			expect(result.fields).toEqual(["first_name", "last_name"]);
		});

		it("handles field names with numbers", () => {
			const result = compileTemplate("{field1} {field2}");

			expect(result.fields).toEqual(["field1", "field2"]);
		});

		it("handles special characters in literal text", () => {
			const result = compileTemplate('#{id} ★ "{title}" © {year}');

			expect(result.fields).toEqual(["id", "title", "year"]);
			expect(result.segments[2]).toEqual({ type: "literal", text: ' ★ "' });
			expect(result.segments[4]).toEqual({ type: "literal", text: '" © ' });
		});

		it("closing brace in literal text is not treated as field end", () => {
			// A closing brace not preceded by an opening brace is literal text
			const result = compileTemplate("value} {field}");

			expect(result.fields).toEqual(["field"]);
			expect(result.segments).toEqual([
				{ type: "literal", text: "value} " },
				{ type: "field", name: "field" },
			]);
		});
	});
});

describe("compileOverflowTemplates", () => {
	it("returns empty array for undefined overflow", () => {
		const result = compileOverflowTemplates(undefined);
		expect(result).toEqual([]);
	});

	it("returns empty array for empty overflow array", () => {
		const result = compileOverflowTemplates([]);
		expect(result).toEqual([]);
	});

	it("compiles single overflow template", () => {
		const result = compileOverflowTemplates(["tagged {tags}"]);

		expect(result).toHaveLength(1);
		expect(result[0].fields).toEqual(["tags"]);
		expect(result[0].segments).toEqual([
			{ type: "literal", text: "tagged " },
			{ type: "field", name: "tags" },
		]);
	});

	it("compiles multiple overflow templates", () => {
		const result = compileOverflowTemplates([
			"tagged {tags}",
			"~ {description}",
		]);

		expect(result).toHaveLength(2);
		expect(result[0].fields).toEqual(["tags"]);
		expect(result[1].fields).toEqual(["description"]);
	});

	it("throws with index in error message for invalid template", () => {
		expect(() =>
			compileOverflowTemplates(["valid {field}", "invalid {", "another {ok}"]),
		).toThrow(/overflow template at index 1/);
	});

	it("throws with index for adjacent fields error in overflow", () => {
		expect(() => compileOverflowTemplates(["{a}{b}"])).toThrow(
			/overflow template at index 0/,
		);
	});

	it("preserves template order in output", () => {
		const templates = ["first: {a}", "second: {b}", "third: {c}"];
		const result = compileOverflowTemplates(templates);

		expect(result).toHaveLength(3);
		expect(result[0].fields[0]).toBe("a");
		expect(result[1].fields[0]).toBe("b");
		expect(result[2].fields[0]).toBe("c");
	});
});
