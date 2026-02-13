import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import type { EffectDatabase } from "../../src/factories/database-effect";
import { createEffectDatabase } from "../../src/factories/database-effect";

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
	let db: EffectDatabase<typeof config>;
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
	});
});
