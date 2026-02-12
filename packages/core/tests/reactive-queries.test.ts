/**
 * Tests for reactive queries at the database factory level.
 *
 * These tests verify that the watch() and watchById() methods on collections
 * work correctly when wired up through createEffectDatabase, including
 * proper integration with CRUD operations that trigger change events.
 */

import { describe, expect, it } from "vitest";
import {
	Chunk,
	Effect,
	ExecutionStrategy,
	Exit,
	Fiber,
	Schema,
	Scope,
	Stream,
} from "effect";
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

// ============================================================================
// Tests - File Changes (16.1 - 16.2)
// ============================================================================

import { Layer } from "effect";
import { jsonCodec } from "../src/serializers/codecs/json.js";
import { makeSerializerLayer } from "../src/serializers/format-codec.js";
import {
	StorageAdapter,
	type StorageAdapterShape,
} from "../src/storage/storage-service.js";
import { StorageError } from "../src/errors/storage-errors.js";
import { createPersistentEffectDatabase } from "../src/factories/database-effect.js";

/**
 * Create a test storage layer with controllable file watchers.
 * Returns the store Map, watchers Map, and the Layer.
 */
const makeTestStorageWithWatchers = () => {
	const store = new Map<string, string>();
	const watchers = new Map<string, () => void>();

	const adapter: StorageAdapterShape = {
		read: (path: string) =>
			Effect.suspend(() => {
				const content = store.get(path);
				if (content === undefined) {
					return Effect.fail(
						new StorageError({
							path,
							operation: "read",
							message: `File not found: ${path}`,
						}),
					);
				}
				return Effect.succeed(content);
			}),
		write: (path: string, data: string) =>
			Effect.sync(() => store.set(path, data)),
		exists: (path: string) => Effect.sync(() => store.has(path)),
		remove: (path: string) => Effect.sync(() => store.delete(path)),
		ensureDir: () => Effect.void,
		watch: (path: string, onChange: () => void) =>
			Effect.sync(() => {
				// Store the callback so we can trigger it manually
				watchers.set(path, onChange);
				return () => {
					watchers.delete(path);
				};
			}),
	};

	const StorageLayer = Layer.succeed(StorageAdapter, adapter);
	const SerializerLayer = makeSerializerLayer([jsonCodec()]);
	const PersistenceLayer = Layer.merge(StorageLayer, SerializerLayer);

	return { store, watchers, layer: PersistenceLayer };
};

describe("reactive queries - file changes", () => {
	// File watcher tests require a persistent database with file storage.
	// We use a custom storage adapter that simulates file changes by
	// allowing us to manually trigger file watcher callbacks.

	describe("file watcher reload triggers watch emission (16.1)", () => {
		it("file reload triggers watch emission when result set changes", async () => {
			// We need to test that external file changes trigger watch emissions.
			// We set up a persistent database with a custom storage adapter that
			// lets us simulate external file changes.

			const { store, watchers, layer } = makeTestStorageWithWatchers();

			// Seed initial data in the "file"
			const initialFileContent = JSON.stringify({
				"1": {
					id: "1",
					title: "Dune",
					author: "Frank Herbert",
					year: 1965,
					genre: "sci-fi",
				},
				"2": {
					id: "2",
					title: "Neuromancer",
					author: "William Gibson",
					year: 1984,
					genre: "sci-fi",
				},
			});
			store.set("./data/books.json", initialFileContent);

			const FileBookSchema = Schema.Struct({
				id: Schema.String,
				title: Schema.String,
				author: Schema.String,
				year: Schema.Number,
				genre: Schema.String,
			});

			type FileBook = Schema.Schema.Type<typeof FileBookSchema>;

			const fileConfig = {
				books: {
					schema: FileBookSchema,
					file: "./data/books.json",
					relationships: {},
				},
			} as const;

			const program = Effect.gen(function* () {
				// Create persistent database that loads from our store
				const db = yield* createPersistentEffectDatabase(fileConfig, {});

				// Watch sci-fi books sorted by year
				const stream = yield* db.books.watch({
					where: { genre: "sci-fi" },
					sort: { year: "asc" },
				});

				// Track all emissions received
				const emissions: Array<ReadonlyArray<FileBook>> = [];

				// Fork collection with a timeout
				const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
					Effect.sync(() => {
						emissions.push(emission as ReadonlyArray<FileBook>);
					}),
				).pipe(
					Effect.timeoutFail({
						duration: "300 millis",
						onTimeout: () => new Error("timeout"),
					}),
					Effect.catchAll(() => Effect.void),
					Effect.fork,
				);

				// Wait for initial emission to be processed
				yield* Effect.sleep("50 millis");

				// Simulate an external file change by:
				// 1. Writing new data to the store
				// 2. Triggering the file watcher callback
				const newFileContent = JSON.stringify({
					"1": {
						id: "1",
						title: "Dune",
						author: "Frank Herbert",
						year: 1965,
						genre: "sci-fi",
					},
					"2": {
						id: "2",
						title: "Neuromancer",
						author: "William Gibson",
						year: 1984,
						genre: "sci-fi",
					},
					"3": {
						id: "3",
						title: "Foundation",
						author: "Isaac Asimov",
						year: 1951,
						genre: "sci-fi",
					},
				});
				store.set("./data/books.json", newFileContent);

				// Trigger the file watcher callback to simulate file change detection
				const watcherCallback = watchers.get("./data/books.json");
				if (watcherCallback) {
					watcherCallback();
				}

				// Wait for reload and emission
				yield* Effect.sleep("150 millis");

				// Interrupt the fiber
				yield* Fiber.interrupt(collectedFiber);

				// Should have 2 emissions:
				// 1. Initial emission (2 sci-fi books: Dune 1965, Neuromancer 1984)
				// 2. After file reload (3 sci-fi books: Foundation 1951, Dune 1965, Neuromancer 1984)
				expect(emissions).toHaveLength(2);

				// Initial emission: 2 sci-fi books
				expect(emissions[0]).toHaveLength(2);
				expect(emissions[0].map((b) => b.title)).toEqual([
					"Dune",
					"Neuromancer",
				]);

				// After file reload: 3 sci-fi books including Foundation
				expect(emissions[1]).toHaveLength(3);
				expect(emissions[1].map((b) => b.title)).toEqual([
					"Foundation",
					"Dune",
					"Neuromancer",
				]);
			});

			await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));
		});

		it("file reload with modified entity triggers watch emission", async () => {
			const { store, watchers, layer } = makeTestStorageWithWatchers();

			const initialFileContent = JSON.stringify({
				"1": {
					id: "1",
					title: "Dune",
					author: "Frank Herbert",
					year: 1965,
					genre: "sci-fi",
				},
			});
			store.set("./data/books.json", initialFileContent);

			const FileBookSchema = Schema.Struct({
				id: Schema.String,
				title: Schema.String,
				author: Schema.String,
				year: Schema.Number,
				genre: Schema.String,
			});

			type FileBook = Schema.Schema.Type<typeof FileBookSchema>;

			const fileConfig = {
				books: {
					schema: FileBookSchema,
					file: "./data/books.json",
					relationships: {},
				},
			} as const;

			const program = Effect.gen(function* () {
				const db = yield* createPersistentEffectDatabase(fileConfig, {});

				const stream = yield* db.books.watch({
					sort: { title: "asc" },
				});

				const emissions: Array<ReadonlyArray<FileBook>> = [];

				const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
					Effect.sync(() => {
						emissions.push(emission as ReadonlyArray<FileBook>);
					}),
				).pipe(
					Effect.timeoutFail({
						duration: "300 millis",
						onTimeout: () => new Error("timeout"),
					}),
					Effect.catchAll(() => Effect.void),
					Effect.fork,
				);

				yield* Effect.sleep("50 millis");

				// Simulate external modification: update the book's title
				const modifiedFileContent = JSON.stringify({
					"1": {
						id: "1",
						title: "Dune Messiah",
						author: "Frank Herbert",
						year: 1969,
						genre: "sci-fi",
					},
				});
				store.set("./data/books.json", modifiedFileContent);

				// Trigger file watcher
				const watcherCallback = watchers.get("./data/books.json");
				if (watcherCallback) {
					watcherCallback();
				}

				yield* Effect.sleep("150 millis");

				yield* Fiber.interrupt(collectedFiber);

				// Should have 2 emissions: initial + after file modification
				expect(emissions).toHaveLength(2);

				// Initial: Dune 1965
				expect(emissions[0]).toHaveLength(1);
				expect(emissions[0][0].title).toBe("Dune");
				expect(emissions[0][0].year).toBe(1965);

				// After modification: Dune Messiah 1969
				expect(emissions[1]).toHaveLength(1);
				expect(emissions[1][0].title).toBe("Dune Messiah");
				expect(emissions[1][0].year).toBe(1969);
			});

			await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));
		});

		it("file reload with entity deletion triggers watch emission", async () => {
			const { store, watchers, layer } = makeTestStorageWithWatchers();

			const initialFileContent = JSON.stringify({
				"1": {
					id: "1",
					title: "Dune",
					author: "Frank Herbert",
					year: 1965,
					genre: "sci-fi",
				},
				"2": {
					id: "2",
					title: "Neuromancer",
					author: "William Gibson",
					year: 1984,
					genre: "sci-fi",
				},
			});
			store.set("./data/books.json", initialFileContent);

			const FileBookSchema = Schema.Struct({
				id: Schema.String,
				title: Schema.String,
				author: Schema.String,
				year: Schema.Number,
				genre: Schema.String,
			});

			type FileBook = Schema.Schema.Type<typeof FileBookSchema>;

			const fileConfig = {
				books: {
					schema: FileBookSchema,
					file: "./data/books.json",
					relationships: {},
				},
			} as const;

			const program = Effect.gen(function* () {
				const db = yield* createPersistentEffectDatabase(fileConfig, {});

				const stream = yield* db.books.watch({
					sort: { year: "asc" },
				});

				const emissions: Array<ReadonlyArray<FileBook>> = [];

				const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
					Effect.sync(() => {
						emissions.push(emission as ReadonlyArray<FileBook>);
					}),
				).pipe(
					Effect.timeoutFail({
						duration: "300 millis",
						onTimeout: () => new Error("timeout"),
					}),
					Effect.catchAll(() => Effect.void),
					Effect.fork,
				);

				yield* Effect.sleep("50 millis");

				// Simulate external deletion: remove one book from the file
				const modifiedFileContent = JSON.stringify({
					"2": {
						id: "2",
						title: "Neuromancer",
						author: "William Gibson",
						year: 1984,
						genre: "sci-fi",
					},
				});
				store.set("./data/books.json", modifiedFileContent);

				// Trigger file watcher
				const watcherCallback = watchers.get("./data/books.json");
				if (watcherCallback) {
					watcherCallback();
				}

				yield* Effect.sleep("150 millis");

				yield* Fiber.interrupt(collectedFiber);

				// Should have 2 emissions: initial + after file deletion
				expect(emissions).toHaveLength(2);

				// Initial: 2 books (Dune 1965, Neuromancer 1984)
				expect(emissions[0]).toHaveLength(2);
				expect(emissions[0].map((b) => b.title)).toEqual([
					"Dune",
					"Neuromancer",
				]);

				// After deletion: 1 book (Neuromancer only)
				expect(emissions[1]).toHaveLength(1);
				expect(emissions[1][0].title).toBe("Neuromancer");
			});

			await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));
		});
	});

	describe("file watcher reload does not emit when unchanged (16.2)", () => {
		it("file reload with unchanged content does not emit (deduplication)", async () => {
			const { store, watchers, layer } = makeTestStorageWithWatchers();

			// Seed initial data in the "file"
			const fileContent = JSON.stringify({
				"1": {
					id: "1",
					title: "Dune",
					author: "Frank Herbert",
					year: 1965,
					genre: "sci-fi",
				},
				"2": {
					id: "2",
					title: "Neuromancer",
					author: "William Gibson",
					year: 1984,
					genre: "sci-fi",
				},
			});
			store.set("./data/books.json", fileContent);

			const FileBookSchema = Schema.Struct({
				id: Schema.String,
				title: Schema.String,
				author: Schema.String,
				year: Schema.Number,
				genre: Schema.String,
			});

			type FileBook = Schema.Schema.Type<typeof FileBookSchema>;

			const fileConfig = {
				books: {
					schema: FileBookSchema,
					file: "./data/books.json",
					relationships: {},
				},
			} as const;

			const program = Effect.gen(function* () {
				const db = yield* createPersistentEffectDatabase(fileConfig, {});

				const stream = yield* db.books.watch({
					where: { genre: "sci-fi" },
					sort: { year: "asc" },
				});

				// Track all emissions received
				const emissions: Array<ReadonlyArray<FileBook>> = [];

				// Fork collection with a timeout
				const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
					Effect.sync(() => {
						emissions.push(emission as ReadonlyArray<FileBook>);
					}),
				).pipe(
					Effect.timeoutFail({
						duration: "300 millis",
						onTimeout: () => new Error("timeout"),
					}),
					Effect.catchAll(() => Effect.void),
					Effect.fork,
				);

				// Wait for initial emission to be processed
				yield* Effect.sleep("50 millis");

				// Simulate a file change event with UNCHANGED content
				// This might happen if a file is "touched" or saved without modifications.
				// The store already has the same content, so we just trigger the watcher.
				const watcherCallback = watchers.get("./data/books.json");
				if (watcherCallback) {
					watcherCallback();
				}

				// Wait for potential reload and emission
				yield* Effect.sleep("150 millis");

				// Interrupt the fiber
				yield* Fiber.interrupt(collectedFiber);

				// Should have ONLY 1 emission (initial)
				// No second emission because the result set is unchanged (deduplication)
				expect(emissions).toHaveLength(1);

				// Initial emission: 2 sci-fi books
				expect(emissions[0]).toHaveLength(2);
				expect(emissions[0].map((b) => b.title)).toEqual([
					"Dune",
					"Neuromancer",
				]);
			});

			await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));
		});

		it("file reload with reordered but equivalent content does not emit", async () => {
			const { store, watchers, layer } = makeTestStorageWithWatchers();

			// Initial file content (ordering in JSON doesn't matter for objects)
			const initialContent = JSON.stringify({
				"1": {
					id: "1",
					title: "Dune",
					author: "Frank Herbert",
					year: 1965,
					genre: "sci-fi",
				},
				"2": {
					id: "2",
					title: "Neuromancer",
					author: "William Gibson",
					year: 1984,
					genre: "sci-fi",
				},
			});
			store.set("./data/books.json", initialContent);

			const FileBookSchema = Schema.Struct({
				id: Schema.String,
				title: Schema.String,
				author: Schema.String,
				year: Schema.Number,
				genre: Schema.String,
			});

			type FileBook = Schema.Schema.Type<typeof FileBookSchema>;

			const fileConfig = {
				books: {
					schema: FileBookSchema,
					file: "./data/books.json",
					relationships: {},
				},
			} as const;

			const program = Effect.gen(function* () {
				const db = yield* createPersistentEffectDatabase(fileConfig, {});

				const stream = yield* db.books.watch({
					sort: { year: "asc" },
				});

				const emissions: Array<ReadonlyArray<FileBook>> = [];

				const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
					Effect.sync(() => {
						emissions.push(emission as ReadonlyArray<FileBook>);
					}),
				).pipe(
					Effect.timeoutFail({
						duration: "300 millis",
						onTimeout: () => new Error("timeout"),
					}),
					Effect.catchAll(() => Effect.void),
					Effect.fork,
				);

				yield* Effect.sleep("50 millis");

				// Write "new" file content with keys in different order but same data
				// JSON object key ordering doesn't affect the actual data
				const reorderedContent = JSON.stringify({
					"2": {
						id: "2",
						title: "Neuromancer",
						author: "William Gibson",
						year: 1984,
						genre: "sci-fi",
					},
					"1": {
						id: "1",
						title: "Dune",
						author: "Frank Herbert",
						year: 1965,
						genre: "sci-fi",
					},
				});
				store.set("./data/books.json", reorderedContent);

				// Trigger file watcher
				const watcherCallback = watchers.get("./data/books.json");
				if (watcherCallback) {
					watcherCallback();
				}

				yield* Effect.sleep("150 millis");

				yield* Fiber.interrupt(collectedFiber);

				// Should have ONLY 1 emission (initial)
				// The result set is unchanged (same books, same sorted order)
				expect(emissions).toHaveLength(1);

				// Initial emission: 2 books sorted by year (Dune 1965, Neuromancer 1984)
				expect(emissions[0]).toHaveLength(2);
				expect(emissions[0].map((b) => b.title)).toEqual([
					"Dune",
					"Neuromancer",
				]);
			});

			await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));
		});

		it("file reload with non-matching change does not emit for filtered watch", async () => {
			const { store, watchers, layer } = makeTestStorageWithWatchers();

			// Initial file content with both sci-fi and fantasy
			const initialContent = JSON.stringify({
				"1": {
					id: "1",
					title: "Dune",
					author: "Frank Herbert",
					year: 1965,
					genre: "sci-fi",
				},
				"2": {
					id: "2",
					title: "The Hobbit",
					author: "J.R.R. Tolkien",
					year: 1937,
					genre: "fantasy",
				},
			});
			store.set("./data/books.json", initialContent);

			const FileBookSchema = Schema.Struct({
				id: Schema.String,
				title: Schema.String,
				author: Schema.String,
				year: Schema.Number,
				genre: Schema.String,
			});

			type FileBook = Schema.Schema.Type<typeof FileBookSchema>;

			const fileConfig = {
				books: {
					schema: FileBookSchema,
					file: "./data/books.json",
					relationships: {},
				},
			} as const;

			const program = Effect.gen(function* () {
				const db = yield* createPersistentEffectDatabase(fileConfig, {});

				// Watch only sci-fi books
				const stream = yield* db.books.watch({
					where: { genre: "sci-fi" },
					sort: { year: "asc" },
				});

				const emissions: Array<ReadonlyArray<FileBook>> = [];

				const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
					Effect.sync(() => {
						emissions.push(emission as ReadonlyArray<FileBook>);
					}),
				).pipe(
					Effect.timeoutFail({
						duration: "300 millis",
						onTimeout: () => new Error("timeout"),
					}),
					Effect.catchAll(() => Effect.void),
					Effect.fork,
				);

				yield* Effect.sleep("50 millis");

				// External file change: modify the fantasy book (not in our filter)
				const modifiedContent = JSON.stringify({
					"1": {
						id: "1",
						title: "Dune",
						author: "Frank Herbert",
						year: 1965,
						genre: "sci-fi",
					},
					"2": {
						id: "2",
						title: "The Hobbit (Illustrated)",
						author: "J.R.R. Tolkien",
						year: 1937,
						genre: "fantasy",
					},
				});
				store.set("./data/books.json", modifiedContent);

				// Trigger file watcher
				const watcherCallback = watchers.get("./data/books.json");
				if (watcherCallback) {
					watcherCallback();
				}

				yield* Effect.sleep("150 millis");

				yield* Fiber.interrupt(collectedFiber);

				// Should have ONLY 1 emission (initial)
				// The change was to a fantasy book, which doesn't affect our sci-fi filter
				expect(emissions).toHaveLength(1);

				// Initial emission: 1 sci-fi book (Dune)
				expect(emissions[0]).toHaveLength(1);
				expect(emissions[0][0].title).toBe("Dune");
			});

			await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));
		});

		it("multiple file reloads with unchanged content emit only once", async () => {
			const { store, watchers, layer } = makeTestStorageWithWatchers();

			const fileContent = JSON.stringify({
				"1": {
					id: "1",
					title: "Dune",
					author: "Frank Herbert",
					year: 1965,
					genre: "sci-fi",
				},
			});
			store.set("./data/books.json", fileContent);

			const FileBookSchema = Schema.Struct({
				id: Schema.String,
				title: Schema.String,
				author: Schema.String,
				year: Schema.Number,
				genre: Schema.String,
			});

			type FileBook = Schema.Schema.Type<typeof FileBookSchema>;

			const fileConfig = {
				books: {
					schema: FileBookSchema,
					file: "./data/books.json",
					relationships: {},
				},
			} as const;

			const program = Effect.gen(function* () {
				const db = yield* createPersistentEffectDatabase(fileConfig, {});

				const stream = yield* db.books.watch({
					sort: { title: "asc" },
				});

				const emissions: Array<ReadonlyArray<FileBook>> = [];

				const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
					Effect.sync(() => {
						emissions.push(emission as ReadonlyArray<FileBook>);
					}),
				).pipe(
					Effect.timeoutFail({
						duration: "400 millis",
						onTimeout: () => new Error("timeout"),
					}),
					Effect.catchAll(() => Effect.void),
					Effect.fork,
				);

				yield* Effect.sleep("50 millis");

				// Trigger file watcher multiple times with unchanged content
				const watcherCallback = watchers.get("./data/books.json");
				if (watcherCallback) {
					watcherCallback();
					yield* Effect.sleep("50 millis");
					watcherCallback();
					yield* Effect.sleep("50 millis");
					watcherCallback();
				}

				yield* Effect.sleep("150 millis");

				yield* Fiber.interrupt(collectedFiber);

				// Should have ONLY 1 emission (initial)
				// Multiple reloads of unchanged content should be deduplicated
				expect(emissions).toHaveLength(1);

				expect(emissions[0]).toHaveLength(1);
				expect(emissions[0][0].title).toBe("Dune");
			});

			await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));
		});
	});
});

// ============================================================================
// Tests - Debounce (17.1 - 17.2)
// ============================================================================

describe("reactive queries - debounce", () => {
	describe("rapid mutations produce at most one emission (17.1)", () => {
		it("50 creates in a loop produce at most one emission after debounce settles", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch all books sorted by year
					const stream = yield* db.books.watch({
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
							duration: "500 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emission to be processed
					yield* Effect.sleep("30 millis");

					// Perform 50 rapid creates in a loop
					for (let i = 0; i < 50; i++) {
						yield* db.books.create({
							title: `Book ${i}`,
							author: `Author ${i}`,
							year: 2000 + i,
							genre: "sci-fi",
						});
					}

					// Wait for debounce to settle and any emissions to occur
					// Default debounce is 10ms, so 100ms should be plenty
					yield* Effect.sleep("200 millis");

					// Interrupt the fiber
					yield* Fiber.interrupt(collectedFiber);

					// Should have exactly 2 emissions:
					// 1. Initial emission (3 books from testBooks)
					// 2. ONE emission after debounce settles with all 53 books
					// NOT 50+ emissions (one per create)
					expect(emissions).toHaveLength(2);

					// Initial emission: 3 books from testBooks (The Hobbit 1937, Dune 1965, Neuromancer 1984)
					expect(emissions[0]).toHaveLength(3);
					expect(emissions[0].map((b) => b.title)).toEqual([
						"The Hobbit",
						"Dune",
						"Neuromancer",
					]);

					// After debounce: 53 books total (3 original + 50 created)
					expect(emissions[1]).toHaveLength(53);
					// Verify some of the new books are present
					expect(emissions[1].some((b) => b.title === "Book 0")).toBe(true);
					expect(emissions[1].some((b) => b.title === "Book 49")).toBe(true);
				}),
			);
		});

		it("rapid updates to the same entity produce at most one emission", async () => {
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
							duration: "500 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");

					// Rapidly update the same entity 50 times
					for (let i = 0; i < 50; i++) {
						yield* db.books.update("1", { year: 1965 + i });
					}

					// Wait for debounce to settle
					yield* Effect.sleep("200 millis");

					// Interrupt the fiber
					yield* Fiber.interrupt(collectedFiber);

					// Should have exactly 2 emissions: initial + one after debounce
					expect(emissions).toHaveLength(2);

					// Initial: Dune 1965, Neuromancer 1984
					expect(emissions[0]).toHaveLength(2);
					expect(emissions[0][0].year).toBe(1965); // Dune

					// After debounce: Dune's year should be final value (1965 + 49 = 2014)
					// Note: Since we're updating to 2014, the order might change
					// Neuromancer (1984) is now first, Dune (2014) is now second
					expect(emissions[1]).toHaveLength(2);
					const dune = emissions[1].find((b) => b.id === "1");
					expect(dune?.year).toBe(2014);
				}),
			);
		});

		it("mixed rapid operations (create, update, delete) produce at most one emission", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Track all emissions
					const emissions: Array<ReadonlyArray<Book>> = [];

					// Fork collection with a timeout
					const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
						Effect.sync(() => {
							emissions.push(emission);
						}),
					).pipe(
						Effect.timeoutFail({
							duration: "500 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");

					// Perform rapid mixed operations
					for (let i = 0; i < 20; i++) {
						// Create a new sci-fi book
						yield* db.books.create({
							title: `New Book ${i}`,
							author: `New Author ${i}`,
							year: 2000 + i,
							genre: "sci-fi",
						});

						// Update an existing book's year
						yield* db.books.update("1", { year: 1960 + i });
					}

					// Delete the original Neuromancer (id: "2")
					yield* db.books.delete("2");

					// Wait for debounce to settle
					yield* Effect.sleep("200 millis");

					// Interrupt the fiber
					yield* Fiber.interrupt(collectedFiber);

					// Should have exactly 2 emissions: initial + one after debounce
					expect(emissions).toHaveLength(2);

					// Initial: 2 sci-fi books
					expect(emissions[0]).toHaveLength(2);
					expect(emissions[0].map((b) => b.title)).toEqual([
						"Dune",
						"Neuromancer",
					]);

					// After debounce:
					// - Dune's year is now 1979 (1960 + 19 = final update)
					// - Neuromancer is deleted
					// - 20 new sci-fi books added
					// Total: 1 (Dune) + 20 (new) = 21 books
					expect(emissions[1]).toHaveLength(21);

					// Verify Neuromancer is gone
					expect(
						emissions[1].find((b) => b.id === "2"),
					).toBeUndefined();

					// Verify Dune has the final year
					const dune = emissions[1].find((b) => b.id === "1");
					expect(dune?.year).toBe(1979);

					// Verify new books are present
					expect(emissions[1].some((b) => b.title === "New Book 0")).toBe(true);
					expect(emissions[1].some((b) => b.title === "New Book 19")).toBe(true);
				}),
			);
		});

		it("createMany with many entities produces one emission after debounce", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch all books
					const stream = yield* db.books.watch({
						sort: { year: "asc" },
					});

					// Track all emissions
					const emissions: Array<ReadonlyArray<Book>> = [];

					// Fork collection with a timeout
					const collectedFiber = yield* Stream.runForEach(stream, (emission) =>
						Effect.sync(() => {
							emissions.push(emission);
						}),
					).pipe(
						Effect.timeoutFail({
							duration: "500 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");

					// Create 100 books in one batch
					const newBooks = Array.from({ length: 100 }, (_, i) => ({
						title: `Batch Book ${i}`,
						author: `Batch Author ${i}`,
						year: 2100 + i,
						genre: "sci-fi",
					}));
					yield* db.books.createMany(newBooks);

					// Wait for debounce to settle
					yield* Effect.sleep("200 millis");

					// Interrupt the fiber
					yield* Fiber.interrupt(collectedFiber);

					// Should have exactly 2 emissions: initial + one after createMany
					expect(emissions).toHaveLength(2);

					// Initial: 3 books
					expect(emissions[0]).toHaveLength(3);

					// After createMany: 103 books total
					expect(emissions[1]).toHaveLength(103);
				}),
			);
		});

		it("deleteMany with many entities produces one emission after debounce", async () => {
			// First create many books, then delete them
			const manyBooksConfig = {
				books: {
					schema: BookSchema,
					relationships: {},
				},
				authors: {
					schema: AuthorSchema,
					relationships: {},
				},
			} as const;

			// Create a lot of initial books
			const manyBooks: ReadonlyArray<Book> = Array.from(
				{ length: 100 },
				(_, i) => ({
					id: `book-${i}`,
					title: `Book ${i}`,
					author: `Author ${i}`,
					year: 2000 + i,
					genre: "sci-fi",
				}),
			);

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createEffectDatabase(manyBooksConfig, {
							books: manyBooks,
							authors: [],
						});

						// Watch all books
						const stream = yield* db.books.watch({
							sort: { year: "asc" },
						});

						// Track all emissions
						const emissions: Array<ReadonlyArray<Book>> = [];

						// Fork collection with a timeout
						const collectedFiber = yield* Stream.runForEach(
							stream,
							(emission) =>
								Effect.sync(() => {
									emissions.push(emission);
								}),
						).pipe(
							Effect.timeoutFail({
								duration: "500 millis",
								onTimeout: () => new Error("timeout"),
							}),
							Effect.catchAll(() => Effect.void),
							Effect.fork,
						);

						// Wait for initial emission
						yield* Effect.sleep("30 millis");

						// Delete 50 books using deleteMany with a predicate
						yield* db.books.deleteMany((book: Book) => book.year < 2050);

						// Wait for debounce to settle
						yield* Effect.sleep("200 millis");

						// Interrupt the fiber
						yield* Fiber.interrupt(collectedFiber);

						// Should have exactly 2 emissions: initial + one after deleteMany
						expect(emissions).toHaveLength(2);

						// Initial: 100 books
						expect(emissions[0]).toHaveLength(100);

						// After deleteMany: 50 books (years 2050-2099)
						expect(emissions[1]).toHaveLength(50);
						// All remaining books should have year >= 2050
						expect(emissions[1].every((b) => b.year >= 2050)).toBe(true);
					}),
				),
			);
		});
	});

	describe("configurable debounce interval (17.2)", () => {
		it("respects custom debounceMs configuration", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Use a longer debounce interval (100ms instead of default 10ms)
					const customDebounceMs = 100;

					const stream = yield* db.books.watch({
						sort: { year: "asc" },
						debounceMs: customDebounceMs,
					});

					const emissions: ReadonlyArray<Book>[] = [];

					// Start collecting emissions in a fiber
					const collectedFiber = yield* Effect.fork(
						Stream.runForEach(stream, (emission) =>
							Effect.sync(() => {
								emissions.push(emission);
							}),
						),
					);

					// Wait a bit for the initial emission to arrive
					yield* Effect.sleep("30 millis");

					// Initial emission should have happened
					expect(emissions).toHaveLength(1);

					// Create a new book to trigger a change event
					yield* db.books.create({
						id: "test-debounce",
						title: "Test Book",
						author: "Test Author",
						year: 2000,
						genre: "test",
					});

					// Wait 50ms - less than the custom debounce interval
					yield* Effect.sleep("50 millis");

					// Still should only have the initial emission (debounce hasn't settled)
					expect(emissions).toHaveLength(1);

					// Wait for the full debounce interval to pass (another 100ms to be safe)
					yield* Effect.sleep("150 millis");

					// Now the debounced emission should have arrived
					expect(emissions).toHaveLength(2);
					expect(emissions[1]).toHaveLength(4); // 3 original + 1 new

					yield* Fiber.interrupt(collectedFiber);
				}),
			);
		});

		it("uses default debounce when not configured", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch without custom debounceMs - should use default 10ms
					const stream = yield* db.books.watch({
						sort: { year: "asc" },
					});

					const emissions: ReadonlyArray<Book>[] = [];

					const collectedFiber = yield* Effect.fork(
						Stream.runForEach(stream, (emission) =>
							Effect.sync(() => {
								emissions.push(emission);
							}),
						),
					);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");
					expect(emissions).toHaveLength(1);

					// Create a book
					yield* db.books.create({
						id: "test-default-debounce",
						title: "Default Debounce Test",
						author: "Test Author",
						year: 2001,
						genre: "test",
					});

					// Wait 50ms - which is plenty of time for the default 10ms debounce
					yield* Effect.sleep("50 millis");

					// Should have received the emission with default debounce
					expect(emissions).toHaveLength(2);
					expect(emissions[1]).toHaveLength(4);

					yield* Fiber.interrupt(collectedFiber);
				}),
			);
		});

		it("different watches with different debounce intervals are respected independently", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Create two watchers with different debounce intervals
					const fastStream = yield* db.books.watch({
						sort: { year: "asc" },
						debounceMs: 20, // Fast debounce
					});

					const slowStream = yield* db.books.watch({
						sort: { year: "asc" },
						debounceMs: 150, // Slow debounce
					});

					const fastEmissions: ReadonlyArray<Book>[] = [];
					const slowEmissions: ReadonlyArray<Book>[] = [];

					// Start collecting emissions in fibers
					const fastFiber = yield* Effect.fork(
						Stream.runForEach(fastStream, (emission) =>
							Effect.sync(() => {
								fastEmissions.push(emission);
							}),
						),
					);

					const slowFiber = yield* Effect.fork(
						Stream.runForEach(slowStream, (emission) =>
							Effect.sync(() => {
								slowEmissions.push(emission);
							}),
						),
					);

					// Wait for initial emissions
					yield* Effect.sleep("30 millis");
					expect(fastEmissions).toHaveLength(1);
					expect(slowEmissions).toHaveLength(1);

					// Create a book
					yield* db.books.create({
						id: "test-independent-debounce",
						title: "Independent Debounce Test",
						author: "Test Author",
						year: 2002,
						genre: "test",
					});

					// Wait 80ms - fast watcher should have emitted, slow should not
					yield* Effect.sleep("80 millis");

					// Fast watcher should have its emission
					expect(fastEmissions).toHaveLength(2);
					// Slow watcher should still be waiting
					expect(slowEmissions).toHaveLength(1);

					// Wait for slow watcher's debounce to settle
					yield* Effect.sleep("150 millis");

					// Now slow watcher should also have emitted
					expect(slowEmissions).toHaveLength(2);

					yield* Fiber.interrupt(fastFiber);
					yield* Fiber.interrupt(slowFiber);
				}),
			);
		});
	});
});

// ============================================================================
// Tests - Unsubscribe and Cleanup (18.1 - 18.3)
// ============================================================================

describe("reactive queries - unsubscribe and cleanup", () => {
	describe("stream interruption stops emissions (18.1)", () => {
		it("stream interruption stops emissions and cleans up the PubSub subscription", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch all books
					const stream = yield* db.books.watch({
						sort: { year: "asc" },
					});

					// Track emissions received
					const emissions: Array<ReadonlyArray<Book>> = [];

					// Fork the stream consumer
					const consumerFiber = yield* Stream.runForEach(stream, (emission) =>
						Effect.sync(() => {
							emissions.push(emission);
						}),
					).pipe(Effect.fork);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");

					// Should have received the initial emission
					expect(emissions).toHaveLength(1);

					// Interrupt the stream - this should stop emissions and cleanup
					yield* Fiber.interrupt(consumerFiber);

					// Wait a bit to ensure the interruption is processed
					yield* Effect.sleep("30 millis");

					// Now create some books - these should NOT trigger emissions
					// because the subscription should be cleaned up
					yield* db.books.create({
						title: "Post-Interrupt Book 1",
						author: "Test Author",
						year: 2050,
						genre: "sci-fi",
					});

					yield* db.books.create({
						title: "Post-Interrupt Book 2",
						author: "Test Author",
						year: 2051,
						genre: "sci-fi",
					});

					// Wait for any potential emissions (there should be none)
					yield* Effect.sleep("100 millis");

					// Should still only have the initial emission
					// No new emissions after interruption
					expect(emissions).toHaveLength(1);
				}),
			);
		});

		it("interrupted fiber does not receive subsequent mutations", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch sci-fi books
					const stream = yield* db.books.watch({
						where: { genre: "sci-fi" },
						sort: { year: "asc" },
					});

					// Track emissions
					const emissions: Array<ReadonlyArray<Book>> = [];

					// Fork the stream consumer
					const consumerFiber = yield* Stream.runForEach(stream, (emission) =>
						Effect.sync(() => {
							emissions.push(emission);
						}),
					).pipe(Effect.fork);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");
					expect(emissions).toHaveLength(1);
					expect(emissions[0]).toHaveLength(2); // Dune, Neuromancer

					// Create a book before interruption - should trigger emission
					yield* db.books.create({
						title: "Pre-Interrupt Book",
						author: "Test Author",
						year: 1990,
						genre: "sci-fi",
					});

					// Wait for the emission
					yield* Effect.sleep("50 millis");
					expect(emissions).toHaveLength(2);
					expect(emissions[1]).toHaveLength(3); // Dune, Neuromancer, Pre-Interrupt Book

					// Now interrupt the fiber
					yield* Fiber.interrupt(consumerFiber);

					// Wait for cleanup
					yield* Effect.sleep("30 millis");

					// Create books after interruption
					yield* db.books.create({
						title: "Post-Interrupt Book A",
						author: "Test Author",
						year: 1991,
						genre: "sci-fi",
					});

					yield* db.books.create({
						title: "Post-Interrupt Book B",
						author: "Test Author",
						year: 1992,
						genre: "sci-fi",
					});

					// Wait for any potential emissions
					yield* Effect.sleep("100 millis");

					// Should still only have 2 emissions (none after interruption)
					expect(emissions).toHaveLength(2);
				}),
			);
		});

		it("multiple streams can be independently interrupted", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Create two separate watch streams
					const stream1 = yield* db.books.watch({
						where: { genre: "sci-fi" },
					});
					const stream2 = yield* db.books.watch({
						where: { genre: "fantasy" },
					});

					// Track emissions for each
					const emissions1: Array<ReadonlyArray<Book>> = [];
					const emissions2: Array<ReadonlyArray<Book>> = [];

					// Fork both stream consumers
					const fiber1 = yield* Stream.runForEach(stream1, (emission) =>
						Effect.sync(() => {
							emissions1.push(emission);
						}),
					).pipe(Effect.fork);

					const fiber2 = yield* Stream.runForEach(stream2, (emission) =>
						Effect.sync(() => {
							emissions2.push(emission);
						}),
					).pipe(Effect.fork);

					// Wait for initial emissions
					yield* Effect.sleep("30 millis");
					expect(emissions1).toHaveLength(1); // 2 sci-fi books
					expect(emissions2).toHaveLength(1); // 1 fantasy book (The Hobbit)

					// Interrupt only the first stream
					yield* Fiber.interrupt(fiber1);

					// Wait for cleanup
					yield* Effect.sleep("30 millis");

					// Create a sci-fi book - should NOT trigger emission for stream1
					yield* db.books.create({
						title: "New Sci-Fi",
						author: "Author",
						year: 2000,
						genre: "sci-fi",
					});

					// Create a fantasy book - SHOULD trigger emission for stream2
					yield* db.books.create({
						title: "New Fantasy",
						author: "Author",
						year: 2001,
						genre: "fantasy",
					});

					// Wait for emissions
					yield* Effect.sleep("100 millis");

					// Stream1 should still have only 1 emission (was interrupted)
					expect(emissions1).toHaveLength(1);

					// Stream2 should have 2 emissions (initial + after fantasy book)
					expect(emissions2).toHaveLength(2);
					expect(emissions2[1]).toHaveLength(2); // 2 fantasy books now

					// Cleanup stream2
					yield* Fiber.interrupt(fiber2);
				}),
			);
		});

		it("Stream.take naturally ends stream and cleans up subscription", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch all books
					const stream = yield* db.books.watch({
						sort: { year: "asc" },
					});

					// Use Stream.take to get only 2 emissions, then stream ends naturally
					const collectedFiber = yield* Stream.take(stream, 2).pipe(
						Stream.runCollect,
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");

					// Create a book to trigger second emission
					yield* db.books.create({
						title: "Second Emission Book",
						author: "Test Author",
						year: 2000,
						genre: "sci-fi",
					});

					// Wait for the fiber to complete (should complete after 2 emissions)
					const results = yield* Fiber.join(collectedFiber);
					const emissions = Chunk.toReadonlyArray(results) as ReadonlyArray<
						ReadonlyArray<Book>
					>;

					// Should have exactly 2 emissions
					expect(emissions).toHaveLength(2);
					expect(emissions[0]).toHaveLength(3); // Initial
					expect(emissions[1]).toHaveLength(4); // After create

					// Wait to ensure the stream properly cleaned up
					yield* Effect.sleep("50 millis");

					// Create more books - should not cause any issues since stream ended
					// (This tests that cleanup happened properly)
					yield* db.books.create({
						title: "Post-End Book 1",
						author: "Test Author",
						year: 2001,
						genre: "sci-fi",
					});

					yield* db.books.create({
						title: "Post-End Book 2",
						author: "Test Author",
						year: 2002,
						genre: "sci-fi",
					});

					// Wait to ensure no errors occur (the database should work normally
					// even after streams end - this verifies cleanup was successful)
					yield* Effect.sleep("50 millis");
				}),
			);
		});
	});

	describe("Scope closure cleans up all active subscriptions (18.2)", () => {
		it("closing a Scope cleans up all watch subscriptions within it", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					// Create database in outer scope (stays alive for the whole test)
					const db = yield* createEffectDatabase(config, initialData);

					// Track emissions from subscriptions started within an inner scope
					const emissions1: Array<ReadonlyArray<Book>> = [];
					const emissions2: Array<ReadonlyArray<Book>> = [];

					// Create an inner scope that we will manually close
					const innerScope = yield* Scope.make();

					// Create watch subscriptions within the inner scope
					const stream1 = yield* db.books
						.watch({ where: { genre: "sci-fi" } })
						.pipe(Effect.provideService(Scope.Scope, innerScope));

					const stream2 = yield* db.books
						.watch({ where: { genre: "fantasy" } })
						.pipe(Effect.provideService(Scope.Scope, innerScope));

					// Fork stream consumers
					const fiber1 = yield* Stream.runForEach(stream1, (emission) =>
						Effect.sync(() => {
							emissions1.push(emission);
						}),
					).pipe(Effect.fork);

					const fiber2 = yield* Stream.runForEach(stream2, (emission) =>
						Effect.sync(() => {
							emissions2.push(emission);
						}),
					).pipe(Effect.fork);

					// Wait for initial emissions
					yield* Effect.sleep("30 millis");
					expect(emissions1).toHaveLength(1); // Initial sci-fi (2 books)
					expect(emissions2).toHaveLength(1); // Initial fantasy (1 book)

					// Trigger some mutations to verify subscriptions are active
					yield* db.books.create({
						title: "New Sci-Fi",
						author: "Test",
						year: 2000,
						genre: "sci-fi",
					});

					yield* Effect.sleep("50 millis");
					expect(emissions1).toHaveLength(2); // sci-fi subscription got update

					yield* db.books.create({
						title: "New Fantasy",
						author: "Test",
						year: 2001,
						genre: "fantasy",
					});

					yield* Effect.sleep("50 millis");
					expect(emissions2).toHaveLength(2); // fantasy subscription got update

					// Now close the inner scope - this should clean up BOTH subscriptions
					yield* Scope.close(innerScope, Exit.void);

					// Wait for cleanup to process
					yield* Effect.sleep("50 millis");

					// Create more books - no emissions should be received since
					// all subscriptions in the inner scope were cleaned up
					const emissionsBeforeMutation1 = emissions1.length;
					const emissionsBeforeMutation2 = emissions2.length;

					yield* db.books.create({
						title: "Post-Scope-Close Sci-Fi",
						author: "Test",
						year: 2002,
						genre: "sci-fi",
					});

					yield* db.books.create({
						title: "Post-Scope-Close Fantasy",
						author: "Test",
						year: 2003,
						genre: "fantasy",
					});

					// Wait for any potential emissions
					yield* Effect.sleep("100 millis");

					// No new emissions should have been received after scope closure
					expect(emissions1).toHaveLength(emissionsBeforeMutation1);
					expect(emissions2).toHaveLength(emissionsBeforeMutation2);

					// The fibers should have been interrupted when scope closed
					// Await them to ensure they completed (either interrupted or finished)
					yield* Fiber.await(fiber1);
					yield* Fiber.await(fiber2);
				}).pipe(Effect.scoped),
			);
		});

		it("multiple scopes can independently manage their subscriptions", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					// Create database in outer scope
					const db = yield* createEffectDatabase(config, initialData);

					// Track emissions from two separate scopes
					const scopeAEmissions: Array<ReadonlyArray<Book>> = [];
					const scopeBEmissions: Array<ReadonlyArray<Book>> = [];

					// Create two independent scopes
					const scopeA = yield* Scope.make();
					const scopeB = yield* Scope.make();

					// Create subscriptions in scope A
					const streamA = yield* db.books
						.watch({ where: { genre: "sci-fi" } })
						.pipe(Effect.provideService(Scope.Scope, scopeA));

					// Create subscriptions in scope B
					const streamB = yield* db.books
						.watch({ where: { genre: "fantasy" } })
						.pipe(Effect.provideService(Scope.Scope, scopeB));

					// Fork consumers
					const fiberA = yield* Stream.runForEach(streamA, (emission) =>
						Effect.sync(() => {
							scopeAEmissions.push(emission);
						}),
					).pipe(Effect.fork);

					const fiberB = yield* Stream.runForEach(streamB, (emission) =>
						Effect.sync(() => {
							scopeBEmissions.push(emission);
						}),
					).pipe(Effect.fork);

					// Wait for initial emissions
					yield* Effect.sleep("30 millis");
					expect(scopeAEmissions).toHaveLength(1);
					expect(scopeBEmissions).toHaveLength(1);

					// Close only scope A - scope B should still work
					yield* Scope.close(scopeA, Exit.void);
					yield* Effect.sleep("30 millis");

					// Create books to test scope B is still active
					yield* db.books.create({
						title: "After Scope A Close",
						author: "Test",
						year: 2000,
						genre: "fantasy",
					});

					yield* Effect.sleep("50 millis");

					// Scope A subscription should not have received more emissions
					expect(scopeAEmissions).toHaveLength(1);

					// Scope B subscription should still be active and received the update
					expect(scopeBEmissions).toHaveLength(2);

					// Cleanup scope B
					yield* Scope.close(scopeB, Exit.void);
					yield* Fiber.await(fiberA);
					yield* Fiber.await(fiberB);
				}).pipe(Effect.scoped),
			);
		});

		it("nested scopes respect scope hierarchy for subscription cleanup", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					// Create database
					const db = yield* createEffectDatabase(config, initialData);

					// Track emissions
					const outerScopeEmissions: Array<ReadonlyArray<Book>> = [];
					const innerScopeEmissions: Array<ReadonlyArray<Book>> = [];

					// Create outer scope
					const outerScope = yield* Scope.make();

					// Create subscription in outer scope
					const outerStream = yield* db.books
						.watch({ sort: { year: "asc" } })
						.pipe(Effect.provideService(Scope.Scope, outerScope));

					const outerFiber = yield* Stream.runForEach(outerStream, (emission) =>
						Effect.sync(() => {
							outerScopeEmissions.push(emission);
						}),
					).pipe(Effect.fork);

					// Create inner scope forked from outer scope
					const innerScope = yield* outerScope.fork(
						ExecutionStrategy.sequential,
					);

					// Create subscription in inner scope
					const innerStream = yield* db.books
						.watch({ where: { genre: "sci-fi" } })
						.pipe(Effect.provideService(Scope.Scope, innerScope));

					const innerFiber = yield* Stream.runForEach(innerStream, (emission) =>
						Effect.sync(() => {
							innerScopeEmissions.push(emission);
						}),
					).pipe(Effect.fork);

					// Wait for initial emissions
					yield* Effect.sleep("30 millis");
					expect(outerScopeEmissions).toHaveLength(1);
					expect(innerScopeEmissions).toHaveLength(1);

					// Verify both subscriptions are working
					yield* db.books.create({
						title: "New Sci-Fi",
						author: "Test",
						year: 2000,
						genre: "sci-fi",
					});

					yield* Effect.sleep("50 millis");
					expect(outerScopeEmissions).toHaveLength(2);
					expect(innerScopeEmissions).toHaveLength(2);

					// Close inner scope - inner subscription should stop, outer should continue
					yield* Scope.close(innerScope, Exit.void);
					yield* Effect.sleep("30 millis");

					const innerEmissionsBeforeMutation = innerScopeEmissions.length;

					yield* db.books.create({
						title: "After Inner Scope Close",
						author: "Test",
						year: 2001,
						genre: "sci-fi",
					});

					yield* Effect.sleep("50 millis");

					// Outer scope subscription should still be active
					expect(outerScopeEmissions).toHaveLength(3);

					// Inner scope subscription should be cleaned up (no new emissions)
					expect(innerScopeEmissions).toHaveLength(innerEmissionsBeforeMutation);

					// Cleanup
					yield* Scope.close(outerScope, Exit.void);
					yield* Fiber.await(outerFiber);
					yield* Fiber.await(innerFiber);
				}).pipe(Effect.scoped),
			);
		});
	});

	describe("watchById emits entity state, re-emits on update, emits null on deletion (18.3)", () => {
		it("watchById emits the entity state immediately on subscription", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch a specific book by ID (Dune)
					const stream = yield* db.books.watchById("1");

					// Take just the initial emission
					const results = yield* Stream.runCollect(Stream.take(stream, 1));
					const emission = Chunk.toReadonlyArray(results)[0] as Book | null;

					// Should emit the entity immediately
					expect(emission).not.toBeNull();
					expect(emission?.id).toBe("1");
					expect(emission?.title).toBe("Dune");
					expect(emission?.author).toBe("Frank Herbert");
				}),
			);
		});

		it("watchById emits null for non-existent entity", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch a non-existent book
					const stream = yield* db.books.watchById("non-existent-id");

					// Take the initial emission
					const results = yield* Stream.runCollect(Stream.take(stream, 1));
					const emission = Chunk.toReadonlyArray(results)[0];

					// Should emit null for non-existent entity
					expect(emission).toBeNull();
				}),
			);
		});

		it("watchById re-emits the entity on update", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch Dune (id: "1")
					const stream = yield* db.books.watchById("1");

					// Track emissions
					const emissions: Array<Book | null> = [];

					// Fork stream consumer
					const consumerFiber = yield* Stream.runForEach(stream, (emission) =>
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
					expect(emissions).toHaveLength(1);
					expect(emissions[0]?.title).toBe("Dune");
					expect(emissions[0]?.year).toBe(1965);

					// Update the watched entity
					yield* db.books.update("1", { year: 1966, title: "Dune (Special Edition)" });

					// Wait for re-emission
					yield* Effect.sleep("50 millis");

					// Should have a second emission with the updated entity
					expect(emissions).toHaveLength(2);
					expect(emissions[1]?.title).toBe("Dune (Special Edition)");
					expect(emissions[1]?.year).toBe(1966);
					expect(emissions[1]?.id).toBe("1");

					yield* Fiber.interrupt(consumerFiber);
				}),
			);
		});

		it("watchById emits null when the entity is deleted", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch Dune (id: "1")
					const stream = yield* db.books.watchById("1");

					// Track emissions
					const emissions: Array<Book | null> = [];

					// Fork stream consumer
					const consumerFiber = yield* Stream.runForEach(stream, (emission) =>
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
					expect(emissions).toHaveLength(1);
					expect(emissions[0]).not.toBeNull();
					expect(emissions[0]?.id).toBe("1");
					expect(emissions[0]?.title).toBe("Dune");

					// Delete the watched entity
					yield* db.books.delete("1");

					// Wait for emission
					yield* Effect.sleep("50 millis");

					// Should have a second emission with null (entity deleted)
					expect(emissions).toHaveLength(2);
					expect(emissions[1]).toBeNull();

					yield* Fiber.interrupt(consumerFiber);
				}),
			);
		});

		it("watchById tracks entity through multiple updates and deletion", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch Neuromancer (id: "2")
					const stream = yield* db.books.watchById("2");

					// Track emissions
					const emissions: Array<Book | null> = [];

					// Fork stream consumer
					const consumerFiber = yield* Stream.runForEach(stream, (emission) =>
						Effect.sync(() => {
							emissions.push(emission);
						}),
					).pipe(
						Effect.timeoutFail({
							duration: "400 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emission
					yield* Effect.sleep("30 millis");
					expect(emissions).toHaveLength(1);
					expect(emissions[0]?.title).toBe("Neuromancer");
					expect(emissions[0]?.genre).toBe("sci-fi");

					// First update
					yield* db.books.update("2", { genre: "cyberpunk" });
					yield* Effect.sleep("50 millis");

					expect(emissions).toHaveLength(2);
					expect(emissions[1]?.genre).toBe("cyberpunk");

					// Second update
					yield* db.books.update("2", { year: 1985 });
					yield* Effect.sleep("50 millis");

					expect(emissions).toHaveLength(3);
					expect(emissions[2]?.year).toBe(1985);
					expect(emissions[2]?.genre).toBe("cyberpunk");

					// Delete
					yield* db.books.delete("2");
					yield* Effect.sleep("50 millis");

					// Final emission should be null
					expect(emissions).toHaveLength(4);
					expect(emissions[3]).toBeNull();

					yield* Fiber.interrupt(consumerFiber);
				}),
			);
		});

		it("watchById does not emit when a different entity is updated", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch Dune (id: "1")
					const stream = yield* db.books.watchById("1");

					// Track emissions
					const emissions: Array<Book | null> = [];

					// Fork stream consumer
					const consumerFiber = yield* Stream.runForEach(stream, (emission) =>
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
					expect(emissions).toHaveLength(1);
					expect(emissions[0]?.title).toBe("Dune");

					// Update a DIFFERENT entity (Neuromancer, id: "2")
					yield* db.books.update("2", { title: "Neuromancer (Revised)" });

					// Wait for any potential emission
					yield* Effect.sleep("100 millis");

					// Should still only have the initial emission
					// (deduplication: result set is unchanged for watchById("1"))
					expect(emissions).toHaveLength(1);

					yield* Fiber.interrupt(consumerFiber);
				}),
			);
		});

		it("watchById emits entity when it is created after subscription started", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch a book ID that doesn't exist yet
					const stream = yield* db.books.watchById("new-book-id");

					// Track emissions
					const emissions: Array<Book | null> = [];

					// Fork stream consumer
					const consumerFiber = yield* Stream.runForEach(stream, (emission) =>
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
					expect(emissions).toHaveLength(1);
					expect(emissions[0]).toBeNull(); // Entity doesn't exist yet

					// Create the entity with the watched ID
					yield* db.books.create({
						id: "new-book-id",
						title: "Brand New Book",
						author: "New Author",
						year: 2024,
						genre: "sci-fi",
					});

					// Wait for emission
					yield* Effect.sleep("50 millis");

					// Should have a second emission with the newly created entity
					expect(emissions).toHaveLength(2);
					expect(emissions[1]).not.toBeNull();
					expect(emissions[1]?.id).toBe("new-book-id");
					expect(emissions[1]?.title).toBe("Brand New Book");

					yield* Fiber.interrupt(consumerFiber);
				}),
			);
		});

		it("watchById handles create, update, and delete sequence", async () => {
			await runWithDb((db) =>
				Effect.gen(function* () {
					// Watch a book ID that doesn't exist yet
					const stream = yield* db.books.watchById("lifecycle-book");

					// Track emissions
					const emissions: Array<Book | null> = [];

					// Fork stream consumer
					const consumerFiber = yield* Stream.runForEach(stream, (emission) =>
						Effect.sync(() => {
							emissions.push(emission);
						}),
					).pipe(
						Effect.timeoutFail({
							duration: "500 millis",
							onTimeout: () => new Error("timeout"),
						}),
						Effect.catchAll(() => Effect.void),
						Effect.fork,
					);

					// Wait for initial emission (null - doesn't exist)
					yield* Effect.sleep("30 millis");
					expect(emissions).toHaveLength(1);
					expect(emissions[0]).toBeNull();

					// Create
					yield* db.books.create({
						id: "lifecycle-book",
						title: "Lifecycle Book",
						author: "Lifecycle Author",
						year: 2020,
						genre: "test",
					});
					yield* Effect.sleep("50 millis");
					expect(emissions).toHaveLength(2);
					expect(emissions[1]?.title).toBe("Lifecycle Book");

					// Update
					yield* db.books.update("lifecycle-book", { year: 2021 });
					yield* Effect.sleep("50 millis");
					expect(emissions).toHaveLength(3);
					expect(emissions[2]?.year).toBe(2021);

					// Delete
					yield* db.books.delete("lifecycle-book");
					yield* Effect.sleep("50 millis");
					expect(emissions).toHaveLength(4);
					expect(emissions[3]).toBeNull();

					// Re-create with same ID
					yield* db.books.create({
						id: "lifecycle-book",
						title: "Lifecycle Book Reborn",
						author: "Lifecycle Author",
						year: 2025,
						genre: "test",
					});
					yield* Effect.sleep("50 millis");
					expect(emissions).toHaveLength(5);
					expect(emissions[4]?.title).toBe("Lifecycle Book Reborn");
					expect(emissions[4]?.year).toBe(2025);

					yield* Fiber.interrupt(consumerFiber);
				}),
			);
		});
	});
});
