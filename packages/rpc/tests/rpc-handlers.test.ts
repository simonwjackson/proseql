/**
 * Tests for the RPC handler layer implementation.
 */

import {
	createPersistentEffectDatabase,
	jsonCodec,
	makeInMemoryStorageLayer,
	makeSerializerLayer,
} from "@proseql/core";
import { Chunk, Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	makeDatabaseContextTag,
	makeRpcHandlers,
	makeRpcHandlersFromDatabase,
	makeRpcHandlersLayer,
	makeRpcHandlersLayerFromDatabase,
} from "../src/rpc-handlers.js";

// Test schema
const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
});

const AuthorSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	bio: Schema.optional(Schema.String),
});

// Test config
const singleCollectionConfig = {
	books: {
		schema: BookSchema,
		relationships: {},
	},
} as const;

const multiCollectionConfig = {
	books: {
		schema: BookSchema,
		relationships: {
			author: {
				type: "ref" as const,
				target: "authors" as const,
				foreignKey: "authorId",
			},
		},
	},
	authors: {
		schema: AuthorSchema,
		relationships: {},
	},
} as const;

// Initial data
const initialBooks = [
	{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
	{ id: "2", title: "Neuromancer", author: "William Gibson", year: 1984 },
];

describe("makeRpcHandlers", () => {
	it("should create handlers for a single collection", async () => {
		const handlers = await Effect.runPromise(
			makeRpcHandlers(singleCollectionConfig, {
				books: initialBooks,
			}),
		);

		expect(handlers.books).toBeDefined();
		expect(handlers.books.findById).toBeTypeOf("function");
		expect(handlers.books.query).toBeTypeOf("function");
		expect(handlers.books.create).toBeTypeOf("function");
		expect(handlers.books.createMany).toBeTypeOf("function");
		expect(handlers.books.update).toBeTypeOf("function");
		expect(handlers.books.updateMany).toBeTypeOf("function");
		expect(handlers.books.delete).toBeTypeOf("function");
		expect(handlers.books.deleteMany).toBeTypeOf("function");
		expect(handlers.books.aggregate).toBeTypeOf("function");
		expect(handlers.books.upsert).toBeTypeOf("function");
		expect(handlers.books.upsertMany).toBeTypeOf("function");
	});

	it("should create handlers for multiple collections", async () => {
		const handlers = await Effect.runPromise(
			makeRpcHandlers(multiCollectionConfig, {
				books: initialBooks,
				authors: [{ id: "a1", name: "Frank Herbert" }],
			}),
		);

		expect(handlers.books).toBeDefined();
		expect(handlers.authors).toBeDefined();

		// Verify each collection has all handlers
		for (const collectionHandlers of [handlers.books, handlers.authors]) {
			expect(collectionHandlers.findById).toBeTypeOf("function");
			expect(collectionHandlers.query).toBeTypeOf("function");
			expect(collectionHandlers.create).toBeTypeOf("function");
		}
	});

	describe("handler operations", () => {
		it("findById should return the entity", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			const book = await Effect.runPromise(
				handlers.books.findById({ id: "1" }),
			);
			expect(book).toEqual({
				id: "1",
				title: "Dune",
				author: "Frank Herbert",
				year: 1965,
			});
		});

		it("findById should fail for non-existent entity", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			const result = await Effect.runPromise(
				Effect.either(handlers.books.findById({ id: "nonexistent" })),
			);

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expect(result.left._tag).toBe("NotFoundError");
			}
		});

		it("findById should return typed NotFoundError that can be caught with Effect.catchTag", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			// Use Effect.catchTag to verify the error is properly typed
			// This demonstrates that the error type flows through correctly
			const result = await Effect.runPromise(
				handlers.books.findById({ id: "nonexistent" }).pipe(
					Effect.catchTag("NotFoundError", (error) =>
						// The error is typed - we can access its fields
						Effect.succeed({
							caught: true,
							errorTag: error._tag,
							errorCollection: error.collection,
							errorId: error.id,
						}),
					),
				),
			);

			expect(result).toEqual({
				caught: true,
				errorTag: "NotFoundError",
				errorCollection: "books",
				errorId: "nonexistent",
			});
		});

		it("create should add a new entity", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			const newBook = await Effect.runPromise(
				handlers.books.create({
					data: {
						id: "3",
						title: "Snow Crash",
						author: "Neal Stephenson",
						year: 1992,
					},
				}),
			);

			expect(newBook.id).toBe("3");
			expect(newBook.title).toBe("Snow Crash");

			// Verify it was added
			const found = await Effect.runPromise(
				handlers.books.findById({ id: "3" }),
			);
			expect(found.title).toBe("Snow Crash");
		});

		it("create should return typed ValidationError for invalid data", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			// Attempt to create with invalid data (missing required field 'author', wrong type for 'year')
			const result = await Effect.runPromise(
				Effect.either(
					handlers.books.create({
						data: {
							id: "bad",
							title: "Bad Book",
							year: "not-a-number",
						} as unknown as Record<string, unknown>,
					}),
				),
			);

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expect(result.left._tag).toBe("ValidationError");
			}
		});

		it("create should return typed ValidationError that can be caught with Effect.catchTag", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			// Use Effect.catchTag to verify the error is properly typed
			const result = await Effect.runPromise(
				handlers.books
					.create({
						data: { id: "bad", title: "Bad Book" } as unknown as Record<
							string,
							unknown
						>,
					})
					.pipe(
						Effect.catchTag("ValidationError", (error) =>
							// The error is typed - we can access its fields
							Effect.succeed({
								caught: true,
								errorTag: error._tag,
								hasIssues: error.issues.length > 0,
								hasMessage: error.message.length > 0,
							}),
						),
					),
			);

			expect(result).toEqual({
				caught: true,
				errorTag: "ValidationError",
				hasIssues: true,
				hasMessage: true,
			});
		});

		it("update should modify an existing entity", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			const updated = await Effect.runPromise(
				handlers.books.update({
					id: "1",
					updates: { year: 1966 },
				}),
			);

			expect(updated.year).toBe(1966);
			expect(updated.title).toBe("Dune"); // Other fields unchanged
		});

		it("update should fail for non-existent entity with NotFoundError", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			const result = await Effect.runPromise(
				Effect.either(
					handlers.books.update({
						id: "nonexistent",
						updates: { year: 2000 },
					}),
				),
			);

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expect(result.left._tag).toBe("NotFoundError");
			}
		});

		it("delete should remove an entity", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			const deleted = await Effect.runPromise(
				handlers.books.delete({ id: "1" }),
			);
			expect(deleted.id).toBe("1");

			// Verify it was removed
			const result = await Effect.runPromise(
				Effect.either(handlers.books.findById({ id: "1" })),
			);
			expect(result._tag).toBe("Left");
		});

		it("delete should fail for non-existent entity with NotFoundError", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			const result = await Effect.runPromise(
				Effect.either(handlers.books.delete({ id: "nonexistent" })),
			);

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expect(result.left._tag).toBe("NotFoundError");
			}
		});

		it("aggregate should compute aggregates", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			const result = await Effect.runPromise(
				handlers.books.aggregate({ count: true, avg: "year" }),
			);

			expect(result.count).toBe(2);
			expect(result.avg).toBeDefined();
			expect(result.avg?.year).toBe((1965 + 1984) / 2);
		});

		it("aggregate should compute all scalar operations (sum, min, max)", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			const result = await Effect.runPromise(
				handlers.books.aggregate({
					count: true,
					sum: "year",
					min: "year",
					max: "year",
					avg: "year",
				}),
			);

			// count: 2 books
			expect(result.count).toBe(2);

			// sum: 1965 + 1984 = 3949
			expect(result.sum).toBeDefined();
			expect(result.sum?.year).toBe(1965 + 1984);

			// min: 1965 (Dune)
			expect(result.min).toBeDefined();
			expect(result.min?.year).toBe(1965);

			// max: 1984 (Neuromancer)
			expect(result.max).toBeDefined();
			expect(result.max?.year).toBe(1984);

			// avg: (1965 + 1984) / 2 = 1974.5
			expect(result.avg).toBeDefined();
			expect(result.avg?.year).toBe((1965 + 1984) / 2);
		});

		it("query should return all entities when no filter is provided", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			const results = await Effect.runPromise(handlers.books.query({}));
			expect(results).toHaveLength(2);
			expect(results[0].title).toBe("Dune");
			expect(results[1].title).toBe("Neuromancer");
		});

		it("query should return filtered results", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			const results = await Effect.runPromise(
				handlers.books.query({
					where: { year: { $gte: 1980 } },
				}),
			);
			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Neuromancer");
		});

		it("query should support sorting", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			const results = await Effect.runPromise(
				handlers.books.query({
					sort: { year: "desc" },
				}),
			);
			expect(results).toHaveLength(2);
			expect(results[0].title).toBe("Neuromancer"); // 1984
			expect(results[1].title).toBe("Dune"); // 1965
		});

		it("query should support pagination", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			const results = await Effect.runPromise(
				handlers.books.query({
					limit: 1,
					offset: 1,
				}),
			);
			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Neuromancer");
		});
	});

	describe("streaming handler operations", () => {
		it("queryStream should return a stream of entities", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			// queryStream returns a Stream that can be collected
			const stream = handlers.books.queryStream({});
			const results = await Effect.runPromise(
				Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray)),
			);

			expect(results).toHaveLength(2);
			expect(results[0].title).toBe("Dune");
			expect(results[1].title).toBe("Neuromancer");
		});

		it("queryStream should support filtering", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			const stream = handlers.books.queryStream({
				where: { year: { $gte: 1980 } },
			});
			const results = await Effect.runPromise(
				Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray)),
			);

			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Neuromancer");
		});

		it("queryStream should accept streamingOptions", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: [
						{ id: "1", title: "Book 1", author: "Author", year: 2000 },
						{ id: "2", title: "Book 2", author: "Author", year: 2001 },
						{ id: "3", title: "Book 3", author: "Author", year: 2002 },
						{ id: "4", title: "Book 4", author: "Author", year: 2003 },
						{ id: "5", title: "Book 5", author: "Author", year: 2004 },
					],
				}),
			);

			// queryStream with chunkSize should work
			const stream = handlers.books.queryStream({
				streamingOptions: { chunkSize: 2 },
			});
			const results = await Effect.runPromise(
				Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray)),
			);

			// Should still return all 5 items regardless of chunk size
			expect(results).toHaveLength(5);
		});

		it("queryStream with chunkSize should rechunk the stream", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: [
						{ id: "1", title: "Book 1", author: "Author", year: 2000 },
						{ id: "2", title: "Book 2", author: "Author", year: 2001 },
						{ id: "3", title: "Book 3", author: "Author", year: 2002 },
						{ id: "4", title: "Book 4", author: "Author", year: 2003 },
						{ id: "5", title: "Book 5", author: "Author", year: 2004 },
					],
				}),
			);

			// Track chunk sizes to verify rechunking behavior
			const chunkSizes: number[] = [];
			const stream = handlers.books.queryStream({
				streamingOptions: { chunkSize: 2 },
			});

			// Use mapChunks to observe the actual chunk structure
			const observedStream = Stream.mapChunks(stream, (chunk) => {
				chunkSizes.push(Chunk.size(chunk));
				return chunk;
			});

			await Effect.runPromise(
				Stream.runCollect(observedStream).pipe(
					Effect.map(Chunk.toReadonlyArray),
				),
			);

			// With 5 items and chunkSize 2, we should get chunks of size 2, 2, 1
			// (or similar batching depending on implementation)
			expect(chunkSizes.length).toBeGreaterThan(0);
			// At least some chunks should respect the chunkSize
			expect(chunkSizes.some((size) => size <= 2)).toBe(true);
		});

		it("queryStream without chunkSize should pass stream through unchanged", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			// Without streamingOptions, stream should work normally
			const stream = handlers.books.queryStream({});
			const results = await Effect.runPromise(
				Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray)),
			);

			expect(results).toHaveLength(2);
		});

		it("queryStream with chunkSize=1 should not apply rechunking", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			// chunkSize of 1 should not trigger rechunking (no benefit)
			const stream = handlers.books.queryStream({
				streamingOptions: { chunkSize: 1 },
			});
			const results = await Effect.runPromise(
				Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray)),
			);

			expect(results).toHaveLength(2);
		});

		it("streamingOptions.bufferSize should be accepted but not affect handler", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			// bufferSize is a client-side hint; handler should accept it without error
			const stream = handlers.books.queryStream({
				streamingOptions: { bufferSize: 32 },
			});
			const results = await Effect.runPromise(
				Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray)),
			);

			expect(results).toHaveLength(2);
		});
	});

	describe("batch handler operations", () => {
		it("createMany should create multiple entities", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: [],
				}),
			);

			const result = await Effect.runPromise(
				handlers.books.createMany({
					data: [
						{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
						{
							id: "2",
							title: "Neuromancer",
							author: "William Gibson",
							year: 1984,
						},
					],
				}),
			);

			expect(result.created).toHaveLength(2);
			expect(result.created[0].title).toBe("Dune");
			expect(result.created[1].title).toBe("Neuromancer");

			// Verify entities were added
			const allBooks = await Effect.runPromise(handlers.books.query({}));
			expect(allBooks).toHaveLength(2);
		});

		it("createMany should support skipDuplicates option", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: [
						{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
					],
				}),
			);

			const result = await Effect.runPromise(
				handlers.books.createMany({
					data: [
						{
							id: "1",
							title: "Dune Again",
							author: "Frank Herbert",
							year: 1965,
						}, // Duplicate ID
						{
							id: "2",
							title: "Neuromancer",
							author: "William Gibson",
							year: 1984,
						},
					],
					options: { skipDuplicates: true },
				}),
			);

			expect(result.created).toHaveLength(1);
			expect(result.created[0].title).toBe("Neuromancer");
			expect(result.skipped).toHaveLength(1);
			expect(result.skipped?.[0].reason).toContain("Duplicate");
		});

		it("updateMany should update matching entities", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: [
						{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
						{
							id: "2",
							title: "Neuromancer",
							author: "William Gibson",
							year: 1984,
						},
						{
							id: "3",
							title: "Foundation",
							author: "Isaac Asimov",
							year: 1951,
						},
					],
				}),
			);

			const result = await Effect.runPromise(
				handlers.books.updateMany({
					where: { author: "Frank Herbert" },
					updates: { year: 2000 },
				}),
			);

			expect(result.count).toBe(1);
			expect(result.updated).toHaveLength(1);
			expect(result.updated[0].year).toBe(2000);

			// Verify the update persisted
			const dune = await Effect.runPromise(
				handlers.books.findById({ id: "1" }),
			);
			expect(dune.year).toBe(2000);
		});

		it("deleteMany should delete matching entities", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: [
						{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
						{
							id: "2",
							title: "Neuromancer",
							author: "William Gibson",
							year: 1984,
						},
						{
							id: "3",
							title: "Foundation",
							author: "Isaac Asimov",
							year: 1951,
						},
					],
				}),
			);

			const result = await Effect.runPromise(
				handlers.books.deleteMany({
					where: { year: 1965 },
				}),
			);

			expect(result.count).toBe(1);
			expect(result.deleted).toHaveLength(1);
			expect(result.deleted[0].title).toBe("Dune");

			// Verify remaining books
			const allBooks = await Effect.runPromise(handlers.books.query({}));
			expect(allBooks).toHaveLength(2);
		});

		it("deleteMany should respect limit option", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: [
						{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
						{
							id: "2",
							title: "Children of Dune",
							author: "Frank Herbert",
							year: 1976,
						},
						{
							id: "3",
							title: "Foundation",
							author: "Isaac Asimov",
							year: 1951,
						},
					],
				}),
			);

			const result = await Effect.runPromise(
				handlers.books.deleteMany({
					where: { author: "Frank Herbert" },
					options: { limit: 1 },
				}),
			);

			expect(result.count).toBe(1);
			expect(result.deleted).toHaveLength(1);

			// Verify one Frank Herbert book remains
			const allBooks = await Effect.runPromise(handlers.books.query({}));
			expect(allBooks).toHaveLength(2);
			const herbertBooks = allBooks.filter((b) => b.author === "Frank Herbert");
			expect(herbertBooks).toHaveLength(1);
		});

		it("upsert should create when entity does not exist", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: [],
				}),
			);

			const result = await Effect.runPromise(
				handlers.books.upsert({
					where: { id: "1" },
					create: {
						id: "1",
						title: "Dune",
						author: "Frank Herbert",
						year: 1965,
					},
					update: { year: 2000 },
				}),
			);

			// UpsertResult<T> is T & { __action }, so entity fields are at top level
			expect(result.__action).toBe("created");
			expect(result.title).toBe("Dune");
			expect(result.year).toBe(1965);
		});

		it("upsert should update when entity exists", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: [
						{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
					],
				}),
			);

			const result = await Effect.runPromise(
				handlers.books.upsert({
					where: { id: "1" },
					create: {
						id: "1",
						title: "Dune",
						author: "Frank Herbert",
						year: 1965,
					},
					update: { year: 2000 },
				}),
			);

			// UpsertResult<T> is T & { __action }, so entity fields are at top level
			expect(result.__action).toBe("updated");
			expect(result.year).toBe(2000);
		});

		it("upsertMany should create and update multiple entities", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: [
						{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
					],
				}),
			);

			const result = await Effect.runPromise(
				handlers.books.upsertMany({
					data: [
						{
							where: { id: "1" },
							create: {
								id: "1",
								title: "Dune",
								author: "Frank Herbert",
								year: 1965,
							},
							update: { year: 2000 },
						},
						{
							where: { id: "2" },
							create: {
								id: "2",
								title: "Neuromancer",
								author: "William Gibson",
								year: 1984,
							},
							update: { year: 2001 },
						},
					],
				}),
			);

			expect(result.updated).toHaveLength(1);
			expect(result.updated[0].id).toBe("1");
			expect(result.updated[0].year).toBe(2000);
			expect(result.created).toHaveLength(1);
			expect(result.created[0].id).toBe("2");
			expect(result.created[0].year).toBe(1984);

			// Verify both entities exist
			const allBooks = await Effect.runPromise(handlers.books.query({}));
			expect(allBooks).toHaveLength(2);
		});
	});
});

describe("makeRpcHandlersLayer", () => {
	it("should create a layer with DatabaseContext", async () => {
		const layer = makeRpcHandlersLayer(singleCollectionConfig, {
			books: initialBooks,
		});

		const DatabaseContextTag =
			makeDatabaseContextTag<typeof singleCollectionConfig>();

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ctx = yield* DatabaseContextTag;
				const book = yield* ctx.db.books.findById("1");
				return book;
			}).pipe(Effect.provide(layer)),
		);

		expect(result.title).toBe("Dune");
	});
});

describe("makeRpcHandlersFromDatabase", () => {
	// Config with file persistence
	const persistentConfig = {
		books: {
			schema: BookSchema,
			file: "/data/books.json",
			relationships: {},
		},
	} as const;

	it("should create handlers from an existing database", async () => {
		const handlers = await Effect.runPromise(
			Effect.gen(function* () {
				const db = yield* Effect.provide(
					createPersistentEffectDatabase(persistentConfig, {
						books: initialBooks,
					}),
					Layer.merge(
						makeInMemoryStorageLayer(),
						makeSerializerLayer([jsonCodec()]),
					),
				);
				return makeRpcHandlersFromDatabase(persistentConfig, db);
			}).pipe(Effect.scoped),
		);

		expect(handlers.books).toBeDefined();
		expect(handlers.books.findById).toBeTypeOf("function");

		// Verify handlers work
		const book = await Effect.runPromise(handlers.books.findById({ id: "1" }));
		expect(book.title).toBe("Dune");
	});

	it("should trigger persistence when mutations are performed through RPC handlers", async () => {
		// Track what gets written to storage
		const store = new Map<string, string>();
		const customStorageLayer = makeInMemoryStorageLayer(store);
		const serializerLayer = makeSerializerLayer([jsonCodec()]);
		const layer = Layer.merge(customStorageLayer, serializerLayer);

		await Effect.runPromise(
			Effect.gen(function* () {
				// Create a persistent database
				const db = yield* createPersistentEffectDatabase(persistentConfig, {
					books: [],
				});

				// Wire RPC handlers to the persistent database
				const handlers = makeRpcHandlersFromDatabase(persistentConfig, db);

				// File should not exist yet
				expect(store.has("/data/books.json")).toBe(false);

				// Create a book via RPC handler
				yield* handlers.books.create({
					data: {
						id: "new-1",
						title: "Snow Crash",
						author: "Neal Stephenson",
						year: 1992,
					},
				});

				// Flush to ensure persistence
				yield* Effect.promise(() => db.flush());

				// Verify the file was written
				expect(store.has("/data/books.json")).toBe(true);
				const fileContent = store.get("/data/books.json");
				expect(fileContent).toBeDefined();
				const parsed = JSON.parse(fileContent ?? "{}");
				expect(parsed["new-1"]).toBeDefined();
				expect(parsed["new-1"].title).toBe("Snow Crash");
			}).pipe(Effect.provide(layer), Effect.scoped),
		);
	});

	it("should persist updates made through RPC handlers", async () => {
		const store = new Map<string, string>();
		const layer = Layer.merge(
			makeInMemoryStorageLayer(store),
			makeSerializerLayer([jsonCodec()]),
		);

		await Effect.runPromise(
			Effect.gen(function* () {
				const db = yield* createPersistentEffectDatabase(persistentConfig, {
					books: [
						{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
					],
				});

				const handlers = makeRpcHandlersFromDatabase(persistentConfig, db);

				// Update via RPC handler
				yield* handlers.books.update({
					id: "1",
					updates: { title: "Dune (Revised Edition)" },
				});

				// Flush to ensure persistence
				yield* Effect.promise(() => db.flush());

				// Verify the update was persisted
				expect(store.has("/data/books.json")).toBe(true);
				const fileContent = store.get("/data/books.json");
				expect(fileContent).toBeDefined();
				const parsed = JSON.parse(fileContent ?? "{}");
				expect(parsed["1"].title).toBe("Dune (Revised Edition)");
			}).pipe(Effect.provide(layer), Effect.scoped),
		);
	});

	it("should persist deletions made through RPC handlers", async () => {
		const store = new Map<string, string>();
		const layer = Layer.merge(
			makeInMemoryStorageLayer(store),
			makeSerializerLayer([jsonCodec()]),
		);

		await Effect.runPromise(
			Effect.gen(function* () {
				const db = yield* createPersistentEffectDatabase(persistentConfig, {
					books: [
						{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
						{
							id: "2",
							title: "Neuromancer",
							author: "William Gibson",
							year: 1984,
						},
					],
				});

				const handlers = makeRpcHandlersFromDatabase(persistentConfig, db);

				// Delete via RPC handler
				yield* handlers.books.delete({ id: "1" });

				// Flush to ensure persistence
				yield* Effect.promise(() => db.flush());

				// Verify the deletion was persisted
				expect(store.has("/data/books.json")).toBe(true);
				const fileContent = store.get("/data/books.json");
				expect(fileContent).toBeDefined();
				const parsed = JSON.parse(fileContent ?? "{}");
				expect(parsed["1"]).toBeUndefined();
				expect(parsed["2"]).toBeDefined();
			}).pipe(Effect.provide(layer), Effect.scoped),
		);
	});

	it("should persist batch operations made through RPC handlers", async () => {
		const store = new Map<string, string>();
		const layer = Layer.merge(
			makeInMemoryStorageLayer(store),
			makeSerializerLayer([jsonCodec()]),
		);

		await Effect.runPromise(
			Effect.gen(function* () {
				const db = yield* createPersistentEffectDatabase(persistentConfig, {
					books: [],
				});

				const handlers = makeRpcHandlersFromDatabase(persistentConfig, db);

				// Create many via RPC handler
				yield* handlers.books.createMany({
					data: [
						{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
						{
							id: "2",
							title: "Neuromancer",
							author: "William Gibson",
							year: 1984,
						},
						{
							id: "3",
							title: "Snow Crash",
							author: "Neal Stephenson",
							year: 1992,
						},
					],
				});

				// Flush to ensure persistence
				yield* Effect.promise(() => db.flush());

				// Verify all were persisted
				expect(store.has("/data/books.json")).toBe(true);
				const fileContent = store.get("/data/books.json");
				expect(fileContent).toBeDefined();
				const parsed = JSON.parse(fileContent ?? "{}");
				expect(Object.keys(parsed)).toHaveLength(3);
				expect(parsed["1"].title).toBe("Dune");
				expect(parsed["2"].title).toBe("Neuromancer");
				expect(parsed["3"].title).toBe("Snow Crash");
			}).pipe(Effect.provide(layer), Effect.scoped),
		);
	});
});

describe("typed error flow through to client", () => {
	/**
	 * Task 10.12: Test that typed errors flow through to the client side.
	 *
	 * This test demonstrates the full pattern of typed error handling:
	 * 1. Errors maintain their _tag through the RPC layer
	 * 2. Effect.catchTag can discriminate between error types
	 * 3. Multiple error types can be handled with different catch branches
	 * 4. Uncaught errors propagate correctly
	 */
	it("should allow Effect.catchTag to discriminate between different error types", async () => {
		const handlers = await Effect.runPromise(
			makeRpcHandlers(singleCollectionConfig, {
				books: initialBooks,
			}),
		);

		// Test that NotFoundError can be caught specifically while letting other errors pass
		const notFoundResult = await Effect.runPromise(
			handlers.books.findById({ id: "nonexistent" }).pipe(
				Effect.catchTag("NotFoundError", (error) =>
					Effect.succeed({
						handledBy: "NotFoundError" as const,
						tag: error._tag,
						id: error.id,
					}),
				),
				Effect.catchTag("ValidationError", () =>
					Effect.succeed({ handledBy: "ValidationError" as const }),
				),
			),
		);

		expect(notFoundResult.handledBy).toBe("NotFoundError");
		expect(notFoundResult.tag).toBe("NotFoundError");
		expect((notFoundResult as { id: string }).id).toBe("nonexistent");

		// Test that ValidationError is caught by its specific handler, not NotFoundError handler
		const validationResult = await Effect.runPromise(
			handlers.books
				.create({
					data: { id: "invalid", title: 123 } as unknown as Record<
						string,
						unknown
					>,
				})
				.pipe(
					Effect.catchTag("NotFoundError", () =>
						Effect.succeed({ handledBy: "NotFoundError" as const }),
					),
					Effect.catchTag("ValidationError", (error) =>
						Effect.succeed({
							handledBy: "ValidationError" as const,
							tag: error._tag,
							hasIssues: error.issues.length > 0,
						}),
					),
				),
		);

		expect(validationResult.handledBy).toBe("ValidationError");
		expect(validationResult.tag).toBe("ValidationError");
		expect((validationResult as { hasIssues: boolean }).hasIssues).toBe(true);
	});

	it("should preserve all error fields through the RPC layer", async () => {
		const handlers = await Effect.runPromise(
			makeRpcHandlers(singleCollectionConfig, {
				books: initialBooks,
			}),
		);

		// Verify NotFoundError fields are preserved
		const notFoundError = await Effect.runPromise(
			handlers.books.findById({ id: "missing-book-123" }).pipe(
				Effect.flip, // Convert error to success to inspect it
			),
		);

		expect(notFoundError._tag).toBe("NotFoundError");
		expect(notFoundError.collection).toBe("books");
		expect(notFoundError.id).toBe("missing-book-123");
		expect(notFoundError.message).toContain("missing-book-123");
	});

	it("should allow chaining multiple catchTag handlers for different error scenarios", async () => {
		const handlers = await Effect.runPromise(
			makeRpcHandlers(singleCollectionConfig, {
				books: initialBooks,
			}),
		);

		// Define a generic error handler that uses multiple catchTag calls
		const handleOperation = <T>(
			operation: Effect.Effect<T, { _tag: string }>,
		) =>
			operation.pipe(
				Effect.catchTag("NotFoundError", (e) =>
					Effect.succeed({ status: "not_found" as const, errorId: e.id }),
				),
				Effect.catchTag("ValidationError", (e) =>
					Effect.succeed({
						status: "validation_failed" as const,
						issues: e.issues.length,
					}),
				),
				Effect.catchTag("DuplicateKeyError", (e) =>
					Effect.succeed({ status: "duplicate" as const, field: e.field }),
				),
			);

		// Test not found scenario
		const findResult = await Effect.runPromise(
			handleOperation(handlers.books.findById({ id: "ghost" })),
		);
		expect(findResult.status).toBe("not_found");

		// Test validation scenario
		const createResult = await Effect.runPromise(
			handleOperation(
				handlers.books.create({
					data: { id: "bad" } as unknown as Record<string, unknown>,
				}),
			),
		);
		expect(createResult.status).toBe("validation_failed");

		// Test success scenario (no error, returns the entity)
		const successResult = await Effect.runPromise(
			handleOperation(handlers.books.findById({ id: "1" })),
		);
		expect(successResult).toEqual({
			id: "1",
			title: "Dune",
			author: "Frank Herbert",
			year: 1965,
		});
	});

	it("should allow Effect.catchTags to handle multiple error types at once", async () => {
		const handlers = await Effect.runPromise(
			makeRpcHandlers(singleCollectionConfig, {
				books: initialBooks,
			}),
		);

		// Use Effect.catchTags to handle multiple error types in a single call
		const result = await Effect.runPromise(
			handlers.books.findById({ id: "nonexistent" }).pipe(
				Effect.catchTags({
					NotFoundError: (e) =>
						Effect.succeed({
							handled: "NotFoundError",
							collection: e.collection,
						}),
					ValidationError: (e) =>
						Effect.succeed({ handled: "ValidationError", issues: e.issues }),
				}),
			),
		);

		expect(result).toEqual({ handled: "NotFoundError", collection: "books" });
	});
});

describe("makeRpcHandlersLayerFromDatabase", () => {
	const persistentConfig = {
		books: {
			schema: BookSchema,
			file: "/data/books.json",
			relationships: {},
		},
	} as const;

	it("should create a layer from an existing database", async () => {
		const store = new Map<string, string>();
		const layer = Layer.merge(
			makeInMemoryStorageLayer(store),
			makeSerializerLayer([jsonCodec()]),
		);

		const DatabaseContextTag =
			makeDatabaseContextTag<typeof persistentConfig>();

		await Effect.runPromise(
			Effect.gen(function* () {
				const db = yield* createPersistentEffectDatabase(persistentConfig, {
					books: initialBooks,
				});

				const handlerLayer = makeRpcHandlersLayerFromDatabase(db);

				// Use the layer to access the database
				const result = yield* Effect.gen(function* () {
					const ctx = yield* DatabaseContextTag;
					return yield* ctx.db.books.findById("1");
				}).pipe(Effect.provide(handlerLayer));

				expect(result.title).toBe("Dune");
			}).pipe(Effect.provide(layer), Effect.scoped),
		);
	});
});
