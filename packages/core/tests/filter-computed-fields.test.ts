import { Chunk, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { filterData } from "../src/operations/query/filter";
import { applyFilter } from "../src/operations/query/filter-stream";
import { resolveComputedFields } from "../src/operations/query/resolve-computed";
import type { ComputedFieldsConfig } from "../src/types/computed-types";

/**
 * Task 3.1-3.4: Verify that filterData works on entities with computed fields attached.
 *
 * The filterData function uses dynamic property access (`key in item` and `item[key]`),
 * which handles arbitrary keys including computed field keys. These tests confirm
 * that filtering by computed fields works correctly.
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

// Helper to collect filtered stream
const collectFiltered = <T extends Record<string, unknown>>(
	data: readonly T[],
	where: Record<string, unknown> | undefined,
): Promise<readonly T[]> =>
	Effect.runPromise(
		Stream.fromIterable(data).pipe(
			applyFilter<T>(where),
			Stream.runCollect,
			Effect.map(Chunk.toReadonlyArray),
		),
	);

describe("filterData with computed fields", () => {
	describe("Task 3.1: Verify filterData handles computed field keys via dynamic property access", () => {
		it("should filter entities by computed field displayName (string)", () => {
			// Direct call to filterData
			const result = filterData([...booksWithComputed], {
				displayName: "Dune (1965)",
			});

			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("1");
			expect(result[0].displayName).toBe("Dune (1965)");
		});

		it("should filter entities by computed field isClassic (boolean)", () => {
			const result = filterData([...booksWithComputed], { isClassic: true });

			// Books from before 1980: Dune (1965), Left Hand of Darkness (1969)
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id).sort()).toEqual(["1", "3"]);
		});

		it("should filter entities by computed field yearsSincePublication (number)", () => {
			const result = filterData([...booksWithComputed], {
				yearsSincePublication: { $lt: 50 },
			});

			// Books from 1975 or later: Neuromancer (1984), Project Hail Mary (2021), Snow Crash (1992)
			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id).sort()).toEqual(["2", "4", "5"]);
		});

		it("should handle multiple computed fields in where clause", () => {
			const result = filterData([...booksWithComputed], {
				isClassic: false,
				yearsSincePublication: { $lt: 40 },
			});

			// Not classic (1980+) AND less than 40 years old (after 1984)
			// Neuromancer (1984, 40 years) - excluded (exactly 40)
			// Project Hail Mary (2021, 3 years) - included
			// Snow Crash (1992, 32 years) - included
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id).sort()).toEqual(["4", "5"]);
		});

		it("should combine stored and computed fields in where clause", () => {
			const result = filterData([...booksWithComputed], {
				genre: "sci-fi",
				isClassic: true,
			});

			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id).sort()).toEqual(["1", "3"]);
		});
	});

	describe("Task 3.2: Filter by computed string field with $contains operator", () => {
		it("should filter by computed displayName with $contains", async () => {
			const result = await collectFiltered(booksWithComputed, {
				displayName: { $contains: "1965" },
			});

			expect(result).toHaveLength(1);
			expect(result[0].title).toBe("Dune");
		});

		it("should filter by computed displayName with $startsWith", async () => {
			const result = await collectFiltered(booksWithComputed, {
				displayName: { $startsWith: "Dune" },
			});

			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("1");
		});

		it("should filter by computed displayName with $endsWith", async () => {
			const result = await collectFiltered(booksWithComputed, {
				displayName: { $endsWith: "(1969)" },
			});

			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("3");
		});

		it("should combine $contains with other operators on computed field", async () => {
			const result = await collectFiltered(booksWithComputed, {
				displayName: { $contains: "19" },
				isClassic: false,
			});

			// Books with "19" in display name AND not classic (1980+)
			// Neuromancer (1984) - yes
			// Snow Crash (1992) - yes
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id).sort()).toEqual(["2", "5"]);
		});
	});

	describe("Task 3.3: Filter by computed boolean field with direct equality", () => {
		it("should filter where isClassic is true", async () => {
			const result = await collectFiltered(booksWithComputed, {
				isClassic: true,
			});

			expect(result).toHaveLength(2);
			expect(result.every((r) => r.year < 1980)).toBe(true);
		});

		it("should filter where isClassic is false", async () => {
			const result = await collectFiltered(booksWithComputed, {
				isClassic: false,
			});

			expect(result).toHaveLength(3);
			expect(result.every((r) => r.year >= 1980)).toBe(true);
		});

		it("should filter with $eq operator on boolean computed field", async () => {
			const result = await collectFiltered(booksWithComputed, {
				isClassic: { $eq: true },
			});

			expect(result).toHaveLength(2);
		});

		it("should filter with $ne operator on boolean computed field", async () => {
			const result = await collectFiltered(booksWithComputed, {
				isClassic: { $ne: true },
			});

			expect(result).toHaveLength(3);
		});
	});

	describe("Task 3.4: Filter by computed numeric field with $gt/$lt operators", () => {
		it("should filter by computed yearsSincePublication with $gt", async () => {
			const result = await collectFiltered(booksWithComputed, {
				yearsSincePublication: { $gt: 50 },
			});

			// Books older than 50 years (before 1974): Dune (1965), Left Hand (1969)
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id).sort()).toEqual(["1", "3"]);
		});

		it("should filter by computed yearsSincePublication with $lt", async () => {
			const result = await collectFiltered(booksWithComputed, {
				yearsSincePublication: { $lt: 10 },
			});

			// Books less than 10 years old (after 2014): Project Hail Mary (2021)
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("4");
		});

		it("should filter by computed yearsSincePublication with $gte and $lte", async () => {
			const result = await collectFiltered(booksWithComputed, {
				yearsSincePublication: { $gte: 30, $lte: 40 },
			});

			// Books between 30 and 40 years old (1984-1994)
			// Neuromancer (1984, 40 years) - included
			// Snow Crash (1992, 32 years) - included
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id).sort()).toEqual(["2", "5"]);
		});

		it("should filter by computed field with $in operator", async () => {
			const result = await collectFiltered(booksWithComputed, {
				yearsSincePublication: { $in: [3, 32, 59] },
			});

			// Exact matches: Project Hail Mary (3), Snow Crash (32), Dune (59)
			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id).sort()).toEqual(["1", "4", "5"]);
		});
	});

	describe("Complex filters with computed and stored fields", () => {
		it("should handle $or with computed fields", async () => {
			const result = await collectFiltered(booksWithComputed, {
				$or: [{ isClassic: true }, { title: "Project Hail Mary" }],
			});

			// Classic books OR Project Hail Mary
			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id).sort()).toEqual(["1", "3", "4"]);
		});

		it("should handle $and with computed fields", async () => {
			const result = await collectFiltered(booksWithComputed, {
				$and: [{ isClassic: false }, { yearsSincePublication: { $lt: 35 } }],
			});

			// Not classic AND less than 35 years old
			// Snow Crash (32), Project Hail Mary (3)
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id).sort()).toEqual(["4", "5"]);
		});

		it("should handle $not with computed fields", async () => {
			const result = await collectFiltered(booksWithComputed, {
				$not: { isClassic: true },
			});

			// Not classic
			expect(result).toHaveLength(3);
			expect(result.every((r) => r.year >= 1980)).toBe(true);
		});

		it("should handle deeply nested conditions with computed fields", async () => {
			const result = await collectFiltered(booksWithComputed, {
				$or: [
					{
						$and: [{ isClassic: true }, { displayName: { $contains: "Dune" } }],
					},
					{
						$and: [{ isClassic: false }, { yearsSincePublication: { $lt: 5 } }],
					},
				],
			});

			// (Classic AND contains Dune) OR (Not classic AND <5 years old)
			// Dune (classic, contains Dune) - yes
			// Project Hail Mary (not classic, 3 years) - yes
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id).sort()).toEqual(["1", "4"]);
		});
	});
});
