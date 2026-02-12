/**
 * Tests for watch() result deduplication.
 *
 * Verifies that consecutive identical result sets are deduplicated to avoid
 * spurious emissions when a change event occurs but doesn't affect the query results.
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, PubSub, Ref, Stream } from "effect";
import { watch } from "../src/reactive/watch.js";
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

describe("watch() deduplication", () => {
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

	it("deduplicates when change event does not affect query results", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			// Watch only sci-fi books
			const stream = yield* watch(pubsub, ref, "books", {
				where: { genre: "sci-fi" },
			});

			// Start collecting with a timeout to catch if extra emissions happen
			const collectedFiber = yield* Stream.take(stream, 2).pipe(
				Stream.runCollect,
				Effect.timeoutFail({
					duration: "200 millis",
					onTimeout: () => new Error("timeout - only got 1 emission as expected"),
				}),
				Effect.either,
				Effect.fork,
			);

			// Wait a tick for initial emission
			yield* Effect.sleep("10 millis");

			// Add a fantasy book (doesn't match the sci-fi filter)
			// This should NOT cause a second emission since result set is unchanged
			yield* Ref.update(ref, (map) => {
				const newMap = new Map(map);
				newMap.set("4", {
					id: "4",
					title: "The Name of the Wind",
					author: "Patrick Rothfuss",
					year: 2007,
					genre: "fantasy",
				});
				return newMap;
			});

			// Publish change event
			yield* publishEvent(pubsub, "books", "create");

			// Wait a bit for any spurious emission
			yield* Effect.sleep("50 millis");

			const result = yield* Fiber.join(collectedFiber);

			// Should timeout because no second emission occurred (deduplication worked)
			expect(result._tag).toBe("Left");
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("emits when change event affects query results", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			// Watch only sci-fi books
			const stream = yield* watch(pubsub, ref, "books", {
				where: { genre: "sci-fi" },
			});

			// Collect 2 emissions
			const collectedFiber = yield* Stream.take(stream, 2).pipe(
				Stream.runCollect,
				Effect.fork,
			);

			// Wait a tick for initial emission
			yield* Effect.sleep("10 millis");

			// Add a sci-fi book (matches the filter)
			// This SHOULD cause a second emission since result set changed
			yield* Ref.update(ref, (map) => {
				const newMap = new Map(map);
				newMap.set("4", {
					id: "4",
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

			// First emission: 2 sci-fi books
			expect(emissions[0]).toHaveLength(2);

			// Second emission: 3 sci-fi books (after adding Snow Crash)
			expect(emissions[1]).toHaveLength(3);
			expect(emissions[1].some((b) => b.title === "Snow Crash")).toBe(true);
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("deduplicates multiple consecutive identical results", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			// Watch only sci-fi books
			const stream = yield* watch(pubsub, ref, "books", {
				where: { genre: "sci-fi" },
			});

			// Start collecting with a timeout
			const collectedFiber = yield* Stream.take(stream, 2).pipe(
				Stream.runCollect,
				Effect.timeoutFail({
					duration: "200 millis",
					onTimeout: () => new Error("timeout - deduplication worked"),
				}),
				Effect.either,
				Effect.fork,
			);

			// Wait a tick for initial emission
			yield* Effect.sleep("10 millis");

			// Publish multiple change events that don't affect results
			for (let i = 0; i < 5; i++) {
				// Add non-matching books
				yield* Ref.update(ref, (map) => {
					const newMap = new Map(map);
					newMap.set(`fantasy-${i}`, {
						id: `fantasy-${i}`,
						title: `Fantasy Book ${i}`,
						author: "Some Author",
						year: 2000 + i,
						genre: "fantasy",
					});
					return newMap;
				});
				yield* publishEvent(pubsub, "books", "create");
			}

			// Wait for any spurious emissions
			yield* Effect.sleep("50 millis");

			const result = yield* Fiber.join(collectedFiber);

			// Should timeout because no second emission occurred despite 5 events
			expect(result._tag).toBe("Left");
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("handles empty result sets correctly", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			// Watch horror books (none exist)
			const stream = yield* watch(pubsub, ref, "books", {
				where: { genre: "horror" },
			});

			// Start collecting with a timeout
			const collectedFiber = yield* Stream.take(stream, 2).pipe(
				Stream.runCollect,
				Effect.timeoutFail({
					duration: "200 millis",
					onTimeout: () => new Error("timeout - deduplication worked"),
				}),
				Effect.either,
				Effect.fork,
			);

			// Wait a tick for initial emission
			yield* Effect.sleep("10 millis");

			// Add a sci-fi book (doesn't match horror filter)
			yield* Ref.update(ref, (map) => {
				const newMap = new Map(map);
				newMap.set("4", {
					id: "4",
					title: "Snow Crash",
					author: "Neal Stephenson",
					year: 1992,
					genre: "sci-fi",
				});
				return newMap;
			});
			yield* publishEvent(pubsub, "books", "create");

			// Wait for any spurious emissions
			yield* Effect.sleep("50 millis");

			const result = yield* Fiber.join(collectedFiber);

			// Should timeout because both results are empty arrays
			expect(result._tag).toBe("Left");
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("does not deduplicate when entities are updated to different values", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef(testBooks);

			// Watch sci-fi books
			const stream = yield* watch(pubsub, ref, "books", {
				where: { genre: "sci-fi" },
			});

			// Collect 2 emissions
			const collectedFiber = yield* Stream.take(stream, 2).pipe(
				Stream.runCollect,
				Effect.fork,
			);

			// Wait a tick for initial emission
			yield* Effect.sleep("10 millis");

			// Update an existing sci-fi book's title
			yield* Ref.update(ref, (map) => {
				const newMap = new Map(map);
				const existing = newMap.get("1");
				if (existing) {
					newMap.set("1", { ...existing, title: "Dune (Revised Edition)" });
				}
				return newMap;
			});
			yield* publishEvent(pubsub, "books", "update");

			const results = yield* Fiber.join(collectedFiber);
			const emissions = Array.from(results) as ReadonlyArray<ReadonlyArray<Book>>;

			// Both emissions have 2 books but content differs
			expect(emissions[0]).toHaveLength(2);
			expect(emissions[1]).toHaveLength(2);

			// First emission has original title
			expect(emissions[0].find((b) => b.id === "1")?.title).toBe("Dune");

			// Second emission has updated title
			expect(emissions[1].find((b) => b.id === "1")?.title).toBe(
				"Dune (Revised Edition)",
			);
		});

		await Effect.runPromise(Effect.scoped(program));
	});
});
