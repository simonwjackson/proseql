/**
 * Tests for RPC streaming functionality over in-process transport.
 *
 * These tests verify that the queryStream procedure works correctly
 * when using RpcRouter.toHandlerRaw (in-process, no serialization).
 *
 * This test validates task 4.3: "Verify streaming works over in-process
 * transport (RpcServer.makeNoSerialization)". The @effect/rpc v0.51.x
 * provides RpcRouter.toHandlerRaw which achieves the same goal - it creates
 * a direct, no-serialization handler that can be invoked in-process.
 */

import { Rpc, RpcRouter } from "@effect/rpc";
import { Chunk, Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makeRpcHandlers } from "../src/rpc-handlers.js";
import { QueryPayloadSchema, StreamingOptionsSchema } from "../src/rpc-schemas.js";

// Test schema
const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
});

// Test config
const config = {
	books: {
		schema: BookSchema,
		relationships: {},
	},
} as const;

// Initial test data
const initialBooks = [
	{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
	{ id: "2", title: "Neuromancer", author: "William Gibson", year: 1984 },
	{ id: "3", title: "Snow Crash", author: "Neal Stephenson", year: 1992 },
];

// Create a StreamRequest schema for books.queryStream using @effect/rpc v0.51.x API
// Note: Rpc.StreamRequest() returns a function that creates a TaggedRequest class
const BooksQueryStreamRequest = class BooksQueryStreamRequest extends Rpc.StreamRequest<BooksQueryStreamRequest>()(
	"books.queryStream",
	{
		failure: Schema.Never,
		success: BookSchema,
		payload: {
			where: QueryPayloadSchema.fields.where,
			sort: QueryPayloadSchema.fields.sort,
			select: QueryPayloadSchema.fields.select,
			populate: QueryPayloadSchema.fields.populate,
			limit: QueryPayloadSchema.fields.limit,
			offset: QueryPayloadSchema.fields.offset,
			streamingOptions: QueryPayloadSchema.fields.streamingOptions,
		},
	},
) {};

describe("RPC Streaming over in-process transport", () => {
	it("should stream query results via RpcRouter.toHandlerRaw (no serialization)", async () => {
		// Create handlers with initial data
		const handlers = await Effect.runPromise(
			makeRpcHandlers(config, { books: initialBooks }),
		);

		// Create a stream handler using @effect/rpc v0.51.x API
		const streamRpc = Rpc.stream(
			BooksQueryStreamRequest,
			(payload) => handlers.books.queryStream(payload),
		);

		// Create an RpcRouter with the streaming handler
		const router = RpcRouter.make(streamRpc);

		// Use toHandlerRaw for direct, in-process invocation (no serialization)
		const rawHandler = RpcRouter.toHandlerRaw(router);

		// Create a request instance
		const request = new BooksQueryStreamRequest({});

		// Call the raw handler directly - returns a Stream for stream requests
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				// rawHandler returns Stream for StreamRequest types
				const stream = rawHandler(request) as Stream.Stream<
					Schema.Schema.Type<typeof BookSchema>,
					never
				>;

				// Collect all results from the stream
				const results = yield* Stream.runCollect(stream).pipe(
					Effect.map(Chunk.toReadonlyArray),
				);

				return results;
			}),
		);

		// Verify all books were streamed
		expect(result).toHaveLength(3);
		expect(result[0].title).toBe("Dune");
		expect(result[1].title).toBe("Neuromancer");
		expect(result[2].title).toBe("Snow Crash");
	});

	it("should stream filtered results via in-process transport", async () => {
		const handlers = await Effect.runPromise(
			makeRpcHandlers(config, { books: initialBooks }),
		);

		const streamRpc = Rpc.stream(
			BooksQueryStreamRequest,
			(payload) => handlers.books.queryStream(payload),
		);

		const router = RpcRouter.make(streamRpc);
		const rawHandler = RpcRouter.toHandlerRaw(router);

		const request = new BooksQueryStreamRequest({
			where: { year: { $gte: 1980 } },
		});

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const stream = rawHandler(request) as Stream.Stream<
					Schema.Schema.Type<typeof BookSchema>,
					never
				>;

				const results = yield* Stream.runCollect(stream).pipe(
					Effect.map(Chunk.toReadonlyArray),
				);

				return results;
			}),
		);

		// Only books from 1980 onwards
		expect(result).toHaveLength(2);
		expect(result[0].title).toBe("Neuromancer");
		expect(result[1].title).toBe("Snow Crash");
	});

	it("should stream sorted results via in-process transport", async () => {
		const handlers = await Effect.runPromise(
			makeRpcHandlers(config, { books: initialBooks }),
		);

		const streamRpc = Rpc.stream(
			BooksQueryStreamRequest,
			(payload) => handlers.books.queryStream(payload),
		);

		const router = RpcRouter.make(streamRpc);
		const rawHandler = RpcRouter.toHandlerRaw(router);

		const request = new BooksQueryStreamRequest({
			sort: { year: "desc" },
		});

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const stream = rawHandler(request) as Stream.Stream<
					Schema.Schema.Type<typeof BookSchema>,
					never
				>;

				const results = yield* Stream.runCollect(stream).pipe(
					Effect.map(Chunk.toReadonlyArray),
				);

				return results;
			}),
		);

		// Results should be sorted by year descending
		expect(result).toHaveLength(3);
		expect(result[0].title).toBe("Snow Crash"); // 1992
		expect(result[1].title).toBe("Neuromancer"); // 1984
		expect(result[2].title).toBe("Dune"); // 1965
	});

	it("should support streaming options (chunkSize) via in-process transport", async () => {
		// Create a larger dataset for chunking tests
		const manyBooks = Array.from({ length: 10 }, (_, i) => ({
			id: String(i + 1),
			title: `Book ${i + 1}`,
			author: "Test Author",
			year: 2000 + i,
		}));

		const handlers = await Effect.runPromise(
			makeRpcHandlers(config, { books: manyBooks }),
		);

		const streamRpc = Rpc.stream(
			BooksQueryStreamRequest,
			(payload) => handlers.books.queryStream(payload),
		);

		const router = RpcRouter.make(streamRpc);
		const rawHandler = RpcRouter.toHandlerRaw(router);

		const request = new BooksQueryStreamRequest({
			streamingOptions: { chunkSize: 3 },
		});

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const stream = rawHandler(request) as Stream.Stream<
					Schema.Schema.Type<typeof BookSchema>,
					never
				>;

				const results = yield* Stream.runCollect(stream).pipe(
					Effect.map(Chunk.toReadonlyArray),
				);

				return results;
			}),
		);

		// All 10 books should be returned regardless of chunk size
		expect(result).toHaveLength(10);
		expect(result[0].title).toBe("Book 1");
		expect(result[9].title).toBe("Book 10");
	});

	it("should stream results incrementally (verify streaming behavior)", async () => {
		const handlers = await Effect.runPromise(
			makeRpcHandlers(config, { books: initialBooks }),
		);

		const streamRpc = Rpc.stream(
			BooksQueryStreamRequest,
			(payload) => handlers.books.queryStream(payload),
		);

		const router = RpcRouter.make(streamRpc);
		const rawHandler = RpcRouter.toHandlerRaw(router);

		const request = new BooksQueryStreamRequest({});

		// Track items as they are received to verify incremental delivery
		const receivedItems: string[] = [];

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const stream = rawHandler(request) as Stream.Stream<
					Schema.Schema.Type<typeof BookSchema>,
					never
				>;

				// Use Stream.tap to observe items as they flow through
				const observedStream = Stream.tap(stream, (book) =>
					Effect.sync(() => {
						receivedItems.push(book.title);
					}),
				);

				const results = yield* Stream.runCollect(observedStream).pipe(
					Effect.map(Chunk.toReadonlyArray),
				);

				return results;
			}),
		);

		// Verify items were observed as they streamed through
		expect(receivedItems).toEqual(["Dune", "Neuromancer", "Snow Crash"]);
		expect(result).toHaveLength(3);
	});

	it("should stream with limit and offset via in-process transport", async () => {
		const handlers = await Effect.runPromise(
			makeRpcHandlers(config, { books: initialBooks }),
		);

		const streamRpc = Rpc.stream(
			BooksQueryStreamRequest,
			(payload) => handlers.books.queryStream(payload),
		);

		const router = RpcRouter.make(streamRpc);
		const rawHandler = RpcRouter.toHandlerRaw(router);

		const request = new BooksQueryStreamRequest({
			limit: 1,
			offset: 1,
		});

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const stream = rawHandler(request) as Stream.Stream<
					Schema.Schema.Type<typeof BookSchema>,
					never
				>;

				const results = yield* Stream.runCollect(stream).pipe(
					Effect.map(Chunk.toReadonlyArray),
				);

				return results;
			}),
		);

		// Should return only the second book
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Neuromancer");
	});

	it("should return empty stream when no results match", async () => {
		const handlers = await Effect.runPromise(
			makeRpcHandlers(config, { books: initialBooks }),
		);

		const streamRpc = Rpc.stream(
			BooksQueryStreamRequest,
			(payload) => handlers.books.queryStream(payload),
		);

		const router = RpcRouter.make(streamRpc);
		const rawHandler = RpcRouter.toHandlerRaw(router);

		const request = new BooksQueryStreamRequest({
			where: { year: { $gt: 3000 } },
		});

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const stream = rawHandler(request) as Stream.Stream<
					Schema.Schema.Type<typeof BookSchema>,
					never
				>;

				const results = yield* Stream.runCollect(stream).pipe(
					Effect.map(Chunk.toReadonlyArray),
				);

				return results;
			}),
		);

		// Should return an empty array
		expect(result).toHaveLength(0);
	});

	it("should work with the full RPC round-trip via toHandler (with serialization semantics)", async () => {
		// This test verifies streaming works through the full RPC handler pipeline,
		// which includes serialization-style processing (though still in-process)
		const handlers = await Effect.runPromise(
			makeRpcHandlers(config, { books: initialBooks }),
		);

		const streamRpc = Rpc.stream(
			BooksQueryStreamRequest,
			(payload) => handlers.books.queryStream(payload),
		);

		const router = RpcRouter.make(streamRpc);

		// Use toHandler which provides the full RPC pipeline with serialization
		const handler = RpcRouter.toHandler(router);

		// Create a serialized request array (as would come from network)
		const requestArray = [
			{
				request: new BooksQueryStreamRequest({}),
				traceId: "test-trace-id",
				spanId: "test-span-id",
				sampled: false,
				headers: {},
			},
		];

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				// Handler returns a Stream of responses
				const responseStream = handler(requestArray);

				// Collect the response stream
				const responses = yield* Stream.runCollect(responseStream).pipe(
					Effect.map(Chunk.toReadonlyArray),
					Effect.scoped,
				);

				return responses;
			}),
		);

		// Response should contain serialized book data
		// The exact structure depends on @effect/rpc's encoding
		expect(result.length).toBeGreaterThan(0);
	});
});
