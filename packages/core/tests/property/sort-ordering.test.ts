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
	type GeneratedSortConfig,
	getNumRuns,
	sortConfigArbitrary,
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

	describe("Task 5.2: Adjacent pair ordering property", () => {
		/**
		 * Helper function to compare two values for ordering.
		 * This mirrors the comparison logic in sort-stream.ts to ensure
		 * test assertions match actual database behavior.
		 *
		 * Returns:
		 *   negative if a < b
		 *   0 if a === b
		 *   positive if a > b
		 */
		const compareValues = (aValue: unknown, bValue: unknown): number => {
			// Handle undefined/null values - they always sort to the end
			if (aValue === undefined || aValue === null) {
				if (bValue === undefined || bValue === null) {
					return 0;
				}
				return 1;
			}
			if (bValue === undefined || bValue === null) {
				return -1;
			}

			// String comparison using localeCompare (matches database)
			if (typeof aValue === "string" && typeof bValue === "string") {
				return aValue.localeCompare(bValue);
			}

			// Number comparison
			if (typeof aValue === "number" && typeof bValue === "number") {
				return aValue - bValue;
			}

			// Boolean comparison (false=0, true=1)
			if (typeof aValue === "boolean" && typeof bValue === "boolean") {
				return (aValue ? 1 : 0) - (bValue ? 1 : 0);
			}

			// Fallback: convert to string and use localeCompare (matches database)
			return String(aValue).localeCompare(String(bValue));
		};

		/**
		 * Helper to ensure entities have unique IDs.
		 * The database stores entities by ID, so duplicates collapse into one.
		 */
		const ensureUniqueIds = <T extends { id: string }>(
			entities: readonly T[],
		): readonly T[] => {
			const seen = new Set<string>();
			const result: T[] = [];
			for (const entity of entities) {
				if (!seen.has(entity.id)) {
					seen.add(entity.id);
					result.push(entity);
				}
			}
			return result;
		};

		/**
		 * Verify that an array is sorted according to the given sort configuration.
		 * Returns true if all adjacent pairs satisfy the ordering constraint.
		 */
		const verifySortOrder = <T extends Record<string, unknown>>(
			items: readonly T[],
			sortConfig: GeneratedSortConfig,
		): boolean => {
			if (items.length <= 1) return true;

			const sortFields = Object.entries(sortConfig);
			if (sortFields.length === 0) return true; // No sort = any order is valid

			for (let i = 0; i < items.length - 1; i++) {
				const a = items[i];
				const b = items[i + 1];

				// Compare using sort fields in order (primary, secondary, etc.)
				for (const [field, direction] of sortFields) {
					const aValue = a[field];
					const bValue = b[field];
					const cmp = compareValues(aValue, bValue);

					if (cmp !== 0) {
						// Values differ - check if order is correct for this direction
						if (direction === "asc" && cmp > 0) {
							// a > b but should be a <= b for ascending
							return false;
						}
						if (direction === "desc" && cmp < 0) {
							// a < b but should be a >= b for descending
							return false;
						}
						// Order is correct, move to next pair
						break;
					}
					// Values are equal, continue to next sort field
				}
			}

			return true;
		};

		it("should maintain ordering invariant for adjacent pairs with single-field sort", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate 2-30 entities for the collection
					fc.array(entityArbitrary(BookSchema), {
						minLength: 2,
						maxLength: 30,
					}),
					// Generate a sort config that has at least one field
					sortConfigArbitrary(BookSchema).filter(
						(sort) => Object.keys(sort).length > 0,
					),
					async (entities, sort) => {
						// Ensure unique IDs (duplicates collapse in database)
						const uniqueEntities = ensureUniqueIds(entities);
						if (uniqueEntities.length < 2) return; // Need at least 2 for ordering test

						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: uniqueEntities,
							});

							// Query with the generated sort configuration
							const chunk = yield* Stream.runCollect(db.books.query({ sort }));
							const sortedResults = Chunk.toReadonlyArray(chunk);

							// Verify: all unique entities are returned
							expect(sortedResults.length).toBe(uniqueEntities.length);

							// Verify: ordering invariant holds for adjacent pairs
							const isOrdered = verifySortOrder(sortedResults, sort);
							expect(isOrdered).toBe(true);

							// Additional verification: check each adjacent pair explicitly
							const sortFields = Object.entries(sort);
							for (let i = 0; i < sortedResults.length - 1; i++) {
								const a = sortedResults[i];
								const b = sortedResults[i + 1];

								// For the primary sort field, verify the ordering
								for (const [field, direction] of sortFields) {
									const aValue = a[field as keyof Book];
									const bValue = b[field as keyof Book];
									const cmp = compareValues(aValue, bValue);

									if (cmp !== 0) {
										// Values differ - verify order
										if (direction === "asc") {
											expect(cmp).toBeLessThanOrEqual(0);
										} else {
											expect(cmp).toBeGreaterThanOrEqual(0);
										}
										break;
									}
								}
							}
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should maintain ordering for multi-field sort configurations", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate 5-20 entities for the collection
					fc.array(entityArbitrary(BookSchema), {
						minLength: 5,
						maxLength: 20,
					}),
					// Generate a multi-field sort config
					sortConfigArbitrary(BookSchema).filter(
						(sort) => Object.keys(sort).length >= 2,
					),
					async (entities, sort) => {
						// Ensure unique IDs (duplicates collapse in database)
						const uniqueEntities = ensureUniqueIds(entities);
						if (uniqueEntities.length < 2) return; // Need at least 2 for ordering test

						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: uniqueEntities,
							});

							const chunk = yield* Stream.runCollect(db.books.query({ sort }));
							const sortedResults = Chunk.toReadonlyArray(chunk);

							expect(sortedResults.length).toBe(uniqueEntities.length);

							// Verify ordering invariant with multi-field comparison
							const isOrdered = verifySortOrder(sortedResults, sort);
							expect(isOrdered).toBe(true);
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should handle ascending sort correctly", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(entityArbitrary(BookSchema), {
						minLength: 2,
						maxLength: 20,
					}),
					// Generate specifically ascending sort on sortable fields
					fc
						.constantFrom("title", "author", "year", "rating")
						.map((field) => ({ [field]: "asc" as const })),
					async (entities, sort) => {
						// Ensure unique IDs (duplicates collapse in database)
						const uniqueEntities = ensureUniqueIds(entities);
						if (uniqueEntities.length < 2) return; // Need at least 2 for ordering test

						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: uniqueEntities,
							});

							const chunk = yield* Stream.runCollect(db.books.query({ sort }));
							const sortedResults = Chunk.toReadonlyArray(chunk);

							const field = Object.keys(sort)[0];

							// Every adjacent pair should have a[field] <= b[field]
							for (let i = 0; i < sortedResults.length - 1; i++) {
								const a = sortedResults[i];
								const b = sortedResults[i + 1];
								const aVal = a[field as keyof Book];
								const bVal = b[field as keyof Book];
								const cmp = compareValues(aVal, bVal);
								expect(cmp).toBeLessThanOrEqual(0);
							}
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should handle descending sort correctly", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(entityArbitrary(BookSchema), {
						minLength: 2,
						maxLength: 20,
					}),
					// Generate specifically descending sort on sortable fields
					fc
						.constantFrom("title", "author", "year", "rating")
						.map((field) => ({ [field]: "desc" as const })),
					async (entities, sort) => {
						// Ensure unique IDs (duplicates collapse in database)
						const uniqueEntities = ensureUniqueIds(entities);
						if (uniqueEntities.length < 2) return; // Need at least 2 for ordering test

						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: uniqueEntities,
							});

							const chunk = yield* Stream.runCollect(db.books.query({ sort }));
							const sortedResults = Chunk.toReadonlyArray(chunk);

							const field = Object.keys(sort)[0];

							// Every adjacent pair should have a[field] >= b[field]
							for (let i = 0; i < sortedResults.length - 1; i++) {
								const a = sortedResults[i];
								const b = sortedResults[i + 1];
								const aVal = a[field as keyof Book];
								const bVal = b[field as keyof Book];
								const cmp = compareValues(aVal, bVal);
								expect(cmp).toBeGreaterThanOrEqual(0);
							}
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should handle edge cases: empty sort config returns all entities", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(entityArbitrary(BookSchema), {
						minLength: 0,
						maxLength: 20,
					}),
					async (entities) => {
						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: entities,
							});

							// Query with empty sort config
							const chunk = yield* Stream.runCollect(
								db.books.query({ sort: {} }),
							);
							const results = Chunk.toReadonlyArray(chunk);

							// All entities should be returned (order undefined)
							expect(results.length).toBe(entities.length);

							// Same set of IDs
							const resultIds = new Set(results.map((e) => e.id));
							const entityIds = new Set(entities.map((e) => e.id));
							expect(resultIds).toEqual(entityIds);
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should handle edge cases: single entity collection", async () => {
			await fc.assert(
				fc.asyncProperty(
					entityArbitrary(BookSchema),
					sortConfigArbitrary(BookSchema),
					async (entity, sort) => {
						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: [entity],
							});

							const chunk = yield* Stream.runCollect(db.books.query({ sort }));
							const results = Chunk.toReadonlyArray(chunk);

							// Single entity is always "sorted"
							expect(results.length).toBe(1);
							expect(results[0].id).toBe(entity.id);
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should handle edge cases: two entities with same sort key value", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate two entities with the same year value
					fc
						.tuple(entityArbitrary(BookSchema), entityArbitrary(BookSchema))
						.map(([e1, e2]) => [e1, { ...e2, year: e1.year }] as [Book, Book]),
					async ([entity1, entity2]) => {
						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: [entity1, entity2],
							});

							// Sort by year (both have same year)
							const chunk = yield* Stream.runCollect(
								db.books.query({ sort: { year: "asc" } }),
							);
							const results = Chunk.toReadonlyArray(chunk);

							expect(results.length).toBe(2);

							// Both should be present
							const ids = new Set(results.map((e) => e.id));
							expect(ids.has(entity1.id)).toBe(true);
							expect(ids.has(entity2.id)).toBe(true);

							// Order is valid (equal values can be in any order)
							expect(results[0].year).toBe(results[1].year);
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should maintain sort order combined with filter", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(entityArbitrary(BookSchema), {
						minLength: 5,
						maxLength: 25,
					}),
					sortConfigArbitrary(BookSchema).filter(
						(sort) => Object.keys(sort).length > 0,
					),
					async (entities, sort) => {
						// Ensure unique IDs (duplicates collapse in database)
						const uniqueEntities = ensureUniqueIds(entities);

						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: uniqueEntities,
							});

							// Query with both filter and sort
							// Use a simple filter that should match some entities
							const chunk = yield* Stream.runCollect(
								db.books.query({
									where: { isPublished: true },
									sort,
								}),
							);
							const sortedResults = Chunk.toReadonlyArray(chunk);

							// Verify: only published books are returned
							for (const result of sortedResults) {
								expect(result.isPublished).toBe(true);
							}

							// Verify: ordering invariant holds
							if (sortedResults.length > 1) {
								const isOrdered = verifySortOrder(sortedResults, sort);
								expect(isOrdered).toBe(true);
							}
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});
	});

	describe("Task 5.3: Sort stability property", () => {
		/**
		 * Helper to ensure entities have unique IDs.
		 * The database stores entities by ID, so duplicates collapse into one.
		 */
		const ensureUniqueIds = <T extends { id: string }>(
			entities: readonly T[],
		): readonly T[] => {
			const seen = new Set<string>();
			const result: T[] = [];
			for (const entity of entities) {
				if (!seen.has(entity.id)) {
					seen.add(entity.id);
					result.push(entity);
				}
			}
			return result;
		};

		/**
		 * Property: entities with duplicate sort key values maintain consistent
		 * relative ordering across repeated runs with the same seed.
		 *
		 * This verifies sort stability: if we run the same query multiple times
		 * with the same data, entities with equal sort keys should always appear
		 * in the same relative order.
		 */
		it("should maintain consistent ordering for entities with duplicate sort key values", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate 5-20 entities with potential duplicates in sort field
					fc.array(entityArbitrary(BookSchema), {
						minLength: 5,
						maxLength: 20,
					}),
					// Generate a single-field sort config
					fc
						.constantFrom("year", "rating", "title", "author")
						.map((field) => ({ [field]: "asc" as const })),
					async (entities, sort) => {
						// Ensure unique IDs (duplicates collapse in database)
						const uniqueEntities = ensureUniqueIds(entities);
						if (uniqueEntities.length < 3) return; // Need at least 3 for meaningful stability test

						// Force some duplicate sort key values by copying values between entities
						const sortField = Object.keys(sort)[0];
						const modifiedEntities = [...uniqueEntities];

						// Make some entities share the same sort key value
						if (modifiedEntities.length >= 3) {
							const firstValue = modifiedEntities[0][
								sortField as keyof Book
							] as unknown;
							// Set indices 1 and 2 to have the same value as index 0
							modifiedEntities[1] = {
								...modifiedEntities[1],
								[sortField]: firstValue,
							};
							modifiedEntities[2] = {
								...modifiedEntities[2],
								[sortField]: firstValue,
							};
						}

						// Run the query multiple times and verify consistent ordering
						const NUM_RUNS = 5;
						const resultsPerRun: string[][] = [];

						for (let run = 0; run < NUM_RUNS; run++) {
							const program = Effect.gen(function* () {
								const db = yield* createEffectDatabase(config, {
									books: modifiedEntities,
								});

								const chunk = yield* Stream.runCollect(
									db.books.query({ sort }),
								);
								return Chunk.toReadonlyArray(chunk).map((b) => b.id);
							});

							const ids = await Effect.runPromise(program);
							resultsPerRun.push([...ids]);
						}

						// All runs should produce identical ordering
						const firstRunIds = resultsPerRun[0];
						for (let run = 1; run < NUM_RUNS; run++) {
							const currentRunIds = resultsPerRun[run];

							// Same length
							expect(currentRunIds.length).toBe(firstRunIds.length);

							// Same order (including entities with duplicate sort keys)
							expect(currentRunIds).toEqual(firstRunIds);
						}
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		/**
		 * Property: sort stability holds for descending order as well.
		 */
		it("should maintain consistent ordering for duplicate values in descending sort", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(entityArbitrary(BookSchema), {
						minLength: 5,
						maxLength: 15,
					}),
					fc
						.constantFrom("year", "rating")
						.map((field) => ({ [field]: "desc" as const })),
					async (entities, sort) => {
						const uniqueEntities = ensureUniqueIds(entities);
						if (uniqueEntities.length < 3) return;

						const sortField = Object.keys(sort)[0];
						const modifiedEntities = [...uniqueEntities];

						// Create duplicates in sort key
						if (modifiedEntities.length >= 4) {
							const val = modifiedEntities[0][
								sortField as keyof Book
							] as unknown;
							modifiedEntities[1] = {
								...modifiedEntities[1],
								[sortField]: val,
							};
							modifiedEntities[2] = {
								...modifiedEntities[2],
								[sortField]: val,
							};
							modifiedEntities[3] = {
								...modifiedEntities[3],
								[sortField]: val,
							};
						}

						const NUM_RUNS = 5;
						const resultsPerRun: string[][] = [];

						for (let run = 0; run < NUM_RUNS; run++) {
							const program = Effect.gen(function* () {
								const db = yield* createEffectDatabase(config, {
									books: modifiedEntities,
								});

								const chunk = yield* Stream.runCollect(
									db.books.query({ sort }),
								);
								return Chunk.toReadonlyArray(chunk).map((b) => b.id);
							});

							const ids = await Effect.runPromise(program);
							resultsPerRun.push([...ids]);
						}

						// Verify all runs are identical
						for (let run = 1; run < NUM_RUNS; run++) {
							expect(resultsPerRun[run]).toEqual(resultsPerRun[0]);
						}
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		/**
		 * Property: with multi-field sort, when the primary key has duplicates,
		 * the secondary key should determine the order, and ties in secondary
		 * should be stable.
		 */
		it("should maintain stability with multi-field sort and duplicate primary keys", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(entityArbitrary(BookSchema), {
						minLength: 6,
						maxLength: 15,
					}),
					async (entities) => {
						const uniqueEntities = ensureUniqueIds(entities);
						if (uniqueEntities.length < 6) return;

						// Create entities with duplicate primary sort key (year)
						// but varying secondary sort key (rating)
						const modifiedEntities = uniqueEntities.map((e, i) => ({
							...e,
							// First 3 entities have year=2000, next 3 have year=2010
							year: i < 3 ? 2000 : 2010,
						}));

						const sort = { year: "asc" as const, rating: "asc" as const };

						const NUM_RUNS = 5;
						const resultsPerRun: string[][] = [];

						for (let run = 0; run < NUM_RUNS; run++) {
							const program = Effect.gen(function* () {
								const db = yield* createEffectDatabase(config, {
									books: modifiedEntities,
								});

								const chunk = yield* Stream.runCollect(
									db.books.query({ sort }),
								);
								return Chunk.toReadonlyArray(chunk).map((b) => b.id);
							});

							const ids = await Effect.runPromise(program);
							resultsPerRun.push([...ids]);
						}

						// All runs should be identical
						for (let run = 1; run < NUM_RUNS; run++) {
							expect(resultsPerRun[run]).toEqual(resultsPerRun[0]);
						}

						// Verify that within each year group, items are sorted by rating
						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: modifiedEntities,
							});

							const chunk = yield* Stream.runCollect(db.books.query({ sort }));
							return Chunk.toReadonlyArray(chunk);
						});

						const results = await Effect.runPromise(program);

						// All year=2000 items should come before year=2010 items
						const year2000Items = results.filter((b) => b.year === 2000);
						const year2010Items = results.filter((b) => b.year === 2010);

						// Find where 2010 items start
						const firstYear2010Idx = results.findIndex((b) => b.year === 2010);
						if (firstYear2010Idx !== -1) {
							// All 2000 items should be before this index
							expect(year2000Items.length).toBeLessThanOrEqual(
								firstYear2010Idx,
							);
						}

						// Within each group, ratings should be ascending
						for (let i = 1; i < year2000Items.length; i++) {
							expect(year2000Items[i].rating).toBeGreaterThanOrEqual(
								year2000Items[i - 1].rating,
							);
						}
						for (let i = 1; i < year2010Items.length; i++) {
							expect(year2010Items[i].rating).toBeGreaterThanOrEqual(
								year2010Items[i - 1].rating,
							);
						}
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		/**
		 * Property: sort is deterministic - creating the same database twice
		 * with the same data should produce identical query results.
		 */
		it("should produce deterministic results for identical database setups", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(entityArbitrary(BookSchema), {
						minLength: 3,
						maxLength: 20,
					}),
					sortConfigArbitrary(BookSchema).filter(
						(sort) => Object.keys(sort).length > 0,
					),
					async (entities, sort) => {
						const uniqueEntities = ensureUniqueIds(entities);
						if (uniqueEntities.length < 2) return;

						// Create two separate databases with the same data
						const program1 = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: uniqueEntities,
							});
							const chunk = yield* Stream.runCollect(db.books.query({ sort }));
							return Chunk.toReadonlyArray(chunk).map((b) => b.id);
						});

						const program2 = Effect.gen(function* () {
							const db = yield* createEffectDatabase(config, {
								books: uniqueEntities,
							});
							const chunk = yield* Stream.runCollect(db.books.query({ sort }));
							return Chunk.toReadonlyArray(chunk).map((b) => b.id);
						});

						const [ids1, ids2] = await Promise.all([
							Effect.runPromise(program1),
							Effect.runPromise(program2),
						]);

						// Both should have the same result
						expect(ids1).toEqual(ids2);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		/**
		 * Property: sort stability with all identical sort key values.
		 * When ALL entities have the same sort key value, the relative order
		 * should be consistent across runs.
		 */
		it("should maintain consistent ordering when all entities have identical sort key values", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(entityArbitrary(BookSchema), {
						minLength: 3,
						maxLength: 15,
					}),
					fc.integer({ min: 1900, max: 2100 }), // shared year value
					async (entities, sharedYear) => {
						const uniqueEntities = ensureUniqueIds(entities);
						if (uniqueEntities.length < 3) return;

						// All entities have the same year
						const modifiedEntities = uniqueEntities.map((e) => ({
							...e,
							year: sharedYear,
						}));

						const sort = { year: "asc" as const };

						const NUM_RUNS = 5;
						const resultsPerRun: string[][] = [];

						for (let run = 0; run < NUM_RUNS; run++) {
							const program = Effect.gen(function* () {
								const db = yield* createEffectDatabase(config, {
									books: modifiedEntities,
								});

								const chunk = yield* Stream.runCollect(
									db.books.query({ sort }),
								);
								return Chunk.toReadonlyArray(chunk).map((b) => b.id);
							});

							const ids = await Effect.runPromise(program);
							resultsPerRun.push([...ids]);
						}

						// All runs should produce the same ordering
						for (let run = 1; run < NUM_RUNS; run++) {
							expect(resultsPerRun[run]).toEqual(resultsPerRun[0]);
						}
					},
				),
				{ numRuns: getNumRuns() },
			);
		});
	});
});
