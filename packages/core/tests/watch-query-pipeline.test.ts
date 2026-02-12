/**
 * Tests for the reactive watch() query pipeline application.
 *
 * Verifies that the full query pipeline (filter, sort, select, paginate) is
 * applied correctly on both initial emission and re-evaluation after changes.
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, PubSub, Ref, Stream } from "effect";
import { watch, type WatchQueryConfig } from "../src/reactive/watch.js";
import { createChangePubSub } from "../src/reactive/change-pubsub.js";
import type { ChangeEvent } from "../src/types/reactive-types.js";

interface Book {
	readonly id: string;
	readonly title: string;
	readonly author: string;
	readonly year: number;
	readonly genre: string;
}

/**
 * Helper to create a Ref from an array of entities
 */
const createRef = (books: ReadonlyArray<Book>) =>
	Effect.gen(function* () {
		const map = new Map<string, Book>();
		for (const book of books) {
			map.set(book.id, book);
		}
		return yield* Ref.make(map as ReadonlyMap<string, Book>);
	});

/**
 * Helper to publish a change event
 */
const publishEvent = (
	pubsub: PubSub.PubSub<ChangeEvent>,
	collection: string,
	operation: ChangeEvent["operation"],
) => PubSub.publish(pubsub, { collection, operation });

describe("watch() query pipeline on re-evaluation", () => {
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
		{
			id: "4",
			title: "Foundation",
			author: "Isaac Asimov",
			year: 1951,
			genre: "sci-fi",
		},
		{
			id: "5",
			title: "1984",
			author: "George Orwell",
			year: 1949,
			genre: "dystopian",
		},
	];

	it("applies filter on initial emission", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			const stream = yield* watch(pubsub, ref, "books", {
				where: { genre: "sci-fi" },
			});

			// Take just the initial emission
			const results = yield* Stream.runCollect(Stream.take(stream, 1));
			const firstEmission = results.pipe(
				(chunk) => Array.from(chunk)[0],
			) as ReadonlyArray<Book>;

			// Should only include sci-fi books
			expect(firstEmission).toHaveLength(3);
			expect(firstEmission.every((b) => b.genre === "sci-fi")).toBe(true);
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("applies sort on initial emission", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			const stream = yield* watch(pubsub, ref, "books", {
				where: { genre: "sci-fi" },
				sort: { year: "asc" },
			});

			const results = yield* Stream.runCollect(Stream.take(stream, 1));
			const firstEmission = results.pipe(
				(chunk) => Array.from(chunk)[0],
			) as ReadonlyArray<Book>;

			// Should be sorted by year ascending
			expect(firstEmission[0].year).toBe(1951); // Foundation
			expect(firstEmission[1].year).toBe(1965); // Dune
			expect(firstEmission[2].year).toBe(1984); // Neuromancer
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("applies pagination on initial emission", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			const stream = yield* watch(pubsub, ref, "books", {
				sort: { year: "asc" },
				limit: 2,
				offset: 1,
			});

			const results = yield* Stream.runCollect(Stream.take(stream, 1));
			const firstEmission = results.pipe(
				(chunk) => Array.from(chunk)[0],
			) as ReadonlyArray<Book>;

			// Should skip first (1937), take next 2 (1949, 1951)
			expect(firstEmission).toHaveLength(2);
			expect(firstEmission[0].year).toBe(1949);
			expect(firstEmission[1].year).toBe(1951);
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("applies select on initial emission", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			const stream = yield* watch(pubsub, ref, "books", {
				where: { id: "1" },
				select: ["title", "author"],
			});

			const results = yield* Stream.runCollect(Stream.take(stream, 1));
			const firstEmission = results.pipe(
				(chunk) => Array.from(chunk)[0],
			) as ReadonlyArray<Record<string, unknown>>;

			// Should only have title and author fields
			expect(firstEmission).toHaveLength(1);
			expect(firstEmission[0]).toEqual({ title: "Dune", author: "Frank Herbert" });
			expect(firstEmission[0]).not.toHaveProperty("year");
			expect(firstEmission[0]).not.toHaveProperty("genre");
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("applies full pipeline (filter + sort + paginate + select) on initial emission", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			const stream = yield* watch(pubsub, ref, "books", {
				where: { genre: "sci-fi" },
				sort: { year: "desc" },
				limit: 2,
				select: ["title", "year"],
			});

			const results = yield* Stream.runCollect(Stream.take(stream, 1));
			const firstEmission = results.pipe(
				(chunk) => Array.from(chunk)[0],
			) as ReadonlyArray<Record<string, unknown>>;

			// Filter: sci-fi (1965, 1984, 1951)
			// Sort: desc (1984, 1965, 1951)
			// Limit: 2 (1984, 1965)
			// Select: title, year only
			expect(firstEmission).toHaveLength(2);
			expect(firstEmission[0]).toEqual({ title: "Neuromancer", year: 1984 });
			expect(firstEmission[1]).toEqual({ title: "Dune", year: 1965 });
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("applies filter on re-evaluation after change event", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			const stream = yield* watch(pubsub, ref, "books", {
				where: { genre: "sci-fi" },
			});

			// Collect in the background to get emissions
			const collectedFiber = yield* Stream.take(stream, 2).pipe(
				Stream.runCollect,
				Effect.fork,
			);

			// Wait a tick, then add a new sci-fi book
			yield* Effect.sleep("10 millis");
			yield* Ref.update(ref, (map) => {
				const newMap = new Map(map);
				newMap.set("6", {
					id: "6",
					title: "Snow Crash",
					author: "Neal Stephenson",
					year: 1992,
					genre: "sci-fi",
				});
				return newMap;
			});

			// Publish change event
			yield* publishEvent(pubsub, "books", "create");

			const results = yield* Fiber.join(collectedFiber);
			const emissions = Array.from(results) as ReadonlyArray<ReadonlyArray<Book>>;

			// First emission: 3 sci-fi books
			expect(emissions[0]).toHaveLength(3);

			// Second emission: 4 sci-fi books (after adding Snow Crash)
			expect(emissions[1]).toHaveLength(4);
			expect(emissions[1].every((b) => b.genre === "sci-fi")).toBe(true);
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("applies sort on re-evaluation after change event", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			const stream = yield* watch(pubsub, ref, "books", {
				where: { genre: "sci-fi" },
				sort: { year: "asc" },
			});

			// Collect in the background
			const collectedFiber = yield* Stream.take(stream, 2).pipe(
				Stream.runCollect,
				Effect.fork,
			);

			// Wait a tick, then add a book with year between existing ones
			yield* Effect.sleep("10 millis");
			yield* Ref.update(ref, (map) => {
				const newMap = new Map(map);
				newMap.set("6", {
					id: "6",
					title: "Ender's Game",
					author: "Orson Scott Card",
					year: 1985,
					genre: "sci-fi",
				});
				return newMap;
			});

			yield* publishEvent(pubsub, "books", "create");

			const results = yield* Fiber.join(collectedFiber);
			const emissions = Array.from(results) as ReadonlyArray<ReadonlyArray<Book>>;

			// Second emission should have the new book sorted correctly
			const secondEmission = emissions[1];
			expect(secondEmission).toHaveLength(4);
			// Order: 1951, 1965, 1984, 1985
			expect(secondEmission[0].year).toBe(1951);
			expect(secondEmission[1].year).toBe(1965);
			expect(secondEmission[2].year).toBe(1984);
			expect(secondEmission[3].year).toBe(1985);
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("applies pagination on re-evaluation after change event", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			const stream = yield* watch(pubsub, ref, "books", {
				sort: { year: "asc" },
				limit: 2,
			});

			const collectedFiber = yield* Stream.take(stream, 2).pipe(
				Stream.runCollect,
				Effect.fork,
			);

			// Wait a tick, then add a book that should appear in the first 2
			yield* Effect.sleep("10 millis");
			yield* Ref.update(ref, (map) => {
				const newMap = new Map(map);
				newMap.set("6", {
					id: "6",
					title: "Frankenstein",
					author: "Mary Shelley",
					year: 1818,
					genre: "gothic",
				});
				return newMap;
			});

			yield* publishEvent(pubsub, "books", "create");

			const results = yield* Fiber.join(collectedFiber);
			const emissions = Array.from(results) as ReadonlyArray<ReadonlyArray<Book>>;

			// First emission: 1937, 1949
			expect(emissions[0]).toHaveLength(2);
			expect(emissions[0][0].year).toBe(1937);
			expect(emissions[0][1].year).toBe(1949);

			// Second emission: 1818, 1937 (new book pushes into top 2)
			expect(emissions[1]).toHaveLength(2);
			expect(emissions[1][0].year).toBe(1818);
			expect(emissions[1][1].year).toBe(1937);
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("applies select on re-evaluation after change event", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			const stream = yield* watch(pubsub, ref, "books", {
				where: { genre: "sci-fi" },
				select: ["title"],
			});

			const collectedFiber = yield* Stream.take(stream, 2).pipe(
				Stream.runCollect,
				Effect.fork,
			);

			yield* Effect.sleep("10 millis");
			yield* Ref.update(ref, (map) => {
				const newMap = new Map(map);
				newMap.set("6", {
					id: "6",
					title: "Snow Crash",
					author: "Neal Stephenson",
					year: 1992,
					genre: "sci-fi",
				});
				return newMap;
			});

			yield* publishEvent(pubsub, "books", "create");

			const results = yield* Fiber.join(collectedFiber);
			const emissions = Array.from(results) as ReadonlyArray<
				ReadonlyArray<Record<string, unknown>>
			>;

			// Both emissions should only have title field
			for (const emission of emissions) {
				for (const item of emission) {
					expect(Object.keys(item)).toEqual(["title"]);
				}
			}

			// Second emission should include the new book's title
			const titles = emissions[1].map((b) => b.title);
			expect(titles).toContain("Snow Crash");
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("applies full pipeline on re-evaluation after change event", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			const stream = yield* watch(pubsub, ref, "books", {
				where: { genre: "sci-fi" },
				sort: { year: "desc" },
				limit: 2,
				select: ["title", "year"],
			});

			const collectedFiber = yield* Stream.take(stream, 2).pipe(
				Stream.runCollect,
				Effect.fork,
			);

			// Add a very recent sci-fi book
			yield* Effect.sleep("10 millis");
			yield* Ref.update(ref, (map) => {
				const newMap = new Map(map);
				newMap.set("6", {
					id: "6",
					title: "Snow Crash",
					author: "Neal Stephenson",
					year: 1992,
					genre: "sci-fi",
				});
				return newMap;
			});

			yield* publishEvent(pubsub, "books", "create");

			const results = yield* Fiber.join(collectedFiber);
			const emissions = Array.from(results) as ReadonlyArray<
				ReadonlyArray<Record<string, unknown>>
			>;

			// First emission:
			// Filter sci-fi: Dune(1965), Neuromancer(1984), Foundation(1951)
			// Sort desc: Neuromancer(1984), Dune(1965), Foundation(1951)
			// Limit 2: Neuromancer(1984), Dune(1965)
			// Select: title, year
			expect(emissions[0]).toHaveLength(2);
			expect(emissions[0][0]).toEqual({ title: "Neuromancer", year: 1984 });
			expect(emissions[0][1]).toEqual({ title: "Dune", year: 1965 });

			// Second emission (with Snow Crash added):
			// Filter sci-fi: now 4 books
			// Sort desc: Snow Crash(1992), Neuromancer(1984), Dune(1965), Foundation(1951)
			// Limit 2: Snow Crash(1992), Neuromancer(1984)
			// Select: title, year
			expect(emissions[1]).toHaveLength(2);
			expect(emissions[1][0]).toEqual({ title: "Snow Crash", year: 1992 });
			expect(emissions[1][1]).toEqual({ title: "Neuromancer", year: 1984 });
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("ignores events for other collections", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			const stream = yield* watch(pubsub, ref, "books", {
				where: { genre: "sci-fi" },
			});

			// Collect emissions with a timeout
			const collectedFiber = yield* Stream.take(stream, 2).pipe(
				Stream.runCollect,
				Effect.timeoutFail({
					duration: "100 millis",
					onTimeout: () => new Error("timeout"),
				}),
				Effect.either,
				Effect.fork,
			);

			// Wait a tick, then publish event for different collection
			yield* Effect.sleep("10 millis");
			yield* publishEvent(pubsub, "authors", "create");

			const result = yield* Fiber.join(collectedFiber);

			// Should timeout because no second emission was triggered
			expect(result._tag).toBe("Left");
		});

		await Effect.runPromise(Effect.scoped(program));
	});
});
