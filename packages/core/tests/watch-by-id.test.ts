/**
 * Tests for watchById() reactive single-entity queries.
 *
 * Verifies that watchById:
 * - Emits the entity immediately if it exists
 * - Emits null immediately if entity doesn't exist
 * - Re-emits when the entity is updated
 * - Emits null when the entity is deleted (task 9.2)
 */

import { Effect, Fiber, PubSub, Ref, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { createChangePubSub } from "../src/reactive/change-pubsub.js";
import { watchById } from "../src/reactive/watch-by-id.js";
import type { ChangeEvent } from "../src/types/reactive-types.js";

interface Book {
	readonly id: string;
	readonly title: string;
	readonly author: string;
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

describe("watchById()", () => {
	const testBook: Book = {
		id: "1",
		title: "Dune",
		author: "Frank Herbert",
	};

	it("emits entity immediately when it exists", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef([testBook]);

			const stream = yield* watchById(pubsub, ref, "books", "1");

			// Take just the initial emission
			const results = yield* Stream.runCollect(Stream.take(stream, 1));
			const firstEmission = Array.from(results)[0] as Book | null;

			expect(firstEmission).not.toBeNull();
			expect(firstEmission?.id).toBe("1");
			expect(firstEmission?.title).toBe("Dune");
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("emits null immediately when entity does not exist", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef([testBook]);

			// Watch a non-existent ID
			const stream = yield* watchById(pubsub, ref, "books", "nonexistent");

			const results = yield* Stream.runCollect(Stream.take(stream, 1));
			const firstEmission = Array.from(results)[0] as Book | null;

			expect(firstEmission).toBeNull();
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("re-emits when entity is updated", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef([testBook]);

			const stream = yield* watchById(pubsub, ref, "books", "1");

			const collectedFiber = yield* Stream.take(stream, 2).pipe(
				Stream.runCollect,
				Effect.fork,
			);

			// Wait, then update the entity
			yield* Effect.sleep("15 millis");
			yield* Ref.update(ref, (map) => {
				const newMap = new Map(map);
				newMap.set("1", { ...testBook, title: "Dune Messiah" });
				return newMap;
			});

			// Publish change event
			yield* publishEvent(pubsub, "books", "update");

			const results = yield* Fiber.join(collectedFiber);
			const emissions = Array.from(results) as Array<Book | null>;

			// First emission: original entity
			expect(emissions[0]?.title).toBe("Dune");

			// Second emission: updated entity
			expect(emissions[1]?.title).toBe("Dune Messiah");
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	/**
	 * Task 9.2: Emit null when the entity is deleted (result array becomes empty)
	 */
	it("emits null when entity is deleted", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef([testBook]);

			const stream = yield* watchById(pubsub, ref, "books", "1");

			const collectedFiber = yield* Stream.take(stream, 2).pipe(
				Stream.runCollect,
				Effect.fork,
			);

			// Wait, then delete the entity
			yield* Effect.sleep("15 millis");
			yield* Ref.update(ref, (map) => {
				const newMap = new Map(map);
				newMap.delete("1");
				return newMap;
			});

			// Publish delete change event
			yield* publishEvent(pubsub, "books", "delete");

			const results = yield* Fiber.join(collectedFiber);
			const emissions = Array.from(results) as Array<Book | null>;

			// First emission: entity exists
			expect(emissions[0]).not.toBeNull();
			expect(emissions[0]?.id).toBe("1");
			expect(emissions[0]?.title).toBe("Dune");

			// Second emission: entity deleted, should be null
			expect(emissions[1]).toBeNull();
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("emits entity when previously non-existent entity is created", async () => {
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef([]); // Start empty

			const stream = yield* watchById(pubsub, ref, "books", "1");

			const collectedFiber = yield* Stream.take(stream, 2).pipe(
				Stream.runCollect,
				Effect.fork,
			);

			// Wait, then create the entity
			yield* Effect.sleep("15 millis");
			yield* Ref.update(ref, (map) => {
				const newMap = new Map(map);
				newMap.set("1", testBook);
				return newMap;
			});

			// Publish create change event
			yield* publishEvent(pubsub, "books", "create");

			const results = yield* Fiber.join(collectedFiber);
			const emissions = Array.from(results) as Array<Book | null>;

			// First emission: entity doesn't exist, should be null
			expect(emissions[0]).toBeNull();

			// Second emission: entity created
			expect(emissions[1]).not.toBeNull();
			expect(emissions[1]?.id).toBe("1");
			expect(emissions[1]?.title).toBe("Dune");
		});

		await Effect.runPromise(Effect.scoped(program));
	});

	it("ignores changes to other entities", async () => {
		const otherBook: Book = { id: "2", title: "Neuromancer", author: "Gibson" };
		const program = Effect.gen(function* () {
			const pubsub = yield* createChangePubSub();
			const ref = yield* createRef([testBook, otherBook]);

			const stream = yield* watchById(pubsub, ref, "books", "1");

			// Try to collect 2 emissions with a timeout
			const collectedFiber = yield* Stream.take(stream, 2).pipe(
				Stream.runCollect,
				Effect.timeoutFail({
					duration: "100 millis",
					onTimeout: () => new Error("timeout"),
				}),
				Effect.either,
				Effect.fork,
			);

			// Wait, then modify a different entity
			yield* Effect.sleep("15 millis");
			yield* Ref.update(ref, (map) => {
				const newMap = new Map(map);
				newMap.set("2", { ...otherBook, title: "Updated Other" });
				return newMap;
			});

			// Publish update event
			yield* publishEvent(pubsub, "books", "update");

			const result = yield* Fiber.join(collectedFiber);

			// Should timeout because the watched entity (id=1) didn't change
			// Deduplication should prevent re-emission of identical result
			expect(result._tag).toBe("Left");
		});

		await Effect.runPromise(Effect.scoped(program));
	});
});
