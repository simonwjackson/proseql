import { describe, it, expect } from "vitest";
import { Effect, Stream, Chunk } from "effect";
import { applySelect, applySelectToArray } from "../src/operations/query/select-stream";
import { applyObjectSelection } from "../src/operations/query/select";
import { resolveComputedFields } from "../src/operations/query/resolve-computed";
import type { ComputedFieldsConfig } from "../src/types/computed-types";

/**
 * Task 5.1-5.5: Verify that selectFields/applyObjectSelection works on entities with computed fields attached.
 *
 * The select functions use dynamic property access (`key in item` and `item[key]`),
 * which handles arbitrary keys including computed field keys. These tests confirm
 * that selecting computed fields works correctly.
 */

// Test data: books with stored fields
interface StoredBook {
	readonly id: string;
	readonly title: string;
	readonly year: number;
	readonly genre: string;
}

// Computed fields config
const computedConfig = {
	displayName: (book: StoredBook) => `${book.title} (${book.year})`,
	isClassic: (book: StoredBook) => book.year < 1980,
	yearsSincePublication: (book: StoredBook) => 2024 - book.year,
} as const satisfies ComputedFieldsConfig<StoredBook>;

// Type for book with computed fields
type BookWithComputed = StoredBook & {
	readonly displayName: string;
	readonly isClassic: boolean;
	readonly yearsSincePublication: number;
};

// Raw test data
const storedBooks: readonly StoredBook[] = [
	{ id: "1", title: "Dune", year: 1965, genre: "sci-fi" },
	{ id: "2", title: "Neuromancer", year: 1984, genre: "sci-fi" },
	{ id: "3", title: "The Left Hand of Darkness", year: 1969, genre: "sci-fi" },
	{ id: "4", title: "Project Hail Mary", year: 2021, genre: "sci-fi" },
	{ id: "5", title: "Snow Crash", year: 1992, genre: "sci-fi" },
];

// Books with computed fields resolved
const booksWithComputed: readonly BookWithComputed[] = storedBooks.map((book) =>
	resolveComputedFields(book, computedConfig),
);

// Helper to collect selected stream
const collectSelected = <T extends Record<string, unknown>>(
	data: readonly T[],
	select: Record<string, unknown> | ReadonlyArray<string> | undefined,
): Promise<readonly T[]> =>
	Effect.runPromise(
		Stream.fromIterable(data).pipe(
			applySelect<T>(select),
			Stream.runCollect,
			Effect.map(Chunk.toReadonlyArray),
		),
	);

describe("selectFields with computed fields", () => {
	describe("Task 5.1: Verify applyObjectSelection handles computed field keys via dynamic property access", () => {
		it("should select a computed field using applyObjectSelection", () => {
			// Direct call to applyObjectSelection
			const result = applyObjectSelection(
				booksWithComputed[0] as Record<string, unknown>,
				{ displayName: true },
			);

			expect(result).toEqual({ displayName: "Dune (1965)" });
		});

		it("should select multiple computed fields", () => {
			const result = applyObjectSelection(
				booksWithComputed[0] as Record<string, unknown>,
				{ displayName: true, isClassic: true, yearsSincePublication: true },
			);

			expect(result).toEqual({
				displayName: "Dune (1965)",
				isClassic: true,
				yearsSincePublication: 59,
			});
		});

		it("should select a mix of stored and computed fields", () => {
			const result = applyObjectSelection(
				booksWithComputed[0] as Record<string, unknown>,
				{ id: true, title: true, displayName: true, isClassic: true },
			);

			expect(result).toEqual({
				id: "1",
				title: "Dune",
				displayName: "Dune (1965)",
				isClassic: true,
			});
		});

		it("should select only stored fields, excluding computed fields", () => {
			const result = applyObjectSelection(
				booksWithComputed[0] as Record<string, unknown>,
				{ id: true, title: true, year: true, genre: true },
			);

			expect(result).toEqual({
				id: "1",
				title: "Dune",
				year: 1965,
				genre: "sci-fi",
			});
			// Computed fields should not be present
			expect(result).not.toHaveProperty("displayName");
			expect(result).not.toHaveProperty("isClassic");
			expect(result).not.toHaveProperty("yearsSincePublication");
		});

		it("should handle selecting non-existent fields gracefully", () => {
			const result = applyObjectSelection(
				booksWithComputed[0] as Record<string, unknown>,
				{ id: true, nonExistent: true },
			);

			expect(result).toEqual({ id: "1" });
		});
	});

	describe("Task 5.1 continued: Verify applySelect stream combinator with computed fields", () => {
		it("should select computed field via stream combinator", async () => {
			const result = await collectSelected(booksWithComputed, {
				displayName: true,
			});

			expect(result).toHaveLength(5);
			expect(result[0]).toEqual({ displayName: "Dune (1965)" });
			expect(result[1]).toEqual({ displayName: "Neuromancer (1984)" });
		});

		it("should select multiple computed fields via stream", async () => {
			const result = await collectSelected(booksWithComputed, {
				isClassic: true,
				yearsSincePublication: true,
			});

			expect(result).toHaveLength(5);
			expect(result[0]).toEqual({ isClassic: true, yearsSincePublication: 59 });
			expect(result[1]).toEqual({ isClassic: false, yearsSincePublication: 40 });
		});

		it("should select stored and computed fields via stream", async () => {
			const result = await collectSelected(booksWithComputed, {
				title: true,
				displayName: true,
			});

			expect(result).toHaveLength(5);
			expect(result[0]).toEqual({ title: "Dune", displayName: "Dune (1965)" });
		});

		it("should work with array-based select for stored fields", async () => {
			const result = await collectSelected(booksWithComputed, ["id", "title"]);

			expect(result).toHaveLength(5);
			expect(result[0]).toEqual({ id: "1", title: "Dune" });
			// Note: array-based select converts to object-based internally
		});
	});

	describe("Task 5.1 continued: Verify applySelectToArray with computed fields", () => {
		it("should select computed fields from an array of items", () => {
			const result = applySelectToArray(
				booksWithComputed as readonly Record<string, unknown>[],
				{ displayName: true, isClassic: true },
			);

			expect(result).toHaveLength(5);
			expect(result[0]).toEqual({ displayName: "Dune (1965)", isClassic: true });
			expect(result[4]).toEqual({ displayName: "Snow Crash (1992)", isClassic: false });
		});

		it("should handle undefined select (return all fields)", () => {
			const result = applySelectToArray(
				booksWithComputed as readonly Record<string, unknown>[],
				undefined,
			);

			expect(result).toHaveLength(5);
			// Should return all fields including computed ones
			expect(result[0]).toHaveProperty("id");
			expect(result[0]).toHaveProperty("displayName");
			expect(result[0]).toHaveProperty("isClassic");
		});

		it("should handle empty object select (return all fields)", () => {
			const result = applySelectToArray(
				booksWithComputed as readonly Record<string, unknown>[],
				{},
			);

			expect(result).toHaveLength(5);
			// Empty select returns all fields
			expect(result[0]).toHaveProperty("id");
			expect(result[0]).toHaveProperty("displayName");
		});
	});

	describe("Edge cases with computed fields in select", () => {
		it("should handle single entity selection", () => {
			const book = booksWithComputed[0];
			const result = applyObjectSelection(
				book as Record<string, unknown>,
				{ displayName: true },
			);

			expect(result).toEqual({ displayName: "Dune (1965)" });
		});

		it("should handle empty data array", async () => {
			const result = await collectSelected([], { displayName: true });
			expect(result).toEqual([]);
		});

		it("should preserve computed field types correctly", () => {
			const result = applyObjectSelection(
				booksWithComputed[0] as Record<string, unknown>,
				{ isClassic: true, yearsSincePublication: true },
			);

			expect(typeof result.isClassic).toBe("boolean");
			expect(typeof result.yearsSincePublication).toBe("number");
		});

		it("should handle selection with only non-matching keys", () => {
			const result = applyObjectSelection(
				booksWithComputed[0] as Record<string, unknown>,
				{ nonExistent1: true, nonExistent2: true },
			);

			expect(result).toEqual({});
		});
	});
});
