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
	matchesWhere,
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

	describe("Task 4.2: Query with arbitrary where clause returns exact matching subset", () => {
		/**
		 * This test uses the exported matchesWhere function from generators.ts
		 * as a reference implementation (test oracle). The implementation was
		 * extracted in task 4.4 to enable reuse across multiple property test files.
		 */

		it("should return exact matching subset for arbitrary where clauses", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate 1-20 entities for the collection
					fc.array(entityArbitrary(BookSchema), { minLength: 1, maxLength: 20 }),
					// Generate an arbitrary where clause
					whereClauseArbitrary(BookSchema),
					async (entities, where) => {
						// Create a fresh database with the generated entities
						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: entities,
							});

							// Query with the generated where clause
							const chunk = yield* Stream.runCollect(
								db.books.query({ where }),
							);
							const queryResults = Chunk.toReadonlyArray(chunk);

							// Calculate expected results using the reference implementation
							const expectedResults = entities.filter((entity) =>
								matchesWhere(entity, where),
							);

							// Verify: same count
							expect(queryResults.length).toBe(expectedResults.length);

							// Verify: same set of IDs (order may differ)
							const queryIds = new Set(queryResults.map((e) => e.id));
							const expectedIds = new Set(expectedResults.map((e) => e.id));
							expect(queryIds).toEqual(expectedIds);

							// Verify: no false inclusions
							for (const result of queryResults) {
								expect(matchesWhere(result, where)).toBe(true);
							}

							// Verify: no false exclusions
							for (const entity of entities) {
								const shouldMatch = matchesWhere(entity, where);
								const wasIncluded = queryIds.has(entity.id);
								expect(wasIncluded).toBe(shouldMatch);
							}
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should handle edge cases: single entity collections", async () => {
			await fc.assert(
				fc.asyncProperty(
					entityArbitrary(BookSchema),
					whereClauseArbitrary(BookSchema),
					async (entity, where) => {
						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: [entity],
							});

							const chunk = yield* Stream.runCollect(
								db.books.query({ where }),
							);
							const queryResults = Chunk.toReadonlyArray(chunk);

							const shouldMatch = matchesWhere(entity, where);

							if (shouldMatch) {
								expect(queryResults.length).toBe(1);
								expect(queryResults[0].id).toBe(entity.id);
							} else {
								expect(queryResults.length).toBe(0);
							}
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should be consistent across multiple queries with the same where clause", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(entityArbitrary(BookSchema), { minLength: 5, maxLength: 15 }),
					whereClauseArbitrary(BookSchema),
					async (entities, where) => {
						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: entities,
							});

							// Run the same query 3 times
							const chunk1 = yield* Stream.runCollect(
								db.books.query({ where }),
							);
							const results1 = Chunk.toReadonlyArray(chunk1);

							const chunk2 = yield* Stream.runCollect(
								db.books.query({ where }),
							);
							const results2 = Chunk.toReadonlyArray(chunk2);

							const chunk3 = yield* Stream.runCollect(
								db.books.query({ where }),
							);
							const results3 = Chunk.toReadonlyArray(chunk3);

							// All queries should return the same results
							const ids1 = new Set(results1.map((e) => e.id));
							const ids2 = new Set(results2.map((e) => e.id));
							const ids3 = new Set(results3.map((e) => e.id));

							expect(ids1).toEqual(ids2);
							expect(ids2).toEqual(ids3);
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() / 2 }, // Fewer runs since we're doing 3x queries
			);
		});
	});

	describe("Task 4.3: Query with empty where clause returns all entities", () => {
		it("should return all entities when where clause is empty object", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate 0-25 entities for the collection
					fc.array(entityArbitrary(BookSchema), { minLength: 0, maxLength: 25 }),
					async (entities) => {
						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: entities,
							});

							// Query with empty where clause
							const chunk = yield* Stream.runCollect(
								db.books.query({ where: {} }),
							);
							const queryResults = Chunk.toReadonlyArray(chunk);

							// All entities should be returned
							expect(queryResults.length).toBe(entities.length);

							// Verify same set of IDs
							const queryIds = new Set(queryResults.map((e) => e.id));
							const entityIds = new Set(entities.map((e) => e.id));
							expect(queryIds).toEqual(entityIds);
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should return all entities when where clause is undefined", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(entityArbitrary(BookSchema), { minLength: 0, maxLength: 25 }),
					async (entities) => {
						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: entities,
							});

							// Query with no where clause (undefined)
							const chunk = yield* Stream.runCollect(db.books.query({}));
							const queryResults = Chunk.toReadonlyArray(chunk);

							// All entities should be returned
							expect(queryResults.length).toBe(entities.length);

							// Verify same set of IDs
							const queryIds = new Set(queryResults.map((e) => e.id));
							const entityIds = new Set(entities.map((e) => e.id));
							expect(queryIds).toEqual(entityIds);
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should return an empty array for empty collection with any where clause", async () => {
			await fc.assert(
				fc.asyncProperty(whereClauseArbitrary(BookSchema), async (where) => {
					const program = Effect.gen(function* () {
						const db = yield* createEffectDatabase(config, {
							books: [], // Empty collection
						});

						// Query with arbitrary where clause
						const chunk = yield* Stream.runCollect(db.books.query({ where }));
						const queryResults = Chunk.toReadonlyArray(chunk);

						// Empty collection always returns empty results
						expect(queryResults.length).toBe(0);
					});

					await Effect.runPromise(program);
				}),
				{ numRuns: getNumRuns() },
			);
		});

		it("should return all entities consistently across multiple calls", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(entityArbitrary(BookSchema), { minLength: 1, maxLength: 15 }),
					async (entities) => {
						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: entities,
							});

							// Run empty query multiple times
							const chunk1 = yield* Stream.runCollect(
								db.books.query({ where: {} }),
							);
							const results1 = Chunk.toReadonlyArray(chunk1);

							const chunk2 = yield* Stream.runCollect(db.books.query({}));
							const results2 = Chunk.toReadonlyArray(chunk2);

							const chunk3 = yield* Stream.runCollect(
								db.books.query({ where: {} }),
							);
							const results3 = Chunk.toReadonlyArray(chunk3);

							// All should return the same count
							expect(results1.length).toBe(entities.length);
							expect(results2.length).toBe(entities.length);
							expect(results3.length).toBe(entities.length);

							// All should return the same set of IDs
							const ids1 = new Set(results1.map((e) => e.id));
							const ids2 = new Set(results2.map((e) => e.id));
							const ids3 = new Set(results3.map((e) => e.id));
							expect(ids1).toEqual(ids2);
							expect(ids2).toEqual(ids3);
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() / 2 },
			);
		});

		it("should handle large collections efficiently", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate a larger collection
					fc.array(entityArbitrary(BookSchema), {
						minLength: 50,
						maxLength: 100,
					}),
					async (entities) => {
						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: entities,
							});

							// Query with empty where clause
							const chunk = yield* Stream.runCollect(
								db.books.query({ where: {} }),
							);
							const queryResults = Chunk.toReadonlyArray(chunk);

							// All entities should be returned
							expect(queryResults.length).toBe(entities.length);

							// Verify every original entity is present
							const queryIds = new Set(queryResults.map((e) => e.id));
							for (const entity of entities) {
								expect(queryIds.has(entity.id)).toBe(true);
							}
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: 20 }, // Fewer runs for large collections
			);
		});
	});

	describe("Task 4.4: Reference matchesWhere implementation as test oracle", () => {
		/**
		 * The matchesWhere function is exported from generators.ts and provides
		 * a reference implementation for evaluating where clauses. This describe
		 * block documents and tests the oracle function itself.
		 */

		it("should return true for empty where clause", () => {
			const entity = {
				id: "1",
				title: "Dune",
				author: "Frank Herbert",
				year: 1965,
				rating: 4.5,
				isPublished: true,
				tags: ["sci-fi"],
				scores: [95],
			};
			expect(matchesWhere(entity, {})).toBe(true);
		});

		it("should handle direct value equality", () => {
			const entity = {
				id: "1",
				title: "Dune",
				author: "Frank Herbert",
				year: 1965,
				rating: 4.5,
				isPublished: true,
				tags: ["sci-fi"],
				scores: [95],
			};
			expect(matchesWhere(entity, { title: "Dune" })).toBe(true);
			expect(matchesWhere(entity, { title: "Other" })).toBe(false);
			expect(matchesWhere(entity, { year: 1965 })).toBe(true);
			expect(matchesWhere(entity, { year: 2000 })).toBe(false);
			expect(matchesWhere(entity, { isPublished: true })).toBe(true);
			expect(matchesWhere(entity, { isPublished: false })).toBe(false);
		});

		it("should handle $eq operator", () => {
			const entity = { id: "1", title: "Dune", year: 1965 };
			expect(matchesWhere(entity, { title: { $eq: "Dune" } })).toBe(true);
			expect(matchesWhere(entity, { title: { $eq: "Other" } })).toBe(false);
			expect(matchesWhere(entity, { year: { $eq: 1965 } })).toBe(true);
		});

		it("should handle $ne operator", () => {
			const entity = { id: "1", title: "Dune", year: 1965 };
			expect(matchesWhere(entity, { title: { $ne: "Other" } })).toBe(true);
			expect(matchesWhere(entity, { title: { $ne: "Dune" } })).toBe(false);
		});

		it("should handle $in operator", () => {
			const entity = { id: "1", title: "Dune", genre: "sci-fi" };
			expect(matchesWhere(entity, { genre: { $in: ["sci-fi", "fantasy"] } })).toBe(true);
			expect(matchesWhere(entity, { genre: { $in: ["romance", "mystery"] } })).toBe(false);
		});

		it("should handle $nin operator", () => {
			const entity = { id: "1", title: "Dune", genre: "sci-fi" };
			expect(matchesWhere(entity, { genre: { $nin: ["romance", "mystery"] } })).toBe(true);
			expect(matchesWhere(entity, { genre: { $nin: ["sci-fi", "fantasy"] } })).toBe(false);
		});

		it("should handle comparison operators ($gt, $gte, $lt, $lte)", () => {
			const entity = { id: "1", year: 1965 };
			expect(matchesWhere(entity, { year: { $gt: 1960 } })).toBe(true);
			expect(matchesWhere(entity, { year: { $gt: 1965 } })).toBe(false);
			expect(matchesWhere(entity, { year: { $gte: 1965 } })).toBe(true);
			expect(matchesWhere(entity, { year: { $gte: 1966 } })).toBe(false);
			expect(matchesWhere(entity, { year: { $lt: 1970 } })).toBe(true);
			expect(matchesWhere(entity, { year: { $lt: 1965 } })).toBe(false);
			expect(matchesWhere(entity, { year: { $lte: 1965 } })).toBe(true);
			expect(matchesWhere(entity, { year: { $lte: 1964 } })).toBe(false);
		});

		it("should handle string comparison operators", () => {
			const entity = { id: "1", title: "Dune" };
			expect(matchesWhere(entity, { title: { $gt: "Apple" } })).toBe(true);
			expect(matchesWhere(entity, { title: { $gt: "Zoo" } })).toBe(false);
			expect(matchesWhere(entity, { title: { $lt: "Zoo" } })).toBe(true);
		});

		it("should handle string operators ($startsWith, $endsWith, $contains)", () => {
			const entity = { id: "1", title: "The Left Hand of Darkness" };
			expect(matchesWhere(entity, { title: { $startsWith: "The" } })).toBe(true);
			expect(matchesWhere(entity, { title: { $startsWith: "Left" } })).toBe(false);
			expect(matchesWhere(entity, { title: { $endsWith: "Darkness" } })).toBe(true);
			expect(matchesWhere(entity, { title: { $endsWith: "Hand" } })).toBe(false);
			expect(matchesWhere(entity, { title: { $contains: "Hand" } })).toBe(true);
			expect(matchesWhere(entity, { title: { $contains: "Foot" } })).toBe(false);
		});

		it("should handle array $contains operator", () => {
			const entity = { id: "1", tags: ["sci-fi", "classic", "space"] };
			expect(matchesWhere(entity, { tags: { $contains: "sci-fi" } })).toBe(true);
			expect(matchesWhere(entity, { tags: { $contains: "romance" } })).toBe(false);
		});

		it("should handle $all operator", () => {
			const entity = { id: "1", tags: ["sci-fi", "classic", "space"] };
			expect(matchesWhere(entity, { tags: { $all: ["sci-fi", "classic"] } })).toBe(true);
			expect(matchesWhere(entity, { tags: { $all: ["sci-fi", "romance"] } })).toBe(false);
		});

		it("should handle $size operator", () => {
			const entity = { id: "1", tags: ["sci-fi", "classic", "space"] };
			expect(matchesWhere(entity, { tags: { $size: 3 } })).toBe(true);
			expect(matchesWhere(entity, { tags: { $size: 2 } })).toBe(false);
		});

		it("should handle combined operators (range queries)", () => {
			const entity = { id: "1", year: 1965 };
			expect(matchesWhere(entity, { year: { $gte: 1960, $lte: 1970 } })).toBe(true);
			expect(matchesWhere(entity, { year: { $gte: 1970, $lte: 1980 } })).toBe(false);
			expect(matchesWhere(entity, { year: { $gt: 1960, $lt: 1970 } })).toBe(true);
		});

		it("should handle multiple field conditions (AND logic)", () => {
			const entity = {
				id: "1",
				title: "Dune",
				author: "Frank Herbert",
				year: 1965,
			};
			expect(matchesWhere(entity, { title: "Dune", author: "Frank Herbert" })).toBe(true);
			expect(matchesWhere(entity, { title: "Dune", author: "Other Author" })).toBe(false);
			expect(matchesWhere(entity, { title: "Dune", year: { $gt: 1960 } })).toBe(true);
			expect(matchesWhere(entity, { title: "Other", year: { $gt: 1960 } })).toBe(false);
		});

		it("should handle unknown operators by returning false", () => {
			const entity = { id: "1", title: "Dune" };
			// Unknown operators should cause no match
			expect(matchesWhere(entity, { title: { $unknownOp: "value" } })).toBe(false);
		});

		it("should be consistent with property test assertions", async () => {
			// This property test verifies the matchesWhere oracle behaves consistently
			// across random inputs
			await fc.assert(
				fc.asyncProperty(
					fc.array(entityArbitrary(BookSchema), { minLength: 1, maxLength: 10 }),
					whereClauseArbitrary(BookSchema),
					async (entities, where) => {
						// For each entity, matchesWhere should give a deterministic result
						for (const entity of entities) {
							const result1 = matchesWhere(entity, where);
							const result2 = matchesWhere(entity, where);
							expect(result1).toBe(result2);
						}

						// The count of matching entities should be consistent
						const matches = entities.filter((e) => matchesWhere(e, where));
						expect(matches.length).toBeGreaterThanOrEqual(0);
						expect(matches.length).toBeLessThanOrEqual(entities.length);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});
	});
});
