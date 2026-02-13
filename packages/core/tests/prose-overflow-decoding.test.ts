import { describe, expect, it } from "vitest";
import {
	compileOverflowTemplates,
	decodeOverflowLines,
} from "../src/serializers/codecs/prose.js";

/**
 * Tests for prose overflow decoding.
 * Task 6.3: fields in order, skipped field is null, no overflow lines,
 * multi-line continuation, continuation line that looks like a template but is deeper-indented
 */

describe("decodeOverflowLines", () => {
	describe("fields in order", () => {
		it("decodes a single overflow field", () => {
			const templates = compileOverflowTemplates(["tagged {tags}"]);
			const lines = ["  tagged sci-fi"];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({ tags: "sci-fi" });
			expect(result.linesConsumed).toBe(1);
		});

		it("decodes a single overflow field with array value", () => {
			const templates = compileOverflowTemplates(["tagged {tags}"]);
			const lines = ["  tagged [sci-fi, classic]"];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({ tags: ["sci-fi", "classic"] });
			expect(result.linesConsumed).toBe(1);
		});

		it("decodes multiple overflow fields in template order", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
			]);
			const lines = ["  tagged [sci-fi]", "  ~ A classic novel"];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				tags: ["sci-fi"],
				description: "A classic novel",
			});
			expect(result.linesConsumed).toBe(2);
		});

		it("decodes three overflow fields in order", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
				"notes: {notes}",
			]);
			const lines = [
				"  tagged [sci-fi, classic]",
				"  ~ Epic space opera",
				"  notes: Must read",
			];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				tags: ["sci-fi", "classic"],
				description: "Epic space opera",
				notes: "Must read",
			});
			expect(result.linesConsumed).toBe(3);
		});

		it("decodes overflow fields with different value types", () => {
			const templates = compileOverflowTemplates([
				"count: {count}",
				"active: {active}",
				"label: {label}",
			]);
			const lines = ["  count: 42", "  active: false", "  label: test-item"];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				count: 42,
				active: false,
				label: "test-item",
			});
			expect(result.linesConsumed).toBe(3);
		});

		it("decodes overflow with null value (~)", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const lines = ["  ~ ~"];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({ description: null });
			expect(result.linesConsumed).toBe(1);
		});

		it("decodes overflow with boolean values", () => {
			const templates = compileOverflowTemplates([
				"available: {available}",
				"featured: {featured}",
			]);
			const lines = ["  available: true", "  featured: false"];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				available: true,
				featured: false,
			});
			expect(result.linesConsumed).toBe(2);
		});

		it("decodes overflow with number values", () => {
			const templates = compileOverflowTemplates([
				"pages: {pages}",
				"rating: {rating}",
			]);
			const lines = ["  pages: 412", "  rating: 4.5"];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				pages: 412,
				rating: 4.5,
			});
			expect(result.linesConsumed).toBe(2);
		});
	});

	describe("skipped field is null (not present)", () => {
		it("returns empty fields when first template does not match", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
			]);
			// Only second template matches
			const lines = ["  ~ A description"];

			const result = decodeOverflowLines(lines, templates);

			// First template (tags) was skipped, so no tags field is set
			// Second template matched
			expect(result.fields).toEqual({ description: "A description" });
			expect(result.linesConsumed).toBe(1);
		});

		it("returns empty fields when middle template does not match", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
				"notes: {notes}",
			]);
			// First and third template match, middle is skipped
			const lines = ["  tagged [sci-fi]", "  notes: Must read"];

			const result = decodeOverflowLines(lines, templates);

			// Middle template (description) was skipped - no description field
			expect(result.fields).toEqual({
				tags: ["sci-fi"],
				notes: "Must read",
			});
			expect(result.linesConsumed).toBe(2);
		});

		it("returns empty fields when last template does not match", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
			]);
			// Only first template matches
			const lines = ["  tagged [classic]"];

			const result = decodeOverflowLines(lines, templates);

			// Second template (description) was not present
			expect(result.fields).toEqual({ tags: ["classic"] });
			expect(result.linesConsumed).toBe(1);
		});

		it("matches templates out of order (tries all templates for each line)", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
			]);
			// Second template first, then first template
			const lines = ["  ~ A description", "  tagged [sci-fi]"];

			const result = decodeOverflowLines(lines, templates);

			// Both templates should match
			expect(result.fields).toEqual({
				description: "A description",
				tags: ["sci-fi"],
			});
			expect(result.linesConsumed).toBe(2);
		});
	});

	describe("no overflow lines", () => {
		it("returns empty fields when lines array is empty", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
			]);
			const lines: string[] = [];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({});
			expect(result.linesConsumed).toBe(0);
		});

		it("returns empty fields when no templates defined", () => {
			const templates = compileOverflowTemplates([]);
			const lines = ["  tagged [sci-fi]"];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({});
			// No templates to match, but we still try to process lines
			expect(result.linesConsumed).toBe(1);
		});

		it("returns empty fields when templates undefined", () => {
			const templates = compileOverflowTemplates(undefined);
			const lines = ["  tagged [sci-fi]"];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({});
			// Lines are consumed even without templates
			expect(result.linesConsumed).toBe(1);
		});

		it("stops consuming when line is not indented enough", () => {
			const templates = compileOverflowTemplates(["tagged {tags}"]);
			// First line is indented, second is not
			const lines = ["  tagged [sci-fi]", "not indented"];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({ tags: ["sci-fi"] });
			// Only first line consumed
			expect(result.linesConsumed).toBe(1);
		});

		it("stops consuming when encountering a headline (no indent)", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const lines = ["  ~ First record description", "#2 Next headline"];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				description: "First record description",
			});
			expect(result.linesConsumed).toBe(1);
		});
	});

	describe("multi-line continuation", () => {
		it("decodes multi-line value with one continuation line", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const lines = ["  ~ First line", "    Second line"];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({ description: "First line\nSecond line" });
			expect(result.linesConsumed).toBe(2);
		});

		it("decodes multi-line value with multiple continuation lines", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const lines = [
				"  ~ First line",
				"    Second line",
				"    Third line",
				"    Fourth line",
			];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				description: "First line\nSecond line\nThird line\nFourth line",
			});
			expect(result.linesConsumed).toBe(4);
		});

		it("decodes multi-line value with empty continuation line", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const lines = ["  ~ First line", "    ", "    Third line"];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				description: "First line\n\nThird line",
			});
			expect(result.linesConsumed).toBe(3);
		});

		it("decodes continuation then another overflow template", () => {
			const templates = compileOverflowTemplates([
				"~ {description}",
				"notes: {notes}",
			]);
			const lines = [
				"  ~ First line",
				"    Second line",
				"  notes: A simple note",
			];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				description: "First line\nSecond line",
				notes: "A simple note",
			});
			expect(result.linesConsumed).toBe(3);
		});

		it("decodes multiple overflow fields each with continuation", () => {
			const templates = compileOverflowTemplates([
				"~ {description}",
				"notes: {notes}",
			]);
			const lines = [
				"  ~ First line of description",
				"    Second line of description",
				"  notes: First line of notes",
				"    Second line of notes",
			];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				description: "First line of description\nSecond line of description",
				notes: "First line of notes\nSecond line of notes",
			});
			expect(result.linesConsumed).toBe(4);
		});

		it("handles continuation line with different indentation depth", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			// Continuation with 6 spaces instead of 4 (still deeper than base 2)
			const lines = ["  ~ First line", "      Deeply indented"];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				description: "First line\nDeeply indented",
			});
			expect(result.linesConsumed).toBe(2);
		});
	});

	describe("continuation line that looks like a template but is deeper-indented", () => {
		it("treats deeper-indented template-like line as continuation", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
			]);
			// The line "    tagged something" looks like it could match "tagged {tags}"
			// but it's indented deeper (4 spaces vs 2), so it's a continuation
			const lines = [
				"  ~ First line",
				"    tagged something", // This should be continuation, not a new template match
			];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				description: "First line\ntagged something",
			});
			expect(result.linesConsumed).toBe(2);
		});

		it("treats deeper-indented line starting with ~ as continuation", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			// The line "    ~ more text" looks like it could match "~ {description}"
			// but it's indented deeper, so it's a continuation
			const lines = [
				"  ~ First line",
				"    ~ more text that happens to start with tilde",
			];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				description: "First line\n~ more text that happens to start with tilde",
			});
			expect(result.linesConsumed).toBe(2);
		});

		it("distinguishes between continuation and actual template match at same indent", () => {
			const templates = compileOverflowTemplates([
				"~ {description}",
				"notes: {notes}",
			]);
			// "  notes: something" at base indent should match the notes template
			// not be treated as continuation
			const lines = [
				"  ~ Description text",
				"  notes: This is a note", // Same indent as first line = new template
			];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				description: "Description text",
				notes: "This is a note",
			});
			expect(result.linesConsumed).toBe(2);
		});

		it("handles code block style continuation with template-like content", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			// A code block containing what looks like overflow templates
			const lines = [
				"  ~ Here is some code:",
				"    tagged {tags}", // Looks like a template but is continuation
				"    ~ {other}", // Looks like a template but is continuation
				"    notes: {notes}", // Looks like a template but is continuation
			];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				description:
					"Here is some code:\ntagged {tags}\n~ {other}\nnotes: {notes}",
			});
			expect(result.linesConsumed).toBe(4);
		});

		it("multiple templates with interleaved continuations", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
			]);
			const lines = [
				"  tagged [sci-fi]",
				"  ~ First line",
				"    tagged [this is NOT a tag match, it's continuation text]",
				"    more continuation",
			];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({
				tags: ["sci-fi"],
				description:
					"First line\ntagged [this is NOT a tag match, it's continuation text]\nmore continuation",
			});
			expect(result.linesConsumed).toBe(4);
		});
	});

	describe("custom base indent", () => {
		it("respects custom base indent of 4", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const lines = ["    ~ A description"]; // 4 spaces

			const result = decodeOverflowLines(lines, templates, 4);

			expect(result.fields).toEqual({ description: "A description" });
			expect(result.linesConsumed).toBe(1);
		});

		it("continuation with custom base indent", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const lines = [
				"    ~ First line", // 4 spaces (base)
				"      Second line", // 6 spaces (continuation)
			];

			const result = decodeOverflowLines(lines, templates, 4);

			expect(result.fields).toEqual({
				description: "First line\nSecond line",
			});
			expect(result.linesConsumed).toBe(2);
		});

		it("stops when line has less than custom base indent", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const lines = [
				"    ~ First line", // 4 spaces (base)
				"  ~ Second line", // 2 spaces (less than base, stops)
			];

			const result = decodeOverflowLines(lines, templates, 4);

			expect(result.fields).toEqual({ description: "First line" });
			expect(result.linesConsumed).toBe(1);
		});
	});

	describe("edge cases", () => {
		it("handles line with only whitespace", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const lines = ["  ~ First line", "    ", "    Third line"];

			const result = decodeOverflowLines(lines, templates);

			// Empty continuation line should still be captured
			expect(result.fields).toEqual({
				description: "First line\n\nThird line",
			});
			expect(result.linesConsumed).toBe(3);
		});

		it("handles empty string field value", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const lines = ["  ~ "];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({ description: "" });
			expect(result.linesConsumed).toBe(1);
		});

		it("handles overflow template with multiple fields", () => {
			const templates = compileOverflowTemplates(["meta: {count} / {total}"]);
			const lines = ["  meta: 5 / 10"];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({ count: 5, total: 10 });
			expect(result.linesConsumed).toBe(1);
		});

		it("handles lines that do not match any template", () => {
			const templates = compileOverflowTemplates(["tagged {tags}"]);
			const lines = ["  something completely different"];

			const result = decodeOverflowLines(lines, templates);

			// No match, but line is still consumed
			expect(result.fields).toEqual({});
			expect(result.linesConsumed).toBe(1);
		});

		it("handles tabs as indentation", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const lines = ["\t\t~ A description"]; // 2 tabs

			const result = decodeOverflowLines(lines, templates, 2);

			expect(result.fields).toEqual({ description: "A description" });
			expect(result.linesConsumed).toBe(1);
		});

		it("handles mixed spaces and tabs", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const lines = [" \t~ A description"]; // 1 space + 1 tab = 2 whitespace chars

			const result = decodeOverflowLines(lines, templates, 2);

			expect(result.fields).toEqual({ description: "A description" });
			expect(result.linesConsumed).toBe(1);
		});

		it("handles array with quoted elements in overflow", () => {
			const templates = compileOverflowTemplates(["tagged {tags}"]);
			const lines = ['  tagged [sci-fi, "has, comma"]'];

			const result = decodeOverflowLines(lines, templates);

			expect(result.fields).toEqual({ tags: ["sci-fi", "has, comma"] });
			expect(result.linesConsumed).toBe(1);
		});

		it("round-trip consistency: encode then decode", () => {
			// This test ensures that what we encode can be decoded back
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
			]);
			const originalFields = {
				tags: ["sci-fi", "classic"],
				description: "A multi-line\ndescription here",
			};

			// We can't use encodeOverflowLines directly here since we're testing decode,
			// but we can construct what encode would produce:
			const encodedLines = [
				"  tagged [sci-fi, classic]",
				"  ~ A multi-line",
				"    description here",
			];

			const result = decodeOverflowLines(encodedLines, templates);

			expect(result.fields).toEqual(originalFields);
			expect(result.linesConsumed).toBe(3);
		});
	});
});
