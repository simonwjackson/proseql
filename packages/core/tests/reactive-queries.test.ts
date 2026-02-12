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

// ============================================================================
// Tests - Irrelevant Mutations (14.1 - 14.2)
// ============================================================================

describe("reactive queries - irrelevant mutations", () => {
	describe("deduplication of unchanged result sets (14.2)", () => {
		it("creating a non-matching entity does not produce a new emission", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books only
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Track all emissions received
					const emissions: Array<ReadonlyArray<Book>> = [];

					// Fork collection with a timeout - we expect only initial emission
					const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
						Effect.sync(() => {
							emissions.push(emission);
						}),
					).pipe(
						Effect.timeoutFail({
							duration: "100 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emission to be processed
					yield* Effect.sleep("30 millis");

					// Create a fantasy book - does NOT match the sci-fi filter
					// This triggers a change event, but the result set is unchanged
					yield* db.books.create({
						title: "The Name of the Wind",
						author: "Patrick Rothfuss",
						year: 2007,
						genre: "fantasy",
					});

					// Wait to allow any potential (erroneous) emission
					yield* Effect.sleep("50 millis");

					// Interrupt the fiber
					yield* Fiber.interrupt(collectedFiber);

					// Should only have the initial emission - no second emission
					// because the result set is unchanged (deduplication)
					expect(emissions).toHaveLength(1);
					expect(emissions[0]).toHaveLength(2); // 2 sci-fi books
					expect(emissions[0].map((b) => b.title)).toEqual([
						"Dune",
						"Neuromancer",
					]);
				}),
			);
		});

		it("createMany of all non-matching entities does not produce a new emission", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books only
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Track all emissions received
					const emissions: Array<ReadonlyArray<Book>> = [];

					// Fork collection with a timeout
					const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
						Effect.sync(() => {
							emissions.push(emission);
						}),
					).pipe(
						Effect.timeoutFail({
							duration: "100 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");

					// Create multiple fantasy books - none match the sci-fi filter
					yield* db.books.createMany([
						{
							title: "The Name of the Wind",
							author: "Patrick Rothfuss",
							year: 2007,
							genre: "fantasy",
						},
						{
							title: "A Game of Thrones",
							author: "George R.R. Martin",
							year: 1996,
							genre: "fantasy",
						},
						{
							title: "The Way of Kings",
							author: "Brandon Sanderson",
							year: 2010,
							genre: "fantasy",
						},
					]);

					// Wait for any potential emissions
					yield* Effect.sleep("50 millis");

					// Interrupt the fiber
					yield* Fiber.interrupt(collectedFiber);

					// Should only have the initial emission
					expect(emissions).toHaveLength(1);
					expect(emissions[0]).toHaveLength(2); // 2 sci-fi books unchanged
				}),
			);
		});

		it("updating a non-matching entity (that stays non-matching) does not produce a new emission", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books only
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Track all emissions received
					const emissions: Array<ReadonlyArray<Book>> = [];

					// Fork collection with a timeout
					const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
						Effect.sync(() => {
							emissions.push(emission);
						}),
					).pipe(
						Effect.timeoutFail({
							duration: "100 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");

					// Update The Hobbit (id: "3", genre: "fantasy") year
					// It doesn't match the sci-fi filter, and the update doesn't make it match
					yield* db.books.update("3", { year: 2000 });

					// Wait for any potential emissions
					yield* Effect.sleep("50 millis");

					// Interrupt the fiber
					yield* Fiber.interrupt(collectedFiber);

					// Should only have the initial emission
					expect(emissions).toHaveLength(1);
					expect(emissions[0]).toHaveLength(2); // 2 sci-fi books unchanged
				}),
			);
		});

		it("deleting a non-matching entity does not produce a new emission", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books only
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Track all emissions received
					const emissions: Array<ReadonlyArray<Book>> = [];

					// Fork collection with a timeout
					const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
						Effect.sync(() => {
							emissions.push(emission);
						}),
					).pipe(
						Effect.timeoutFail({
							duration: "100 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");

					// Delete The Hobbit (id: "3", genre: "fantasy")
					// It doesn't match the sci-fi filter, so result set is unchanged
					yield* db.books.delete("3");

					// Wait for any potential emissions
					yield* Effect.sleep("50 millis");

					// Interrupt the fiber
					yield* Fiber.interrupt(collectedFiber);

					// Should only have the initial emission
					expect(emissions).toHaveLength(1);
					expect(emissions[0]).toHaveLength(2); // 2 sci-fi books unchanged
				}),
			);
		});

		it("update that changes fields not in where clause produces emission only if result changes", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch books sorted by year
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Fork collection to get 2 emissions: initial + after meaningful update
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");

					// First, update Dune's author (result changes because we're watching all fields)
					yield* db.books.update("1", { author: "F. Herbert" });

					// Collect results
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					// Should have 2 emissions because the result set content changed
					expect(emissions).toHaveLength(2);
					expect(emissions[0].find((b) => b.id === "1")?.author).toBe(
						"Frank Herbert",
					);
					expect(emissions[1].find((b) => b.id === "1")?.author).toBe(
						"F. Herbert",
					);
				}),
			);
		});
	});

	describe("mutation to different collection (14.1)", () => {
		it("mutation to a different collection does not trigger re-evaluation", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch books collection
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Track all emissions received
					const emissions: Array<ReadonlyArray<Book>> = [];

					// Fork collection with a timeout - we expect only initial emission
					const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
						Effect.sync(() => {
							emissions.push(emission);
						}),
					).pipe(
						Effect.timeoutFail({
							duration: "100 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchTag("NoSuchElementException", () => Effect.void),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emission to be processed
					yield* Effect.sleep("30 millis");

					// Perform mutations on the AUTHORS collection (not books)
					yield* db.authors.create({
						name: "Ursula K. Le Guin",
						country: "USA",
					});
					yield* db.authors.update("a1", { country: "United States" });
					yield* db.authors.delete("a2");

					// Wait a bit more to allow any potential (erroneous) emissions
					yield* Effect.sleep("50 millis");

					// Interrupt the fiber
					yield* Fiber.interrupt(collectedFiber);

					// Should only have the initial emission - no re-evaluation from authors mutations
					expect(emissions).toHaveLength(1);
					expect(emissions[0]).toHaveLength(2); // 2 sci-fi books
					expect(emissions[0].map((b) => b.title)).toEqual([
						"Dune",
						"Neuromancer",
					]);
				}),
			);
		});

		it("createMany on different collection does not trigger re-evaluation", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch books collection
					const stream = yield* db.books.watch({
						sort: { title: "asc" },
					});

					// Track all emissions received
					const emissions: Array<ReadonlyArray<Book>> = [];

					// Fork collection with a timeout
					const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
						Effect.sync(() => {
							emissions.push(emission);
						}),
					).pipe(
						Effect.timeoutFail({
							duration: "100 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");

					// Create multiple authors - should not trigger books watch
					yield* db.authors.createMany([
						{ name: "Isaac Asimov", country: "USA" },
						{ name: "Arthur C. Clarke", country: "UK" },
						{ name: "Ray Bradbury", country: "USA" },
					]);

					// Wait for any potential emissions
					yield* Effect.sleep("50 millis");

					// Interrupt the fiber
					yield* Fiber.interrupt(collectedFiber);

					// Should only have the initial emission
					expect(emissions).toHaveLength(1);
					expect(emissions[0]).toHaveLength(3); // All 3 books
				}),
			);
		});

		it("simultaneous watches on different collections receive only relevant mutations", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch both collections simultaneously
					const booksStream = yield* db.books.watch({
						where: { genre: "sci-fi" },
					});
					const authorsStream = yield* db.authors.watch();

					// Track emissions for both
					const bookEmissions: Array<ReadonlyArray<Book>> = [];
					const authorEmissions: Array<ReadonlyArray<Author>> = [];

					// Fork both watchers
					const booksFiber = yield* Stream.runForEach(booksStream, (emission) =>
						Effect.sync(() => {
							bookEmissions.push(emission);
						}),
					).pipe(
						Effect.timeoutFail({
							duration: "150 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					const authorsFiber = yield* Stream.runForEach(
						authorsStream,
						(emission) =>
							Effect.sync(() => {
								authorEmissions.push(emission);
							}),
					).pipe(
						Effect.timeoutFail({
							duration: "150 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emissions
					yield* Effect.sleep("30 millis");

					// Mutate only authors
					yield* db.authors.create({
						name: "Ursula K. Le Guin",
						country: "USA",
					});

					// Wait for emissions to settle
					yield* Effect.sleep("50 millis");

					// Interrupt both fibers
					yield* Fiber.interrupt(booksFiber);
					yield* Fiber.interrupt(authorsFiber);

					// Books should only have initial emission (authors mutation irrelevant)
					expect(bookEmissions).toHaveLength(1);
					expect(bookEmissions[0]).toHaveLength(2); // 2 sci-fi books

					// Authors should have 2 emissions: initial + after create
					expect(authorEmissions).toHaveLength(2);
					expect(authorEmissions[0]).toHaveLength(2); // Initial 2 authors
					expect(authorEmissions[1]).toHaveLength(3); // After creating new author
				}),
			);
		});
	});
});

// ============================================================================
// Tests - Transactions (15.1 - 15.3)
// ============================================================================

describe("reactive queries - transactions", () => {
	describe("no emissions during transaction (15.1)", () => {
		it("transaction: no emissions during transaction (intermediate states suppressed)", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Track all emissions received
					const emissions: Array<ReadonlyArray<Book>> = [];

					// Fork collection with a timeout
					const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
						Effect.sync(() => {
							emissions.push(emission);
						}),
					).pipe(
						Effect.timeoutFail({
							duration: "200 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emission to be processed
					yield* Effect.sleep("30 millis");

					// Start a transaction and perform multiple mutations
					// These should NOT trigger emissions during the transaction
					yield* db.$transaction((tx) =>
						Effect.gen(function* () {
							// Create a new book
							yield* tx.books.create({
								title: "Foundation",
								author: "Isaac Asimov",
								year: 1951,
								genre: "sci-fi",
							});

							// Wait to see if any emission happens (it shouldn't)
							yield* Effect.sleep("30 millis");

							// Update an existing book
							yield* tx.books.update("1", { year: 1966 });

							// Wait again
							yield* Effect.sleep("30 millis");

							// Create another book
							yield* tx.books.create({
								title: "Snow Crash",
								author: "Neal Stephenson",
								year: 1992,
								genre: "sci-fi",
							});

							// Wait one more time inside the transaction
							yield* Effect.sleep("30 millis");
						}),
					);

					// Wait for any emissions after commit
					yield* Effect.sleep("50 millis");

					// Interrupt the fiber
					yield* Fiber.interrupt(collectedFiber);

					// Should have exactly 2 emissions:
					// 1. Initial emission (2 sci-fi books: Dune 1965, Neuromancer 1984)
					// 2. Post-commit emission (4 sci-fi books: Foundation 1951, Dune 1966, Neuromancer 1984, Snow Crash 1992)
					// NO intermediate emissions during the transaction
					expect(emissions).toHaveLength(2);

					// Initial emission: 2 sci-fi books
					expect(emissions[0]).toHaveLength(2);
					expect(emissions[0].map((b) => b.title)).toEqual([
						"Dune",
						"Neuromancer",
					]);

					// After commit: 4 sci-fi books, sorted by year
					expect(emissions[1]).toHaveLength(4);
					expect(emissions[1].map((b) => b.title)).toEqual([
						"Foundation",
						"Dune",
						"Neuromancer",
						"Snow Crash",
					]);
					// Verify Dune's year was updated
					expect(emissions[1].find((b) => b.id === "1")?.year).toBe(1966);
				}),
			);
		});

		it("transaction mutations on different collections don't emit during transaction", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch both books and authors
					const booksStream = yield* db.books.watch({
						where: { genre: "sci-fi" },
					});
					const authorsStream = yield* db.authors.watch();

					// Track emissions for both
					const bookEmissions: Array<ReadonlyArray<Book>> = [];
					const authorEmissions: Array<ReadonlyArray<Author>> = [];

					// Fork watchers for both collections
					const booksFiber = yield* Stream.runForEach(
						booksStream,
						(emission) =>
							Effect.sync(() => {
								bookEmissions.push(emission);
							}),
					).pipe(
						Effect.timeoutFail({
							duration: "200 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					const authorsFiber = yield* Stream.runForEach(
						authorsStream,
						(emission) =>
							Effect.sync(() => {
								authorEmissions.push(emission);
							}),
					).pipe(
						Effect.timeoutFail({
							duration: "200 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emissions
					yield* Effect.sleep("30 millis");

					// Transaction that mutates both collections
					yield* db.$transaction((tx) =>
						Effect.gen(function* () {
							yield* tx.books.create({
								title: "Foundation",
								author: "Isaac Asimov",
								year: 1951,
								genre: "sci-fi",
							});
							yield* Effect.sleep("20 millis");

							yield* tx.authors.create({
								name: "Isaac Asimov",
								country: "USA",
							});
							yield* Effect.sleep("20 millis");

							yield* tx.books.create({
								title: "Snow Crash",
								author: "Neal Stephenson",
								year: 1992,
								genre: "sci-fi",
							});
							yield* Effect.sleep("20 millis");
						}),
					);

					// Wait for emissions after commit
					yield* Effect.sleep("50 millis");

					// Interrupt both fibers
					yield* Fiber.interrupt(booksFiber);
					yield* Fiber.interrupt(authorsFiber);

					// Books: initial + 1 post-commit emission (no intermediate)
					expect(bookEmissions).toHaveLength(2);
					expect(bookEmissions[0]).toHaveLength(2); // Initial: 2 sci-fi books
					expect(bookEmissions[1]).toHaveLength(4); // After commit: 4 sci-fi books

					// Authors: initial + 1 post-commit emission (no intermediate)
					expect(authorEmissions).toHaveLength(2);
					expect(authorEmissions[0]).toHaveLength(2); // Initial: 2 authors
					expect(authorEmissions[1]).toHaveLength(3); // After commit: 3 authors
				}),
			);
		});
	});

	describe("transaction commit exactly one emission (15.2)", () => {
		it("transaction commit produces exactly one emission with the final state", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch all books sorted by year
					const stream = yield* db.books.watch({
						sort: { year: "asc" },
					});

					// Fork to get exactly 2 emissions: initial + post-commit
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");

					// Perform a transaction with multiple mutations
					yield* db.$transaction((tx) =>
						Effect.gen(function* () {
							// Create two books
							yield* tx.books.create({
								title: "Foundation",
								author: "Isaac Asimov",
								year: 1951,
								genre: "sci-fi",
							});

							yield* tx.books.create({
								title: "I, Robot",
								author: "Isaac Asimov",
								year: 1950,
								genre: "sci-fi",
							});

							// Delete one book
							yield* tx.books.delete("3"); // The Hobbit

							// Update one book
							yield* tx.books.update("1", { title: "Dune (Revised)" });
						}),
					);

					// Collect results
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					// Should have exactly 2 emissions: initial + one post-commit
					expect(emissions).toHaveLength(2);

					// Initial emission: 3 books (The Hobbit, Dune, Neuromancer)
					expect(emissions[0]).toHaveLength(3);
					expect(emissions[0].map((b) => b.title)).toEqual([
						"The Hobbit",
						"Dune",
						"Neuromancer",
					]);

					// Post-commit emission: 4 books, all changes applied
					// I, Robot (1950), Foundation (1951), Dune (Revised) (1965), Neuromancer (1984)
					// The Hobbit was deleted
					expect(emissions[1]).toHaveLength(4);
					expect(emissions[1].map((b) => b.title)).toEqual([
						"I, Robot",
						"Foundation",
						"Dune (Revised)",
						"Neuromancer",
					]);
					// Verify The Hobbit was deleted
					expect(
						emissions[1].find((b) => b.title === "The Hobbit"),
					).toBeUndefined();
					// Verify Dune was renamed
					expect(
						emissions[1].find((b) => b.title === "Dune (Revised)"),
					).toBeDefined();
				}),
			);
		});

		it("multiple sequential transactions each produce exactly one emission", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Fork to get 3 emissions: initial + 2 post-commit
					const collectedFiber = yield* Stream.take(stream, 3).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");

					// First transaction: add one book
					yield* db.$transaction((tx) =>
						Effect.gen(function* () {
							yield* tx.books.create({
								title: "Foundation",
								author: "Isaac Asimov",
								year: 1951,
								genre: "sci-fi",
							});
						}),
					);

					// Wait for first post-commit emission
					yield* Effect.sleep("50 millis");

					// Second transaction: add another book
					yield* db.$transaction((tx) =>
						Effect.gen(function* () {
							yield* tx.books.create({
								title: "Snow Crash",
								author: "Neal Stephenson",
								year: 1992,
								genre: "sci-fi",
							});
						}),
					);

					// Collect results
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					// Should have exactly 3 emissions: initial + one per transaction
					expect(emissions).toHaveLength(3);

					// Initial: 2 sci-fi books (Dune 1965, Neuromancer 1984)
					expect(emissions[0]).toHaveLength(2);
					expect(emissions[0].map((b) => b.title)).toEqual([
						"Dune",
						"Neuromancer",
					]);

					// After first transaction: 3 sci-fi books (Foundation 1951, Dune 1965, Neuromancer 1984)
					expect(emissions[1]).toHaveLength(3);
					expect(emissions[1].map((b) => b.title)).toEqual([
						"Foundation",
						"Dune",
						"Neuromancer",
					]);

					// After second transaction: 4 sci-fi books (Foundation 1951, Dune 1965, Neuromancer 1984, Snow Crash 1992)
					expect(emissions[2]).toHaveLength(4);
					expect(emissions[2].map((b) => b.title)).toEqual([
						"Foundation",
						"Dune",
						"Neuromancer",
						"Snow Crash",
					]);
				}),
			);
		});

		it("transaction with mutations to multiple collections produces one emission per affected collection", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch both books and authors
					const booksStream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { title: "asc" },
					});
					const authorsStream = yield* db.authors.watch({
						sort: { name: "asc" },
					});

					// Fork both to get 2 emissions each: initial + post-commit
					const booksFiber = yield* Stream.take(booksStream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);
					const authorsFiber = yield* Stream.take(authorsStream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emissions
					yield* Effect.sleep("30 millis");

					// Transaction mutating both collections
					yield* db.$transaction((tx) =>
						Effect.gen(function* () {
							yield* tx.books.create({
								title: "2001: A Space Odyssey",
								author: "Arthur C. Clarke",
								year: 1968,
								genre: "sci-fi",
							});
							yield* tx.authors.create({
								name: "Arthur C. Clarke",
								country: "UK",
							});
						}),
					);

					// Collect results from both
					const booksResults = yield* Fiber.join(booksFiber);
					const authorsResults = yield* Fiber.join(authorsFiber);

					const bookEmissions = Chunk.toReadonlyArray(
						booksResults,
					) as ReadonlyArray<ReadonlyArray<Book>>;
					const authorEmissions = Chunk.toReadonlyArray(
						authorsResults,
					) as ReadonlyArray<ReadonlyArray<Author>>;

					// Books: exactly 2 emissions (initial + one post-commit)
					expect(bookEmissions).toHaveLength(2);
					expect(bookEmissions[0]).toHaveLength(2); // Initial: Dune, Neuromancer
					expect(bookEmissions[1]).toHaveLength(3); // After: 2001, Dune, Neuromancer
					expect(bookEmissions[1].map((b) => b.title)).toEqual([
						"2001: A Space Odyssey",
						"Dune",
						"Neuromancer",
					]);

					// Authors: exactly 2 emissions (initial + one post-commit)
					expect(authorEmissions).toHaveLength(2);
					expect(authorEmissions[0]).toHaveLength(2); // Initial: Frank Herbert, William Gibson
					expect(authorEmissions[1]).toHaveLength(3); // After: Arthur C. Clarke added
					expect(authorEmissions[1].map((a) => a.name)).toContain(
						"Arthur C. Clarke",
					);
				}),
			);
		});
	});

	describe("transaction rollback no emissions (15.3)", () => {
		it("transaction rollback produces no emissions (state unchanged)", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Track all emissions received
					const emissions: Array<ReadonlyArray<Book>> = [];

					// Fork collection with a timeout
					const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
						Effect.sync(() => {
							emissions.push(emission);
						}),
					).pipe(
						Effect.timeoutFail({
							duration: "200 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emission to be processed
					yield* Effect.sleep("30 millis");

					// Start a transaction that will fail and be rolled back
					yield* db
						.$transaction((tx) =>
							Effect.gen(function* () {
								// Create a new book
								yield* tx.books.create({
									title: "Foundation",
									author: "Isaac Asimov",
									year: 1951,
									genre: "sci-fi",
								});

								// Wait to see if any emission happens (it shouldn't)
								yield* Effect.sleep("30 millis");

								// Update an existing book
								yield* tx.books.update("1", { year: 1966 });

								// Wait again
								yield* Effect.sleep("30 millis");

								// Force the transaction to fail and rollback
								return yield* Effect.fail(new Error("intentional failure"));
							}),
						)
						.pipe(Effect.catchAll(() => Effect.void)); // Catch the intentional failure

					// Wait for any potential emissions after rollback
					yield* Effect.sleep("50 millis");

					// Interrupt the fiber
					yield* Fiber.interrupt(collectedFiber);

					// Should have ONLY the initial emission - no emissions from rollback
					// Rollback restores state and publishes nothing
					expect(emissions).toHaveLength(1);

					// Initial emission: 2 sci-fi books (Dune 1965, Neuromancer 1984)
					expect(emissions[0]).toHaveLength(2);
					expect(emissions[0].map((b) => b.title)).toEqual([
						"Dune",
						"Neuromancer",
					]);
				}),
			);
		});

		it("failed transaction with delete and create produces no emissions", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch all books
					const stream = yield* db.books.watch({
						sort: { title: "asc" },
					});

					// Track all emissions received
					const emissions: Array<ReadonlyArray<Book>> = [];

					// Fork collection with a timeout
					const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
						Effect.sync(() => {
							emissions.push(emission);
						}),
					).pipe(
						Effect.timeoutFail({
							duration: "200 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");

					// Transaction that performs create and delete, then fails
					yield* db
						.$transaction((tx) =>
							Effect.gen(function* () {
								// Create a book
								yield* tx.books.create({
									title: "2001: A Space Odyssey",
									author: "Arthur C. Clarke",
									year: 1968,
									genre: "sci-fi",
								});

								yield* Effect.sleep("30 millis");

								// Delete The Hobbit
								yield* tx.books.delete("3");

								yield* Effect.sleep("30 millis");

								// Fail to trigger rollback
								return yield* Effect.fail(new Error("intentional failure"));
							}),
						)
						.pipe(Effect.catchAll(() => Effect.void));

					// Wait for any potential emissions after rollback
					yield* Effect.sleep("50 millis");

					// Interrupt the fiber
					yield* Fiber.interrupt(collectedFiber);

					// Should have ONLY the initial emission - no emissions from rollback
					expect(emissions).toHaveLength(1);

					// Initial emission: 3 books (unchanged from before rollback)
					expect(emissions[0]).toHaveLength(3);
					expect(emissions[0].map((b) => b.title)).toEqual([
						"Dune",
						"Neuromancer",
						"The Hobbit",
					]);
				}),
			);
		});

		it("rollback after partial mutations on multiple collections produces no emissions", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch both collections
					const booksStream = yield* db.books.watch({
						where: { genre: "sci-fi" },
					});
					const authorsStream = yield* db.authors.watch();

					// Track emissions for both
					const bookEmissions: Array<ReadonlyArray<Book>> = [];
					const authorEmissions: Array<ReadonlyArray<Author>> = [];

					// Fork watchers for both collections
					const booksFiber = yield* Stream.runForEach(
						booksStream,
						(emission) =>
							Effect.sync(() => {
								bookEmissions.push(emission);
							}),
					).pipe(
						Effect.timeoutFail({
							duration: "200 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					const authorsFiber = yield* Stream.runForEach(
						authorsStream,
						(emission) =>
							Effect.sync(() => {
								authorEmissions.push(emission);
							}),
					).pipe(
						Effect.timeoutFail({
							duration: "200 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emissions
					yield* Effect.sleep("30 millis");

					// Transaction that mutates both collections then fails
					yield* db
						.$transaction((tx) =>
							Effect.gen(function* () {
								// Mutate books
								yield* tx.books.create({
									title: "Foundation",
									author: "Isaac Asimov",
									year: 1951,
									genre: "sci-fi",
								});
								yield* Effect.sleep("20 millis");

								// Mutate authors
								yield* tx.authors.create({
									name: "Isaac Asimov",
									country: "USA",
								});
								yield* Effect.sleep("20 millis");

								// More mutations
								yield* tx.books.update("1", { title: "Dune (Special Edition)" });
								yield* tx.authors.delete("a1"); // Delete Frank Herbert

								yield* Effect.sleep("20 millis");

								// Force failure and rollback
								return yield* Effect.fail(new Error("intentional failure"));
							}),
						)
						.pipe(Effect.catchAll(() => Effect.void));

					// Wait for any potential emissions after rollback
					yield* Effect.sleep("50 millis");

					// Interrupt both fibers
					yield* Fiber.interrupt(booksFiber);
					yield* Fiber.interrupt(authorsFiber);

					// Both should have ONLY the initial emission - no emissions from rollback
					expect(bookEmissions).toHaveLength(1);
					expect(bookEmissions[0]).toHaveLength(2); // 2 sci-fi books

					expect(authorEmissions).toHaveLength(1);
					expect(authorEmissions[0]).toHaveLength(2); // 2 authors
				}),
			);
		});
	});
});
