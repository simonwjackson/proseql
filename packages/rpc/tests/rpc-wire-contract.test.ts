import { Effect, Option, Queue, Schema, Stream } from "effect";
import {
	RpcClient,
	type RpcMessage,
	RpcSerialization,
	RpcServer,
} from "effect/unstable/rpc";
import { describe, expect, it } from "vitest";
import { makeRpcGroup } from "../src/index.js";
import { makeRpcHandlers } from "../src/server.js";

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	year: Schema.Number,
});
const config = { books: { schema: BookSchema, relationships: {} } } as const;

type ClientDelivery = {
	readonly clientId: number;
	readonly message: RpcMessage.FromClientEncoded;
};
type ServerDelivery = {
	readonly clientId: number;
	readonly message: RpcMessage.FromServerEncoded;
};

const jsonRoundTrip = <A>(
	parser: RpcSerialization.Parser,
	value: A,
	frames: Array<string>,
): A => {
	const encoded = parser.encode(value);
	if (encoded === undefined)
		throw new Error("JSON transport produced no frame");
	frames.push(
		typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded),
	);
	const [decoded] = parser.decode(encoded);
	return decoded as A;
};

const makeSerializedTransport = Effect.gen(function* () {
	const clientToServer = yield* Queue.unbounded<ClientDelivery>();
	const serverToClient = yield* Queue.unbounded<ServerDelivery>();
	const disconnects = yield* Queue.unbounded<number>();
	const clientFrames: Array<string> = [];
	const serverFrames: Array<string> = [];
	const clientParser = RpcSerialization.json.makeUnsafe();
	const serverParser = RpcSerialization.json.makeUnsafe();

	const serverProtocol = RpcServer.Protocol.of({
		run: (receive) =>
			Effect.forever(
				Effect.flatMap(Queue.take(clientToServer), ({ clientId, message }) =>
					receive(clientId, message),
				),
			),
		disconnects,
		send: (clientId, message) =>
			Queue.offer(serverToClient, {
				clientId,
				message: jsonRoundTrip(serverParser, message, serverFrames),
			}),
		end: () => Effect.void,
		initialMessage: Effect.succeed(Option.none()),
		supportsAck: true,
		supportsTransferables: false,
		supportsSpanPropagation: false,
	});
	const clientProtocol = RpcClient.Protocol.of({
		run: (clientId, receive) =>
			Effect.forever(
				Effect.flatMap(Queue.take(serverToClient), (delivery) =>
					delivery.clientId === clientId
						? receive(delivery.message)
						: Effect.void,
				),
			),
		send: (clientId, message) =>
			Queue.offer(clientToServer, {
				clientId,
				message: jsonRoundTrip(clientParser, message, clientFrames),
			}),
		supportsAck: true,
		supportsTransferables: false,
	});
	return {
		clientFrames,
		clientProtocol,
		serverFrames,
		serverProtocol,
	} as const;
});

describe("serialized RPC wire contract", () => {
	it("JSON-encodes and decodes normal calls, typed failures, and stream chunks", async () => {
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const group = makeRpcGroup(config);
					const transport = yield* makeSerializedTransport;
					yield* RpcServer.make(group).pipe(
						Effect.provide(
							makeRpcHandlers(config, {
								books: [
									{ id: "1", title: "Dune", year: 1965 },
									{ id: "2", title: "Neuromancer", year: 1984 },
								],
							}),
						),
						Effect.provideService(RpcServer.Protocol, transport.serverProtocol),
						Effect.forkScoped,
					);
					const client = yield* RpcClient.make(group).pipe(
						Effect.provideService(RpcClient.Protocol, transport.clientProtocol),
					);
					const created = yield* client["books.create"]({
						data: { id: "3", title: "Snow Crash", year: 1992 },
					});
					const failure = yield* client["books.findById"]({
						id: "missing",
					}).pipe(Effect.catchTag("NotFoundError", Effect.succeed));
					const streamed = yield* Stream.runCollect(
						client["books.queryStream"]({ sort: { year: "asc" } }),
					);
					return { created, failure, streamed, transport };
				}),
			),
		);

		expect(result.created.title).toBe("Snow Crash");
		expect(result.failure._tag).toBe("NotFoundError");
		expect(result.failure.id).toBe("missing");
		expect(result.streamed.map((row) => row.id)).toEqual(["1", "2", "3"]);
		expect(
			result.transport.clientFrames.some((frame) =>
				frame.includes('"tag":"books.create"'),
			),
		).toBe(true);
		expect(
			result.transport.clientFrames.some((frame) =>
				frame.includes('"tag":"books.queryStream"'),
			),
		).toBe(true);
		expect(
			result.transport.serverFrames.some((frame) =>
				frame.includes('"_tag":"NotFoundError"'),
			),
		).toBe(true);
		expect(
			result.transport.serverFrames.some((frame) =>
				frame.includes('"_tag":"Chunk"'),
			),
		).toBe(true);
	});
});
