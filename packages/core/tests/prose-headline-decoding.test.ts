import { describe, expect, it } from "vitest";
import {
	compileTemplate,
	decodeHeadline,
} from "../src/serializers/codecs/prose.js";

/**
 * Tests for prose headline decoding.
 * Task 4.4: matching line, non-matching line returns null, quoted fields,
 * escaped quotes, greedy last field
 */

describe("decodeHeadline", () => {
	describe("matching line", () => {
		it("decodes a simple record with string fields", () => {
			const template = compileTemplate('#{id} "{title}" by {author}');
			const line = '#1 "Dune" by Frank Herbert';

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				id: 1,
				title: "Dune",
				author: "Frank Herbert",
			});
		});

		it("decodes a record with number fields", () => {
			const template = compileTemplate("{title} ({year})");
			const line = "Dune (1965)";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				title: "Dune",
				year: 1965,
			});
		});

		it("decodes a record with boolean fields", () => {
			const template = compileTemplate("{name}: {active}");
			const line = "Feature: true";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				name: "Feature",
				active: true,
			});
		});

		it("decodes a record with null field (tilde)", () => {
			const template = compileTemplate("{title} by {author}");
			const line = "Untitled by ~";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				title: "Untitled",
				author: null,
			});
		});

		it("decodes a record with array field", () => {
			const template = compileTemplate("{title} tagged {tags}");
			const line = "Dune tagged [sci-fi, classic]";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				title: "Dune",
				tags: ["sci-fi", "classic"],
			});
		});

		it("decodes a record with mixed types", () => {
			const template = compileTemplate('#{id} "{title}" ({year}) - {genre}');
			const line = '#1 "Dune" (1965) - sci-fi';

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				id: 1,
				title: "Dune",
				year: 1965,
				genre: "sci-fi",
			});
		});

		it("handles template with leading literal only", () => {
			const template = compileTemplate("Book: {title}");
			const line = "Book: Dune";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				title: "Dune",
			});
		});

		it("handles template with trailing literal only", () => {
			const template = compileTemplate("{title} (end)");
			const line = "Dune (end)";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				title: "Dune",
			});
		});

		it("handles template with single field", () => {
			const template = compileTemplate("{name}");
			const line = "value";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				name: "value",
			});
		});

		it("handles null in middle of template", () => {
			const template = compileTemplate("{a} - {b} - {c}");
			const line = "first - ~ - last";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				a: "first",
				b: null,
				c: "last",
			});
		});

		it("handles multiple null fields", () => {
			const template = compileTemplate("{a} | {b} | {c}");
			const line = "~ | ~ | ~";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				a: null,
				b: null,
				c: null,
			});
		});
	});

	describe("non-matching line returns null", () => {
		it("returns null when leading literal does not match", () => {
			const template = compileTemplate("Book: {title}");
			const line = "Novel: Dune";

			expect(decodeHeadline(line, template)).toBeNull();
		});

		it("returns null when delimiter literal is not present", () => {
			const template = compileTemplate("{title} -> {author}");
			const line = "Dune | Frank Herbert";

			expect(decodeHeadline(line, template)).toBeNull();
		});

		it("returns null when trailing literal does not match", () => {
			const template = compileTemplate("{title} (end)");
			const line = "Dune [end]";

			expect(decodeHeadline(line, template)).toBeNull();
		});

		it("returns null when line is empty", () => {
			const template = compileTemplate("{title} by {author}");
			const line = "";

			expect(decodeHeadline(line, template)).toBeNull();
		});

		it("returns null when line is too short", () => {
			const template = compileTemplate("Book: {title} by {author}");
			const line = "Book:";

			expect(decodeHeadline(line, template)).toBeNull();
		});

		it("returns null when delimiter not found", () => {
			const template = compileTemplate("{title} -> {author}");
			const line = "Dune by Frank Herbert";

			expect(decodeHeadline(line, template)).toBeNull();
		});

		it("returns null when there is extra content after last field with trailing literal", () => {
			const template = compileTemplate("{title} (end)");
			const line = "Dune (end) extra";

			expect(decodeHeadline(line, template)).toBeNull();
		});

		it("returns null for completely different line structure", () => {
			const template = compileTemplate('#{id} "{title}" by {author}');
			const line = "This is just some random text";

			expect(decodeHeadline(line, template)).toBeNull();
		});

		it("returns null when markdown header does not match template", () => {
			const template = compileTemplate('#{id} "{title}" by {author}');
			const line = "## The Golden Age";

			expect(decodeHeadline(line, template)).toBeNull();
		});
	});

	describe("quoted fields", () => {
		it("decodes quoted value containing delimiter", () => {
			const template = compileTemplate("{title} by {author}");
			// The value "Written by Me" is quoted because it contains " by "
			const line = '"Written by Me" by Author Name';

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				title: "Written by Me",
				author: "Author Name",
			});
		});

		it("decodes quoted value with single-char delimiter", () => {
			const template = compileTemplate("{a}:{b}");
			const line = '"x:y":z';

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				a: "x:y",
				b: "z",
			});
		});

		it("decodes quoted value with multi-char delimiter", () => {
			const template = compileTemplate("{name} -> {value}");
			const line = '"a -> b -> c" -> result';

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				name: "a -> b -> c",
				value: "result",
			});
		});

		it("decodes multiple quoted fields", () => {
			const template = compileTemplate("{a} | {b} | {c}");
			const line = '"x | y" | "p | q" | m | n';

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				a: "x | y",
				b: "p | q",
				c: "m | n",
			});
		});

		it("decodes quoted array value", () => {
			const template = compileTemplate("{tags} - {name}");
			const line = '"[a - b, c]" - test';

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				tags: ["a - b", "c"],
				name: "test",
			});
		});
	});

	describe("escaped quotes", () => {
		it("decodes escaped quotes within quoted value", () => {
			const template = compileTemplate("{title} - {desc}");
			const line = '"Title - with \\"quotes\\"" - description';

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				title: 'Title - with "quotes"',
				desc: "description",
			});
		});

		it("decodes multiple escaped quotes", () => {
			const template = compileTemplate("{text} | {end}");
			const line = '"say \\"hello\\" and \\"goodbye\\"" | done';

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				text: 'say "hello" and "goodbye"',
				end: "done",
			});
		});

		it("decodes escaped quote at start of quoted value", () => {
			const template = compileTemplate("{value} - {rest}");
			const line = '"\\"quoted\\" - text" - end';

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				value: '"quoted" - text',
				rest: "end",
			});
		});

		it("decodes escaped quote at end of quoted value", () => {
			const template = compileTemplate("{value} - {rest}");
			const line = '"text - \\"quoted\\"" - end';

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				value: 'text - "quoted"',
				rest: "end",
			});
		});

		it("handles backslash that is not an escape sequence", () => {
			const template = compileTemplate("{path} -> {dest}");
			const line = '"C:\\Users -> folder" -> output';

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				path: "C:\\Users -> folder",
				dest: "output",
			});
		});
	});

	describe("greedy last field", () => {
		it("captures to end of line for last field", () => {
			const template = compileTemplate("{title} by {author}");
			const line = "Dune by Frank Herbert";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				title: "Dune",
				author: "Frank Herbert",
			});
		});

		it("captures delimiter text in last field without quoting", () => {
			const template = compileTemplate("{first} by {last}");
			// Last field contains the delimiter " by " but is captured greedily
			const line = "Start by End by Someone";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				first: "Start",
				last: "End by Someone",
			});
		});

		it("captures any text in single-field template", () => {
			const template = compileTemplate("{value}");
			const line = "anything: including delimiters -> here";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				value: "anything: including delimiters -> here",
			});
		});

		it("captures quotes in last field without escaping", () => {
			const template = compileTemplate("{title}: {description}");
			const line = 'Title: Say "hello" to the world';

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				title: "Title",
				description: 'Say "hello" to the world',
			});
		});

		it("captures array-like text in last field", () => {
			const template = compileTemplate("{name}: {data}");
			const line = "Items: [a, b, c]";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				name: "Items",
				data: ["a", "b", "c"],
			});
		});

		it("captures empty string as last field", () => {
			const template = compileTemplate("{title} - {note}");
			const line = "Dune - ";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				title: "Dune",
				note: "",
			});
		});

		it("captures multi-word last field", () => {
			const template = compileTemplate('#{id} "{title}"');
			const line = '#42 "The Long Way to a Small Angry Planet"';

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				id: 42,
				title: "The Long Way to a Small Angry Planet",
			});
		});
	});

	describe("round-trip encoding/decoding", () => {
		it("round-trips simple record", () => {
			const template = compileTemplate('#{id} "{title}" by {author}');
			const original = { id: 1, title: "Dune", author: "Frank Herbert" };

			// Import encodeHeadline for round-trip test
			const { encodeHeadline } = require("../src/serializers/codecs/prose.js");
			const encoded = encodeHeadline(original, template);
			const decoded = decodeHeadline(encoded, template);

			expect(decoded).toEqual(original);
		});

		it("round-trips record with delimiter in value", () => {
			const template = compileTemplate("{title} by {author}");
			const original = { title: "Written by Me", author: "Author Name" };

			const { encodeHeadline } = require("../src/serializers/codecs/prose.js");
			const encoded = encodeHeadline(original, template);
			const decoded = decodeHeadline(encoded, template);

			expect(decoded).toEqual(original);
		});

		it("round-trips record with quotes in value", () => {
			const template = compileTemplate("{title} - {desc}");
			const original = { title: 'Title - with "quotes"', desc: "description" };

			const { encodeHeadline } = require("../src/serializers/codecs/prose.js");
			const encoded = encodeHeadline(original, template);
			const decoded = decodeHeadline(encoded, template);

			expect(decoded).toEqual(original);
		});

		it("round-trips record with null values", () => {
			const template = compileTemplate("{a} | {b} | {c}");
			const original = { a: "first", b: null, c: "last" };

			const { encodeHeadline } = require("../src/serializers/codecs/prose.js");
			const encoded = encodeHeadline(original, template);
			const decoded = decodeHeadline(encoded, template);

			expect(decoded).toEqual(original);
		});

		it("round-trips record with array values", () => {
			const template = compileTemplate("{title} tagged {tags}");
			const original = { title: "Dune", tags: ["sci-fi", "classic"] };

			const { encodeHeadline } = require("../src/serializers/codecs/prose.js");
			const encoded = encodeHeadline(original, template);
			const decoded = decodeHeadline(encoded, template);

			expect(decoded).toEqual(original);
		});
	});

	describe("edge cases", () => {
		it("handles empty string field", () => {
			const template = compileTemplate("{title} - {note}");
			const line = "Dune - ";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				title: "Dune",
				note: "",
			});
		});

		it("handles template with no fields (literal only)", () => {
			const template = compileTemplate("static text");
			const line = "static text";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({});
		});

		it("returns null for literal-only template with non-matching line", () => {
			const template = compileTemplate("static text");
			const line = "other text";

			expect(decodeHeadline(line, template)).toBeNull();
		});

		it("handles special characters in literal text", () => {
			const template = compileTemplate("★ {title} © {year} ™");
			const line = "★ Dune © 1965 ™";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				title: "Dune",
				year: 1965,
			});
		});

		it("handles negative numbers", () => {
			const template = compileTemplate("{name}: {value}");
			const line = "temperature: -42";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				name: "temperature",
				value: -42,
			});
		});

		it("handles floating point numbers", () => {
			const template = compileTemplate("{name}: {value}");
			const line = "pi: 3.14159";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				name: "pi",
				value: 3.14159,
			});
		});

		it("handles negative floating point numbers", () => {
			const template = compileTemplate("{name}: {value}");
			const line = "temp: -273.15";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				name: "temp",
				value: -273.15,
			});
		});

		it("handles false boolean", () => {
			const template = compileTemplate("{name}: {active}");
			const line = "Feature: false";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				name: "Feature",
				active: false,
			});
		});

		it("handles empty array", () => {
			const template = compileTemplate("{title} tagged {tags}");
			const line = "Dune tagged []";

			const result = decodeHeadline(line, template);
			expect(result).toEqual({
				title: "Dune",
				tags: [],
			});
		});
	});
});
