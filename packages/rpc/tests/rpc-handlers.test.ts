/**
 * Tests for the RPC handler layer implementation.
 */

import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { makeRpcHandlers, makeRpcHandlersLayer, makeDatabaseContextTag } from "../src/rpc-handlers.js";

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
			author: { type: "ref" as const, target: "authors" as const, foreignKey: "authorId" },
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

			const book = await Effect.runPromise(handlers.books.findById({ id: "1" }));
			expect(book).toEqual({ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 });
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

		it("create should add a new entity", async () => {
			const handlers = await Effect.runPromise(
				makeRpcHandlers(singleCollectionConfig, {
					books: initialBooks,
				}),
			);

			const newBook = await Effect.runPromise(
				handlers.books.create({
					data: { id: "3", title: "Snow Crash", author: "Neal Stephenson", year: 1992 },
				}),
			);

			expect(newBook.id).toBe("3");
			expect(newBook.title).toBe("Snow Crash");

			// Verify it was added
			const found = await Effect.runPromise(handlers.books.findById({ id: "3" }));
			expect(found.title).toBe("Snow Crash");
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
				Effect.either(handlers.books.update({
					id: "nonexistent",
					updates: { year: 2000 },
				})),
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

			const deleted = await Effect.runPromise(handlers.books.delete({ id: "1" }));
			expect(deleted.id).toBe("1");

			// Verify it was removed
			const result = await Effect.runPromise(
				Effect.either(handlers.books.findById({ id: "1" })),
			);
			expect(result._tag).toBe("Left");
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
});

describe("makeRpcHandlersLayer", () => {
	it("should create a layer with DatabaseContext", async () => {
		const layer = makeRpcHandlersLayer(singleCollectionConfig, {
			books: initialBooks,
		});

		const DatabaseContextTag = makeDatabaseContextTag<typeof singleCollectionConfig>();

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
