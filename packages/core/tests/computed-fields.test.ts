import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Schema } from "effect";
import { createEffectDatabase } from "../src/factories/database-effect";
import type { EffectDatabase } from "../src/factories/database-effect";

/**
 * Task 9: Comprehensive computed fields test suite.
 *
 * This test file verifies the core behavior of computed fields through
 * end-to-end integration tests using the full database API.
 */

// =============================================================================
// Test Helpers & Fixtures (Task 9.1)
// =============================================================================

// Book schema - stored fields only (id, title, year, authorId)
const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	year: Schema.Number,
	authorId: Schema.optional(Schema.String),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

// Author schema
const AuthorSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

type Book = typeof BookSchema.Type;

// Database config with computed fields:
// - displayName: formatted string `${title} (${year})`
// - isClassic: boolean (year < 1980)
const config = {
	books: {
		schema: BookSchema,
		relationships: {
			author: {
				type: "ref" as const,
				target: "authors" as const,
				foreignKey: "authorId",
			},
		},
		computed: {
			displayName: (book: Book) => `${book.title} (${book.year})`,
			isClassic: (book: Book) => book.year < 1980,
		},
	},
	authors: {
		schema: AuthorSchema,
		relationships: {
			books: {
				type: "inverse" as const,
				target: "books" as const,
				foreignKey: "authorId",
			},
		},
	},
} as const;

// Initial test data
const initialAuthors = [
	{ id: "author1", name: "Frank Herbert" },
	{ id: "author2", name: "William Gibson" },
];

const initialBooks = [
	{ id: "book1", title: "Dune", year: 1965, authorId: "author1" },
	{ id: "book2", title: "Neuromancer", year: 1984, authorId: "author2" },
	{
		id: "book3",
		title: "The Left Hand of Darkness",
		year: 1969,
		authorId: "author1",
	},
	{ id: "book4", title: "Project Hail Mary", year: 2021, authorId: "author2" },
	{ id: "book5", title: "Snow Crash", year: 1992, authorId: "author2" },
];

describe("Computed Fields — Core Behavior (Task 9)", () => {
	let db: EffectDatabase<typeof config>;

	beforeEach(async () => {
		db = await Effect.runPromise(
			createEffectDatabase(config, {
				books: initialBooks,
				authors: initialAuthors,
			}),
		);
	});

	// =========================================================================
	// Task 9.2: Query results include computed fields by default
	// =========================================================================
	describe("Task 9.2: Query results include computed fields by default", () => {
		it("should include computed fields in query results without select clause", async () => {
			const results = await db.books.query().runPromise;

			expect(results).toHaveLength(5);
			for (const book of results) {
				expect(book).toHaveProperty("displayName");
				expect(book).toHaveProperty("isClassic");
			}
		});

		it("should include computed fields alongside stored fields", async () => {
			const result = await db.books.query({ where: { id: "book1" } }).runPromise;

			expect(result).toHaveLength(1);
			const dune = result[0];

			// Stored fields
			expect(dune.id).toBe("book1");
			expect(dune.title).toBe("Dune");
			expect(dune.year).toBe(1965);
			expect(dune.authorId).toBe("author1");

			// Computed fields
			expect(dune.displayName).toBe("Dune (1965)");
			expect(dune.isClassic).toBe(true);
		});
	});

	// =========================================================================
	// Task 9.3: Computed field values are correct
	// =========================================================================
	describe("Task 9.3: Computed field values are correct", () => {
		it("should compute displayName as title (year) format", async () => {
			const results = await db.books.query({ sort: { id: "asc" } }).runPromise;

			expect(results[0].displayName).toBe("Dune (1965)");
			expect(results[1].displayName).toBe("Neuromancer (1984)");
			expect(results[2].displayName).toBe("The Left Hand of Darkness (1969)");
			expect(results[3].displayName).toBe("Project Hail Mary (2021)");
			expect(results[4].displayName).toBe("Snow Crash (1992)");
		});

		it("should compute isClassic as true for books before 1980", async () => {
			const results = await db.books.query({ sort: { id: "asc" } }).runPromise;

			// Dune (1965) - classic
			expect(results[0].isClassic).toBe(true);
			// Neuromancer (1984) - not classic
			expect(results[1].isClassic).toBe(false);
			// Left Hand (1969) - classic
			expect(results[2].isClassic).toBe(true);
			// Project Hail Mary (2021) - not classic
			expect(results[3].isClassic).toBe(false);
			// Snow Crash (1992) - not classic
			expect(results[4].isClassic).toBe(false);
		});
	});

	// =========================================================================
	// Task 9.4: No select clause — all stored + computed fields present
	// =========================================================================
	describe("Task 9.4: No select clause returns all stored and computed fields", () => {
		it("should return all stored and computed fields when select is undefined", async () => {
			const results = await db.books.query().runPromise;

			expect(results).toHaveLength(5);

			const dune = results.find((b) => b.id === "book1");
			expect(dune).toBeDefined();

			// All stored fields present
			expect(dune).toHaveProperty("id");
			expect(dune).toHaveProperty("title");
			expect(dune).toHaveProperty("year");
			expect(dune).toHaveProperty("authorId");

			// All computed fields present
			expect(dune).toHaveProperty("displayName");
			expect(dune).toHaveProperty("isClassic");
		});

		it("should have correct total field count (stored + computed)", async () => {
			const results = await db.books.query().runPromise;

			const keys = Object.keys(results[0]);
			// Stored: id, title, year, authorId = 4 (createdAt/updatedAt not in initial data)
			// Computed: displayName, isClassic = 2
			// Total = 6
			expect(keys).toHaveLength(6);
			expect(keys.sort()).toEqual([
				"authorId",
				"displayName",
				"id",
				"isClassic",
				"title",
				"year",
			]);
		});
	});

	// =========================================================================
	// Task 9.5: Select including computed — only selected fields present
	// =========================================================================
	describe("Task 9.5: Select including computed fields", () => {
		it("should return only selected fields including computed", async () => {
			const results = await db.books
				.query({
					select: { title: true, displayName: true },
				})
				.runPromise;

			expect(results).toHaveLength(5);
			for (const book of results) {
				expect(Object.keys(book).sort()).toEqual(["displayName", "title"]);
			}
		});

		it("should return a mix of stored and computed when both selected", async () => {
			const results = await db.books
				.query({
					select: { id: true, title: true, displayName: true, isClassic: true },
				})
				.runPromise;

			const dune = results.find((b) => b.id === "book1");
			expect(dune).toEqual({
				id: "book1",
				title: "Dune",
				displayName: "Dune (1965)",
				isClassic: true,
			});
		});
	});

	// =========================================================================
	// Task 9.6: Select excluding computed — computed fields absent, not evaluated
	// =========================================================================
	describe("Task 9.6: Select excluding computed fields", () => {
		it("should return only stored fields when computed are not selected", async () => {
			const results = await db.books
				.query({
					select: { id: true, title: true, year: true },
				})
				.runPromise;

			expect(results).toHaveLength(5);
			for (const book of results) {
				const keys = Object.keys(book);
				expect(keys.sort()).toEqual(["id", "title", "year"]);
				expect(book).not.toHaveProperty("displayName");
				expect(book).not.toHaveProperty("isClassic");
			}
		});

		it("should not include computed fields when only stored fields selected", async () => {
			const results = await db.books
				.query({
					select: { title: true, authorId: true },
				})
				.runPromise;

			for (const book of results) {
				expect(Object.keys(book)).toContain("title");
				expect(Object.keys(book)).toContain("authorId");
				expect(Object.keys(book)).not.toContain("displayName");
				expect(Object.keys(book)).not.toContain("isClassic");
			}
		});
	});

	// =========================================================================
	// Task 9.7: Filter by computed boolean field
	// =========================================================================
	describe("Task 9.7: Filter by computed boolean field", () => {
		it("should filter where isClassic is true", async () => {
			const results = await db.books
				.query({ where: { isClassic: true } })
				.runPromise;

			// Books before 1980: Dune (1965), Left Hand (1969)
			expect(results).toHaveLength(2);
			const titles = results.map((b) => b.title);
			expect(titles).toContain("Dune");
			expect(titles).toContain("The Left Hand of Darkness");
		});

		it("should filter where isClassic is false", async () => {
			const results = await db.books
				.query({ where: { isClassic: false } })
				.runPromise;

			// Books 1980+: Neuromancer (1984), Project Hail Mary (2021), Snow Crash (1992)
			expect(results).toHaveLength(3);
			const titles = results.map((b) => b.title);
			expect(titles).toContain("Neuromancer");
			expect(titles).toContain("Project Hail Mary");
			expect(titles).toContain("Snow Crash");
		});
	});

	// =========================================================================
	// Task 9.8: Filter by computed string field with operator
	// =========================================================================
	describe("Task 9.8: Filter by computed string field with operator", () => {
		it("should filter by displayName with $contains", async () => {
			const results = await db.books
				.query({ where: { displayName: { $contains: "1965" } } })
				.runPromise;

			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Dune");
		});

		it("should filter by displayName with $startsWith", async () => {
			const results = await db.books
				.query({ where: { displayName: { $startsWith: "Dune" } } })
				.runPromise;

			expect(results).toHaveLength(1);
			expect(results[0].displayName).toBe("Dune (1965)");
		});

		it("should filter by displayName with $endsWith", async () => {
			const results = await db.books
				.query({ where: { displayName: { $endsWith: "(1969)" } } })
				.runPromise;

			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("The Left Hand of Darkness");
		});
	});

	// =========================================================================
	// Task 9.9: Sort by computed field ascending
	// =========================================================================
	describe("Task 9.9: Sort by computed field ascending", () => {
		it("should sort by displayName ascending", async () => {
			const results = await db.books
				.query({ sort: { displayName: "asc" } })
				.runPromise;

			expect(results).toHaveLength(5);
			const displayNames = results.map((b) => b.displayName);
			expect(displayNames).toEqual([
				"Dune (1965)",
				"Neuromancer (1984)",
				"Project Hail Mary (2021)",
				"Snow Crash (1992)",
				"The Left Hand of Darkness (1969)",
			]);
		});
	});

	// =========================================================================
	// Task 9.10: Sort by computed field descending
	// =========================================================================
	describe("Task 9.10: Sort by computed field descending", () => {
		it("should sort by displayName descending", async () => {
			const results = await db.books
				.query({ sort: { displayName: "desc" } })
				.runPromise;

			expect(results).toHaveLength(5);
			const displayNames = results.map((b) => b.displayName);
			expect(displayNames).toEqual([
				"The Left Hand of Darkness (1969)",
				"Snow Crash (1992)",
				"Project Hail Mary (2021)",
				"Neuromancer (1984)",
				"Dune (1965)",
			]);
		});

		it("should sort by isClassic descending (true before false)", async () => {
			const results = await db.books
				.query({ sort: { isClassic: "desc", title: "asc" } })
				.runPromise;

			// true (1) > false (0), so classics first, then by title
			const classicStatus = results.map((b) => b.isClassic);
			expect(classicStatus.slice(0, 2).every((c) => c === true)).toBe(true);
			expect(classicStatus.slice(2).every((c) => c === false)).toBe(true);
		});
	});

	// =========================================================================
	// Task 9.11: Combined: filter + sort + select with computed fields
	// =========================================================================
	describe("Task 9.11: Combined filter, sort, and select with computed fields", () => {
		it("should filter by computed, sort by computed, and select computed", async () => {
			const results = await db.books
				.query({
					where: { isClassic: false },
					sort: { displayName: "asc" },
					select: { title: true, displayName: true, isClassic: true },
				})
				.runPromise;

			// Filter: isClassic === false → Neuromancer, Project Hail Mary, Snow Crash
			// Sort: displayName asc → Neuromancer, Project Hail Mary, Snow Crash
			expect(results).toHaveLength(3);
			expect(results.map((r) => r.title)).toEqual([
				"Neuromancer",
				"Project Hail Mary",
				"Snow Crash",
			]);

			// All should have isClassic: false
			expect(results.every((r) => r.isClassic === false)).toBe(true);

			// Should only have selected fields
			for (const result of results) {
				expect(Object.keys(result).sort()).toEqual([
					"displayName",
					"isClassic",
					"title",
				]);
			}
		});

		it("should filter by stored field, sort by computed, select mix", async () => {
			const results = await db.books
				.query({
					where: { authorId: "author2" },
					sort: { displayName: "desc" },
					select: { title: true, displayName: true },
				})
				.runPromise;

			// Author2 books: Neuromancer, Project Hail Mary, Snow Crash
			// Sort desc by displayName: Snow Crash, Project Hail Mary, Neuromancer
			expect(results).toHaveLength(3);
			expect(results.map((r) => r.title)).toEqual([
				"Snow Crash",
				"Project Hail Mary",
				"Neuromancer",
			]);
		});
	});

	// =========================================================================
	// Task 9.12: Multiple computed fields on the same collection
	// =========================================================================
	describe("Task 9.12: Multiple computed fields on the same collection", () => {
		it("should support multiple computed fields simultaneously", async () => {
			const results = await db.books.query({ where: { id: "book1" } }).runPromise;

			expect(results).toHaveLength(1);
			const dune = results[0];

			// Both computed fields should be present
			expect(dune.displayName).toBe("Dune (1965)");
			expect(dune.isClassic).toBe(true);
		});

		it("should allow selecting both computed fields", async () => {
			const results = await db.books
				.query({
					select: { displayName: true, isClassic: true },
				})
				.runPromise;

			expect(results).toHaveLength(5);
			for (const book of results) {
				expect(Object.keys(book).sort()).toEqual(["displayName", "isClassic"]);
			}
		});

		it("should allow filtering by one computed and sorting by another", async () => {
			const results = await db.books
				.query({
					where: { isClassic: true },
					sort: { displayName: "asc" },
				})
				.runPromise;

			expect(results).toHaveLength(2);
			// Classics sorted by displayName: Dune, Left Hand
			expect(results[0].displayName).toBe("Dune (1965)");
			expect(results[1].displayName).toBe("The Left Hand of Darkness (1969)");
		});
	});

	// =========================================================================
	// Task 9.13: Collection with no computed fields (regression check)
	// =========================================================================
	describe("Task 9.13: Collection with no computed fields (regression)", () => {
		it("should query authors collection without computed fields normally", async () => {
			const results = await db.authors.query().runPromise;

			expect(results).toHaveLength(2);
			const names = results.map((a) => a.name);
			expect(names).toContain("Frank Herbert");
			expect(names).toContain("William Gibson");
		});

		it("should not have computed fields on authors collection", async () => {
			const results = await db.authors.query().runPromise;

			for (const author of results) {
				expect(author).not.toHaveProperty("displayName");
				expect(author).not.toHaveProperty("isClassic");
			}
		});

		it("should filter authors by stored fields correctly", async () => {
			const results = await db.authors
				.query({ where: { name: "Frank Herbert" } })
				.runPromise;

			expect(results).toHaveLength(1);
			expect(results[0].id).toBe("author1");
		});

		it("should sort authors correctly", async () => {
			const results = await db.authors
				.query({ sort: { name: "asc" } })
				.runPromise;

			expect(results).toHaveLength(2);
			expect(results[0].name).toBe("Frank Herbert");
			expect(results[1].name).toBe("William Gibson");
		});

		it("should select authors fields correctly", async () => {
			const results = await db.authors
				.query({ select: { name: true } })
				.runPromise;

			expect(results).toHaveLength(2);
			for (const author of results) {
				expect(Object.keys(author)).toEqual(["name"]);
			}
		});
	});
});
