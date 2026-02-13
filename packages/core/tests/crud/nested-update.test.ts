import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { createEffectDatabase } from "../../src/factories/database-effect";
import type { GenerateDatabase } from "../../src/types/types";

/**
 * Schema with nested metadata object for testing deep merge updates.
 */
const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	genre: Schema.String,
	metadata: Schema.Struct({
		views: Schema.Number,
		rating: Schema.Number,
		tags: Schema.Array(Schema.String),
		description: Schema.optional(Schema.String),
		featured: Schema.optional(Schema.Boolean),
		popularity: Schema.optional(Schema.Number),
	}),
	author: Schema.optional(
		Schema.Struct({
			name: Schema.String,
			country: Schema.String,
		}),
	),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
});

const config = {
	books: {
		schema: BookSchema,
		relationships: {},
	},
} as const;

describe("Nested Schema Update Operations", () => {
	let db: GenerateDatabase<typeof config>;
	let now: string;

	beforeEach(async () => {
		now = new Date().toISOString();
		db = await Effect.runPromise(
			createEffectDatabase(config, {
				books: [
					{
						id: "book1",
						title: "Dune",
						genre: "sci-fi",
						metadata: {
							views: 150,
							rating: 5,
							tags: ["classic", "epic"],
							description: "A desert planet story",
							featured: true,
						},
						author: {
							name: "Frank Herbert",
							country: "USA",
						},
						createdAt: now,
						updatedAt: now,
					},
					{
						id: "book2",
						title: "Neuromancer",
						genre: "sci-fi",
						metadata: {
							views: 80,
							rating: 4,
							tags: ["cyberpunk"],
							description: "Hacking adventure",
							featured: false,
						},
						author: {
							name: "William Gibson",
							country: "USA",
						},
						createdAt: now,
						updatedAt: now,
					},
				],
			}),
		);
	});

	describe("deep merge updates", () => {
		it("should preserve sibling nested fields when updating one nested field (task 4.3)", async () => {
			// Update only metadata.views, should preserve metadata.rating and metadata.tags
			const result = await db.books.update("book1", {
				metadata: { views: 500 },
			}).runPromise;

			expect(result.metadata.views).toBe(500);
			expect(result.metadata.rating).toBe(5); // preserved
			expect(result.metadata.tags).toEqual(["classic", "epic"]); // preserved
			expect(result.metadata.description).toBe("A desert planet story"); // preserved
			expect(result.metadata.featured).toBe(true); // preserved

			// Verify in database
			const found = await db.books.findById("book1").runPromise;
			expect(found.metadata.views).toBe(500);
			expect(found.metadata.rating).toBe(5);
			expect(found.metadata.tags).toEqual(["classic", "epic"]);
		});

		it("should apply $increment operator on nested field while preserving siblings (task 4.4)", async () => {
			// Initial metadata.views is 150
			const result = await db.books.update("book1", {
				metadata: { views: { $increment: 1 } },
			}).runPromise;

			expect(result.metadata.views).toBe(151); // incremented by 1
			expect(result.metadata.rating).toBe(5); // preserved
			expect(result.metadata.tags).toEqual(["classic", "epic"]); // preserved
			expect(result.metadata.description).toBe("A desert planet story"); // preserved
			expect(result.metadata.featured).toBe(true); // preserved

			// Apply another increment
			const result2 = await db.books.update("book1", {
				metadata: { views: { $increment: 10 } },
			}).runPromise;

			expect(result2.metadata.views).toBe(161); // incremented by 10 from 151
			expect(result2.metadata.rating).toBe(5); // still preserved

			// Verify in database
			const found = await db.books.findById("book1").runPromise;
			expect(found.metadata.views).toBe(161);
			expect(found.metadata.rating).toBe(5);
			expect(found.metadata.tags).toEqual(["classic", "epic"]);
		});

		it("should replace entire nested object when using $set at object level (task 4.5)", async () => {
			// Using $set at the nested object level should replace the entire object
			// This means { metadata: { $set: { views: 0 } } } replaces metadata entirely
			const result = await db.books.update("book1", {
				metadata: { $set: { views: 0, rating: 1, tags: [] } },
			}).runPromise;

			// metadata should be completely replaced with only the $set value
			expect(result.metadata).toEqual({ views: 0, rating: 1, tags: [] });
			// Previous fields that weren't in $set should NOT be present
			expect(result.metadata.description).toBeUndefined();
			expect(result.metadata.featured).toBeUndefined();

			// Verify in database
			const found = await db.books.findById("book1").runPromise;
			expect(found.metadata).toEqual({ views: 0, rating: 1, tags: [] });
		});

		it("should handle mixed nested + flat update (task 4.6)", async () => {
			// Update both a top-level field (title) and a nested field (metadata.rating)
			const result = await db.books.update("book1", {
				title: "New Title",
				metadata: { rating: 5 },
			}).runPromise;

			// Flat field should be updated
			expect(result.title).toBe("New Title");
			// Nested field should be updated
			expect(result.metadata.rating).toBe(5);
			// Other nested fields should be preserved
			expect(result.metadata.views).toBe(150);
			expect(result.metadata.tags).toEqual(["classic", "epic"]);
			expect(result.metadata.description).toBe("A desert planet story");
			expect(result.metadata.featured).toBe(true);
			// Other flat fields should be preserved
			expect(result.genre).toBe("sci-fi");

			// Verify in database
			const found = await db.books.findById("book1").runPromise;
			expect(found.title).toBe("New Title");
			expect(found.metadata.rating).toBe(5);
			expect(found.metadata.views).toBe(150);
			expect(found.genre).toBe("sci-fi");
		});

		it("should apply $append operator on nested string field (task 4.7)", async () => {
			// Initial metadata.description is "A desert planet story"
			const result = await db.books.update("book1", {
				metadata: { description: { $append: " (Updated)" } },
			}).runPromise;

			expect(result.metadata.description).toBe(
				"A desert planet story (Updated)",
			);
			// Other nested fields should be preserved
			expect(result.metadata.views).toBe(150);
			expect(result.metadata.rating).toBe(5);
			expect(result.metadata.tags).toEqual(["classic", "epic"]);
			expect(result.metadata.featured).toBe(true);

			// Verify in database
			const found = await db.books.findById("book1").runPromise;
			expect(found.metadata.description).toBe(
				"A desert planet story (Updated)",
			);
			expect(found.metadata.views).toBe(150);
			expect(found.metadata.rating).toBe(5);
		});

		it("should apply $append operator on nested array field (task 4.8)", async () => {
			// Initial metadata.tags is ["classic", "epic"]
			const result = await db.books.update("book1", {
				metadata: { tags: { $append: "classic" } },
			}).runPromise;

			expect(result.metadata.tags).toEqual(["classic", "epic", "classic"]);
			// Other nested fields should be preserved
			expect(result.metadata.views).toBe(150);
			expect(result.metadata.rating).toBe(5);
			expect(result.metadata.description).toBe("A desert planet story");
			expect(result.metadata.featured).toBe(true);

			// Verify in database
			const found = await db.books.findById("book1").runPromise;
			expect(found.metadata.tags).toEqual(["classic", "epic", "classic"]);
			expect(found.metadata.views).toBe(150);
			expect(found.metadata.rating).toBe(5);
		});

		it("should apply $toggle operator on nested boolean field (task 4.9)", async () => {
			// Initial metadata.featured is true for book1
			const result = await db.books.update("book1", {
				metadata: { featured: { $toggle: true } },
			}).runPromise;

			expect(result.metadata.featured).toBe(false); // toggled from true to false
			// Other nested fields should be preserved
			expect(result.metadata.views).toBe(150);
			expect(result.metadata.rating).toBe(5);
			expect(result.metadata.tags).toEqual(["classic", "epic"]);
			expect(result.metadata.description).toBe("A desert planet story");

			// Verify in database
			const found = await db.books.findById("book1").runPromise;
			expect(found.metadata.featured).toBe(false);
			expect(found.metadata.views).toBe(150);
			expect(found.metadata.rating).toBe(5);

			// Toggle again to verify it works both ways
			const result2 = await db.books.update("book1", {
				metadata: { featured: { $toggle: true } },
			}).runPromise;

			expect(result2.metadata.featured).toBe(true); // toggled from false back to true
			expect(result2.metadata.views).toBe(150); // still preserved

			// Test on book2 which has featured: false
			const result3 = await db.books.update("book2", {
				metadata: { featured: { $toggle: true } },
			}).runPromise;

			expect(result3.metadata.featured).toBe(true); // toggled from false to true
			expect(result3.metadata.views).toBe(80); // preserved
			expect(result3.metadata.rating).toBe(4); // preserved
		});

		it("should add a new field to nested object when field does not exist (task 4.10)", async () => {
			// Initial metadata does NOT have 'popularity' field (it's optional in schema)
			// Verify initial state
			const initial = await db.books.findById("book1").runPromise;
			expect(initial.metadata.popularity).toBeUndefined();

			// Update with a new nested field that doesn't exist yet
			const result = await db.books.update("book1", {
				metadata: { popularity: 42 },
			}).runPromise;

			// New field should be added
			expect(result.metadata.popularity).toBe(42);
			// All existing nested fields should be preserved
			expect(result.metadata.views).toBe(150);
			expect(result.metadata.rating).toBe(5);
			expect(result.metadata.tags).toEqual(["classic", "epic"]);
			expect(result.metadata.description).toBe("A desert planet story");
			expect(result.metadata.featured).toBe(true);

			// Verify in database
			const found = await db.books.findById("book1").runPromise;
			expect(found.metadata.popularity).toBe(42);
			expect(found.metadata.views).toBe(150);
			expect(found.metadata.rating).toBe(5);
			expect(found.metadata.tags).toEqual(["classic", "epic"]);
			expect(found.metadata.description).toBe("A desert planet story");
			expect(found.metadata.featured).toBe(true);

			// Update the newly added field to verify it can be modified
			const result2 = await db.books.update("book1", {
				metadata: { popularity: 100 },
			}).runPromise;

			expect(result2.metadata.popularity).toBe(100);
			expect(result2.metadata.views).toBe(150); // still preserved
		});
	});

	describe("flat schema regression (task 4.11)", () => {
		/**
		 * These tests verify that flat schemas (schemas with no nested objects)
		 * behave identically after the deep merge update changes.
		 *
		 * This is a regression test to ensure the new deepMergeUpdates logic
		 * doesn't break existing flat schema behavior.
		 */

		// Define a flat schema (no nested objects)
		const FlatBookSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			genre: Schema.String,
			year: Schema.Number,
			inStock: Schema.Boolean,
			tags: Schema.Array(Schema.String),
			description: Schema.optional(Schema.String),
			rating: Schema.optional(Schema.Number),
			createdAt: Schema.optional(Schema.String),
			updatedAt: Schema.optional(Schema.String),
		});

		const flatConfig = {
			flatBooks: {
				schema: FlatBookSchema,
				relationships: {},
			},
		} as const;

		it("should update a single flat field without affecting others", async () => {
			const flatDb = await Effect.runPromise(
				createEffectDatabase(flatConfig, {
					flatBooks: [
						{
							id: "flat1",
							title: "Original Title",
							genre: "sci-fi",
							year: 2020,
							inStock: true,
							tags: ["space", "adventure"],
							description: "A space story",
							rating: 4,
						},
					],
				}),
			);

			const result = await flatDb.flatBooks.update("flat1", {
				title: "Updated Title",
			}).runPromise;

			// Updated field
			expect(result.title).toBe("Updated Title");
			// All other fields should be preserved
			expect(result.genre).toBe("sci-fi");
			expect(result.year).toBe(2020);
			expect(result.inStock).toBe(true);
			expect(result.tags).toEqual(["space", "adventure"]);
			expect(result.description).toBe("A space story");
			expect(result.rating).toBe(4);
		});

		it("should apply $increment operator on flat number field", async () => {
			const flatDb = await Effect.runPromise(
				createEffectDatabase(flatConfig, {
					flatBooks: [
						{
							id: "flat1",
							title: "Test Book",
							genre: "sci-fi",
							year: 2020,
							inStock: true,
							tags: ["tag1"],
							rating: 3,
						},
					],
				}),
			);

			const result = await flatDb.flatBooks.update("flat1", {
				rating: { $increment: 2 },
			}).runPromise;

			expect(result.rating).toBe(5);
			// Other fields preserved
			expect(result.year).toBe(2020);
			expect(result.title).toBe("Test Book");
		});

		it("should apply $decrement operator on flat number field", async () => {
			const flatDb = await Effect.runPromise(
				createEffectDatabase(flatConfig, {
					flatBooks: [
						{
							id: "flat1",
							title: "Test Book",
							genre: "sci-fi",
							year: 2020,
							inStock: true,
							tags: ["tag1"],
							rating: 5,
						},
					],
				}),
			);

			const result = await flatDb.flatBooks.update("flat1", {
				year: { $decrement: 10 },
			}).runPromise;

			expect(result.year).toBe(2010);
			expect(result.rating).toBe(5); // preserved
		});

		it("should apply $multiply operator on flat number field", async () => {
			const flatDb = await Effect.runPromise(
				createEffectDatabase(flatConfig, {
					flatBooks: [
						{
							id: "flat1",
							title: "Test Book",
							genre: "sci-fi",
							year: 100,
							inStock: true,
							tags: ["tag1"],
						},
					],
				}),
			);

			const result = await flatDb.flatBooks.update("flat1", {
				year: { $multiply: 20 },
			}).runPromise;

			expect(result.year).toBe(2000);
		});

		it("should apply $append operator on flat string field", async () => {
			const flatDb = await Effect.runPromise(
				createEffectDatabase(flatConfig, {
					flatBooks: [
						{
							id: "flat1",
							title: "Test Book",
							genre: "sci-fi",
							year: 2020,
							inStock: true,
							tags: ["tag1"],
							description: "A story about",
						},
					],
				}),
			);

			const result = await flatDb.flatBooks.update("flat1", {
				description: { $append: " space travel" },
			}).runPromise;

			expect(result.description).toBe("A story about space travel");
		});

		it("should apply $prepend operator on flat string field", async () => {
			const flatDb = await Effect.runPromise(
				createEffectDatabase(flatConfig, {
					flatBooks: [
						{
							id: "flat1",
							title: "Test Book",
							genre: "sci-fi",
							year: 2020,
							inStock: true,
							tags: ["tag1"],
							description: "about space travel",
						},
					],
				}),
			);

			const result = await flatDb.flatBooks.update("flat1", {
				description: { $prepend: "A story " },
			}).runPromise;

			expect(result.description).toBe("A story about space travel");
		});

		it("should apply $append operator on flat array field", async () => {
			const flatDb = await Effect.runPromise(
				createEffectDatabase(flatConfig, {
					flatBooks: [
						{
							id: "flat1",
							title: "Test Book",
							genre: "sci-fi",
							year: 2020,
							inStock: true,
							tags: ["sci-fi", "adventure"],
						},
					],
				}),
			);

			const result = await flatDb.flatBooks.update("flat1", {
				tags: { $append: "classic" },
			}).runPromise;

			expect(result.tags).toEqual(["sci-fi", "adventure", "classic"]);
		});

		it("should apply $prepend operator on flat array field", async () => {
			const flatDb = await Effect.runPromise(
				createEffectDatabase(flatConfig, {
					flatBooks: [
						{
							id: "flat1",
							title: "Test Book",
							genre: "sci-fi",
							year: 2020,
							inStock: true,
							tags: ["adventure"],
						},
					],
				}),
			);

			const result = await flatDb.flatBooks.update("flat1", {
				tags: { $prepend: "must-read" },
			}).runPromise;

			expect(result.tags).toEqual(["must-read", "adventure"]);
		});

		it("should apply $remove operator on flat array field", async () => {
			const flatDb = await Effect.runPromise(
				createEffectDatabase(flatConfig, {
					flatBooks: [
						{
							id: "flat1",
							title: "Test Book",
							genre: "sci-fi",
							year: 2020,
							inStock: true,
							tags: ["sci-fi", "adventure", "classic"],
						},
					],
				}),
			);

			const result = await flatDb.flatBooks.update("flat1", {
				tags: { $remove: "adventure" },
			}).runPromise;

			expect(result.tags).toEqual(["sci-fi", "classic"]);
		});

		it("should apply $toggle operator on flat boolean field", async () => {
			const flatDb = await Effect.runPromise(
				createEffectDatabase(flatConfig, {
					flatBooks: [
						{
							id: "flat1",
							title: "Test Book",
							genre: "sci-fi",
							year: 2020,
							inStock: true,
							tags: [],
						},
					],
				}),
			);

			const result = await flatDb.flatBooks.update("flat1", {
				inStock: { $toggle: true },
			}).runPromise;

			expect(result.inStock).toBe(false);

			// Toggle again
			const result2 = await flatDb.flatBooks.update("flat1", {
				inStock: { $toggle: true },
			}).runPromise;

			expect(result2.inStock).toBe(true);
		});

		it("should apply $set operator on flat fields", async () => {
			const flatDb = await Effect.runPromise(
				createEffectDatabase(flatConfig, {
					flatBooks: [
						{
							id: "flat1",
							title: "Test Book",
							genre: "sci-fi",
							year: 2020,
							inStock: true,
							tags: ["old-tag"],
						},
					],
				}),
			);

			const result = await flatDb.flatBooks.update("flat1", {
				title: { $set: "New Title" },
				tags: { $set: ["new-tag", "another"] },
				rating: { $set: 5 },
			}).runPromise;

			expect(result.title).toBe("New Title");
			expect(result.tags).toEqual(["new-tag", "another"]);
			expect(result.rating).toBe(5);
		});

		it("should apply multiple operators in a single update on flat schema", async () => {
			const flatDb = await Effect.runPromise(
				createEffectDatabase(flatConfig, {
					flatBooks: [
						{
							id: "flat1",
							title: "Original",
							genre: "sci-fi",
							year: 2020,
							inStock: false,
							tags: ["tag1"],
							rating: 3,
						},
					],
				}),
			);

			const result = await flatDb.flatBooks.update("flat1", {
				title: { $append: " (Updated)" },
				rating: { $increment: 1 },
				inStock: { $toggle: true },
				tags: { $append: "tag2" },
			}).runPromise;

			expect(result.title).toBe("Original (Updated)");
			expect(result.rating).toBe(4);
			expect(result.inStock).toBe(true);
			expect(result.tags).toEqual(["tag1", "tag2"]);
		});

		it("should update multiple flat fields directly without operators", async () => {
			const flatDb = await Effect.runPromise(
				createEffectDatabase(flatConfig, {
					flatBooks: [
						{
							id: "flat1",
							title: "Original",
							genre: "sci-fi",
							year: 2020,
							inStock: true,
							tags: ["tag1"],
						},
					],
				}),
			);

			const result = await flatDb.flatBooks.update("flat1", {
				title: "New Title",
				genre: "fantasy",
				year: 2024,
				inStock: false,
			}).runPromise;

			expect(result.title).toBe("New Title");
			expect(result.genre).toBe("fantasy");
			expect(result.year).toBe(2024);
			expect(result.inStock).toBe(false);
			// Unchanged field should be preserved
			expect(result.tags).toEqual(["tag1"]);
		});

		it("should preserve state after multiple sequential flat updates", async () => {
			const flatDb = await Effect.runPromise(
				createEffectDatabase(flatConfig, {
					flatBooks: [
						{
							id: "flat1",
							title: "Book",
							genre: "sci-fi",
							year: 2020,
							inStock: true,
							tags: ["tag1"],
							rating: 3,
						},
					],
				}),
			);

			// First update
			await flatDb.flatBooks.update("flat1", {
				title: "Updated Book",
			}).runPromise;

			// Second update
			await flatDb.flatBooks.update("flat1", {
				rating: { $increment: 1 },
			}).runPromise;

			// Third update
			await flatDb.flatBooks.update("flat1", {
				tags: { $append: "tag2" },
			}).runPromise;

			// Verify final state
			const final = await flatDb.flatBooks.findById("flat1").runPromise;
			expect(final.title).toBe("Updated Book");
			expect(final.rating).toBe(4);
			expect(final.tags).toEqual(["tag1", "tag2"]);
			// Unchanged fields
			expect(final.genre).toBe("sci-fi");
			expect(final.year).toBe(2020);
			expect(final.inStock).toBe(true);
		});

		it("should handle flat updateMany with operators", async () => {
			const flatDb = await Effect.runPromise(
				createEffectDatabase(flatConfig, {
					flatBooks: [
						{
							id: "flat1",
							title: "Book 1",
							genre: "sci-fi",
							year: 2020,
							inStock: true,
							tags: [],
							rating: 3,
						},
						{
							id: "flat2",
							title: "Book 2",
							genre: "sci-fi",
							year: 2021,
							inStock: false,
							tags: [],
							rating: 4,
						},
						{
							id: "flat3",
							title: "Book 3",
							genre: "fantasy",
							year: 2022,
							inStock: true,
							tags: [],
							rating: 5,
						},
					],
				}),
			);

			// Update all sci-fi books
			const result = await flatDb.flatBooks.updateMany(
				(b) => b.genre === "sci-fi",
				{
					rating: { $increment: 1 },
					tags: { $append: "updated" },
				},
			).runPromise;

			expect(result.count).toBe(2);
			expect(result.updated.map((b) => b.id).sort()).toEqual([
				"flat1",
				"flat2",
			]);
			expect(result.updated.every((b) => b.tags.includes("updated"))).toBe(
				true,
			);

			// Verify individual updates
			const book1 = await flatDb.flatBooks.findById("flat1").runPromise;
			expect(book1.rating).toBe(4); // 3 + 1

			const book2 = await flatDb.flatBooks.findById("flat2").runPromise;
			expect(book2.rating).toBe(5); // 4 + 1

			// Verify non-matching book was not updated
			const book3 = await flatDb.flatBooks.findById("flat3").runPromise;
			expect(book3.rating).toBe(5); // unchanged
			expect(book3.tags).toEqual([]); // unchanged
		});
	});
});
