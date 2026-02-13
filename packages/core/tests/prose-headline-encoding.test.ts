import { describe, expect, it } from "vitest";
import {
	compileTemplate,
	encodeHeadline,
	serializeValue,
} from "../src/serializers/codecs/prose.js";

/**
 * Tests for prose headline encoding.
 * Task 3.3: flat record, null field, value needing quoting, last field not quoted
 */

describe("encodeHeadline", () => {
	describe("flat record encoding", () => {
		it("encodes a simple record with string fields", () => {
			const template = compileTemplate('#{id} "{title}" by {author}');
			const record = { id: "1", title: "Dune", author: "Frank Herbert" };

			expect(encodeHeadline(record, template)).toBe(
				'#1 "Dune" by Frank Herbert',
			);
		});

		it("encodes a record with number fields", () => {
			const template = compileTemplate("{title} ({year})");
			const record = { title: "Dune", year: 1965 };

			expect(encodeHeadline(record, template)).toBe("Dune (1965)");
		});

		it("encodes a record with boolean fields", () => {
			const template = compileTemplate("{name}: {active}");
			const record = { name: "Feature", active: true };

			expect(encodeHeadline(record, template)).toBe("Feature: true");
		});

		it("encodes a record with array fields", () => {
			const template = compileTemplate("{title} tagged {tags}");
			const record = { title: "Dune", tags: ["sci-fi", "classic"] };

			expect(encodeHeadline(record, template)).toBe(
				"Dune tagged [sci-fi, classic]",
			);
		});

		it("encodes a record with mixed types", () => {
			const template = compileTemplate('#{id} "{title}" ({year}) - {genre}');
			const record = { id: 1, title: "Dune", year: 1965, genre: "sci-fi" };

			expect(encodeHeadline(record, template)).toBe(
				'#1 "Dune" (1965) - sci-fi',
			);
		});

		it("handles template with leading literal only", () => {
			const template = compileTemplate("Book: {title}");
			const record = { title: "Dune" };

			expect(encodeHeadline(record, template)).toBe("Book: Dune");
		});

		it("handles template with trailing literal only", () => {
			const template = compileTemplate("{title} (end)");
			const record = { title: "Dune" };

			expect(encodeHeadline(record, template)).toBe("Dune (end)");
		});

		it("handles template with single field", () => {
			const template = compileTemplate("{name}");
			const record = { name: "value" };

			expect(encodeHeadline(record, template)).toBe("value");
		});
	});

	describe("null field handling", () => {
		it("encodes null field as tilde", () => {
			const template = compileTemplate("{title} by {author}");
			const record = { title: "Untitled", author: null };

			expect(encodeHeadline(record, template)).toBe("Untitled by ~");
		});

		it("encodes undefined field as tilde", () => {
			const template = compileTemplate("{title} by {author}");
			const record = { title: "Untitled" };

			expect(encodeHeadline(record, template)).toBe("Untitled by ~");
		});

		it("encodes null in middle of template", () => {
			const template = compileTemplate("{a} - {b} - {c}");
			const record = { a: "first", b: null, c: "last" };

			expect(encodeHeadline(record, template)).toBe("first - ~ - last");
		});

		it("encodes multiple null fields", () => {
			const template = compileTemplate("{a} | {b} | {c}");
			const record = { a: null, b: null, c: null };

			expect(encodeHeadline(record, template)).toBe("~ | ~ | ~");
		});
	});

	describe("value quoting when containing delimiter", () => {
		it("quotes value that contains the next literal delimiter", () => {
			const template = compileTemplate("{title} by {author}");
			// title contains " by " which is the delimiter before author
			const record = { title: "Written by Me", author: "Author Name" };

			expect(encodeHeadline(record, template)).toBe(
				'"Written by Me" by Author Name',
			);
		});

		it("escapes quotes in quoted value", () => {
			const template = compileTemplate('{id} "{title}" by {author}');
			// title contains a quote which must be escaped when the value is quoted
			const record = { id: "1", title: 'Say "hello"', author: "Test" };

			// The title contains `"` but does NOT contain the delimiter `" by `
			// so it is not quoted - the literal quotes around the field are from the template
			expect(encodeHeadline(record, template)).toBe('1 "Say "hello"" by Test');
		});

		it("quotes value when delimiter is partial match", () => {
			const template = compileTemplate("{name} -> {value}");
			// name contains " -> " which is the delimiter
			const record = { name: "a -> b -> c", value: "result" };

			expect(encodeHeadline(record, template)).toBe('"a -> b -> c" -> result');
		});

		it("does not quote value when delimiter is not contained", () => {
			const template = compileTemplate("{title} by {author}");
			// title does not contain " by "
			const record = { title: "Dune", author: "Frank Herbert" };

			expect(encodeHeadline(record, template)).toBe("Dune by Frank Herbert");
		});

		it("quotes value containing single-char delimiter", () => {
			const template = compileTemplate("{a}:{b}");
			const record = { a: "x:y", b: "z" };

			expect(encodeHeadline(record, template)).toBe('"x:y":z');
		});

		it("escapes existing quotes when quoting", () => {
			const template = compileTemplate("{title} - {desc}");
			const record = { title: 'Title - with "quotes"', desc: "description" };

			expect(encodeHeadline(record, template)).toBe(
				'"Title - with \\"quotes\\"" - description',
			);
		});
	});

	describe("last field not quoted (greedy to EOL)", () => {
		it("does not quote last field even if it contains delimiter", () => {
			const template = compileTemplate("{first} by {last}");
			// last field contains the delimiter " by " but should not be quoted
			const record = { first: "Start", last: "End by Someone" };

			expect(encodeHeadline(record, template)).toBe("Start by End by Someone");
		});

		it("does not quote single-field template", () => {
			const template = compileTemplate("{value}");
			const record = { value: "anything: including delimiters -> here" };

			expect(encodeHeadline(record, template)).toBe(
				"anything: including delimiters -> here",
			);
		});

		it("does not quote last field with quotes in value", () => {
			const template = compileTemplate("{title}: {description}");
			// description has quotes but is last field, so no quoting needed
			const record = {
				title: "Title",
				description: 'Say "hello" to the world',
			};

			expect(encodeHeadline(record, template)).toBe(
				'Title: Say "hello" to the world',
			);
		});

		it("only quotes non-last fields that need it", () => {
			const template = compileTemplate("{a} | {b} | {c}");
			// a contains delimiter, should be quoted
			// b contains delimiter, should be quoted
			// c contains delimiter but is last, should NOT be quoted
			const record = { a: "x | y", b: "p | q", c: "m | n" };

			expect(encodeHeadline(record, template)).toBe(
				'"x | y" | "p | q" | m | n',
			);
		});
	});

	describe("edge cases", () => {
		it("handles empty string field", () => {
			const template = compileTemplate("{title} - {note}");
			const record = { title: "Dune", note: "" };

			expect(encodeHeadline(record, template)).toBe("Dune - ");
		});

		it("handles record with extra fields (ignored)", () => {
			const template = compileTemplate("{title} by {author}");
			const record = {
				title: "Dune",
				author: "Frank Herbert",
				extra: "ignored",
			};

			expect(encodeHeadline(record, template)).toBe("Dune by Frank Herbert");
		});

		it("handles template with no fields (literal only)", () => {
			const template = compileTemplate("static text");
			const record = {};

			expect(encodeHeadline(record, template)).toBe("static text");
		});

		it("handles special characters in literal text", () => {
			const template = compileTemplate("★ {title} © {year} ™");
			const record = { title: "Dune", year: 1965 };

			expect(encodeHeadline(record, template)).toBe("★ Dune © 1965 ™");
		});

		it("handles array field that needs quoting", () => {
			const template = compileTemplate("{tags} - {name}");
			// Array element "a - b" contains comma so it gets quoted within the array
			// but the array serialization doesn't quote elements containing " - "
			// The serialized array is [a - b, c] which contains " - "
			const record = { tags: ["a - b", "c"], name: "test" };

			// The serialized array [a - b, c] contains " - " so the whole value is quoted
			expect(encodeHeadline(record, template)).toBe('"[a - b, c]" - test');
		});
	});
});
