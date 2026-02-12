/**
 * Property-based tests for filter (where clause) consistency.
 *
 * Task 4.1: Create this test file
 * Task 4.2: Property - query with arbitrary where clause returns exact matching subset
 * Task 4.3: Property - query with empty where clause returns all entities
 * Task 4.4: Implement reference matchesWhere function as test oracle
 *
 * These tests verify that the query filter system correctly implements the
 * where clause semantics: no false positives (entities that shouldn't match)
 * and no false negatives (entities that should match but are excluded).
 */
import { Chunk, Effect, Schema, Stream } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEffectDatabase } from "../../src/factories/database-effect";
import {
	entityArbitrary,
	getNumRuns,
	type GeneratedWhereClause,
	whereClauseArbitrary,
} from "./generators";

/**
 * Test schema for filter consistency tests.
 * Covers multiple field types to exercise different operator behaviors.
 */
const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	rating: Schema.Number,
	isPublished: Schema.Boolean,
	tags: Schema.Array(Schema.String),
	scores: Schema.Array(Schema.Number),
});

type Book = Schema.Schema.Type<typeof BookSchema>;

/**
 * Database config for the Book collection.
 */
const config = {
	books: {
		schema: BookSchema,
		relationships: {},
	},
} as const;

describe("Filter consistency properties", () => {
	describe("Task 4.1: Test file structure", () => {
		it("should have access to the required imports and generators", () => {
			// Verify entityArbitrary generates valid entities
			fc.assert(
				fc.property(entityArbitrary(BookSchema), (book) => {
					expect(typeof book.id).toBe("string");
					expect(typeof book.title).toBe("string");
					expect(typeof book.year).toBe("number");
					expect(typeof book.isPublished).toBe("boolean");
					expect(Array.isArray(book.tags)).toBe(true);
				}),
				{ numRuns: 10 },
			);

			// Verify whereClauseArbitrary generates valid where clauses
			fc.assert(
				fc.property(whereClauseArbitrary(BookSchema), (where) => {
					expect(typeof where).toBe("object");
					expect(where).not.toBeNull();
				}),
				{ numRuns: 10 },
			);
		});

		it("should be able to create a database and seed it with entities", async () => {
			const program = Effect.gen(function* () {
				const db = yield* createEffectDatabase(config, {
					books: [
						{
							id: "1",
							title: "Dune",
							author: "Frank Herbert",
							year: 1965,
							rating: 4.5,
							isPublished: true,
							tags: ["sci-fi", "classic"],
							scores: [95, 92, 88],
						},
					],
				});

				const chunk = yield* Stream.runCollect(db.books.query({}));
				const books = Chunk.toReadonlyArray(chunk);
				expect(books).toHaveLength(1);
				expect(books[0].title).toBe("Dune");
			});

			await Effect.runPromise(program);
		});
	});

	// Task 4.2 will add: Property tests for where clause correctness
	// Task 4.3 will add: Property tests for empty where clause returning all
	// Task 4.4 will add: Reference matchesWhere implementation as test oracle
});
