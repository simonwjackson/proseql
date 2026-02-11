import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Schema, Layer, Stream, Chunk } from "effect";
import {
	createEffectDatabase,
	createPersistentEffectDatabase,
} from "../src/factories/database-effect";
import type { EffectDatabase } from "../src/factories/database-effect";
import { makeInMemoryStorageLayer } from "../src/storage/in-memory-adapter-layer";
import { makeSerializerLayer } from "../src/serializers/format-codec";
import { jsonCodec } from "../src/serializers/codecs/json";
import { yamlCodec } from "../src/serializers/codecs/yaml";

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

// =============================================================================
// Task 10: Edge Cases
// =============================================================================

describe("Computed Fields — Edge Cases (Task 10)", () => {
	// =========================================================================
	// Task 10.1: Computed field returning null or undefined — handled gracefully
	// =========================================================================
	describe("Task 10.1: Computed field returning null or undefined", () => {
		// Schema with optional fields to enable nullable computed field scenarios
		const ItemSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			description: Schema.optional(Schema.String),
			rating: Schema.optional(Schema.Number),
		});

		type Item = typeof ItemSchema.Type;

		const nullableComputedConfig = {
			items: {
				schema: ItemSchema,
				relationships: {},
				computed: {
					// Returns null when description is missing
					descriptionLength: (item: Item): number | null =>
						item.description != null ? item.description.length : null,
					// Returns undefined when rating is missing
					ratingCategory: (item: Item): string | undefined => {
						if (item.rating === undefined) return undefined;
						if (item.rating >= 4) return "excellent";
						if (item.rating >= 2) return "average";
						return "poor";
					},
					// Returns null for items without description
					descriptionPreview: (item: Item): string | null =>
						item.description != null
							? item.description.substring(0, 10)
							: null,
				},
			},
		} as const;

		const initialItems = [
			{
				id: "item1",
				name: "Complete Item",
				description: "A full description",
				rating: 5,
			},
			{ id: "item2", name: "No Description", rating: 3 },
			{ id: "item3", name: "No Rating", description: "Has description only" },
			{ id: "item4", name: "Minimal Item" }, // No optional fields
		];

		it("should include computed fields even when they return null or undefined", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(nullableComputedConfig, { items: initialItems }),
			);

			const results = await db.items.query({ sort: { id: "asc" } }).runPromise;

			expect(results).toHaveLength(4);

			// Complete item - all computed fields have values
			expect(results[0].descriptionLength).toBe(18); // "A full description".length
			expect(results[0].ratingCategory).toBe("excellent");
			expect(results[0].descriptionPreview).toBe("A full des");

			// No description - null for description-based fields
			expect(results[1].descriptionLength).toBeNull();
			expect(results[1].ratingCategory).toBe("average");
			expect(results[1].descriptionPreview).toBeNull();

			// No rating - undefined for rating-based field
			expect(results[2].descriptionLength).toBe(20); // "Has description only".length
			expect(results[2].ratingCategory).toBeUndefined();
			expect(results[2].descriptionPreview).toBe("Has descri");

			// Minimal item - all optional-based computed fields are null/undefined
			expect(results[3].descriptionLength).toBeNull();
			expect(results[3].ratingCategory).toBeUndefined();
			expect(results[3].descriptionPreview).toBeNull();
		});

		it("should handle filtering where computed field is null (using $eq: null)", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(nullableComputedConfig, { items: initialItems }),
			);

			const results = await db.items
				.query({ where: { descriptionLength: { $eq: null } } })
				.runPromise;

			// Items without description: item2 "No Description", item4 "Minimal Item"
			expect(results).toHaveLength(2);
			const names = results.map((r) => r.name);
			expect(names).toContain("No Description");
			expect(names).toContain("Minimal Item");
		});

		it("should handle filtering where computed field is not null (using $ne: null)", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(nullableComputedConfig, { items: initialItems }),
			);

			const results = await db.items
				.query({ where: { descriptionLength: { $ne: null } } })
				.runPromise;

			// Items with description: item1 "Complete Item", item3 "No Rating"
			expect(results).toHaveLength(2);
			const names = results.map((r) => r.name);
			expect(names).toContain("Complete Item");
			expect(names).toContain("No Rating");
		});

		it("should handle filtering by computed string field that may be undefined", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(nullableComputedConfig, { items: initialItems }),
			);

			// Filter for "excellent" rating category
			const excellent = await db.items
				.query({ where: { ratingCategory: "excellent" } })
				.runPromise;

			expect(excellent).toHaveLength(1);
			expect(excellent[0].name).toBe("Complete Item");

			// Filter for "average" rating category
			const average = await db.items
				.query({ where: { ratingCategory: "average" } })
				.runPromise;

			expect(average).toHaveLength(1);
			expect(average[0].name).toBe("No Description");
		});

		it("should handle string operators gracefully when computed field returns null", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(nullableComputedConfig, { items: initialItems }),
			);

			// $contains on null/undefined should not match (not throw)
			const results = await db.items
				.query({ where: { descriptionPreview: { $contains: "full" } } })
				.runPromise;

			// Only "Complete Item" has "A full des" as preview which contains "full"
			// Note: substring 0-10 is "A full des", which does contain "full"
			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Complete Item");
		});

		it("should handle $startsWith on computed field that may be null", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(nullableComputedConfig, { items: initialItems }),
			);

			const results = await db.items
				.query({ where: { descriptionPreview: { $startsWith: "A" } } })
				.runPromise;

			// Only "Complete Item" has preview starting with "A"
			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Complete Item");
		});

		it("should sort by computed numeric field with null values (null sorts to end)", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(nullableComputedConfig, { items: initialItems }),
			);

			// Sort ascending - nulls should go to the end
			const ascResults = await db.items
				.query({ sort: { descriptionLength: "asc" } })
				.runPromise;

			// Non-null values first (18, 20), then nulls
			expect(ascResults).toHaveLength(4);
			// First two have description lengths: 18 (Complete Item), 20 (No Rating)
			expect(ascResults[0].descriptionLength).toBe(18);
			expect(ascResults[1].descriptionLength).toBe(20);
			// Last two have null
			expect(ascResults[2].descriptionLength).toBeNull();
			expect(ascResults[3].descriptionLength).toBeNull();
		});

		it("should sort by computed numeric field descending with null values (null sorts to end)", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(nullableComputedConfig, { items: initialItems }),
			);

			// Sort descending - nulls should still go to the end
			const descResults = await db.items
				.query({ sort: { descriptionLength: "desc" } })
				.runPromise;

			// Non-null values first in descending order (20, 18), then nulls
			expect(descResults).toHaveLength(4);
			expect(descResults[0].descriptionLength).toBe(20);
			expect(descResults[1].descriptionLength).toBe(18);
			// Last two have null
			expect(descResults[2].descriptionLength).toBeNull();
			expect(descResults[3].descriptionLength).toBeNull();
		});

		it("should sort by computed string field with undefined values (undefined sorts to end)", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(nullableComputedConfig, { items: initialItems }),
			);

			// Sort ascending by ratingCategory (string)
			const results = await db.items
				.query({ sort: { ratingCategory: "asc" } })
				.runPromise;

			expect(results).toHaveLength(4);
			// Non-undefined values first: "average", "excellent"
			expect(results[0].ratingCategory).toBe("average");
			expect(results[1].ratingCategory).toBe("excellent");
			// Last two have undefined
			expect(results[2].ratingCategory).toBeUndefined();
			expect(results[3].ratingCategory).toBeUndefined();
		});

		it("should handle combined filter and sort with nullable computed fields", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(nullableComputedConfig, { items: initialItems }),
			);

			// Filter to items that have a description, sort by descriptionLength
			const results = await db.items
				.query({
					where: { descriptionLength: { $ne: null } },
					sort: { descriptionLength: "desc" },
				})
				.runPromise;

			expect(results).toHaveLength(2);
			expect(results[0].name).toBe("No Rating"); // descriptionLength: 20
			expect(results[1].name).toBe("Complete Item"); // descriptionLength: 18
		});

		it("should select nullable computed fields correctly", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(nullableComputedConfig, { items: initialItems }),
			);

			const results = await db.items
				.query({
					select: { name: true, descriptionLength: true, ratingCategory: true },
					sort: { id: "asc" },
				})
				.runPromise;

			expect(results).toHaveLength(4);

			// Verify only selected fields are present
			for (const result of results) {
				expect(Object.keys(result).sort()).toEqual([
					"descriptionLength",
					"name",
					"ratingCategory",
				]);
			}

			// Verify values including null/undefined
			expect(results[0]).toEqual({
				name: "Complete Item",
				descriptionLength: 18,
				ratingCategory: "excellent",
			});
			expect(results[1]).toEqual({
				name: "No Description",
				descriptionLength: null,
				ratingCategory: "average",
			});
			expect(results[2]).toEqual({
				name: "No Rating",
				descriptionLength: 20,
				ratingCategory: undefined,
			});
			expect(results[3]).toEqual({
				name: "Minimal Item",
				descriptionLength: null,
				ratingCategory: undefined,
			});
		});
	});

	// =========================================================================
	// Task 10.3: Computed field with population — deriving from related data
	// =========================================================================
	describe("Task 10.3: Computed field with population", () => {
		// Schema and config with computed field that accesses populated relationship
		const BookWithPopulateSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			year: Schema.Number,
			authorId: Schema.optional(Schema.String),
		});

		const AuthorForPopulateSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			nationality: Schema.optional(Schema.String),
		});

		// The computed field accesses the populated author relationship
		// When author is populated, it returns the author's name
		// When author is not populated (undefined), it returns "Unknown"
		const populateComputedConfig = {
			books: {
				schema: BookWithPopulateSchema,
				relationships: {
					author: {
						type: "ref" as const,
						target: "authors" as const,
						foreignKey: "authorId",
					},
				},
				computed: {
					// Accesses populated author.name with fallback
					authorName: (book: Record<string, unknown>) => {
						const author = book.author as
							| { name: string; nationality?: string }
							| undefined;
						return author?.name ?? "Unknown";
					},
					// Accesses populated author.nationality with fallback
					authorNationality: (book: Record<string, unknown>) => {
						const author = book.author as
							| { name: string; nationality?: string }
							| undefined;
						return author?.nationality ?? "Unknown";
					},
					// Combines stored field with populated field
					fullDisplay: (book: Record<string, unknown>) => {
						const title = book.title as string;
						const year = book.year as number;
						const author = book.author as
							| { name: string }
							| undefined;
						const authorName = author?.name ?? "Unknown";
						return `${title} (${year}) by ${authorName}`;
					},
				},
			},
			authors: {
				schema: AuthorForPopulateSchema,
				relationships: {
					books: {
						type: "inverse" as const,
						target: "books" as const,
						foreignKey: "authorId",
					},
				},
			},
		} as const;

		const testAuthors = [
			{ id: "author1", name: "Frank Herbert", nationality: "American" },
			{ id: "author2", name: "William Gibson", nationality: "Canadian" },
			{ id: "author3", name: "Ursula K. Le Guin" }, // No nationality
		];

		const testBooks = [
			{ id: "book1", title: "Dune", year: 1965, authorId: "author1" },
			{ id: "book2", title: "Neuromancer", year: 1984, authorId: "author2" },
			{ id: "book3", title: "The Left Hand of Darkness", year: 1969, authorId: "author3" },
			{ id: "book4", title: "Unknown Book", year: 2000 }, // No authorId
		];

		it("should return 'Unknown' for computed field when populate is not used", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(populateComputedConfig, {
					books: testBooks,
					authors: testAuthors,
				}),
			);

			// Query without populate - author relationship is not populated
			const results = await db.books.query({ sort: { id: "asc" } }).runPromise;

			expect(results).toHaveLength(4);

			// All should have "Unknown" because author is not populated
			expect(results[0].authorName).toBe("Unknown");
			expect(results[1].authorName).toBe("Unknown");
			expect(results[2].authorName).toBe("Unknown");
			expect(results[3].authorName).toBe("Unknown");

			// fullDisplay should use "Unknown" for author name
			expect(results[0].fullDisplay).toBe("Dune (1965) by Unknown");
			expect(results[1].fullDisplay).toBe("Neuromancer (1984) by Unknown");
		});

		it("should derive computed field from populated relationship data", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(populateComputedConfig, {
					books: testBooks,
					authors: testAuthors,
				}),
			);

			// Query with populate - author relationship is populated
			const results = await db.books
				.query({
					populate: { author: true },
					sort: { id: "asc" },
				})
				.runPromise;

			expect(results).toHaveLength(4);

			// Books with authors should have the author's name
			expect(results[0].authorName).toBe("Frank Herbert");
			expect(results[1].authorName).toBe("William Gibson");
			expect(results[2].authorName).toBe("Ursula K. Le Guin");

			// Book without authorId should still have "Unknown"
			expect(results[3].authorName).toBe("Unknown");
		});

		it("should access nested populated fields (author.nationality)", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(populateComputedConfig, {
					books: testBooks,
					authors: testAuthors,
				}),
			);

			const results = await db.books
				.query({
					populate: { author: true },
					sort: { id: "asc" },
				})
				.runPromise;

			// Authors with nationality
			expect(results[0].authorNationality).toBe("American");
			expect(results[1].authorNationality).toBe("Canadian");

			// Author without nationality (Ursula K. Le Guin)
			expect(results[2].authorNationality).toBe("Unknown");

			// Book without author
			expect(results[3].authorNationality).toBe("Unknown");
		});

		it("should combine stored and populated fields in computed field", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(populateComputedConfig, {
					books: testBooks,
					authors: testAuthors,
				}),
			);

			const results = await db.books
				.query({
					populate: { author: true },
					sort: { id: "asc" },
				})
				.runPromise;

			// fullDisplay combines title (stored), year (stored), author.name (populated)
			expect(results[0].fullDisplay).toBe("Dune (1965) by Frank Herbert");
			expect(results[1].fullDisplay).toBe("Neuromancer (1984) by William Gibson");
			expect(results[2].fullDisplay).toBe(
				"The Left Hand of Darkness (1969) by Ursula K. Le Guin",
			);
			expect(results[3].fullDisplay).toBe("Unknown Book (2000) by Unknown");
		});

		it("should filter by computed field derived from populated data", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(populateComputedConfig, {
					books: testBooks,
					authors: testAuthors,
				}),
			);

			// Filter for books by Frank Herbert
			const results = await db.books
				.query({
					populate: { author: true },
					where: { authorName: "Frank Herbert" },
				})
				.runPromise;

			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Dune");
		});

		it("should filter by computed field with $contains on populated data", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(populateComputedConfig, {
					books: testBooks,
					authors: testAuthors,
				}),
			);

			// Filter for books where authorName contains "Gibson"
			const results = await db.books
				.query({
					populate: { author: true },
					where: { authorName: { $contains: "Gibson" } },
				})
				.runPromise;

			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Neuromancer");
		});

		it("should sort by computed field derived from populated data", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(populateComputedConfig, {
					books: testBooks,
					authors: testAuthors,
				}),
			);

			const results = await db.books
				.query({
					populate: { author: true },
					sort: { authorName: "asc" },
				})
				.runPromise;

			// Sorted by authorName ascending: Frank Herbert, Unknown, Ursula K. Le Guin, William Gibson
			expect(results).toHaveLength(4);
			expect(results[0].authorName).toBe("Frank Herbert");
			expect(results[1].authorName).toBe("Unknown"); // Unknown sorts between F and U
			expect(results[2].authorName).toBe("Ursula K. Le Guin");
			expect(results[3].authorName).toBe("William Gibson");
		});

		it("should select computed fields derived from populated data", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(populateComputedConfig, {
					books: testBooks,
					authors: testAuthors,
				}),
			);

			const results = await db.books
				.query({
					populate: { author: true },
					select: { title: true, authorName: true },
					sort: { id: "asc" },
				})
				.runPromise;

			expect(results).toHaveLength(4);

			// Only selected fields should be present
			for (const result of results) {
				expect(Object.keys(result).sort()).toEqual(["authorName", "title"]);
			}

			expect(results[0]).toEqual({ title: "Dune", authorName: "Frank Herbert" });
			expect(results[1]).toEqual({
				title: "Neuromancer",
				authorName: "William Gibson",
			});
		});

		it("should handle combined filter + sort + select with population-based computed fields", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(populateComputedConfig, {
					books: testBooks,
					authors: testAuthors,
				}),
			);

			// Filter for books where authorNationality is not "Unknown"
			// Sort by fullDisplay descending
			// Select specific fields
			const results = await db.books
				.query({
					populate: { author: true },
					where: { authorNationality: { $ne: "Unknown" } },
					sort: { fullDisplay: "asc" },
					select: { title: true, authorName: true, fullDisplay: true },
				})
				.runPromise;

			// Only books with authors that have nationality: book1 (American), book2 (Canadian)
			expect(results).toHaveLength(2);

			// Sorted by fullDisplay ascending
			expect(results[0].fullDisplay).toBe("Dune (1965) by Frank Herbert");
			expect(results[1].fullDisplay).toBe("Neuromancer (1984) by William Gibson");
		});

		it("should handle book without authorId in query without populate", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(populateComputedConfig, {
					books: testBooks,
					authors: testAuthors,
				}),
			);

			// Query without populate for book without author
			const results = await db.books
				.query({ where: { id: "book4" } })
				.runPromise;

			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Unknown Book");
			// Without populate, all books use "Unknown" for author-derived computed fields
			expect(results[0].authorName).toBe("Unknown");
			expect(results[0].fullDisplay).toBe("Unknown Book (2000) by Unknown");
		});

		it("should handle book without authorId in query with populate", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(populateComputedConfig, {
					books: testBooks,
					authors: testAuthors,
				}),
			);

			// Query with populate for book without author
			const results = await db.books
				.query({
					populate: { author: true },
					where: { id: "book4" },
				})
				.runPromise;

			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Unknown Book");
			// Book has no authorId, so author is not populated, fallback is used
			expect(results[0].authorName).toBe("Unknown");
			expect(results[0].fullDisplay).toBe("Unknown Book (2000) by Unknown");
		});
	});

	// =========================================================================
	// Task 10.4: Test that create ignores computed field names in input
	// =========================================================================
	describe("Task 10.4: Create ignores computed field names in input", () => {
		const BookSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			year: Schema.Number,
		});

		type Book = typeof BookSchema.Type;

		const configWithComputed = {
			books: {
				schema: BookSchema,
				relationships: {},
				computed: {
					displayName: (book: Book) => `${book.title} (${book.year})`,
					isClassic: (book: Book) => book.year < 1980,
				},
			},
		} as const;

		it("should ignore computed field values provided in create input", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(configWithComputed, { books: [] }),
			);

			// Try to create with explicit computed field values
			// These should be ignored and the derivation function should be used
			const created = await db.books
				.create({
					id: "book1",
					title: "Dune",
					year: 1965,
					// @ts-expect-error - intentionally providing computed fields in input
					displayName: "WRONG VALUE",
					// @ts-expect-error - intentionally providing computed fields in input
					isClassic: false, // should be true since year < 1980
				})
				.runPromise;

			// Verify the created entity has stored fields only
			expect(created.id).toBe("book1");
			expect(created.title).toBe("Dune");
			expect(created.year).toBe(1965);
			// The computed fields should NOT be present on the stored entity
			expect(created).not.toHaveProperty("displayName");
			expect(created).not.toHaveProperty("isClassic");

			// Query to get the entity with computed fields
			const results = await db.books.query({ where: { id: "book1" } }).runPromise;
			expect(results).toHaveLength(1);

			// Computed fields should be derived from the actual data, not the provided values
			expect(results[0].displayName).toBe("Dune (1965)");
			expect(results[0].isClassic).toBe(true); // year 1965 < 1980, so true
		});

		it("should strip all computed field keys from create input", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(configWithComputed, { books: [] }),
			);

			// Create with computed fields in input (they should be stripped)
			await db.books
				.create({
					id: "book2",
					title: "Neuromancer",
					year: 1984,
					// @ts-expect-error - intentionally providing computed fields
					displayName: "Custom Display Name",
				})
				.runPromise;

			// Query and verify derived value is used
			const results = await db.books.query({ where: { id: "book2" } }).runPromise;
			expect(results).toHaveLength(1);
			expect(results[0].displayName).toBe("Neuromancer (1984)");
			expect(results[0].isClassic).toBe(false); // year 1984 >= 1980
		});

		it("should work correctly with createMany ignoring computed fields", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(configWithComputed, { books: [] }),
			);

			// Create multiple with computed fields in input (they should be stripped)
			const result = await db.books
				.createMany([
					{
						id: "book3",
						title: "Snow Crash",
						year: 1992,
						// @ts-expect-error - intentionally providing computed fields
						displayName: "Wrong Name",
						isClassic: true, // should be false
					},
					{
						id: "book4",
						title: "The Left Hand of Darkness",
						year: 1969,
						// @ts-expect-error - intentionally providing computed fields
						isClassic: false, // should be true
					},
				])
				.runPromise;

			expect(result.created).toHaveLength(2);

			// Query and verify derived values are correct
			const results = await db.books
				.query({ sort: { id: "asc" } })
				.runPromise;
			expect(results).toHaveLength(2);

			// Snow Crash (1992)
			expect(results[0].displayName).toBe("Snow Crash (1992)");
			expect(results[0].isClassic).toBe(false); // year 1992 >= 1980

			// The Left Hand of Darkness (1969)
			expect(results[1].displayName).toBe("The Left Hand of Darkness (1969)");
			expect(results[1].isClassic).toBe(true); // year 1969 < 1980
		});
	});

	// =========================================================================
	// Task 10.5: Test that update ignores computed field names in input
	// =========================================================================
	describe("Task 10.5: Update ignores computed field names in input", () => {
		const BookSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			year: Schema.Number,
			genre: Schema.optional(Schema.String),
		});

		type Book = typeof BookSchema.Type;

		const configWithComputed = {
			books: {
				schema: BookSchema,
				relationships: {},
				computed: {
					displayName: (book: Book) => `${book.title} (${book.year})`,
					isClassic: (book: Book) => book.year < 1980,
				},
			},
		} as const;

		it("should ignore computed field values provided in update input", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(configWithComputed, {
					books: [{ id: "book1", title: "Dune", year: 1965, genre: "sci-fi" }],
				}),
			);

			// Update with explicit computed field values
			// These should be ignored and the derivation function should be used
			const updated = await db.books
				.update("book1", {
					title: "Dune (Revised Edition)",
					// @ts-expect-error - intentionally providing computed fields in input
					displayName: "WRONG VALUE",
					// @ts-expect-error - intentionally providing computed fields in input
					isClassic: false, // should still be true since year < 1980
				})
				.runPromise;

			// Verify the updated entity has stored fields only
			expect(updated.id).toBe("book1");
			expect(updated.title).toBe("Dune (Revised Edition)");
			expect(updated.year).toBe(1965); // unchanged
			// The computed fields should NOT be present on the stored entity
			expect(updated).not.toHaveProperty("displayName");
			expect(updated).not.toHaveProperty("isClassic");

			// Query to get the entity with computed fields
			const results = await db.books.query({ where: { id: "book1" } }).runPromise;
			expect(results).toHaveLength(1);

			// Computed fields should be derived from the actual data, not the provided values
			expect(results[0].displayName).toBe("Dune (Revised Edition) (1965)");
			expect(results[0].isClassic).toBe(true); // year 1965 < 1980, so true
		});

		it("should strip all computed field keys from update input", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(configWithComputed, {
					books: [{ id: "book2", title: "Neuromancer", year: 1984, genre: "cyberpunk" }],
				}),
			);

			// Update with computed fields in input (they should be stripped)
			await db.books
				.update("book2", {
					year: 1985, // changing year changes isClassic and displayName
					// @ts-expect-error - intentionally providing computed fields
					displayName: "Custom Display Name",
				})
				.runPromise;

			// Query and verify derived value is used
			const results = await db.books.query({ where: { id: "book2" } }).runPromise;
			expect(results).toHaveLength(1);
			expect(results[0].displayName).toBe("Neuromancer (1985)");
			expect(results[0].isClassic).toBe(false); // year 1985 >= 1980
		});

		it("should update stored fields correctly while ignoring computed fields", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(configWithComputed, {
					books: [{ id: "book3", title: "Snow Crash", year: 1992, genre: "sci-fi" }],
				}),
			);

			// Update year to make the book a "classic" (year < 1980)
			// But try to pass isClassic: false - this should be IGNORED
			await db.books
				.update("book3", {
					year: 1970, // This makes isClassic = true
					// @ts-expect-error - intentionally providing computed fields
					isClassic: false, // WRONG - should be true
				})
				.runPromise;

			// Query and verify derived values
			const results = await db.books.query({ where: { id: "book3" } }).runPromise;
			expect(results).toHaveLength(1);
			expect(results[0].year).toBe(1970);
			expect(results[0].displayName).toBe("Snow Crash (1970)");
			expect(results[0].isClassic).toBe(true); // year 1970 < 1980
		});

		it("should preserve unmodified stored fields when updating with computed field attempts", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(configWithComputed, {
					books: [{ id: "book4", title: "The Left Hand of Darkness", year: 1969, genre: "sci-fi" }],
				}),
			);

			// Get initial state
			const initial = await db.books.query({ where: { id: "book4" } }).runPromise;
			expect(initial[0].title).toBe("The Left Hand of Darkness");
			expect(initial[0].year).toBe(1969);
			expect(initial[0].genre).toBe("sci-fi");

			// Update only genre, but try to pass computed fields too
			await db.books
				.update("book4", {
					genre: "speculative fiction",
					// @ts-expect-error - intentionally providing computed fields
					displayName: "WRONG NAME",
					// @ts-expect-error - intentionally providing computed fields
					isClassic: false,
				})
				.runPromise;

			// Query and verify
			const results = await db.books.query({ where: { id: "book4" } }).runPromise;
			expect(results).toHaveLength(1);

			// Stored fields
			expect(results[0].title).toBe("The Left Hand of Darkness"); // unchanged
			expect(results[0].year).toBe(1969); // unchanged
			expect(results[0].genre).toBe("speculative fiction"); // updated

			// Computed fields derived correctly
			expect(results[0].displayName).toBe("The Left Hand of Darkness (1969)");
			expect(results[0].isClassic).toBe(true); // year 1969 < 1980
		});

		it("should work correctly with multiple updates ignoring computed fields", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(configWithComputed, {
					books: [{ id: "book5", title: "Project Hail Mary", year: 2021, genre: "sci-fi" }],
				}),
			);

			// First update
			await db.books
				.update("book5", {
					title: "Project Hail Mary (Updated)",
					// @ts-expect-error - intentionally providing computed fields
					displayName: "WRONG1",
				})
				.runPromise;

			let results = await db.books.query({ where: { id: "book5" } }).runPromise;
			expect(results[0].displayName).toBe("Project Hail Mary (Updated) (2021)");
			expect(results[0].isClassic).toBe(false);

			// Second update - change year to before 1980
			await db.books
				.update("book5", {
					year: 1975,
					// @ts-expect-error - intentionally providing computed fields
					isClassic: false, // WRONG - should be true
				})
				.runPromise;

			results = await db.books.query({ where: { id: "book5" } }).runPromise;
			expect(results[0].displayName).toBe("Project Hail Mary (Updated) (1975)");
			expect(results[0].isClassic).toBe(true); // year 1975 < 1980
		});
	});

	// =========================================================================
	// Task 10.2: Computed field on empty collection — no errors, empty results
	// =========================================================================
	describe("Task 10.2: Computed field on empty collection", () => {
		const BookSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			year: Schema.Number,
		});

		type Book = typeof BookSchema.Type;

		const emptyCollectionConfig = {
			books: {
				schema: BookSchema,
				relationships: {},
				computed: {
					displayName: (book: Book) => `${book.title} (${book.year})`,
					isClassic: (book: Book) => book.year < 1980,
					decade: (book: Book) => Math.floor(book.year / 10) * 10,
				},
			},
		} as const;

		it("should return empty array when querying empty collection with computed fields", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(emptyCollectionConfig, { books: [] }),
			);

			const results = await db.books.query().runPromise;

			expect(results).toEqual([]);
			expect(results).toHaveLength(0);
		});

		it("should return empty array when filtering empty collection with computed fields", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(emptyCollectionConfig, { books: [] }),
			);

			const results = await db.books
				.query({ where: { isClassic: true } })
				.runPromise;

			expect(results).toEqual([]);
		});

		it("should return empty array when sorting empty collection by computed field", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(emptyCollectionConfig, { books: [] }),
			);

			const results = await db.books
				.query({ sort: { displayName: "asc" } })
				.runPromise;

			expect(results).toEqual([]);
		});

		it("should return empty array when selecting computed fields from empty collection", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(emptyCollectionConfig, { books: [] }),
			);

			const results = await db.books
				.query({ select: { title: true, displayName: true, isClassic: true } })
				.runPromise;

			expect(results).toEqual([]);
		});

		it("should return empty array with combined filter, sort, select on empty collection", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(emptyCollectionConfig, { books: [] }),
			);

			const results = await db.books
				.query({
					where: { isClassic: true },
					sort: { displayName: "desc" },
					select: { title: true, displayName: true },
				})
				.runPromise;

			expect(results).toEqual([]);
		});

		it("should work with pagination on empty collection with computed fields", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(emptyCollectionConfig, { books: [] }),
			);

			const results = await db.books
				.query({ limit: 10, offset: 0 })
				.runPromise;

			expect(results).toEqual([]);
		});

		it("should allow adding items to empty collection and computed fields work correctly", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(emptyCollectionConfig, { books: [] }),
			);

			// Verify empty first
			const emptyResults = await db.books.query().runPromise;
			expect(emptyResults).toHaveLength(0);

			// Add an item
			await db.books
				.create({ id: "book1", title: "Dune", year: 1965 })
				.runPromise;

			// Query should now return the item with computed fields
			const results = await db.books.query().runPromise;
			expect(results).toHaveLength(1);
			expect(results[0].displayName).toBe("Dune (1965)");
			expect(results[0].isClassic).toBe(true);
			expect(results[0].decade).toBe(1960);
		});

		it("should handle findById returning NotFoundError on empty collection with computed fields", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(emptyCollectionConfig, { books: [] }),
			);

			const result = await Effect.runPromise(
				db.books.findById("nonexistent").pipe(
					Effect.map(() => "found" as const),
					Effect.catchTag("NotFoundError", () => Effect.succeed("not_found" as const)),
				),
			);

			expect(result).toBe("not_found");
		});
	});

	// =========================================================================
	// Task 10.6: Persistence round-trip - save, reload, verify computed fields
	// re-derive correctly through the full query pipeline
	// =========================================================================
	describe("Task 10.6: Persistence round-trip with computed fields", () => {
		// Helper to create test layer with in-memory storage
		const makeTestLayer = (store?: Map<string, string>) => {
			const s = store ?? new Map<string, string>();
			return {
				store: s,
				layer: Layer.merge(
					makeInMemoryStorageLayer(s),
					makeSerializerLayer([jsonCodec(), yamlCodec()]),
				),
			};
		};

		// Book schema - stored fields only
		const PersistentBookSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			year: Schema.Number,
			genre: Schema.String,
			authorId: Schema.optional(Schema.String),
			createdAt: Schema.optional(Schema.String),
			updatedAt: Schema.optional(Schema.String),
		});

		// Author schema
		const PersistentAuthorSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			createdAt: Schema.optional(Schema.String),
			updatedAt: Schema.optional(Schema.String),
		});

		type PersistentBook = typeof PersistentBookSchema.Type;

		// Persistent config with computed fields - JSON format
		const persistentConfig = {
			books: {
				schema: PersistentBookSchema,
				file: "/data/books.json",
				relationships: {
					author: {
						type: "ref" as const,
						target: "authors" as const,
						foreignKey: "authorId",
					},
				},
				computed: {
					displayName: (book: PersistentBook) => `${book.title} (${book.year})`,
					isClassic: (book: PersistentBook) => book.year < 1980,
					yearsSincePublication: (book: PersistentBook) => 2024 - book.year,
				},
			},
			authors: {
				schema: PersistentAuthorSchema,
				file: "/data/authors.json",
				relationships: {
					books: {
						type: "inverse" as const,
						target: "books" as const,
						foreignKey: "authorId",
					},
				},
			},
		} as const;

		// YAML variant for format coverage
		const persistentConfigYaml = {
			books: {
				schema: PersistentBookSchema,
				file: "/data/books.yaml",
				relationships: {
					author: {
						type: "ref" as const,
						target: "authors" as const,
						foreignKey: "authorId",
					},
				},
				computed: {
					displayName: (book: PersistentBook) => `${book.title} (${book.year})`,
					isClassic: (book: PersistentBook) => book.year < 1980,
				},
			},
			authors: {
				schema: PersistentAuthorSchema,
				file: "/data/authors.yaml",
				relationships: {
					books: {
						type: "inverse" as const,
						target: "books" as const,
						foreignKey: "authorId",
					},
				},
			},
		} as const;

		it("should re-derive computed fields automatically after save and reload (JSON)", async () => {
			const { store, layer } = makeTestLayer();

			// Phase 1: Create database, add entities, persist to disk
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								persistentConfig,
								{
									books: [],
									authors: [{ id: "author1", name: "Frank Herbert" }],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						// Create books with varying years (affects computed fields)
						yield* db.books.createMany([
							{
								id: "book1",
								title: "Dune",
								year: 1965,
								genre: "sci-fi",
								authorId: "author1",
							},
							{
								id: "book2",
								title: "Neuromancer",
								year: 1984,
								genre: "sci-fi",
								authorId: "author1",
							},
							{
								id: "book3",
								title: "Snow Crash",
								year: 1992,
								genre: "sci-fi",
								authorId: "author1",
							},
						]);

						// Flush to ensure all data is persisted
						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Verify data was persisted (stored fields only - no computed)
			expect(store.has("/data/books.json")).toBe(true);
			const persistedContent = store.get("/data/books.json")!;
			expect(persistedContent).toContain('"Dune"');
			expect(persistedContent).not.toContain('"displayName"');
			expect(persistedContent).not.toContain('"isClassic"');

			// Phase 2: Create a fresh database instance that loads from the stored data
			// and verify computed fields are automatically re-derived through query()
			const results = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								persistentConfig,
								{
									books: [],
									authors: [{ id: "author1", name: "Frank Herbert" }],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						// Use query() which should automatically resolve computed fields
						// Note: query() returns a RunnableStream, so we need Stream.runCollect
						const chunk = yield* Stream.runCollect(
							db.books.query({ sort: { id: "asc" } }),
						);
						return Chunk.toReadonlyArray(chunk);
					}),
				),
			);

			// Verify computed fields are present and correctly derived
			expect(results).toHaveLength(3);

			// Dune (1965) - classic
			expect(results[0].title).toBe("Dune");
			expect(results[0].displayName).toBe("Dune (1965)");
			expect(results[0].isClassic).toBe(true);
			expect(results[0].yearsSincePublication).toBe(2024 - 1965);

			// Neuromancer (1984) - not classic
			expect(results[1].title).toBe("Neuromancer");
			expect(results[1].displayName).toBe("Neuromancer (1984)");
			expect(results[1].isClassic).toBe(false);
			expect(results[1].yearsSincePublication).toBe(2024 - 1984);

			// Snow Crash (1992) - not classic
			expect(results[2].title).toBe("Snow Crash");
			expect(results[2].displayName).toBe("Snow Crash (1992)");
			expect(results[2].isClassic).toBe(false);
			expect(results[2].yearsSincePublication).toBe(2024 - 1992);
		});

		it("should re-derive computed fields automatically after save and reload (YAML)", async () => {
			const { store, layer } = makeTestLayer();

			// Phase 1: Create database, add entities, persist to YAML
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								persistentConfigYaml,
								{
									books: [],
									authors: [{ id: "author1", name: "Frank Herbert" }],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						yield* db.books.create({
							id: "book1",
							title: "The Left Hand of Darkness",
							year: 1969,
							genre: "sci-fi",
							authorId: "author1",
						});

						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Verify YAML was persisted without computed fields
			expect(store.has("/data/books.yaml")).toBe(true);
			const yamlContent = store.get("/data/books.yaml")!;
			expect(yamlContent).toContain("Left Hand of Darkness");
			expect(yamlContent).not.toContain("displayName:");
			expect(yamlContent).not.toContain("isClassic:");

			// Phase 2: Reload and verify computed fields through query()
			const results = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								persistentConfigYaml,
								{
									books: [],
									authors: [{ id: "author1", name: "Frank Herbert" }],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						const chunk = yield* Stream.runCollect(db.books.query({}));
						return Chunk.toReadonlyArray(chunk);
					}),
				),
			);

			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("The Left Hand of Darkness");
			expect(results[0].displayName).toBe("The Left Hand of Darkness (1969)");
			expect(results[0].isClassic).toBe(true);
		});

		it("should filter by computed fields after reload", async () => {
			const { store, layer } = makeTestLayer();

			// Phase 1: Persist books to storage
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								persistentConfig,
								{
									books: [],
									authors: [{ id: "author1", name: "Frank Herbert" }],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						yield* db.books.createMany([
							{
								id: "book1",
								title: "Dune",
								year: 1965,
								genre: "sci-fi",
								authorId: "author1",
							},
							{
								id: "book2",
								title: "Neuromancer",
								year: 1984,
								genre: "sci-fi",
								authorId: "author1",
							},
							{
								id: "book3",
								title: "Foundation",
								year: 1951,
								genre: "sci-fi",
								authorId: "author1",
							},
						]);

						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Phase 2: Reload and filter by computed field
			const classics = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								persistentConfig,
								{
									books: [],
									authors: [{ id: "author1", name: "Frank Herbert" }],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						// Filter by computed field isClassic
						const chunk = yield* Stream.runCollect(
							db.books.query({ where: { isClassic: true } }),
						);
						return Chunk.toReadonlyArray(chunk);
					}),
				),
			);

			// Only Dune (1965) and Foundation (1951) are classics
			expect(classics).toHaveLength(2);
			const titles = classics.map((b) => b.title);
			expect(titles).toContain("Dune");
			expect(titles).toContain("Foundation");
			expect(titles).not.toContain("Neuromancer");
		});

		it("should sort by computed fields after reload", async () => {
			const { store, layer } = makeTestLayer();

			// Phase 1: Persist books to storage
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								persistentConfig,
								{
									books: [],
									authors: [{ id: "author1", name: "Frank Herbert" }],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						yield* db.books.createMany([
							{
								id: "book1",
								title: "Dune",
								year: 1965,
								genre: "sci-fi",
								authorId: "author1",
							},
							{
								id: "book2",
								title: "Neuromancer",
								year: 1984,
								genre: "sci-fi",
								authorId: "author1",
							},
							{
								id: "book3",
								title: "Foundation",
								year: 1951,
								genre: "sci-fi",
								authorId: "author1",
							},
						]);

						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Phase 2: Reload and sort by computed field
			const sorted = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								persistentConfig,
								{
									books: [],
									authors: [{ id: "author1", name: "Frank Herbert" }],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						// Sort by computed field displayName ascending
						const chunk = yield* Stream.runCollect(
							db.books.query({ sort: { displayName: "asc" } }),
						);
						return Chunk.toReadonlyArray(chunk);
					}),
				),
			);

			// Should be sorted alphabetically by displayName
			expect(sorted).toHaveLength(3);
			expect(sorted[0].displayName).toBe("Dune (1965)");
			expect(sorted[1].displayName).toBe("Foundation (1951)");
			expect(sorted[2].displayName).toBe("Neuromancer (1984)");
		});

		it("should handle update-persist-reload cycle with computed field re-derivation", async () => {
			const { store, layer } = makeTestLayer();

			// Phase 1: Create and persist
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								persistentConfig,
								{
									books: [],
									authors: [{ id: "author1", name: "Frank Herbert" }],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						yield* db.books.create({
							id: "book1",
							title: "Dune",
							year: 1985, // Initially 1985, not a classic
							genre: "sci-fi",
							authorId: "author1",
						});

						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Phase 2: Reload, verify initial state, update, persist
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								persistentConfig,
								{
									books: [],
									authors: [{ id: "author1", name: "Frank Herbert" }],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						// Verify initial computed state through query()
						const initialChunk = yield* Stream.runCollect(
							db.books.query({ where: { id: "book1" } }),
						);
						const initial = Chunk.toReadonlyArray(initialChunk);
						expect(initial).toHaveLength(1);
						expect(initial[0].isClassic).toBe(false);
						expect(initial[0].displayName).toBe("Dune (1985)");

						// Update to make it a classic
						yield* db.books.update("book1", { year: 1965 });

						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Phase 3: Reload again and verify computed fields are re-derived with updated data
			const finalResults = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								persistentConfig,
								{
									books: [],
									authors: [{ id: "author1", name: "Frank Herbert" }],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						const chunk = yield* Stream.runCollect(
							db.books.query({ where: { id: "book1" } }),
						);
						return Chunk.toReadonlyArray(chunk);
					}),
				),
			);

			// Now should be a classic with updated displayName
			expect(finalResults).toHaveLength(1);
			expect(finalResults[0].year).toBe(1965);
			expect(finalResults[0].isClassic).toBe(true);
			expect(finalResults[0].displayName).toBe("Dune (1965)");
			expect(finalResults[0].yearsSincePublication).toBe(2024 - 1965);
		});

		it("should select computed fields correctly after reload", async () => {
			const { store, layer } = makeTestLayer();

			// Phase 1: Persist
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								persistentConfig,
								{
									books: [],
									authors: [{ id: "author1", name: "Frank Herbert" }],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						yield* db.books.create({
							id: "book1",
							title: "Dune",
							year: 1965,
							genre: "sci-fi",
							authorId: "author1",
						});

						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Phase 2: Reload and select specific fields including computed
			const results = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								persistentConfig,
								{
									books: [],
									authors: [{ id: "author1", name: "Frank Herbert" }],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						const chunk = yield* Stream.runCollect(
							db.books.query({
								select: { title: true, displayName: true, isClassic: true },
							}),
						);
						return Chunk.toReadonlyArray(chunk);
					}),
				),
			);

			expect(results).toHaveLength(1);
			expect(Object.keys(results[0]).sort()).toEqual([
				"displayName",
				"isClassic",
				"title",
			]);
			expect(results[0].title).toBe("Dune");
			expect(results[0].displayName).toBe("Dune (1965)");
			expect(results[0].isClassic).toBe(true);
		});

		it("should handle combined filter + sort + select with computed fields after reload", async () => {
			const { store, layer } = makeTestLayer();

			// Phase 1: Persist
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								persistentConfig,
								{
									books: [],
									authors: [{ id: "author1", name: "Frank Herbert" }],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						yield* db.books.createMany([
							{
								id: "book1",
								title: "Dune",
								year: 1965,
								genre: "sci-fi",
								authorId: "author1",
							},
							{
								id: "book2",
								title: "Neuromancer",
								year: 1984,
								genre: "sci-fi",
								authorId: "author1",
							},
							{
								id: "book3",
								title: "Foundation",
								year: 1951,
								genre: "sci-fi",
								authorId: "author1",
							},
							{
								id: "book4",
								title: "Snow Crash",
								year: 1992,
								genre: "sci-fi",
								authorId: "author1",
							},
						]);

						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			// Phase 2: Reload with combined query operations using computed fields
			const results = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(
								persistentConfig,
								{
									books: [],
									authors: [{ id: "author1", name: "Frank Herbert" }],
								},
								{ writeDebounce: 10 },
							),
							layer,
						);

						const chunk = yield* Stream.runCollect(
							db.books.query({
								where: { isClassic: false }, // Non-classics only
								sort: { displayName: "asc" }, // Sort by computed field
								select: { title: true, displayName: true, isClassic: true },
							}),
						);
						return Chunk.toReadonlyArray(chunk);
					}),
				),
			);

			// Only non-classics: Neuromancer (1984), Snow Crash (1992)
			expect(results).toHaveLength(2);
			// Sorted by displayName ascending
			expect(results[0].displayName).toBe("Neuromancer (1984)");
			expect(results[1].displayName).toBe("Snow Crash (1992)");
			// All should have isClassic: false
			expect(results.every((r) => r.isClassic === false)).toBe(true);
		});
	});
});
