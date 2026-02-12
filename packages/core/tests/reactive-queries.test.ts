/**
 * Tests for reactive queries at the database factory level.
 *
 * These tests verify that the watch() and watchById() methods on collections
 * work correctly when wired up through createEffectDatabase, including
 * proper integration with CRUD operations that trigger change events.
 */

import { describe, expect, it } from "vitest";
import { Chunk, Effect, Fiber, Schema, Stream } from "effect";
import { createEffectDatabase } from "../src/factories/database-effect.js";

// ============================================================================
// Test Schemas
// ============================================================================

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	genre: Schema.String,
});

type Book = Schema.Schema.Type<typeof BookSchema>;

const AuthorSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	country: Schema.String,
});

type Author = Schema.Schema.Type<typeof AuthorSchema>;

// ============================================================================
// Test Configuration
// ============================================================================

const config = {
	books: {
		schema: BookSchema,
		relationships: {},
	},
	authors: {
		schema: AuthorSchema,
		relationships: {},
	},
} as const;

// ============================================================================
// Test Data
// ============================================================================

const testBooks: ReadonlyArray<Book> = [
	{
		id: "1",
		title: "Dune",
		author: "Frank Herbert",
		year: 1965,
		genre: "sci-fi",
	},
	{
		id: "2",
		title: "Neuromancer",
		author: "William Gibson",
		year: 1984,
		genre: "sci-fi",
	},
	{
		id: "3",
		title: "The Hobbit",
		author: "J.R.R. Tolkien",
		year: 1937,
		genre: "fantasy",
	},
];

const testAuthors: ReadonlyArray<Author> = [
	{ id: "a1", name: "Frank Herbert", country: "USA" },
	{ id: "a2", name: "William Gibson", country: "USA" },
];

const initialData = {
	books: testBooks,
	authors: testAuthors,
};

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Helper to create a database and run a scoped test program.
 * The database is created within the scope, ensuring proper cleanup of
 * PubSub subscriptions when the test completes.
 */
const runWithDb = <A>(
	program: (
		db: Awaited<ReturnType<typeof createEffectDatabase<typeof config>>>,
	) => Effect.Effect<A, unknown, never>,
) =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const db = yield* createEffectDatabase(config, initialData);
				return yield* program(db);
			}),
		),
	);

// ============================================================================
// Tests - Basic Watch (12.1 - 12.4)
// ============================================================================

describe("reactive queries - basic watch", () => {
	describe("test helpers setup (12.1)", () => {
		it("creates a database with watch methods on collections", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Verify watch methods exist
					expect(typeof db.books.watch).toBe("function");
					expect(typeof db.books.watchById).toBe("function");
					expect(typeof db.authors.watch).toBe("function");
					expect(typeof db.authors.watchById).toBe("function");
				}),
			);
		});

		it("creates a scoped database that can be used with watch subscriptions", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Create a watch subscription - it should be scoped to the database lifecycle
					const stream = yield* db.books.watch();

					// Take one emission to verify the stream works
					const results = yield* Stream.runCollect(Stream.take(stream, 1));
					const emission = Chunk.toReadonlyArray(results)[0];

					expect(emission).toBeDefined();
					expect(Array.isArray(emission)).toBe(true);
				}),
			);
		});
	});

	describe("initial emission (12.2)", () => {
		it("emits the current result set immediately on subscription", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					const stream = yield* db.books.watch();

					// Take just the initial emission
					const results = yield* Stream.runCollect(Stream.take(stream, 1));
					const emission = Chunk.toReadonlyArray(results)[0] as ReadonlyArray<Book>;

					// Should emit all books immediately
					expect(emission).toHaveLength(3);
					expect(emission.map((b) => b.title)).toContain("Dune");
					expect(emission.map((b) => b.title)).toContain("Neuromancer");
					expect(emission.map((b) => b.title)).toContain("The Hobbit");
				}),
			);
		});

		it("emits empty array when no entities match", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					const stream = yield* db.books.watch({
						where: { genre: "horror" },
					});

					const results = yield* Stream.runCollect(Stream.take(stream, 1));
					const emission = Chunk.toReadonlyArray(results)[0] as ReadonlyArray<Book>;

					expect(emission).toHaveLength(0);
				}),
			);
		});
	});

	describe("query config application (12.3)", () => {
		it("applies where filter on initial emission", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
					});

					const results = yield* Stream.runCollect(Stream.take(stream, 1));
					const emission = Chunk.toReadonlyArray(results)[0] as ReadonlyArray<Book>;

					expect(emission).toHaveLength(2);
					expect(emission.every((b) => b.genre === "sci-fi")).toBe(true);
				}),
			);
		});

		it("applies sort on initial emission", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					const stream = yield* db.books.watch({
						sort: { year: "asc" },
					});

					const results = yield* Stream.runCollect(Stream.take(stream, 1));
					const emission = Chunk.toReadonlyArray(results)[0] as ReadonlyArray<Book>;

					expect(emission).toHaveLength(3);
					expect(emission[0].year).toBe(1937);
					expect(emission[1].year).toBe(1965);
					expect(emission[2].year).toBe(1984);
				}),
			);
		});

		it("applies select on initial emission", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					const stream = yield* db.books.watch({
						select: ["title", "author"],
					});

					const results = yield* Stream.runCollect(Stream.take(stream, 1));
					const emission = Chunk.toReadonlyArray(results)[0] as ReadonlyArray<
						Record<string, unknown>
					>;

					expect(emission).toHaveLength(3);
					for (const item of emission) {
						expect(Object.keys(item).sort()).toEqual(["author", "title"]);
					}
				}),
			);
		});

		it("applies limit on initial emission", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					const stream = yield* db.books.watch({
						sort: { year: "asc" },
						limit: 2,
					});

					const results = yield* Stream.runCollect(Stream.take(stream, 1));
					const emission = Chunk.toReadonlyArray(results)[0] as ReadonlyArray<Book>;

					expect(emission).toHaveLength(2);
					expect(emission[0].title).toBe("The Hobbit");
					expect(emission[1].title).toBe("Dune");
				}),
			);
		});

		it("applies offset on initial emission", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					const stream = yield* db.books.watch({
						sort: { year: "asc" },
						offset: 1,
						limit: 2,
					});

					const results = yield* Stream.runCollect(Stream.take(stream, 1));
					const emission = Chunk.toReadonlyArray(results)[0] as ReadonlyArray<Book>;

					expect(emission).toHaveLength(2);
					expect(emission[0].title).toBe("Dune");
					expect(emission[1].title).toBe("Neuromancer");
				}),
			);
		});

		it("applies full pipeline (where + sort + select + limit) on initial emission", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "desc" },
						select: ["title", "year"],
						limit: 1,
					});

					const results = yield* Stream.runCollect(Stream.take(stream, 1));
					const emission = Chunk.toReadonlyArray(results)[0] as ReadonlyArray<
						Record<string, unknown>
					>;

					expect(emission).toHaveLength(1);
					expect(emission[0]).toEqual({ title: "Neuromancer", year: 1984 });
				}),
			);
		});
	});

	describe("stream consumption (12.4)", () => {
		it("can be consumed via Stream.take and Stream.runCollect", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					const stream = yield* db.books.watch();

					// Fork collection to allow concurrent operations
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("20 millis");

					// Trigger a change to get second emission
					yield* db.books.create({
						title: "Foundation",
						author: "Isaac Asimov",
						year: 1951,
						genre: "sci-fi",
					});

					// Wait for second emission and collect
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					expect(emissions).toHaveLength(2);
					expect(emissions[0]).toHaveLength(3);
					expect(emissions[1]).toHaveLength(4);
				}),
			);
		});

		it("can be consumed via Stream.runForEach", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					const stream = yield* db.books.watch();

					const emissions: Array<ReadonlyArray<Book>> = [];

					// Use Stream.runForEach with a take to limit iterations
					yield* Stream.take(stream, 1).pipe(
						Stream.runForEach((emission) =>
							Effect.sync(() => {
								emissions.push(emission);
							}),
						),
					);

					expect(emissions).toHaveLength(1);
					expect(emissions[0]).toHaveLength(3);
				}),
			);
		});

		it("can be mapped and transformed", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
					});

					// Map to just count
					const countStream = Stream.map(stream, (books) => books.length);

					const results = yield* Stream.runCollect(Stream.take(countStream, 1));
					const counts = Chunk.toReadonlyArray(results);

					expect(counts[0]).toBe(2);
				}),
			);
		});

		it("multiple subscriptions receive independent emissions", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Create two independent watch subscriptions
					const stream1 = yield* db.books.watch({ where: { genre: "sci-fi" } });
					const stream2 = yield* db.books.watch({ where: { genre: "fantasy" } });

					// Take initial emissions from both
					const fiber1 = yield* Stream.take(stream1, 1).pipe(
						Stream.runCollect,
						Effect.fork,
					);
					const fiber2 = yield* Stream.take(stream2, 1).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					const results1 = yield* Fiber.join(fiber1);
					const results2 = yield* Fiber.join(fiber2);

					const emission1 = Chunk.toReadonlyArray(results1)[0] as ReadonlyArray<Book>;
					const emission2 = Chunk.toReadonlyArray(results2)[0] as ReadonlyArray<Book>;

					// Each subscription should have its own filtered results
					expect(emission1).toHaveLength(2);
					expect(emission1.every((b) => b.genre === "sci-fi")).toBe(true);

					expect(emission2).toHaveLength(1);
					expect(emission2.every((b) => b.genre === "fantasy")).toBe(true);
				}),
			);
		});
	});
});

// ============================================================================
// Tests - Mutation Triggers (13.1 - 13.5)
// ============================================================================

describe("reactive queries - mutation triggers", () => {
	describe("create triggers watch (13.1)", () => {
		it("inserting a matching entity causes a new emission with the entity included", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Fork collection to get 2 emissions: initial + after create
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission to be processed
					yield* Effect.sleep("20 millis");

					// Create a new sci-fi book that matches the filter
					yield* db.books.create({
						title: "Foundation",
						author: "Isaac Asimov",
						year: 1951,
						genre: "sci-fi",
					});

					// Wait for the stream to emit and collect results
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					// Should have 2 emissions
					expect(emissions).toHaveLength(2);

					// Initial emission: 2 sci-fi books (Dune 1965, Neuromancer 1984)
					expect(emissions[0]).toHaveLength(2);
					expect(emissions[0].map((b) => b.title)).toEqual([
						"Dune",
						"Neuromancer",
					]);

					// After create: 3 sci-fi books, sorted by year (Foundation 1951, Dune 1965, Neuromancer 1984)
					expect(emissions[1]).toHaveLength(3);
					expect(emissions[1].map((b) => b.title)).toEqual([
						"Foundation",
						"Dune",
						"Neuromancer",
					]);
					expect(emissions[1].find((b) => b.title === "Foundation")).toBeDefined();
				}),
			);
		});

		it("inserting multiple matching entities via createMany causes emission with all new entities", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Fork collection to get 2 emissions
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("20 millis");

					// Create multiple sci-fi books at once
					yield* db.books.createMany([
						{
							title: "Foundation",
							author: "Isaac Asimov",
							year: 1951,
							genre: "sci-fi",
						},
						{
							title: "Snow Crash",
							author: "Neal Stephenson",
							year: 1992,
							genre: "sci-fi",
						},
					]);

					// Wait for emission and collect
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					expect(emissions).toHaveLength(2);

					// Initial: 2 sci-fi books
					expect(emissions[0]).toHaveLength(2);

					// After createMany: 4 sci-fi books (Foundation 1951, Dune 1965, Neuromancer 1984, Snow Crash 1992)
					expect(emissions[1]).toHaveLength(4);
					expect(emissions[1].map((b) => b.title)).toEqual([
						"Foundation",
						"Dune",
						"Neuromancer",
						"Snow Crash",
					]);
				}),
			);
		});
	});

	describe("update triggers watch (13.2)", () => {
		it("updating a matched entity causes a new emission with the updated entity", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books sorted by year
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Fork collection to get 2 emissions: initial + after update
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission to be processed
					yield* Effect.sleep("20 millis");

					// Update Dune's year (id: "1", year: 1965 -> 1966)
					yield* db.books.update("1", { year: 1966 });

					// Wait for the stream to emit and collect results
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					// Should have 2 emissions
					expect(emissions).toHaveLength(2);

					// Initial emission: Dune 1965, Neuromancer 1984
					expect(emissions[0]).toHaveLength(2);
					expect(emissions[0].find((b) => b.id === "1")?.year).toBe(1965);

					// After update: Dune 1966, Neuromancer 1984
					expect(emissions[1]).toHaveLength(2);
					expect(emissions[1].find((b) => b.id === "1")?.year).toBe(1966);
				}),
			);
		});

		it("updating a matched entity's title causes emission with new title", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch all books
					const stream = yield* db.books.watch({
						sort: { title: "asc" },
					});

					// Fork collection to get 2 emissions
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("20 millis");

					// Update Dune's title
					yield* db.books.update("1", { title: "Dune Messiah" });

					// Collect results
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					expect(emissions).toHaveLength(2);

					// Initial: Dune, Neuromancer, The Hobbit (sorted alphabetically)
					expect(emissions[0].map((b) => b.title)).toEqual([
						"Dune",
						"Neuromancer",
						"The Hobbit",
					]);

					// After update: Dune Messiah, Neuromancer, The Hobbit
					expect(emissions[1].map((b) => b.title)).toEqual([
						"Dune Messiah",
						"Neuromancer",
						"The Hobbit",
					]);
				}),
			);
		});

		it("updateMany triggers emission with all updated entities", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Fork collection to get 2 emissions
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("20 millis");

					// Update all sci-fi books' years using predicate and single update
					yield* db.books.updateMany(
						(book: Book) => book.genre === "sci-fi",
						{ year: 2000 },
					);

					// Collect results
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					expect(emissions).toHaveLength(2);

					// Initial: Dune 1965, Neuromancer 1984
					expect(emissions[0].map((b) => b.year)).toEqual([1965, 1984]);

					// After updateMany: Both books now have year 2000
					expect(emissions[1].map((b) => b.year)).toEqual([2000, 2000]);
				}),
			);
		});
	});

	describe("entity entering result set (13.4)", () => {
		it("updating a non-matching entity to match the where clause triggers emission", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books only
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Fork collection to get 2 emissions: initial + after update
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission to be processed
					yield* Effect.sleep("20 millis");

					// Update The Hobbit (id: "3", genre: "fantasy") to be sci-fi
					// This makes it match the watch filter
					yield* db.books.update("3", { genre: "sci-fi" });

					// Wait for the stream to emit and collect results
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					// Should have 2 emissions
					expect(emissions).toHaveLength(2);

					// Initial emission: 2 sci-fi books (Dune 1965, Neuromancer 1984)
					expect(emissions[0]).toHaveLength(2);
					expect(emissions[0].map((b) => b.title)).toEqual([
						"Dune",
						"Neuromancer",
					]);

					// After update: 3 sci-fi books, sorted by year
					// (The Hobbit 1937, Dune 1965, Neuromancer 1984)
					expect(emissions[1]).toHaveLength(3);
					expect(emissions[1].map((b) => b.title)).toEqual([
						"The Hobbit",
						"Dune",
						"Neuromancer",
					]);
					// Verify The Hobbit is now included and has correct genre
					const hobbit = emissions[1].find((b) => b.id === "3");
					expect(hobbit).toBeDefined();
					expect(hobbit?.genre).toBe("sci-fi");
				}),
			);
		});

		it("updating entity from one genre to another causes it to enter different watch result sets", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch fantasy books only (initially only The Hobbit)
					const stream = yield* db.books.watch({
						where: { genre: "fantasy" },
						sort: { title: "asc" },
					});

					// Fork collection to get 2 emissions
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("20 millis");

					// Update Dune (id: "1", genre: "sci-fi") to be fantasy
					yield* db.books.update("1", { genre: "fantasy" });

					// Collect results
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					expect(emissions).toHaveLength(2);

					// Initial: 1 fantasy book (The Hobbit)
					expect(emissions[0]).toHaveLength(1);
					expect(emissions[0][0].title).toBe("The Hobbit");

					// After update: 2 fantasy books (Dune and The Hobbit)
					expect(emissions[1]).toHaveLength(2);
					expect(emissions[1].map((b) => b.title)).toEqual([
						"Dune",
						"The Hobbit",
					]);
				}),
			);
		});
	});

	describe("entity leaving result set (13.5)", () => {
		it("updating a matching entity to no longer match triggers emission without the entity", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books only
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Fork collection to get 2 emissions: initial + after update
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission to be processed
					yield* Effect.sleep("20 millis");

					// Update Dune (id: "1", genre: "sci-fi") to be fantasy
					// This makes it no longer match the watch filter
					yield* db.books.update("1", { genre: "fantasy" });

					// Wait for the stream to emit and collect results
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					// Should have 2 emissions
					expect(emissions).toHaveLength(2);

					// Initial emission: 2 sci-fi books (Dune 1965, Neuromancer 1984)
					expect(emissions[0]).toHaveLength(2);
					expect(emissions[0].map((b) => b.title)).toEqual([
						"Dune",
						"Neuromancer",
					]);

					// After update: 1 sci-fi book (Neuromancer 1984)
					// Dune left the result set because it's now fantasy
					expect(emissions[1]).toHaveLength(1);
					expect(emissions[1].map((b) => b.title)).toEqual(["Neuromancer"]);
					// Verify Dune is no longer in the result set
					expect(emissions[1].find((b) => b.id === "1")).toBeUndefined();
				}),
			);
		});

		it("updating entity to leave one watch and enter another", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books (initially Dune and Neuromancer)
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { title: "asc" },
					});

					// Fork collection to get 2 emissions
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("20 millis");

					// Update Neuromancer (id: "2", genre: "sci-fi") to be fantasy
					// This removes it from the sci-fi watch
					yield* db.books.update("2", { genre: "fantasy" });

					// Collect results
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					expect(emissions).toHaveLength(2);

					// Initial: 2 sci-fi books (Dune, Neuromancer)
					expect(emissions[0]).toHaveLength(2);
					expect(emissions[0].map((b) => b.title)).toEqual([
						"Dune",
						"Neuromancer",
					]);

					// After update: 1 sci-fi book (Dune only)
					expect(emissions[1]).toHaveLength(1);
					expect(emissions[1][0].title).toBe("Dune");
				}),
			);
		});

		it("updating multiple entities via updateMany causes some to leave result set", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Fork collection to get 2 emissions
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("20 millis");

					// Change all books from 1970 or later to horror genre
					// This should remove Neuromancer (1984) from the sci-fi results
					yield* db.books.updateMany(
						(book: Book) => book.year >= 1970,
						{ genre: "horror" },
					);

					// Collect results
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					expect(emissions).toHaveLength(2);

					// Initial: 2 sci-fi books (Dune 1965, Neuromancer 1984)
					expect(emissions[0]).toHaveLength(2);
					expect(emissions[0].map((b) => b.title)).toEqual([
						"Dune",
						"Neuromancer",
					]);

					// After updateMany: Only Dune remains (1965 < 1970, so not updated)
					expect(emissions[1]).toHaveLength(1);
					expect(emissions[1][0].title).toBe("Dune");
					expect(emissions[1][0].genre).toBe("sci-fi");
				}),
			);
		});
	});

	describe("delete triggers watch (13.3)", () => {
		it("deleting a matched entity causes a new emission without the entity", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books sorted by year
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Fork collection to get 2 emissions: initial + after delete
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission to be processed
					yield* Effect.sleep("20 millis");

					// Delete Dune (id: "1", genre: "sci-fi")
					yield* db.books.delete("1");

					// Wait for the stream to emit and collect results
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					// Should have 2 emissions
					expect(emissions).toHaveLength(2);

					// Initial emission: Dune 1965, Neuromancer 1984
					expect(emissions[0]).toHaveLength(2);
					expect(emissions[0].map((b) => b.title)).toEqual([
						"Dune",
						"Neuromancer",
					]);

					// After delete: Only Neuromancer remains
					expect(emissions[1]).toHaveLength(1);
					expect(emissions[1].map((b) => b.title)).toEqual(["Neuromancer"]);
					expect(emissions[1].find((b) => b.id === "1")).toBeUndefined();
				}),
			);
		});

		it("deleting multiple matched entities via deleteMany causes emission without those entities", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Fork collection to get 2 emissions
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("20 millis");

					// Delete both sci-fi books using a predicate
					yield* db.books.deleteMany((book: Book) => book.genre === "sci-fi");

					// Collect results
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					expect(emissions).toHaveLength(2);

					// Initial: Dune 1965, Neuromancer 1984
					expect(emissions[0]).toHaveLength(2);
					expect(emissions[0].map((b) => b.title)).toEqual([
						"Dune",
						"Neuromancer",
					]);

					// After deleteMany: No sci-fi books remain
					expect(emissions[1]).toHaveLength(0);
				}),
			);
		});

		it("deleting a non-matching entity does not affect watch results", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Fork collection to get 2 emissions
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("20 millis");

					// Delete The Hobbit (id: "3", genre: "fantasy") - not in sci-fi watch
					yield* db.books.delete("3");

					// Create a new sci-fi book to trigger a second emission
					// (needed since deleting non-matching entity may be deduplicated)
					yield* db.books.create({
						title: "Foundation",
						author: "Isaac Asimov",
						year: 1951,
						genre: "sci-fi",
					});

					// Collect results
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					expect(emissions).toHaveLength(2);

					// Initial: Dune 1965, Neuromancer 1984
					expect(emissions[0]).toHaveLength(2);

					// After delete of fantasy book + create of Foundation:
					// 3 sci-fi books (Foundation was added)
					expect(emissions[1]).toHaveLength(3);
					expect(emissions[1].map((b) => b.title)).toEqual([
						"Foundation",
						"Dune",
						"Neuromancer",
					]);
				}),
			);
		});
	});
});
