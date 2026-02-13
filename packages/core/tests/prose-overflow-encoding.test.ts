import { describe, expect, it } from "vitest";
import {
	compileOverflowTemplates,
	encodeOverflowLines,
} from "../src/serializers/codecs/prose.js";

/**
 * Tests for prose overflow encoding.
 * Task 5.3: single overflow field, multiple overflow fields, null overflow omitted, multi-line value continuation
 */

describe("encodeOverflowLines", () => {
	describe("single overflow field", () => {
		it("encodes a single overflow field with string value", () => {
			const templates = compileOverflowTemplates(["tagged {tags}"]);
			const record = { id: "1", title: "Dune", tags: "sci-fi" };

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual(["  tagged sci-fi"]);
		});

		it("encodes a single overflow field with array value", () => {
			const templates = compileOverflowTemplates(["tagged {tags}"]);
			const record = { id: "1", title: "Dune", tags: ["sci-fi", "classic"] };

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual(["  tagged [sci-fi, classic]"]);
		});

		it("encodes a single overflow field with number value", () => {
			const templates = compileOverflowTemplates(["pages: {pageCount}"]);
			const record = { id: "1", title: "Dune", pageCount: 412 };

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual(["  pages: 412"]);
		});

		it("encodes a single overflow field with boolean value", () => {
			const templates = compileOverflowTemplates(["available: {inStock}"]);
			const record = { id: "1", title: "Dune", inStock: true };

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual(["  available: true"]);
		});

		it("encodes overflow with prefix-style template", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const record = { id: "1", description: "A science fiction masterpiece" };

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual(["  ~ A science fiction masterpiece"]);
		});
	});

	describe("multiple overflow fields", () => {
		it("encodes multiple overflow fields in template order", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
			]);
			const record = {
				id: "1",
				title: "Dune",
				tags: ["sci-fi"],
				description: "Epic space opera",
			};

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual(["  tagged [sci-fi]", "  ~ Epic space opera"]);
		});

		it("encodes three overflow fields", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
				"notes: {notes}",
			]);
			const record = {
				id: "1",
				title: "Dune",
				tags: ["sci-fi", "classic"],
				description: "Epic space opera",
				notes: "Must read",
			};

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual([
				"  tagged [sci-fi, classic]",
				"  ~ Epic space opera",
				"  notes: Must read",
			]);
		});

		it("encodes overflow fields with different value types", () => {
			const templates = compileOverflowTemplates([
				"count: {count}",
				"active: {active}",
				"label: {label}",
			]);
			const record = {
				id: "1",
				count: 42,
				active: false,
				label: "test-item",
			};

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual([
				"  count: 42",
				"  active: false",
				"  label: test-item",
			]);
		});
	});

	describe("null overflow omitted", () => {
		it("omits overflow line when field value is null", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
			]);
			const record = {
				id: "1",
				title: "Dune",
				tags: ["sci-fi"],
				description: null,
			};

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual(["  tagged [sci-fi]"]);
		});

		it("omits overflow line when field value is undefined", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
			]);
			const record = {
				id: "1",
				title: "Dune",
				tags: ["sci-fi"],
				// description is undefined
			};

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual(["  tagged [sci-fi]"]);
		});

		it("omits all overflow lines when all fields are null", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
			]);
			const record = {
				id: "1",
				title: "Dune",
				tags: null,
				description: null,
			};

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual([]);
		});

		it("omits first overflow but keeps second", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
			]);
			const record = {
				id: "1",
				title: "Dune",
				tags: null,
				description: "A classic novel",
			};

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual(["  ~ A classic novel"]);
		});

		it("omits middle overflow in a sequence", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
				"notes: {notes}",
			]);
			const record = {
				id: "1",
				title: "Dune",
				tags: ["sci-fi"],
				description: null,
				notes: "Must read",
			};

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual(["  tagged [sci-fi]", "  notes: Must read"]);
		});
	});

	describe("multi-line value continuation", () => {
		it("encodes multi-line value with continuation lines", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const record = {
				id: "1",
				title: "Dune",
				description: "Line one\nLine two",
			};

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual(["  ~ Line one", "    Line two"]);
		});

		it("encodes multi-line value with three lines", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const record = {
				id: "1",
				title: "Dune",
				description: "First line\nSecond line\nThird line",
			};

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual([
				"  ~ First line",
				"    Second line",
				"    Third line",
			]);
		});

		it("encodes multi-line value with empty continuation lines", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const record = {
				id: "1",
				title: "Dune",
				description: "Line one\n\nLine three",
			};

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual(["  ~ Line one", "    ", "    Line three"]);
		});

		it("handles multi-line with trailing newline", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const record = {
				id: "1",
				title: "Dune",
				description: "Line one\nLine two\n",
			};

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual(["  ~ Line one", "    Line two", "    "]);
		});

		it("handles single-line value (no continuation)", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const record = {
				id: "1",
				title: "Dune",
				description: "Single line with no newlines",
			};

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual(["  ~ Single line with no newlines"]);
		});

		it("multi-line combined with single-line overflow", () => {
			const templates = compileOverflowTemplates([
				"tagged {tags}",
				"~ {description}",
			]);
			const record = {
				id: "1",
				title: "Dune",
				tags: ["sci-fi"],
				description: "First line\nSecond line",
			};

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual([
				"  tagged [sci-fi]",
				"  ~ First line",
				"    Second line",
			]);
		});

		it("multi-line in first overflow, single-line in second", () => {
			const templates = compileOverflowTemplates([
				"~ {description}",
				"notes: {notes}",
			]);
			const record = {
				id: "1",
				description: "Line one\nLine two",
				notes: "Simple note",
			};

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual([
				"  ~ Line one",
				"    Line two",
				"  notes: Simple note",
			]);
		});
	});

	describe("edge cases", () => {
		it("returns empty array when no overflow templates", () => {
			const templates = compileOverflowTemplates([]);
			const record = { id: "1", title: "Dune", tags: ["sci-fi"] };

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual([]);
		});

		it("returns empty array when overflow templates undefined", () => {
			const templates = compileOverflowTemplates(undefined);
			const record = { id: "1", title: "Dune", tags: ["sci-fi"] };

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual([]);
		});

		it("handles empty string field value (not omitted)", () => {
			const templates = compileOverflowTemplates(["~ {description}"]);
			const record = { id: "1", title: "Dune", description: "" };

			const lines = encodeOverflowLines(record, templates);

			// Empty string is not null/undefined, so it should be emitted
			expect(lines).toEqual(["  ~ "]);
		});

		it("handles field with value false (not omitted)", () => {
			const templates = compileOverflowTemplates(["enabled: {enabled}"]);
			const record = { id: "1", enabled: false };

			const lines = encodeOverflowLines(record, templates);

			// false is not null/undefined, so it should be emitted
			expect(lines).toEqual(["  enabled: false"]);
		});

		it("handles field with value 0 (not omitted)", () => {
			const templates = compileOverflowTemplates(["count: {count}"]);
			const record = { id: "1", count: 0 };

			const lines = encodeOverflowLines(record, templates);

			// 0 is not null/undefined, so it should be emitted
			expect(lines).toEqual(["  count: 0"]);
		});

		it("handles overflow template with multiple fields in one line", () => {
			const templates = compileOverflowTemplates(["meta: {count} / {total}"]);
			const record = { id: "1", count: 5, total: 10 };

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual(["  meta: 5 / 10"]);
		});

		it("omits overflow when one of multiple fields is null (partial nullity)", () => {
			const templates = compileOverflowTemplates(["meta: {count} / {total}"]);
			const record = { id: "1", count: 5, total: null };

			const lines = encodeOverflowLines(record, templates);

			// If count is non-null, the line should be emitted with total as ~
			expect(lines).toEqual(["  meta: 5 / ~"]);
		});

		it("omits overflow when all fields in template are null", () => {
			const templates = compileOverflowTemplates(["meta: {count} / {total}"]);
			const record = { id: "1", count: null, total: null };

			const lines = encodeOverflowLines(record, templates);

			expect(lines).toEqual([]);
		});
	});
});
