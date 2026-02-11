import { describe, it, expect } from "vitest";
import { Effect, Stream, Chunk } from "effect";
import { applySort } from "../src/operations/query/sort-stream";
import { sortData } from "../src/operations/query/sort";
import { resolveComputedFields } from "../src/operations/query/resolve-computed";
import type { ComputedFieldsConfig } from "../src/types/computed-types";

/**
 * Task 4.1-4.3: Verify that sortData works on entities with computed fields attached.
 *
 * The sortData function uses dynamic property access via `getNestedValue`,
 * which handles arbitrary keys including computed field keys. These tests confirm
 * that sorting by computed fields works correctly.
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

// Helper to collect sorted stream
const collectSorted = <T extends Record<string, unknown>>(
	data: readonly T[],
	sort: Record<string, "asc" | "desc"> | undefined,
): Promise<readonly T[]> =>
	Effect.runPromise(
		Stream.fromIterable(data).pipe(
			applySort<T>(sort),
			Stream.runCollect,
			Effect.map(Chunk.toReadonlyArray),
		),
	);

describe("sortData with computed fields", () => {
	describe("Task 4.1: Verify sortData handles computed field keys via dynamic property access", () => {
		it("should sort entities by computed field displayName (string)", () => {
			// Direct call to sortData
			const result = sortData([...booksWithComputed], { displayName: "asc" });

			// displayName values alphabetically:
			// "Dune (1965)" < "Neuromancer (1984)" < "Project Hail Mary (2021)" < "Snow Crash (1992)" < "The Left Hand of Darkness (1969)"
			expect(result).toHaveLength(5);
			expect(result[0].title).toBe("Dune");
			expect(result[1].title).toBe("Neuromancer");
			expect(result[2].title).toBe("Project Hail Mary");
			expect(result[3].title).toBe("Snow Crash");
			expect(result[4].title).toBe("The Left Hand of Darkness");
		});

		it("should sort entities by computed field isClassic (boolean)", () => {
			const result = sortData([...booksWithComputed], { isClassic: "asc" });

			// false < true in ascending order
			// First the non-classics (1980+), then the classics (<1980)
			const nonClassicIds = result.slice(0, 3).map((r) => r.id);
			const classicIds = result.slice(3, 5).map((r) => r.id);

			expect(nonClassicIds.sort()).toEqual(["2", "4", "5"]); // 1984, 2021, 1992
			expect(classicIds.sort()).toEqual(["1", "3"]); // 1965, 1969
		});

		it("should sort entities by computed field yearsSincePublication (number)", () => {
			const result = sortData([...booksWithComputed], {
				yearsSincePublication: "asc",
			});

			// Ascending by years since publication = newest books first
			// 2021 (3 years) < 1992 (32) < 1984 (40) < 1969 (55) < 1965 (59)
			expect(result.map((r) => r.id)).toEqual(["4", "5", "2", "3", "1"]);
		});

		it("should handle multiple sort fields including computed", () => {
			const result = sortData([...booksWithComputed], {
				isClassic: "desc",
				yearsSincePublication: "asc",
			});

			// First sort by isClassic descending (true first, then false)
			// Then by yearsSincePublication ascending within each group

			// Classics (<1980): 1969 (55 years), 1965 (59 years)
			expect(result[0].id).toBe("3"); // 1969, 55 years
			expect(result[1].id).toBe("1"); // 1965, 59 years

			// Non-classics (1980+): 2021 (3), 1992 (32), 1984 (40)
			expect(result[2].id).toBe("4"); // 2021, 3 years
			expect(result[3].id).toBe("5"); // 1992, 32 years
			expect(result[4].id).toBe("2"); // 1984, 40 years
		});

		it("should combine stored and computed fields in sort config", () => {
			const result = sortData([...booksWithComputed], {
				genre: "asc",
				yearsSincePublication: "desc",
			});

			// All books have same genre, so sort by yearsSincePublication descending
			// Oldest books first: 1965 (59) > 1969 (55) > 1984 (40) > 1992 (32) > 2021 (3)
			expect(result.map((r) => r.id)).toEqual(["1", "3", "2", "5", "4"]);
		});
	});

	describe("Task 4.2: Sort by computed string field ascending and descending", () => {
		it("should sort by computed displayName ascending via stream", async () => {
			const result = await collectSorted(booksWithComputed, {
				displayName: "asc",
			});

			expect(result[0].title).toBe("Dune");
			expect(result[4].title).toBe("The Left Hand of Darkness");
		});

		it("should sort by computed displayName descending via stream", async () => {
			const result = await collectSorted(booksWithComputed, {
				displayName: "desc",
			});

			// Reverse order
			expect(result[0].title).toBe("The Left Hand of Darkness");
			expect(result[4].title).toBe("Dune");
		});
	});

	describe("Task 4.3: Sort by computed numeric field", () => {
		it("should sort by computed yearsSincePublication ascending via stream", async () => {
			const result = await collectSorted(booksWithComputed, {
				yearsSincePublication: "asc",
			});

			// Newest first when sorted ascending by years since publication
			expect(result[0].year).toBe(2021);
			expect(result[4].year).toBe(1965);
		});

		it("should sort by computed yearsSincePublication descending via stream", async () => {
			const result = await collectSorted(booksWithComputed, {
				yearsSincePublication: "desc",
			});

			// Oldest first when sorted descending by years since publication
			expect(result[0].year).toBe(1965);
			expect(result[4].year).toBe(2021);
		});

		it("should handle secondary sort by computed field", async () => {
			// Add a duplicate genre to test secondary sort
			const booksWithDuplicateGenre: BookWithComputed[] = [
				...booksWithComputed.slice(0, 2),
				{
					...booksWithComputed[2],
					genre: "fantasy" as const,
				} as BookWithComputed,
			];

			const result = await collectSorted(booksWithDuplicateGenre, {
				genre: "asc",
				yearsSincePublication: "asc",
			});

			// fantasy first, then sci-fi, each sorted by yearsSincePublication ascending
			expect(result[0].genre).toBe("fantasy");
			expect(result[1].genre).toBe("sci-fi");
		});
	});

	describe("Edge cases with computed fields in sort", () => {
		it("should handle empty sort config", () => {
			const result = sortData([...booksWithComputed], {});
			expect(result).toEqual(booksWithComputed);
		});

		it("should handle undefined sort config", () => {
			const result = sortData([...booksWithComputed], undefined);
			expect(result).toEqual(booksWithComputed);
		});

		it("should maintain stable sort order for equal computed values", () => {
			// All books have the same genre, so sorting by genre alone should preserve order
			const result = sortData([...booksWithComputed], { genre: "asc" });

			// Order should be preserved since all genres are equal
			expect(result.map((r) => r.id)).toEqual(["1", "2", "3", "4", "5"]);
		});
	});
});
