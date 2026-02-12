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

	describe("Task 6.3: Index bucket integrity after operations (placeholder)", () => {
		// This will be implemented in task 6.3
		it.skip("should maintain correct index bucket entries", async () => {
			// Placeholder for task 6.3
		});
	});
});
