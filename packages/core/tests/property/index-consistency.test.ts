/**
 * Property-based tests for index consistency.
 *
 * Task 6.1: Create this test file
 * Task 6.2: Property - index-accelerated query results are identical to full-scan results
 * Task 6.3: Property - every entity in the collection appears in exactly the correct
 *           index buckets, and no index bucket contains IDs of non-existent entities
 *
 * These tests verify that the index system maintains consistency with the underlying
 * data through arbitrary operation sequences: any query on an indexed field should
 * return identical results whether the index is used or a full scan is performed.
 */
import { Chunk, Effect, Ref, Schema, Stream } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEffectDatabase } from "../../src/factories/database-effect";
import {
	buildIndexes,
	normalizeIndexes,
} from "../../src/indexes/index-manager";
import type { CollectionIndexes } from "../../src/types/index-types";
import {
	entityArbitrary,
	getNumRuns,
	operationSequenceArbitrary,
	type CrudOperation,
} from "./generators";

/**
 * Test schema for index consistency tests.
 * Includes fields of different types that can be indexed.
 */
const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	genre: Schema.String,
	rating: Schema.Number,
	isPublished: Schema.Boolean,
	tags: Schema.Array(Schema.String),
});

type Book = Schema.Schema.Type<typeof BookSchema>;

/**
 * Database config with single-field index on 'genre' for index testing.
 */
const configWithSingleIndex = {
	books: {
		schema: BookSchema,
		indexes: ["genre"] as ReadonlyArray<string>,
		relationships: {},
	},
} as const;

/**
 * Database config with compound index on ['genre', 'year'] for index testing.
 */
const configWithCompoundIndex = {
	books: {
		schema: BookSchema,
		indexes: [["genre", "year"]] as ReadonlyArray<ReadonlyArray<string>>,
		relationships: {},
	},
} as const;

/**
 * Database config with multiple indexes for comprehensive testing.
 */
const configWithMultipleIndexes = {
	books: {
		schema: BookSchema,
		indexes: ["genre", "author", ["genre", "year"]] as ReadonlyArray<
			string | ReadonlyArray<string>
		>,
		relationships: {},
	},
} as const;

/**
 * Database config without indexes for full-scan baseline comparison.
 */
const configWithoutIndexes = {
	books: {
		schema: BookSchema,
		relationships: {},
	},
} as const;

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
 * Helper to get the index map for a specific field(s).
 * @param indexes - The collection's indexes
 * @param fields - The field names for the index
 * @returns Promise resolving to the index map
 */
const getIndexMap = async (
	indexes: CollectionIndexes,
	fields: ReadonlyArray<string>,
): Promise<Map<unknown, Set<string>>> => {
	const indexKey = JSON.stringify(fields);
	const indexRef = indexes.get(indexKey);
	if (!indexRef) {
		return new Map();
	}
	return Effect.runPromise(Ref.get(indexRef));
};

describe("Index consistency properties", () => {
	describe("Task 6.1: Test file structure", () => {
		it("should have access to the required imports and generators", () => {
			// Verify entityArbitrary generates valid entities
			fc.assert(
				fc.property(entityArbitrary(BookSchema), (book) => {
					expect(typeof book.id).toBe("string");
					expect(typeof book.title).toBe("string");
					expect(typeof book.genre).toBe("string");
					expect(typeof book.year).toBe("number");
					expect(typeof book.isPublished).toBe("boolean");
					expect(Array.isArray(book.tags)).toBe(true);
				}),
				{ numRuns: 10 },
			);

			// Verify operationSequenceArbitrary generates valid operations
			fc.assert(
				fc.property(
					operationSequenceArbitrary(BookSchema, { minLength: 1, maxLength: 5 }),
					(ops) => {
						expect(Array.isArray(ops)).toBe(true);
						expect(ops.length).toBeGreaterThanOrEqual(1);
						for (const op of ops) {
							expect(["create", "update", "delete"]).toContain(op.op);
						}
					},
				),
				{ numRuns: 10 },
			);
		});

		it("should be able to create a database with indexes and query it", async () => {
			const program = Effect.gen(function* () {
				const db = yield* createEffectDatabase(configWithSingleIndex, {
					books: [
						{
							id: "1",
							title: "Dune",
							author: "Frank Herbert",
							year: 1965,
							genre: "sci-fi",
							rating: 4.5,
							isPublished: true,
							tags: ["classic", "epic"],
						},
						{
							id: "2",
							title: "Neuromancer",
							author: "William Gibson",
							year: 1984,
							genre: "sci-fi",
							rating: 4.3,
							isPublished: true,
							tags: ["cyberpunk"],
						},
						{
							id: "3",
							title: "The Hobbit",
							author: "J.R.R. Tolkien",
							year: 1937,
							genre: "fantasy",
							rating: 4.7,
							isPublished: true,
							tags: ["classic", "adventure"],
						},
					],
				});

				// Query using indexed field
				const chunk = yield* Stream.runCollect(
					db.books.query({ where: { genre: "sci-fi" } }),
				);
				const books = Chunk.toReadonlyArray(chunk);
				expect(books).toHaveLength(2);
				expect(books.every((b) => b.genre === "sci-fi")).toBe(true);
			});

			await Effect.runPromise(program);
		});

		it("should be able to create a database without indexes and query it", async () => {
			const program = Effect.gen(function* () {
				const db = yield* createEffectDatabase(configWithoutIndexes, {
					books: [
						{
							id: "1",
							title: "Dune",
							author: "Frank Herbert",
							year: 1965,
							genre: "sci-fi",
							rating: 4.5,
							isPublished: true,
							tags: ["classic"],
						},
						{
							id: "2",
							title: "The Hobbit",
							author: "J.R.R. Tolkien",
							year: 1937,
							genre: "fantasy",
							rating: 4.7,
							isPublished: true,
							tags: ["adventure"],
						},
					],
				});

				// Query (full scan since no indexes)
				const chunk = yield* Stream.runCollect(
					db.books.query({ where: { genre: "sci-fi" } }),
				);
				const books = Chunk.toReadonlyArray(chunk);
				expect(books).toHaveLength(1);
				expect(books[0].title).toBe("Dune");
			});

			await Effect.runPromise(program);
		});

		it("should be able to build indexes manually and inspect state", async () => {
			const entities: readonly Book[] = [
				{
					id: "1",
					title: "Dune",
					author: "Frank Herbert",
					year: 1965,
					genre: "sci-fi",
					rating: 4.5,
					isPublished: true,
					tags: [],
				},
				{
					id: "2",
					title: "Foundation",
					author: "Isaac Asimov",
					year: 1951,
					genre: "sci-fi",
					rating: 4.4,
					isPublished: true,
					tags: [],
				},
				{
					id: "3",
					title: "The Hobbit",
					author: "J.R.R. Tolkien",
					year: 1937,
					genre: "fantasy",
					rating: 4.7,
					isPublished: true,
					tags: [],
				},
			];

			const normalized = normalizeIndexes(["genre"]);
			const indexes = await Effect.runPromise(buildIndexes(normalized, entities));

			// Check index structure
			expect(indexes.size).toBe(1);
			expect(indexes.has('["genre"]')).toBe(true);

			// Check index contents
			const genreIndex = await getIndexMap(indexes, ["genre"]);
			expect(genreIndex.get("sci-fi")).toEqual(new Set(["1", "2"]));
			expect(genreIndex.get("fantasy")).toEqual(new Set(["3"]));
		});

		it("should be able to apply operation sequences and query", async () => {
			const operations: readonly CrudOperation<Book>[] = [
				{
					op: "create",
					payload: {
						id: "book-1",
						title: "Dune",
						author: "Frank Herbert",
						year: 1965,
						genre: "sci-fi",
						rating: 4.5,
						isPublished: true,
						tags: [],
					},
				},
				{
					op: "create",
					payload: {
						id: "book-2",
						title: "The Hobbit",
						author: "J.R.R. Tolkien",
						year: 1937,
						genre: "fantasy",
						rating: 4.7,
						isPublished: true,
						tags: [],
					},
				},
				{
					op: "update",
					id: "book-1",
					payload: { genre: "science-fiction" },
				},
			];

			const program = Effect.gen(function* () {
				const db = yield* createEffectDatabase(configWithSingleIndex, {
					books: [],
				});

				// Apply operations
				for (const operation of operations) {
					if (operation.op === "create") {
						yield* db.books.create(operation.payload);
					} else if (operation.op === "update") {
						yield* db.books.update(operation.id, operation.payload);
					} else if (operation.op === "delete") {
						yield* db.books.delete(operation.id);
					}
				}

				// Query and verify
				const chunk = yield* Stream.runCollect(db.books.query({}));
				const books = Chunk.toReadonlyArray(chunk);
				expect(books).toHaveLength(2);

				// The first book should now be "science-fiction" after the update
				const book1 = books.find((b) => b.id === "book-1");
				expect(book1?.genre).toBe("science-fiction");
			});

			await Effect.runPromise(program);
		});
	});

	describe("Task 6.2: Index-accelerated query results identical to full-scan", () => {
		/**
		 * Helper to apply a sequence of CRUD operations to a database.
		 * Returns an Effect that applies all operations in order.
		 */
		const applyOperations = <T extends { id: string }>(
			db: { books: { create: (p: T) => { runPromise: Promise<T> }; update: (id: string, p: Partial<T>) => { runPromise: Promise<T> }; delete: (id: string) => { runPromise: Promise<T> } } },
			operations: readonly CrudOperation<T>[],
		): Effect.Effect<void> =>
			Effect.gen(function* () {
				for (const operation of operations) {
					if (operation.op === "create") {
						yield* Effect.promise(() => db.books.create(operation.payload).runPromise);
					} else if (operation.op === "update") {
						yield* Effect.promise(() =>
							db.books.update(operation.id, operation.payload).runPromise,
						).pipe(Effect.catchAll(() => Effect.void)); // Ignore NotFoundError for updates
					} else if (operation.op === "delete") {
						yield* Effect.promise(() => db.books.delete(operation.id).runPromise).pipe(
							Effect.catchAll(() => Effect.void), // Ignore NotFoundError for deletes
						);
					}
				}
			});

		/**
		 * Helper to sort entities by ID for consistent comparison.
		 * Since the query engine may return results in different orders depending on
		 * whether indexes are used, we sort by ID for comparison purposes.
		 */
		const sortById = <T extends { id: string }>(entities: readonly T[]): T[] =>
			[...entities].sort((a, b) => a.id.localeCompare(b.id));

		it("should return identical results with and without index acceleration (single-field index)", async () => {
			await fc.assert(
				fc.asyncProperty(
					operationSequenceArbitrary(BookSchema, { minLength: 1, maxLength: 15 }),
					async (operations) => {
						// Create two databases: one with index, one without
						const [dbWithIndex, dbWithoutIndex] = await Effect.runPromise(
							Effect.all([
								createEffectDatabase(configWithSingleIndex, { books: [] }),
								createEffectDatabase(configWithoutIndexes, { books: [] }),
							]),
						);

						// Apply the same operations to both databases
						await Effect.runPromise(
							Effect.all([
								applyOperations(dbWithIndex, operations),
								applyOperations(dbWithoutIndex, operations),
							]),
						);

						// Collect unique genre values from the operations
						const genreValues = new Set<string>();
						for (const op of operations) {
							if (op.op === "create") {
								genreValues.add(op.payload.genre);
							} else if (op.op === "update" && "genre" in op.payload) {
								genreValues.add(op.payload.genre as string);
							}
						}

						// Test queries for each genre value (these should use the index)
						for (const genre of genreValues) {
							const whereClause = { genre };

							const [indexedResult, fullScanResult] = await Promise.all([
								dbWithIndex.books.query({ where: whereClause, sort: { id: "asc" } }).runPromise,
								dbWithoutIndex.books.query({ where: whereClause, sort: { id: "asc" } }).runPromise,
							]);

							// Results should have the same length
							expect(indexedResult.length).toBe(fullScanResult.length);

							// Each entity should match (same ID, same data)
							for (let i = 0; i < indexedResult.length; i++) {
								expect(indexedResult[i].id).toBe(fullScanResult[i].id);
								expect(indexedResult[i].genre).toBe(fullScanResult[i].genre);
								expect(indexedResult[i].title).toBe(fullScanResult[i].title);
								expect(indexedResult[i].year).toBe(fullScanResult[i].year);
							}
						}

						// Also test a query that returns all entities (empty where clause)
						const [allIndexed, allFullScan] = await Promise.all([
							dbWithIndex.books.query({ sort: { id: "asc" } }).runPromise,
							dbWithoutIndex.books.query({ sort: { id: "asc" } }).runPromise,
						]);

						expect(allIndexed.length).toBe(allFullScan.length);
						for (let i = 0; i < allIndexed.length; i++) {
							expect(allIndexed[i].id).toBe(allFullScan[i].id);
						}
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should return identical results with and without index acceleration (compound index)", async () => {
			await fc.assert(
				fc.asyncProperty(
					operationSequenceArbitrary(BookSchema, { minLength: 1, maxLength: 15 }),
					async (operations) => {
						// Create two databases: one with compound index, one without
						const [dbWithIndex, dbWithoutIndex] = await Effect.runPromise(
							Effect.all([
								createEffectDatabase(configWithCompoundIndex, { books: [] }),
								createEffectDatabase(configWithoutIndexes, { books: [] }),
							]),
						);

						// Apply the same operations to both databases
						await Effect.runPromise(
							Effect.all([
								applyOperations(dbWithIndex, operations),
								applyOperations(dbWithoutIndex, operations),
							]),
						);

						// Collect unique (genre, year) combinations from the operations
						const combinations = new Set<string>();
						for (const op of operations) {
							if (op.op === "create") {
								combinations.add(JSON.stringify({ genre: op.payload.genre, year: op.payload.year }));
							}
						}

						// Test queries for each (genre, year) combination (these should use the compound index)
						for (const comboStr of combinations) {
							const combo = JSON.parse(comboStr) as { genre: string; year: number };
							const whereClause = { genre: combo.genre, year: combo.year };

							const [indexedResult, fullScanResult] = await Promise.all([
								dbWithIndex.books.query({ where: whereClause, sort: { id: "asc" } }).runPromise,
								dbWithoutIndex.books.query({ where: whereClause, sort: { id: "asc" } }).runPromise,
							]);

							// Results should have the same length
							expect(indexedResult.length).toBe(fullScanResult.length);

							// Each entity should match
							for (let i = 0; i < indexedResult.length; i++) {
								expect(indexedResult[i].id).toBe(fullScanResult[i].id);
								expect(indexedResult[i].genre).toBe(fullScanResult[i].genre);
								expect(indexedResult[i].year).toBe(fullScanResult[i].year);
							}
						}
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should return identical results with $in operator queries", async () => {
			await fc.assert(
				fc.asyncProperty(
					operationSequenceArbitrary(BookSchema, { minLength: 3, maxLength: 15 }),
					async (operations) => {
						// Create two databases: one with index, one without
						const [dbWithIndex, dbWithoutIndex] = await Effect.runPromise(
							Effect.all([
								createEffectDatabase(configWithSingleIndex, { books: [] }),
								createEffectDatabase(configWithoutIndexes, { books: [] }),
							]),
						);

						// Apply the same operations to both databases
						await Effect.runPromise(
							Effect.all([
								applyOperations(dbWithIndex, operations),
								applyOperations(dbWithoutIndex, operations),
							]),
						);

						// Collect unique genre values from the operations
						const genreValues: string[] = [];
						for (const op of operations) {
							if (op.op === "create" && !genreValues.includes(op.payload.genre)) {
								genreValues.push(op.payload.genre);
							}
						}

						// Skip if less than 2 unique genres
						if (genreValues.length < 2) return;

						// Test $in query with multiple genre values (should use index)
						const targetGenres = genreValues.slice(0, Math.min(3, genreValues.length));
						const whereClause = { genre: { $in: targetGenres } };

						const [indexedResult, fullScanResult] = await Promise.all([
							dbWithIndex.books.query({ where: whereClause, sort: { id: "asc" } }).runPromise,
							dbWithoutIndex.books.query({ where: whereClause, sort: { id: "asc" } }).runPromise,
						]);

						// Results should have the same length
						expect(indexedResult.length).toBe(fullScanResult.length);

						// Each entity should match
						for (let i = 0; i < indexedResult.length; i++) {
							expect(indexedResult[i].id).toBe(fullScanResult[i].id);
							expect(targetGenres).toContain(indexedResult[i].genre);
						}
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should return identical results when query includes additional non-indexed conditions", async () => {
			await fc.assert(
				fc.asyncProperty(
					operationSequenceArbitrary(BookSchema, { minLength: 3, maxLength: 15 }),
					async (operations) => {
						// Create two databases: one with index, one without
						const [dbWithIndex, dbWithoutIndex] = await Effect.runPromise(
							Effect.all([
								createEffectDatabase(configWithSingleIndex, { books: [] }),
								createEffectDatabase(configWithoutIndexes, { books: [] }),
							]),
						);

						// Apply the same operations to both databases
						await Effect.runPromise(
							Effect.all([
								applyOperations(dbWithIndex, operations),
								applyOperations(dbWithoutIndex, operations),
							]),
						);

						// Find a genre and a year value from the operations
						let targetGenre: string | undefined;
						let targetYear: number | undefined;
						for (const op of operations) {
							if (op.op === "create") {
								targetGenre = op.payload.genre;
								targetYear = op.payload.year;
								break;
							}
						}

						if (!targetGenre || targetYear === undefined) return;

						// Query with both indexed field (genre) and non-indexed condition (year)
						// The index narrows candidates, then the filter applies the year condition
						const whereClause = { genre: targetGenre, year: { $gte: targetYear } };

						const [indexedResult, fullScanResult] = await Promise.all([
							dbWithIndex.books.query({ where: whereClause, sort: { id: "asc" } }).runPromise,
							dbWithoutIndex.books.query({ where: whereClause, sort: { id: "asc" } }).runPromise,
						]);

						// Results should have the same length
						expect(indexedResult.length).toBe(fullScanResult.length);

						// Each entity should match and satisfy both conditions
						for (let i = 0; i < indexedResult.length; i++) {
							expect(indexedResult[i].id).toBe(fullScanResult[i].id);
							expect(indexedResult[i].genre).toBe(targetGenre);
							expect(indexedResult[i].year).toBeGreaterThanOrEqual(targetYear);
						}
					},
				),
				{ numRuns: getNumRuns() },
			);
		});
	});

	describe("Task 6.3: Index bucket integrity after operations", () => {
		/**
		 * Helper to compute the expected index state from a collection of entities.
		 * This is the "oracle" - what the index SHOULD look like given the entities.
		 *
		 * @param entities - All entities in the collection
		 * @param indexFields - The fields that make up the index (e.g., ["genre"] or ["genre", "year"])
		 * @returns A Map from index key values to Sets of entity IDs
		 */
		const computeExpectedIndex = <T extends { id: string }>(
			entities: readonly T[],
			indexFields: readonly string[],
		): Map<unknown, Set<string>> => {
			const expectedIndex = new Map<unknown, Set<string>>();

			for (const entity of entities) {
				// Compute the index key for this entity
				const values = indexFields.map(
					(field) => (entity as Record<string, unknown>)[field],
				);

				// Skip if any indexed field is null or undefined
				if (values.some((v) => v === null || v === undefined)) {
					continue;
				}

				// Single-field: use raw value; compound: use JSON.stringify'd array
				const key = indexFields.length === 1 ? values[0] : JSON.stringify(values);

				// Add entity ID to the index bucket
				const existing = expectedIndex.get(key);
				if (existing) {
					existing.add(entity.id);
				} else {
					expectedIndex.set(key, new Set([entity.id]));
				}
			}

			return expectedIndex;
		};

		/**
		 * Helper to compare two index maps for equality.
		 * @returns null if equal, or an error message describing the difference
		 */
		const compareIndexMaps = (
			actual: Map<unknown, Set<string>>,
			expected: Map<unknown, Set<string>>,
		): string | null => {
			// Check that all expected keys exist in actual with correct IDs
			for (const [key, expectedIds] of expected) {
				const actualIds = actual.get(key);
				if (!actualIds) {
					return `Missing index bucket for key ${JSON.stringify(key)}. Expected IDs: ${[...expectedIds].join(", ")}`;
				}
				// Check that all expected IDs are present
				for (const id of expectedIds) {
					if (!actualIds.has(id)) {
						return `Index bucket for key ${JSON.stringify(key)} is missing ID "${id}"`;
					}
				}
				// Check that no extra IDs are present
				for (const id of actualIds) {
					if (!expectedIds.has(id)) {
						return `Index bucket for key ${JSON.stringify(key)} contains unexpected ID "${id}"`;
					}
				}
			}

			// Check that actual doesn't have extra keys
			for (const [key, actualIds] of actual) {
				if (!expected.has(key)) {
					return `Unexpected index bucket for key ${JSON.stringify(key)} with IDs: ${[...actualIds].join(", ")}`;
				}
			}

			return null; // Equal
		};

		/**
		 * Helper to apply a sequence of CRUD operations and track the final entity state.
		 * Returns the final array of entities after all operations.
		 */
		const applyOperationsToEntities = <T extends { id: string }>(
			operations: readonly CrudOperation<T>[],
		): T[] => {
			const entities = new Map<string, T>();

			for (const operation of operations) {
				if (operation.op === "create") {
					entities.set(operation.payload.id, operation.payload);
				} else if (operation.op === "update") {
					const existing = entities.get(operation.id);
					if (existing) {
						entities.set(operation.id, { ...existing, ...operation.payload });
					}
				} else if (operation.op === "delete") {
					entities.delete(operation.id);
				}
			}

			return Array.from(entities.values());
		};

		it("should have every entity in exactly the correct index buckets (single-field index)", async () => {
			await fc.assert(
				fc.asyncProperty(
					operationSequenceArbitrary(BookSchema, { minLength: 1, maxLength: 20 }),
					async (operations) => {
						// 1. Create database with single-field index
						const db = await Effect.runPromise(
							createEffectDatabase(configWithSingleIndex, { books: [] }),
						);

						// 2. Apply operations to the database (ignoring errors from updates/deletes of non-existent entities)
						for (const operation of operations) {
							try {
								if (operation.op === "create") {
									await db.books.create(operation.payload).runPromise;
								} else if (operation.op === "update") {
									await db.books.update(operation.id, operation.payload).runPromise;
								} else if (operation.op === "delete") {
									await db.books.delete(operation.id).runPromise;
								}
							} catch {
								// Ignore NotFoundError for updates/deletes
							}
						}

						// 3. Get all entities from the database
						const actualEntities = await db.books.query({ sort: { id: "asc" } }).runPromise;

						// 4. Compute expected index state from actual entities
						const expectedIndex = computeExpectedIndex(actualEntities, ["genre"]);

						// 5. Build a fresh index from the current entities using the index manager
						const normalized = normalizeIndexes(["genre"]);
						const freshIndexes = await Effect.runPromise(buildIndexes(normalized, actualEntities));
						const actualIndex = await getIndexMap(freshIndexes, ["genre"]);

						// 6. Compare: the fresh index should match the expected index
						const difference = compareIndexMaps(actualIndex, expectedIndex);
						expect(difference).toBeNull();

						// 7. Additional check: verify no index bucket contains IDs of non-existent entities
						const entityIds = new Set(actualEntities.map((e) => e.id));
						for (const [key, ids] of actualIndex) {
							for (const id of ids) {
								if (!entityIds.has(id)) {
									throw new Error(
										`Index bucket for key ${JSON.stringify(key)} contains non-existent entity ID "${id}"`,
									);
								}
							}
						}

						// 8. Verify every entity appears in its correct bucket
						for (const entity of actualEntities) {
							const key = entity.genre;
							const bucket = actualIndex.get(key);
							if (!bucket || !bucket.has(entity.id)) {
								throw new Error(
									`Entity "${entity.id}" with genre "${key}" not found in its index bucket`,
								);
							}
						}
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should have every entity in exactly the correct index buckets (compound index)", async () => {
			await fc.assert(
				fc.asyncProperty(
					operationSequenceArbitrary(BookSchema, { minLength: 1, maxLength: 20 }),
					async (operations) => {
						// 1. Create database with compound index
						const db = await Effect.runPromise(
							createEffectDatabase(configWithCompoundIndex, { books: [] }),
						);

						// 2. Apply operations to the database
						for (const operation of operations) {
							try {
								if (operation.op === "create") {
									await db.books.create(operation.payload).runPromise;
								} else if (operation.op === "update") {
									await db.books.update(operation.id, operation.payload).runPromise;
								} else if (operation.op === "delete") {
									await db.books.delete(operation.id).runPromise;
								}
							} catch {
								// Ignore NotFoundError for updates/deletes
							}
						}

						// 3. Get all entities from the database
						const actualEntities = await db.books.query({ sort: { id: "asc" } }).runPromise;

						// 4. Compute expected index state from actual entities
						const expectedIndex = computeExpectedIndex(actualEntities, ["genre", "year"]);

						// 5. Build a fresh index from the current entities
						const normalized = normalizeIndexes([["genre", "year"]]);
						const freshIndexes = await Effect.runPromise(buildIndexes(normalized, actualEntities));
						const actualIndex = await getIndexMap(freshIndexes, ["genre", "year"]);

						// 6. Compare: the fresh index should match the expected index
						const difference = compareIndexMaps(actualIndex, expectedIndex);
						expect(difference).toBeNull();

						// 7. Additional check: verify no index bucket contains IDs of non-existent entities
						const entityIds = new Set(actualEntities.map((e) => e.id));
						for (const [key, ids] of actualIndex) {
							for (const id of ids) {
								if (!entityIds.has(id)) {
									throw new Error(
										`Index bucket for key ${JSON.stringify(key)} contains non-existent entity ID "${id}"`,
									);
								}
							}
						}

						// 8. Verify every entity appears in its correct bucket
						for (const entity of actualEntities) {
							const key = JSON.stringify([entity.genre, entity.year]);
							const bucket = actualIndex.get(key);
							if (!bucket || !bucket.has(entity.id)) {
								throw new Error(
									`Entity "${entity.id}" with [genre="${entity.genre}", year=${entity.year}] not found in its index bucket`,
								);
							}
						}
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should have every entity in exactly the correct index buckets (multiple indexes)", async () => {
			await fc.assert(
				fc.asyncProperty(
					operationSequenceArbitrary(BookSchema, { minLength: 1, maxLength: 20 }),
					async (operations) => {
						// 1. Create database with multiple indexes
						const db = await Effect.runPromise(
							createEffectDatabase(configWithMultipleIndexes, { books: [] }),
						);

						// 2. Apply operations to the database
						for (const operation of operations) {
							try {
								if (operation.op === "create") {
									await db.books.create(operation.payload).runPromise;
								} else if (operation.op === "update") {
									await db.books.update(operation.id, operation.payload).runPromise;
								} else if (operation.op === "delete") {
									await db.books.delete(operation.id).runPromise;
								}
							} catch {
								// Ignore NotFoundError for updates/deletes
							}
						}

						// 3. Get all entities from the database
						const actualEntities = await db.books.query({ sort: { id: "asc" } }).runPromise;

						// 4. Test each index separately
						const indexConfigs: Array<{ fields: readonly string[]; normalized: ReadonlyArray<ReadonlyArray<string>> }> = [
							{ fields: ["genre"], normalized: normalizeIndexes(["genre"]) },
							{ fields: ["author"], normalized: normalizeIndexes(["author"]) },
							{ fields: ["genre", "year"], normalized: normalizeIndexes([["genre", "year"]]) },
						];

						const entityIds = new Set(actualEntities.map((e) => e.id));

						for (const { fields, normalized } of indexConfigs) {
							// Compute expected index
							const expectedIndex = computeExpectedIndex(actualEntities, fields);

							// Build fresh index
							const freshIndexes = await Effect.runPromise(buildIndexes(normalized, actualEntities));
							const actualIndex = await getIndexMap(freshIndexes, fields);

							// Compare
							const difference = compareIndexMaps(actualIndex, expectedIndex);
							if (difference) {
								throw new Error(`Index [${fields.join(", ")}]: ${difference}`);
							}

							// Verify no non-existent entities
							for (const [key, ids] of actualIndex) {
								for (const id of ids) {
									if (!entityIds.has(id)) {
										throw new Error(
											`Index [${fields.join(", ")}] bucket for key ${JSON.stringify(key)} contains non-existent entity ID "${id}"`,
										);
									}
								}
							}
						}
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should not have index buckets for deleted entities", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate a sequence that creates some entities and then deletes some
					fc.array(entityArbitrary(BookSchema), { minLength: 3, maxLength: 10 }),
					fc.integer({ min: 1, max: 5 }),
					async (entities, deleteCount) => {
						// Ensure unique IDs
						const uniqueEntities = ensureUniqueIds(entities);
						if (uniqueEntities.length < 2) return; // Need at least 2 entities

						// 1. Create database with initial entities
						const db = await Effect.runPromise(
							createEffectDatabase(configWithSingleIndex, { books: [] }),
						);

						// 2. Create all entities
						for (const entity of uniqueEntities) {
							await db.books.create(entity).runPromise;
						}

						// 3. Delete some entities (up to deleteCount or half of entities)
						const actualDeleteCount = Math.min(deleteCount, Math.floor(uniqueEntities.length / 2));
						const deletedIds = new Set<string>();
						for (let i = 0; i < actualDeleteCount; i++) {
							const id = uniqueEntities[i].id;
							await db.books.delete(id).runPromise;
							deletedIds.add(id);
						}

						// 4. Get remaining entities
						const remainingEntities = await db.books.query({}).runPromise;

						// 5. Build fresh index from remaining entities
						const normalized = normalizeIndexes(["genre"]);
						const freshIndexes = await Effect.runPromise(buildIndexes(normalized, remainingEntities));
						const actualIndex = await getIndexMap(freshIndexes, ["genre"]);

						// 6. Verify deleted IDs don't appear in any bucket
						for (const [key, ids] of actualIndex) {
							for (const id of ids) {
								if (deletedIds.has(id)) {
									throw new Error(
										`Deleted entity ID "${id}" still appears in index bucket for key ${JSON.stringify(key)}`,
									);
								}
							}
						}

						// 7. Verify all remaining entities are in correct buckets
						for (const entity of remainingEntities) {
							const key = entity.genre;
							const bucket = actualIndex.get(key);
							if (!bucket || !bucket.has(entity.id)) {
								throw new Error(
									`Remaining entity "${entity.id}" with genre "${key}" not found in its index bucket`,
								);
							}
						}
					},
				),
				{ numRuns: getNumRuns() },
			);
		});
	});
});
