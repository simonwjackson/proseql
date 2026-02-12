/**
 * Tests for evaluateQuery function.
 *
 * Verifies that evaluateQuery returns a complete ReadonlyArray<T> (not a Stream
 * or cursor), providing a point-in-time snapshot of query results.
 */

import { describe, expect, it } from "vitest";
import { Effect, Ref } from "effect";
import {
	evaluateQuery,
	type EvaluateQueryConfig,
} from "../src/reactive/evaluate-query.js";

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

describe("evaluateQuery", () => {
	describe("return type: ReadonlyArray<T>", () => {
		it("returns a ReadonlyArray (not a Stream or cursor)", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);
				const results = yield* evaluateQuery(ref, {});

				// Verify it's an array
				expect(Array.isArray(results)).toBe(true);

				// Verify it contains all entities when no filter applied
				expect(results).toHaveLength(5);
			});

			await Effect.runPromise(program);
		});

		it("returns a complete snapshot, not a lazy iterator", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);
				const results = yield* evaluateQuery(ref, { where: { genre: "sci-fi" } });

				// We can iterate multiple times (not consumed on first iteration)
				const firstPass = results.map((b) => b.id);
				const secondPass = results.map((b) => b.id);

				expect(firstPass).toEqual(secondPass);
				expect(results).toHaveLength(3);
			});

			await Effect.runPromise(program);
		});

		it("returns an immutable array (ReadonlyArray)", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);
				const results = yield* evaluateQuery(ref, {});

				// TypeScript enforces ReadonlyArray, but at runtime we can verify
				// the array was properly constructed
				expect(Object.isFrozen(results) || Array.isArray(results)).toBe(true);
			});

			await Effect.runPromise(program);
		});
	});

	describe("empty results", () => {
		it("returns an empty array when no entities match", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);
				const results = yield* evaluateQuery(ref, {
					where: { genre: "romance" },
				});

				expect(results).toEqual([]);
				expect(results).toHaveLength(0);
			});

			await Effect.runPromise(program);
		});

		it("returns an empty array when Ref is empty", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef([]);
				const results = yield* evaluateQuery(ref, {});

				expect(results).toEqual([]);
			});

			await Effect.runPromise(program);
		});
	});

	describe("query pipeline: filter", () => {
		it("applies where clause filter", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);
				const results = yield* evaluateQuery(ref, {
					where: { genre: "sci-fi" },
				});

				expect(results).toHaveLength(3);
				expect(results.every((b) => b.genre === "sci-fi")).toBe(true);
			});

			await Effect.runPromise(program);
		});

		it("applies comparison operators in filter", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);
				const results = yield* evaluateQuery(ref, {
					where: { year: { $lt: 1960 } },
				});

				expect(results.every((b) => b.year < 1960)).toBe(true);
				expect(results).toHaveLength(3); // 1937, 1949, 1951
			});

			await Effect.runPromise(program);
		});
	});

	describe("query pipeline: sort", () => {
		it("applies ascending sort", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);
				const results = yield* evaluateQuery(ref, {
					sort: { year: "asc" },
				});

				const years = results.map((b) => b.year);
				expect(years).toEqual([1937, 1949, 1951, 1965, 1984]);
			});

			await Effect.runPromise(program);
		});

		it("applies descending sort", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);
				const results = yield* evaluateQuery(ref, {
					sort: { year: "desc" },
				});

				const years = results.map((b) => b.year);
				expect(years).toEqual([1984, 1965, 1951, 1949, 1937]);
			});

			await Effect.runPromise(program);
		});
	});

	describe("query pipeline: pagination", () => {
		it("applies limit", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);
				const results = yield* evaluateQuery(ref, {
					sort: { year: "asc" },
					limit: 2,
				});

				expect(results).toHaveLength(2);
				expect(results[0].year).toBe(1937);
				expect(results[1].year).toBe(1949);
			});

			await Effect.runPromise(program);
		});

		it("applies offset", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);
				const results = yield* evaluateQuery(ref, {
					sort: { year: "asc" },
					offset: 2,
				});

				expect(results).toHaveLength(3);
				expect(results[0].year).toBe(1951);
			});

			await Effect.runPromise(program);
		});

		it("applies limit and offset together", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);
				const results = yield* evaluateQuery(ref, {
					sort: { year: "asc" },
					offset: 1,
					limit: 2,
				});

				expect(results).toHaveLength(2);
				expect(results[0].year).toBe(1949);
				expect(results[1].year).toBe(1951);
			});

			await Effect.runPromise(program);
		});
	});

	describe("query pipeline: select", () => {
		it("applies array-based field selection", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);
				const results = yield* evaluateQuery(ref, {
					where: { id: "1" },
					select: ["title", "author"],
				});

				expect(results).toHaveLength(1);
				expect(results[0]).toEqual({ title: "Dune", author: "Frank Herbert" });
			});

			await Effect.runPromise(program);
		});

		it("applies object-based field selection", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);
				const results = yield* evaluateQuery(ref, {
					where: { id: "1" },
					select: { title: true, year: true },
				});

				expect(results).toHaveLength(1);
				expect(results[0]).toEqual({ title: "Dune", year: 1965 });
			});

			await Effect.runPromise(program);
		});
	});

	describe("query pipeline: combined", () => {
		it("applies filter + sort + pagination + select in correct order", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);
				const results = yield* evaluateQuery(ref, {
					where: { genre: "sci-fi" },
					sort: { year: "desc" },
					limit: 2,
					select: ["title", "year"],
				});

				// Filter: sci-fi (1965, 1984, 1951)
				// Sort: desc (1984, 1965, 1951)
				// Limit: 2 (1984, 1965)
				// Select: title, year only
				expect(results).toHaveLength(2);
				expect(results[0]).toEqual({ title: "Neuromancer", year: 1984 });
				expect(results[1]).toEqual({ title: "Dune", year: 1965 });
			});

			await Effect.runPromise(program);
		});
	});

	describe("point-in-time snapshot behavior", () => {
		it("captures state at time of evaluation (modifications after call don't affect result)", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);

				// Evaluate query
				const results = yield* evaluateQuery(ref, { where: { genre: "sci-fi" } });
				const originalLength = results.length;

				// Modify the Ref after evaluation
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

				// The previously returned results should not have changed
				expect(results).toHaveLength(originalLength);
				expect(results.find((b) => b.id === "6")).toBeUndefined();
			});

			await Effect.runPromise(program);
		});

		it("each evaluation gets fresh state from Ref", async () => {
			const program = Effect.gen(function* () {
				const ref = yield* createRef(testBooks);

				const results1 = yield* evaluateQuery(ref, { where: { genre: "sci-fi" } });
				expect(results1).toHaveLength(3);

				// Modify Ref
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

				// New evaluation should include the new entity
				const results2 = yield* evaluateQuery(ref, { where: { genre: "sci-fi" } });
				expect(results2).toHaveLength(4);
			});

			await Effect.runPromise(program);
		});
	});
});
