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
	});
});
