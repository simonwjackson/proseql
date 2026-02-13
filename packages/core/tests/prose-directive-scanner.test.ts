import { describe, expect, it } from "vitest";
import { scanDirective, type ScanDirectiveResult } from "../src/serializers/codecs/prose.js";

/**
 * Tests for prose directive scanner.
 * Task 7.4: first line, mid-file, missing directive error, multiple directives error, preamble preservation
 */

describe("scanDirective", () => {
	describe("directive on first line", () => {
		it("finds directive on first line with no preamble", () => {
			const lines = ['@prose #{id} "{title}"', "#1 Dune"];
			const result = scanDirective(lines);

			expect(result.preambleEnd).toBe(-1);
			expect(result.directiveStart).toBe(0);
		});

		it("finds directive on first line of single-line document", () => {
			const lines = ["@prose {name}"];
			const result = scanDirective(lines);

			expect(result.preambleEnd).toBe(-1);
			expect(result.directiveStart).toBe(0);
		});
	});

	describe("directive preceded by preamble", () => {
		it("finds directive after markdown heading", () => {
			const lines = [
				"# My Books",
				"",
				"A curated list.",
				"",
				'@prose #{id} "{title}"',
				"#1 Dune",
			];
			const result = scanDirective(lines);

			expect(result.preambleEnd).toBe(3);
			expect(result.directiveStart).toBe(4);
		});

		it("finds directive after single preamble line", () => {
			const lines = [
				"# Title",
				'@prose #{id} "{title}"',
				"#1 Dune",
			];
			const result = scanDirective(lines);

			expect(result.preambleEnd).toBe(0);
			expect(result.directiveStart).toBe(1);
		});

		it("finds directive after empty preamble lines", () => {
			const lines = [
				"",
				"",
				"@prose {name}",
				"Alice",
			];
			const result = scanDirective(lines);

			expect(result.preambleEnd).toBe(1);
			expect(result.directiveStart).toBe(2);
		});

		it("preserves all preamble lines before directive", () => {
			const lines = [
				"---",
				"title: My Collection",
				"date: 2024-01-01",
				"---",
				"",
				"# Introduction",
				"",
				"Some introductory text.",
				"",
				'@prose #{id} "{title}" ({year})',
				"#1 Dune (1965)",
			];
			const result = scanDirective(lines);

			// Preamble should be lines 0-8 (indices), directive at 9
			expect(result.preambleEnd).toBe(8);
			expect(result.directiveStart).toBe(9);
		});
	});

	describe("no directive found error", () => {
		it("throws error for empty document", () => {
			const lines: string[] = [];

			expect(() => scanDirective(lines)).toThrow(/No @prose directive found/);
		});

		it("throws error for document with no directive", () => {
			const lines = [
				"# My Books",
				"",
				"Just some text with no @prose directive.",
				"",
				"#1 This looks like a record but has no template",
			];

			expect(() => scanDirective(lines)).toThrow(/No @prose directive found/);
		});

		it("throws error when @prose is not at start of line", () => {
			const lines = [
				"# My Books",
				"The template is @prose #{id} but not at line start",
				"#1 Dune",
			];

			expect(() => scanDirective(lines)).toThrow(/No @prose directive found/);
		});

		it("throws error when @prose has no trailing space", () => {
			const lines = [
				"@prose", // Missing the required space
				"#1 Dune",
			];

			expect(() => scanDirective(lines)).toThrow(/No @prose directive found/);
		});

		it("error message mentions the required format", () => {
			try {
				scanDirective(["No directive here"]);
				expect.fail("Should have thrown");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain("@prose ");
			}
		});
	});

	describe("multiple directives error", () => {
		it("throws error for two directives", () => {
			const lines = [
				"@prose #{id} {name}",
				"#1 Alice",
				"",
				"@prose #{id} {title}",
				"#2 Bob",
			];

			expect(() => scanDirective(lines)).toThrow(/Multiple @prose directives/);
		});

		it("throws error for adjacent directives", () => {
			const lines = [
				"@prose {a}",
				"@prose {b}",
			];

			expect(() => scanDirective(lines)).toThrow(/Multiple @prose directives/);
		});

		it("error message includes line numbers", () => {
			const lines = [
				"# Preamble",
				"@prose {first}",
				"data",
				"@prose {second}",
			];

			try {
				scanDirective(lines);
				expect.fail("Should have thrown");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				const message = (error as Error).message;
				// Line numbers are 1-based in error messages
				expect(message).toContain("line 2");
				expect(message).toContain("line 4");
			}
		});

		it("error message states only one allowed", () => {
			const lines = [
				"@prose {a}",
				"@prose {b}",
			];

			try {
				scanDirective(lines);
				expect.fail("Should have thrown");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain("Only one directive");
			}
		});
	});

	describe("edge cases", () => {
		it("handles directive with complex template", () => {
			const lines = [
				'@prose #{id} "{title}" by {author} ({year}) — {genre}',
				"#1 Dune Frank Herbert (1965) — sci-fi",
			];
			const result = scanDirective(lines);

			expect(result.directiveStart).toBe(0);
		});

		it("handles directive followed by overflow declarations", () => {
			const lines = [
				"@prose #{id} {title}",
				"  tagged {tags}",
				"  ~ {description}",
				"",
				"#1 Dune",
			];
			const result = scanDirective(lines);

			expect(result.directiveStart).toBe(0);
		});

		it("handles lines that look like directives but are not", () => {
			const lines = [
				"@prose_note: This is not a directive",
				"@prose2 Neither is this",
				"@ prose Nor this (space after @)",
				"@prose {actual}",
			];
			const result = scanDirective(lines);

			expect(result.preambleEnd).toBe(2);
			expect(result.directiveStart).toBe(3);
		});

		it("handles whitespace before @prose (not a valid directive)", () => {
			const lines = [
				"  @prose {a}", // Indented - not at start of line
				"@prose {b}",
			];
			const result = scanDirective(lines);

			// Only the second line is a valid directive
			expect(result.preambleEnd).toBe(0);
			expect(result.directiveStart).toBe(1);
		});
	});
});
