/**
 * Property-based tests for CRUD invariants.
 *
 * Task 7.1: Create this test file
 * Task 7.2: Property - for any valid entity, create then findById returns a value deeply equal
 * Task 7.3: Property - for any existing entity, delete then findById fails with NotFoundError
 * Task 7.4: Property - unique constraint enforcement: creating multiple entities with the same
 *           unique value results in exactly one success and the rest failing with UniqueConstraintError
 *
 * These tests verify that the CRUD operations maintain fundamental semantic guarantees
 * across arbitrary valid inputs: entities that are created can be retrieved, deleted
 * entities cannot be retrieved, and unique constraints are properly enforced.
 */
import { Chunk, Effect, Schema, Stream } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NotFoundError } from "../../src/errors/crud-errors";
import { createEffectDatabase } from "../../src/factories/database-effect";
import { entityArbitrary, getNumRuns } from "./generators";

/**
 * Test schema for CRUD invariants tests.
 * Simple schema to focus on CRUD semantics.
 */
const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	rating: Schema.Number,
	isPublished: Schema.Boolean,
	tags: Schema.Array(Schema.String),
});

type Book = Schema.Schema.Type<typeof BookSchema>;

/**
 * Database config without unique constraints for basic CRUD tests.
 */
const basicConfig = {
	books: {
		schema: BookSchema,
		relationships: {},
	},
} as const;

/**
 * Schema for unique constraint tests with a unique 'isbn' field.
 */
const BookWithIsbnSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	isbn: Schema.String,
	year: Schema.Number,
});

type BookWithIsbn = Schema.Schema.Type<typeof BookWithIsbnSchema>;

/**
 * Database config with unique constraint on 'isbn' field.
 */
const configWithUnique = {
	books: {
		schema: BookWithIsbnSchema,
		uniqueFields: ["isbn"],
		relationships: {},
	},
} as const;

describe("CRUD invariant properties", () => {
	describe("Task 7.1: Test file structure", () => {
		it("should have access to the required imports and generators", () => {
			// Verify entityArbitrary generates valid entities
			fc.assert(
				fc.property(entityArbitrary(BookSchema), (book) => {
					expect(typeof book.id).toBe("string");
					expect(typeof book.title).toBe("string");
					expect(typeof book.author).toBe("string");
					expect(typeof book.year).toBe("number");
					expect(typeof book.rating).toBe("number");
					expect(typeof book.isPublished).toBe("boolean");
					expect(Array.isArray(book.tags)).toBe(true);
				}),
				{ numRuns: 10 },
			);
		});

		it("should be able to create a database and perform basic CRUD", async () => {
			const program = Effect.gen(function* () {
				const db = yield* createEffectDatabase(basicConfig, { books: [] });

				// Create
				const book = yield* db.books.create({
					title: "Dune",
					author: "Frank Herbert",
					year: 1965,
					rating: 4.5,
					isPublished: true,
					tags: ["sci-fi", "classic"],
				});
				expect(book.title).toBe("Dune");
				expect(typeof book.id).toBe("string");

				// FindById
				const found = yield* db.books.findById(book.id);
				expect(found.title).toBe("Dune");
				expect(found.id).toBe(book.id);

				// Delete
				const deleted = yield* db.books.delete(book.id);
				expect(deleted.id).toBe(book.id);

				// FindById should fail after delete
				const notFoundResult = yield* db.books.findById(book.id).pipe(
					Effect.flip,
				);
				expect(notFoundResult._tag).toBe("NotFoundError");
			});

			await Effect.runPromise(program);
		});

		it("should be able to create a database with unique constraints", async () => {
			const program = Effect.gen(function* () {
				const db = yield* createEffectDatabase(configWithUnique, { books: [] });

				// Create first book
				const book1 = yield* db.books.create({
					title: "Dune",
					author: "Frank Herbert",
					isbn: "978-0441172719",
					year: 1965,
				});
				expect(book1.isbn).toBe("978-0441172719");

				// Attempt to create with same ISBN should fail
				const error = yield* db.books.create({
					title: "Different Book",
					author: "Other Author",
					isbn: "978-0441172719", // same ISBN
					year: 2000,
				}).pipe(Effect.flip);

				expect(error._tag).toBe("UniqueConstraintError");
			});

			await Effect.runPromise(program);
		});
	});

	describe("Task 7.2: Create then findById returns deeply equal entity", () => {
		it("should return the exact same entity after create then findById", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate a valid entity (without id, since create generates one)
					entityArbitrary(BookSchema),
					async (entityWithId) => {
						// Remove the generated id since create() will generate its own
						const { id: _unusedId, ...entityData } = entityWithId;

						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(basicConfig, {
								books: [],
							});

							// Create the entity
							const created = yield* db.books.create(entityData);

							// Verify create returned an entity with an id
							expect(typeof created.id).toBe("string");
							expect(created.id.length).toBeGreaterThan(0);

							// Verify created entity has all the input fields
							expect(created.title).toBe(entityData.title);
							expect(created.author).toBe(entityData.author);
							expect(created.year).toBe(entityData.year);
							expect(created.rating).toBe(entityData.rating);
							expect(created.isPublished).toBe(entityData.isPublished);
							expect(created.tags).toEqual(entityData.tags);

							// Find the entity by ID
							const found = yield* db.books.findById(created.id);

							// Verify findById returns deeply equal entity
							expect(found).toEqual(created);

							// Verify all fields match individually for clearer error messages
							expect(found.id).toBe(created.id);
							expect(found.title).toBe(created.title);
							expect(found.author).toBe(created.author);
							expect(found.year).toBe(created.year);
							expect(found.rating).toBe(created.rating);
							expect(found.isPublished).toBe(created.isPublished);
							expect(found.tags).toEqual(created.tags);
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should maintain entity integrity across multiple create-findById cycles", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate multiple entities
					fc.array(entityArbitrary(BookSchema), { minLength: 1, maxLength: 10 }),
					async (entitiesWithIds) => {
						// Remove generated ids
						const entitiesData = entitiesWithIds.map(({ id: _unusedId, ...data }) => data);

						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(basicConfig, {
								books: [],
							});

							const createdEntities: Book[] = [];

							// Create all entities
							for (const entityData of entitiesData) {
								const created = yield* db.books.create(entityData);
								createdEntities.push(created);
							}

							// Verify each entity can be found and is deeply equal
							for (const created of createdEntities) {
								const found = yield* db.books.findById(created.id);
								expect(found).toEqual(created);
							}
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() / 2 }, // Fewer runs since we create multiple entities per run
			);
		});

		it("should preserve all field types correctly (strings, numbers, booleans, arrays)", async () => {
			await fc.assert(
				fc.asyncProperty(
					entityArbitrary(BookSchema),
					async (entityWithId) => {
						const { id: _unusedId, ...entityData } = entityWithId;

						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(basicConfig, {
								books: [],
							});

							const created = yield* db.books.create(entityData);
							const found = yield* db.books.findById(created.id);

							// Verify type preservation
							expect(typeof found.id).toBe("string");
							expect(typeof found.title).toBe("string");
							expect(typeof found.author).toBe("string");
							expect(typeof found.year).toBe("number");
							expect(typeof found.rating).toBe("number");
							expect(typeof found.isPublished).toBe("boolean");
							expect(Array.isArray(found.tags)).toBe(true);

							// Verify array element types
							for (const tag of found.tags) {
								expect(typeof tag).toBe("string");
							}

							// Verify exact values match
							expect(found.title).toBe(created.title);
							expect(found.author).toBe(created.author);
							expect(found.year).toBe(created.year);
							expect(found.rating).toBe(created.rating);
							expect(found.isPublished).toBe(created.isPublished);
							expect(found.tags).toEqual(created.tags);
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should handle entities with empty strings and zero values", async () => {
			// Edge case: entities with boundary values
			await fc.assert(
				fc.asyncProperty(
					fc.record({
						title: fc.oneof(fc.constant(""), fc.string({ minLength: 1, maxLength: 10 })),
						author: fc.oneof(fc.constant(""), fc.string({ minLength: 1, maxLength: 10 })),
						year: fc.oneof(fc.constant(0), fc.integer({ min: -1000, max: 3000 })),
						rating: fc.oneof(fc.constant(0), fc.float({ min: 0, max: 5, noNaN: true })),
						isPublished: fc.boolean(),
						tags: fc.oneof(fc.constant([]), fc.array(fc.string(), { minLength: 1, maxLength: 5 })),
					}),
					async (entityData) => {
						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(basicConfig, {
								books: [],
							});

							const created = yield* db.books.create(entityData);
							const found = yield* db.books.findById(created.id);

							expect(found).toEqual(created);
							expect(found.title).toBe(entityData.title);
							expect(found.author).toBe(entityData.author);
							expect(found.year).toBe(entityData.year);
							expect(found.rating).toBe(entityData.rating);
							expect(found.isPublished).toBe(entityData.isPublished);
							expect(found.tags).toEqual(entityData.tags);
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should generate unique IDs for each created entity", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(entityArbitrary(BookSchema), { minLength: 2, maxLength: 20 }),
					async (entitiesWithIds) => {
						const entitiesData = entitiesWithIds.map(({ id: _unusedId, ...data }) => data);

						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(basicConfig, {
								books: [],
							});

							const createdIds: string[] = [];

							for (const entityData of entitiesData) {
								const created = yield* db.books.create(entityData);
								createdIds.push(created.id);
							}

							// All IDs should be unique
							const uniqueIds = new Set(createdIds);
							expect(uniqueIds.size).toBe(createdIds.length);

							// Each entity should be findable by its unique ID
							for (const id of createdIds) {
								const found = yield* db.books.findById(id);
								expect(found.id).toBe(id);
							}
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() / 2 },
			);
		});
	});

	describe("Task 7.3: Delete then findById fails with NotFoundError", () => {
		it("should fail with NotFoundError when finding a deleted entity by ID", async () => {
			await fc.assert(
				fc.asyncProperty(
					entityArbitrary(BookSchema),
					async (entityWithId) => {
						const { id: _unusedId, ...entityData } = entityWithId;

						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(basicConfig, {
								books: [],
							});

							// Create the entity
							const created = yield* db.books.create(entityData);
							expect(typeof created.id).toBe("string");

							// Verify entity exists
							const found = yield* db.books.findById(created.id);
							expect(found.id).toBe(created.id);

							// Delete the entity
							const deleted = yield* db.books.delete(created.id);
							expect(deleted.id).toBe(created.id);

							// findById should fail with NotFoundError
							const notFoundResult = yield* db.books.findById(created.id).pipe(
								Effect.flip,
							);
							expect(notFoundResult._tag).toBe("NotFoundError");
							expect(notFoundResult).toBeInstanceOf(NotFoundError);
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should not include deleted entity in query results", async () => {
			await fc.assert(
				fc.asyncProperty(
					entityArbitrary(BookSchema),
					async (entityWithId) => {
						const { id: _unusedId, ...entityData } = entityWithId;

						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(basicConfig, {
								books: [],
							});

							// Create the entity
							const created = yield* db.books.create(entityData);

							// Verify entity appears in query results before delete
							const beforeDeleteChunk = yield* Stream.runCollect(
								db.books.query({}),
							);
							const beforeDelete = Chunk.toReadonlyArray(beforeDeleteChunk);
							const existsBefore = beforeDelete.some(
								(book) => book.id === created.id,
							);
							expect(existsBefore).toBe(true);

							// Delete the entity
							yield* db.books.delete(created.id);

							// Verify entity does NOT appear in query results after delete
							const afterDeleteChunk = yield* Stream.runCollect(
								db.books.query({}),
							);
							const afterDelete = Chunk.toReadonlyArray(afterDeleteChunk);
							const existsAfter = afterDelete.some(
								(book) => book.id === created.id,
							);
							expect(existsAfter).toBe(false);
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should maintain other entities when deleting one entity from a collection", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate 2-10 unique entities
					fc.array(entityArbitrary(BookSchema), { minLength: 2, maxLength: 10 }),
					// Pick which entity to delete (by index)
					fc.nat(),
					async (entitiesWithIds, deleteIndexSeed) => {
						const entitiesData = entitiesWithIds.map(({ id: _unusedId, ...data }) => data);

						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(basicConfig, {
								books: [],
							});

							// Create all entities
							const createdEntities: Book[] = [];
							for (const entityData of entitiesData) {
								const created = yield* db.books.create(entityData);
								createdEntities.push(created);
							}

							// Pick one entity to delete
							const deleteIndex = deleteIndexSeed % createdEntities.length;
							const entityToDelete = createdEntities[deleteIndex];

							// Delete that entity
							yield* db.books.delete(entityToDelete.id);

							// Verify the deleted entity is not findable
							const deletedFindResult = yield* db.books.findById(entityToDelete.id).pipe(
								Effect.flip,
							);
							expect(deletedFindResult._tag).toBe("NotFoundError");

							// Verify all OTHER entities are still findable
							for (let i = 0; i < createdEntities.length; i++) {
								if (i === deleteIndex) continue;

								const entity = createdEntities[i];
								const found = yield* db.books.findById(entity.id);
								expect(found).toEqual(entity);
							}

							// Verify query returns exactly the remaining entities
							const queryChunk = yield* Stream.runCollect(db.books.query({}));
							const queryResult = Chunk.toReadonlyArray(queryChunk);
							expect(queryResult.length).toBe(createdEntities.length - 1);

							// Verify deleted entity is not in query results
							const deletedInQuery = queryResult.some(
								(book) => book.id === entityToDelete.id,
							);
							expect(deletedInQuery).toBe(false);

							// Verify all remaining entities are in query results
							for (let i = 0; i < createdEntities.length; i++) {
								if (i === deleteIndex) continue;

								const entity = createdEntities[i];
								const inQuery = queryResult.some(
									(book) => book.id === entity.id,
								);
								expect(inQuery).toBe(true);
							}
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() / 2 }, // Fewer runs since we create multiple entities per run
			);
		});

		it("should fail with NotFoundError when deleting the same entity twice", async () => {
			await fc.assert(
				fc.asyncProperty(
					entityArbitrary(BookSchema),
					async (entityWithId) => {
						const { id: _unusedId, ...entityData } = entityWithId;

						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(basicConfig, {
								books: [],
							});

							// Create the entity
							const created = yield* db.books.create(entityData);

							// First delete should succeed
							const firstDelete = yield* db.books.delete(created.id);
							expect(firstDelete.id).toBe(created.id);

							// Second delete should fail with NotFoundError
							const secondDeleteResult = yield* db.books.delete(created.id).pipe(
								Effect.flip,
							);
							expect(secondDeleteResult._tag).toBe("NotFoundError");
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() },
			);
		});

		it("should not include deleted entities in filtered queries", async () => {
			await fc.assert(
				fc.asyncProperty(
					// Generate entities with a specific known genre for filtering
					fc.array(
						fc.record({
							title: fc.string({ minLength: 1, maxLength: 20 }),
							author: fc.string({ minLength: 1, maxLength: 20 }),
							year: fc.integer({ min: 1900, max: 2100 }),
							rating: fc.float({ min: 0, max: 5, noNaN: true }),
							isPublished: fc.boolean(),
							tags: fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 0, maxLength: 5 }),
						}),
						{ minLength: 2, maxLength: 5 },
					),
					fc.nat(),
					async (entitiesData, deleteIndexSeed) => {
						const program = Effect.gen(function* () {
							const db = yield* createEffectDatabase(basicConfig, {
								books: [],
							});

							// Create all entities
							const createdEntities: Book[] = [];
							for (const entityData of entitiesData) {
								const created = yield* db.books.create(entityData);
								createdEntities.push(created);
							}

							// Pick one entity to delete
							const deleteIndex = deleteIndexSeed % createdEntities.length;
							const entityToDelete = createdEntities[deleteIndex];

							// Query with a filter that would include the entity before deletion
							const beforeDeleteChunk = yield* Stream.runCollect(
								db.books.query({ where: { id: entityToDelete.id } }),
							);
							const beforeDelete = Chunk.toReadonlyArray(beforeDeleteChunk);
							expect(beforeDelete.length).toBe(1);
							expect(beforeDelete[0].id).toBe(entityToDelete.id);

							// Delete the entity
							yield* db.books.delete(entityToDelete.id);

							// Query with same filter should now return empty
							const afterDeleteChunk = yield* Stream.runCollect(
								db.books.query({ where: { id: entityToDelete.id } }),
							);
							const afterDelete = Chunk.toReadonlyArray(afterDeleteChunk);
							expect(afterDelete.length).toBe(0);
						});

						await Effect.runPromise(program);
					},
				),
				{ numRuns: getNumRuns() / 2 },
			);
		});
	});

	describe("Task 7.4: Unique constraint enforcement", () => {
		// Property tests will be added in task 7.4
	});
});
