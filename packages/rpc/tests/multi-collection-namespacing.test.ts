import { Effect, Schema } from "effect";
import { RpcTest } from "effect/unstable/rpc";
import { describe, expect, it } from "vitest";
import { makeRpcGroup } from "../src/index.js";
import { makeRpcHandlers } from "../src/server.js";

const ItemSchema = Schema.Struct({ id: Schema.String, name: Schema.String });
const config = {
	books: { schema: ItemSchema, relationships: {} },
	authors: { schema: ItemSchema, relationships: {} },
} as const;

describe("multi-collection RPC namespacing", () => {
	it("routes equal operations to their collection-qualified handlers", async () => {
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const client = yield* RpcTest.makeClient(makeRpcGroup(config));
					const [book, author] = yield* Effect.all(
						[
							client["books.findById"]({ id: "same" }),
							client["authors.findById"]({ id: "same" }),
						],
						{ concurrency: "unbounded" },
					);
					return { book, author };
				}).pipe(
					Effect.provide(
						makeRpcHandlers(config, {
							books: [{ id: "same", name: "Dune" }],
							authors: [{ id: "same", name: "Frank Herbert" }],
						}),
					),
				),
			),
		);
		expect(result.book.name).toBe("Dune");
		expect(result.author.name).toBe("Frank Herbert");
	});

	it("keeps simultaneous clients and collection state distinct", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const group = makeRpcGroup(config);
					const first = yield* RpcTest.makeClient(group);
					const second = yield* RpcTest.makeClient(group);
					yield* Effect.all(
						[
							first["books.create"]({
								data: { id: "b2", name: "Neuromancer" },
							}),
							second["authors.create"]({
								data: { id: "a2", name: "William Gibson" },
							}),
						],
						{ concurrency: "unbounded" },
					);
					expect((yield* second["books.findById"]({ id: "b2" })).name).toBe(
						"Neuromancer",
					);
					expect((yield* first["authors.findById"]({ id: "a2" })).name).toBe(
						"William Gibson",
					);
				}).pipe(
					Effect.provide(makeRpcHandlers(config, { books: [], authors: [] })),
				),
			),
		);
	});
});
