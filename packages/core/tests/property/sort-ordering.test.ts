/**
 * Property-based tests for sort ordering invariants.
 *
 * Task 5.1: Create this test file
 * Task 5.2: Property - for any collection and sort configuration, every adjacent pair
 *           (a, b) in the sorted result satisfies a[field] <= b[field] (asc) or
 *           a[field] >= b[field] (desc)
 * Task 5.3: Property - entities with duplicate sort key values maintain consistent
 *           relative ordering across repeated runs with the same seed (sort stability)
 *
 * These tests verify that the query sort system correctly implements sort semantics:
 * elements are ordered according to the specified direction, and the sort is stable
 * for equal values.
 */
import { Chunk, Effect, Schema, Stream } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEffectDatabase } from "../../src/factories/database-effect";
import {
	entityArbitrary,
	getNumRuns,
	sortConfigArbitrary,
	type GeneratedSortConfig,
} from "./generators";

/**
 * Test schema for sort ordering tests.
 * Covers multiple field types to exercise different comparison behaviors.
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

describe("Sort ordering properties", () => {
	describe("Task 5.1: Test file structure", () => {
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

			// Verify sortConfigArbitrary generates valid sort configurations
			fc.assert(
				fc.property(sortConfigArbitrary(BookSchema), (sort) => {
					expect(typeof sort).toBe("object");
					expect(sort).not.toBeNull();
					// Each entry should be "asc" or "desc"
					for (const direction of Object.values(sort)) {
						expect(["asc", "desc"]).toContain(direction);
					}
				}),
				{ numRuns: 10 },
			);
		});

		it("should be able to create a database and query with sort", async () => {
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
						{
							id: "2",
							title: "Neuromancer",
							author: "William Gibson",
							year: 1984,
							rating: 4.3,
							isPublished: true,
							tags: ["sci-fi", "cyberpunk"],
							scores: [90, 88],
						},
					],
				});

				// Query with ascending sort on year
				const chunk = yield* Stream.runCollect(
					db.books.query({ sort: { year: "asc" } }),
				);
				const books = Chunk.toReadonlyArray(chunk);
				expect(books).toHaveLength(2);
				expect(books[0].year).toBe(1965);
				expect(books[1].year).toBe(1984);
			});

			await Effect.runPromise(program);
		});

		it("should be able to query with descending sort", async () => {
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
							tags: ["sci-fi"],
							scores: [95],
						},
						{
							id: "2",
							title: "Neuromancer",
							author: "William Gibson",
							year: 1984,
							rating: 4.3,
							isPublished: true,
							tags: ["sci-fi"],
							scores: [90],
						},
					],
				});

				// Query with descending sort on year
				const chunk = yield* Stream.runCollect(
					db.books.query({ sort: { year: "desc" } }),
				);
				const books = Chunk.toReadonlyArray(chunk);
				expect(books).toHaveLength(2);
				expect(books[0].year).toBe(1984);
				expect(books[1].year).toBe(1965);
			});

			await Effect.runPromise(program);
		});
	});

	// Task 5.2 and 5.3 tests will be added in subsequent tasks
});
