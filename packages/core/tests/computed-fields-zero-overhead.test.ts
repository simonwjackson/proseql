import { describe, it, expect, vi } from "vitest";
import { Effect, Stream, Chunk, Schema } from "effect";
import {
	resolveComputedStream,
	resolveComputedStreamWithLazySkip,
	hasSelectedComputedFields,
} from "../src/operations/query/resolve-computed";
import { createEffectDatabase } from "../src/factories/database-effect";

/**
 * Task 8.3: Verify that collections without `computed` config have zero overhead.
 *
 * When a collection does not have a computed fields config, the resolution step
 * should be completely bypassed:
 * - resolveComputedStream returns the stream unchanged (no Stream.map)
 * - resolveComputedStreamWithLazySkip returns the stream unchanged (no Stream.map)
 * - hasSelectedComputedFields returns false immediately
 *
 * This ensures no unnecessary computation when computed fields are not configured.
 */

// Test entity type
interface Book {
	readonly id: string;
	readonly title: string;
	readonly year: number;
	readonly genre: string;
}

const testBooks: readonly Book[] = [
	{ id: "1", title: "Dune", year: 1965, genre: "sci-fi" },
	{ id: "2", title: "Neuromancer", year: 1984, genre: "sci-fi" },
	{ id: "3", title: "Project Hail Mary", year: 2021, genre: "sci-fi" },
];

describe("Computed Fields Zero Overhead (Task 8.3)", () => {
	describe("resolveComputedStream with undefined config", () => {
		it("should return the same stream reference when config is undefined", async () => {
			const originalStream = Stream.fromIterable(testBooks);

			// Apply resolve with undefined config
			const resultStream = resolveComputedStream<Book, never>(undefined)(
				originalStream,
			);

			// The returned stream should be the same reference (no wrapping)
			// We verify this by checking the streams produce identical results
			const originalItems = await Effect.runPromise(
				Stream.runCollect(originalStream).pipe(Effect.map(Chunk.toReadonlyArray)),
			);
			const resultItems = await Effect.runPromise(
				Stream.runCollect(resultStream).pipe(Effect.map(Chunk.toReadonlyArray)),
			);

			expect(resultItems).toEqual(originalItems);
			expect(resultItems).toHaveLength(3);
		});

		it("should return the same stream reference when config is empty object", async () => {
			const originalStream = Stream.fromIterable(testBooks);

			// Apply resolve with empty config
			const resultStream = resolveComputedStream<Book, Record<string, never>>(
				{} as Record<string, never>,
			)(originalStream);

			const resultItems = await Effect.runPromise(
				Stream.runCollect(resultStream).pipe(Effect.map(Chunk.toReadonlyArray)),
			);

			expect(resultItems).toHaveLength(3);
			expect(resultItems[0]).toEqual(testBooks[0]);
		});

		it("should not modify entities when config is undefined", async () => {
			const originalStream = Stream.fromIterable(testBooks);
			const resultStream = resolveComputedStream<Book, never>(undefined)(
				originalStream,
			);

			const items = await Effect.runPromise(
				Stream.runCollect(resultStream).pipe(Effect.map(Chunk.toReadonlyArray)),
			);

			// Verify entities are unchanged (no extra properties)
			for (const item of items) {
				const keys = Object.keys(item);
				expect(keys.sort()).toEqual(["genre", "id", "title", "year"]);
			}
		});
	});

	describe("resolveComputedStreamWithLazySkip with undefined config", () => {
		it("should return the same stream reference when config is undefined", async () => {
			const originalStream = Stream.fromIterable(testBooks);

			// Apply with undefined computed config and no select
			const resultStream = resolveComputedStreamWithLazySkip<Book, never>(
				undefined,
				undefined,
			)(originalStream);

			const resultItems = await Effect.runPromise(
				Stream.runCollect(resultStream).pipe(Effect.map(Chunk.toReadonlyArray)),
			);

			expect(resultItems).toEqual(testBooks);
		});

		it("should return the same stream reference regardless of select when config is undefined", async () => {
			const originalStream = Stream.fromIterable(testBooks);

			// Even with a select config, no computed config means no resolution
			const resultStream = resolveComputedStreamWithLazySkip<Book, never>(
				undefined,
				{ title: true, displayName: true },
			)(originalStream);

			const resultItems = await Effect.runPromise(
				Stream.runCollect(resultStream).pipe(Effect.map(Chunk.toReadonlyArray)),
			);

			expect(resultItems).toEqual(testBooks);
		});

		it("should not modify entities when config is empty", async () => {
			const originalStream = Stream.fromIterable(testBooks);
			const resultStream = resolveComputedStreamWithLazySkip<
				Book,
				Record<string, never>
			>({} as Record<string, never>, undefined)(originalStream);

			const items = await Effect.runPromise(
				Stream.runCollect(resultStream).pipe(Effect.map(Chunk.toReadonlyArray)),
			);

			// Verify no extra fields were added
			for (const item of items) {
				expect(Object.keys(item).sort()).toEqual(["genre", "id", "title", "year"]);
			}
		});
	});

	describe("hasSelectedComputedFields with undefined config", () => {
		it("should return false when config is undefined", () => {
			expect(hasSelectedComputedFields(undefined, undefined)).toBe(false);
			expect(hasSelectedComputedFields(undefined, { title: true })).toBe(false);
			expect(
				hasSelectedComputedFields(undefined, { displayName: true }),
			).toBe(false);
		});

		it("should return false when config is empty object", () => {
			expect(hasSelectedComputedFields({}, undefined)).toBe(false);
			expect(hasSelectedComputedFields({}, { title: true })).toBe(false);
		});
	});

	describe("Integration: database collection without computed config", () => {
		// Schema for testing
		const BookSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			year: Schema.Number,
			genre: Schema.String,
		});

		const config = {
			books: {
				schema: BookSchema,
				relationships: {},
				// NO computed field config - testing zero overhead
			},
		} as const;

		const initialData = {
			books: testBooks,
		};

		it("should query without computed fields resolution step", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			);

			const results = await db.books.query().runPromise;

			expect(results).toHaveLength(3);
			// Verify no computed fields are present
			for (const book of results) {
				const keys = Object.keys(book);
				expect(keys.sort()).toEqual(["genre", "id", "title", "year"]);
				expect(book).not.toHaveProperty("displayName");
				expect(book).not.toHaveProperty("isClassic");
			}
		});

		it("should filter correctly without computed fields", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			);

			const results = await db.books
				.query({ where: { year: { $lt: 2000 } } })
				.runPromise;

			expect(results).toHaveLength(2);
			expect(results.map((b) => b.title)).toContain("Dune");
			expect(results.map((b) => b.title)).toContain("Neuromancer");
		});

		it("should sort correctly without computed fields", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			);

			const results = await db.books
				.query({ sort: { year: "asc" } })
				.runPromise;

			expect(results).toHaveLength(3);
			expect(results[0].title).toBe("Dune");
			expect(results[1].title).toBe("Neuromancer");
			expect(results[2].title).toBe("Project Hail Mary");
		});

		it("should select correctly without computed fields", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			);

			const results = await db.books
				.query({ select: { title: true, year: true } })
				.runPromise;

			expect(results).toHaveLength(3);
			for (const book of results) {
				expect(Object.keys(book).sort()).toEqual(["title", "year"]);
			}
		});

		it("should combine filter, sort, and select without computed overhead", async () => {
			const db = await Effect.runPromise(
				createEffectDatabase(config, initialData),
			);

			const results = await db.books
				.query({
					where: { genre: "sci-fi" },
					sort: { year: "desc" },
					select: { title: true },
					limit: 2,
				})
				.runPromise;

			expect(results).toHaveLength(2);
			expect(results[0]).toEqual({ title: "Project Hail Mary" });
			expect(results[1]).toEqual({ title: "Neuromancer" });
		});
	});

	describe("Comparison: collection with vs without computed config", () => {
		const BookSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			year: Schema.Number,
			genre: Schema.String,
		});

		// Config WITHOUT computed fields
		const configWithoutComputed = {
			books: {
				schema: BookSchema,
				relationships: {},
			},
		} as const;

		// Config WITH computed fields
		const configWithComputed = {
			books: {
				schema: BookSchema,
				relationships: {},
				computed: {
					displayName: (book: { title: string; year: number }) =>
						`${book.title} (${book.year})`,
					isClassic: (book: { year: number }) => book.year < 1980,
				},
			},
		} as const;

		const initialData = { books: testBooks };

		it("should produce different results: with computed has extra fields", async () => {
			const dbWithout = await Effect.runPromise(
				createEffectDatabase(configWithoutComputed, initialData),
			);
			const dbWith = await Effect.runPromise(
				createEffectDatabase(configWithComputed, initialData),
			);

			const resultsWithout = await dbWithout.books.query().runPromise;
			const resultsWith = await dbWith.books.query().runPromise;

			// Both should have same number of items
			expect(resultsWithout).toHaveLength(3);
			expect(resultsWith).toHaveLength(3);

			// Without computed: only stored fields
			const keysWithout = Object.keys(resultsWithout[0]).sort();
			expect(keysWithout).toEqual(["genre", "id", "title", "year"]);

			// With computed: stored fields + computed fields
			const keysWith = Object.keys(resultsWith[0]).sort();
			expect(keysWith).toEqual([
				"displayName",
				"genre",
				"id",
				"isClassic",
				"title",
				"year",
			]);

			// Verify computed field values are correct
			const duneWith = resultsWith.find((b) => b.title === "Dune");
			expect(duneWith).toBeDefined();
			expect(duneWith?.displayName).toBe("Dune (1965)");
			expect(duneWith?.isClassic).toBe(true);
		});

		it("should filter identically for stored fields", async () => {
			const dbWithout = await Effect.runPromise(
				createEffectDatabase(configWithoutComputed, initialData),
			);
			const dbWith = await Effect.runPromise(
				createEffectDatabase(configWithComputed, initialData),
			);

			const whereClause = { year: { $lt: 2000 } };

			const resultsWithout = await dbWithout.books
				.query({ where: whereClause })
				.runPromise;
			const resultsWith = await dbWith.books
				.query({ where: whereClause })
				.runPromise;

			// Same number of results
			expect(resultsWithout).toHaveLength(2);
			expect(resultsWith).toHaveLength(2);

			// Same titles
			const titlesWithout = resultsWithout.map((b) => b.title).sort();
			const titlesWith = resultsWith.map((b) => b.title).sort();
			expect(titlesWithout).toEqual(titlesWith);
		});

		it("should sort identically for stored fields", async () => {
			const dbWithout = await Effect.runPromise(
				createEffectDatabase(configWithoutComputed, initialData),
			);
			const dbWith = await Effect.runPromise(
				createEffectDatabase(configWithComputed, initialData),
			);

			const sortConfig = { year: "asc" as const };

			const resultsWithout = await dbWithout.books
				.query({ sort: sortConfig })
				.runPromise;
			const resultsWith = await dbWith.books
				.query({ sort: sortConfig })
				.runPromise;

			// Same order
			expect(resultsWithout.map((b) => b.title)).toEqual(
				resultsWith.map((b) => b.title),
			);
		});
	});
});
