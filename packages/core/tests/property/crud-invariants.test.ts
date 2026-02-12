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
		// Property tests will be added in task 7.2
	});

	describe("Task 7.3: Delete then findById fails with NotFoundError", () => {
		// Property tests will be added in task 7.3
	});

	describe("Task 7.4: Unique constraint enforcement", () => {
		// Property tests will be added in task 7.4
	});
});
