import { Effect, Schema, Stream } from "effect";
import { RpcTest } from "effect/unstable/rpc";
import { describe, expect, it } from "vitest";
import { makeRpcGroup } from "../src/index.js";
import { makeRpcHandlers } from "../src/server.js";

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	year: Schema.Number,
});
const config = { books: { schema: BookSchema, relationships: {} } } as const;
const books = [
	{ id: "1", title: "Dune", year: 1965 },
	{ id: "2", title: "Neuromancer", year: 1984 },
	{ id: "3", title: "Snow Crash", year: 1992 },
];

const run = <A>(
	use: (
		client: Effect.Success<ReturnType<typeof RpcTest.makeClient>>,
	) => Effect.Effect<A, unknown>,
) =>
	Effect.runPromise(
		Effect.scoped(
			Effect.flatMap(RpcTest.makeClient(makeRpcGroup(config)), use).pipe(
				Effect.provide(makeRpcHandlers(config, { books })),
			),
		),
	);

describe("streaming RPC", () => {
	it("streams filtered rows in database order", async () => {
		const rows = await run((client) =>
			Stream.runCollect(
				client["books.queryStream"]({ where: { year: { $gte: 1980 } } }),
			),
		);
		expect(rows.map((row) => row.title)).toEqual(["Neuromancer", "Snow Crash"]);
	});

	it("supports client interruption without buffering the full result", async () => {
		const rows = await run((client) =>
			Stream.runCollect(Stream.take(client["books.queryStream"]({}), 1)),
		);
		expect(rows.map((row) => row.id)).toEqual(["1"]);
	});

	it("reports pre-execution stream failures instead of a successful end", async () => {
		const error = await run((client) =>
			Stream.runCollect(
				client["books.queryStream"]({
					cursor: { key: "year", limit: 1 },
				}),
			).pipe(Effect.catchTag("InvalidRpcRequestError", Effect.succeed)),
		);
		expect(error._tag).toBe("InvalidRpcRequestError");
		expect(error.operation).toBe("books.queryStream");
	});
});
