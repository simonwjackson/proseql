import { Effect, Option, Queue, Schema, Stream } from "effect";
import {
	Rpc,
	RpcClient,
	RpcGroup,
	type RpcMessage,
	RpcSerialization,
	RpcServer,
} from "effect/unstable/rpc";
import { describe, expect, it } from "vitest";
import { makeCollectionRpcs, makeRpcGroup } from "../src/index.js";
import { makeRpcHandlers } from "../src/server.js";

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	year: Schema.Number,
});
const config = {
	books: {
		schema: BookSchema,
		uniqueFields: ["title"],
		relationships: {},
	},
} as const;

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
	it.each([
		"create",
		"createMany",
		"update",
		"upsert",
		"upsertMany",
	] as const)("encodes OperationError from %s instead of failing the RPC schema", (operation) => {
		const definitions = makeCollectionRpcs("books", BookSchema);
		const rpc = definitions[operation];
		const encoded = Schema.encodeUnknownSync(rpc.errorSchema)({
			_tag: "OperationError",
			operation,
			reason: "read-only-source",
			message: "Collection is read-only",
		});
		expect(encoded).toMatchObject({
			_tag: "OperationError",
			operation,
			reason: "read-only-source",
		});
	});

	it("encodes every declared CRUD, relationship, hook, and query failure", () => {
		const definitions = makeCollectionRpcs("books", BookSchema);
		const cases = [
			[
				definitions.create.errorSchema,
				{
					_tag: "ForeignKeyError",
					collection: "books",
					field: "authorId",
					value: "missing",
					targetCollection: "authors",
					message: "Missing author",
				},
			],
			[
				definitions.create.errorSchema,
				{
					_tag: "HookError",
					hook: "beforeCreate",
					collection: "books",
					operation: "create",
					reason: "denied",
					message: "Denied",
				},
			],
			[
				definitions.create.errorSchema,
				{
					_tag: "UniqueConstraintError",
					collection: "books",
					constraint: "unique_title",
					fields: ["title"],
					values: { title: "Dune" },
					existingId: "1",
					message: "Duplicate title",
				},
			],
			[
				definitions.query.errorSchema,
				{
					_tag: "DanglingReferenceError",
					collection: "books",
					field: "authorId",
					targetId: "missing",
					message: "Dangling author",
				},
			],
			[
				definitions.query.errorSchema,
				{
					_tag: "PopulationError",
					collection: "books",
					relationship: "author",
					message: "Population failed",
					cause: { code: "missing" },
				},
			],
		] as const;

		for (const [schema, failure] of cases) {
			const encoded = Schema.encodeUnknownSync(schema)(failure);
			expect(encoded).toMatchObject({ _tag: failure._tag });
		}
	});

	it("serializes relationship, hook, operation, and population failures end to end", async () => {
		const definitions = makeCollectionRpcs("books", BookSchema);
		const group = RpcGroup.make(definitions.create, definitions.query);
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const transport = yield* makeSerializedTransport;
					yield* RpcServer.make(group).pipe(
						Effect.provide(
							group.toLayer({
								"books.create": ({ data }) => {
									if (data.id === "foreign")
										return Effect.fail({
											_tag: "ForeignKeyError" as const,
											collection: "books",
											field: "authorId",
											value: "missing",
											targetCollection: "authors",
											message: "Missing author",
										});
									if (data.id === "hook")
										return Effect.fail({
											_tag: "HookError" as const,
											hook: "beforeCreate",
											collection: "books",
											operation: "create" as const,
											reason: "denied",
											message: "Denied",
										});
									return Effect.fail({
										_tag: "OperationError" as const,
										operation: "create",
										reason: "read-only-source",
										message: "Read only",
									});
								},
								"books.query": () =>
									Effect.fail({
										_tag: "PopulationError" as const,
										collection: "books",
										relationship: "author",
										message: "Population failed",
									}),
							}),
						),
						Effect.provideService(RpcServer.Protocol, transport.serverProtocol),
						Effect.forkScoped,
					);
					const client = yield* RpcClient.make(group).pipe(
						Effect.provideService(RpcClient.Protocol, transport.clientProtocol),
					);
					const foreign = yield* client["books.create"]({
						data: { id: "foreign", title: "Foreign", year: 1 },
					}).pipe(Effect.catchTag("ForeignKeyError", Effect.succeed));
					const hook = yield* client["books.create"]({
						data: { id: "hook", title: "Hook", year: 1 },
					}).pipe(Effect.catchTag("HookError", Effect.succeed));
					const operation = yield* client["books.create"]({
						data: { id: "operation", title: "Operation", year: 1 },
					}).pipe(Effect.catchTag("OperationError", Effect.succeed));
					const population = yield* client["books.query"]({}).pipe(
						Effect.catchTag("PopulationError", Effect.succeed),
					);
					return { foreign, hook, operation, population, transport };
				}),
			),
		);

		expect(result.foreign._tag).toBe("ForeignKeyError");
		expect(result.hook._tag).toBe("HookError");
		expect(result.operation._tag).toBe("OperationError");
		expect(result.population._tag).toBe("PopulationError");
		for (const tag of [
			"ForeignKeyError",
			"HookError",
			"OperationError",
			"PopulationError",
		]) {
			expect(
				result.transport.serverFrames.some((frame) =>
					frame.includes(`"_tag":"${tag}"`),
				),
			).toBe(true);
		}
	});

	it("validates full entity results while preserving shape-changing query rows", () => {
		const definitions = makeCollectionRpcs("books", BookSchema);
		expect(() =>
			Schema.encodeUnknownSync(definitions.createMany.successSchema)({
				created: [{ id: "1", title: "Missing year" }],
			}),
		).toThrow();
		const selected = Schema.encodeUnknownSync(definitions.query.successSchema)([
			{ title: "Dune" },
		]);
		expect(selected).toEqual([{ title: "Dune" }]);
	});

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
					const validation = yield* client["books.create"]({
						data: { id: "invalid", title: "Incomplete" },
					}).pipe(Effect.catchTag("ValidationError", Effect.succeed));
					const duplicate = yield* client["books.create"]({
						data: { id: "3", title: "Different", year: 2000 },
					}).pipe(Effect.catchTag("DuplicateKeyError", Effect.succeed));
					const unique = yield* client["books.create"]({
						data: { id: "unique", title: "Dune", year: 2001 },
					}).pipe(Effect.catchTag("UniqueConstraintError", Effect.succeed));
					const selected = yield* client["books.query"]({
						select: ["title"],
						sort: { year: "asc" },
						limit: 1,
					});
					const updated = yield* client["books.update"]({
						id: "3",
						updates: { year: 1993 },
					});
					const manyCreated = yield* client["books.createMany"]({
						data: [{ id: "4", title: "Emma", year: 1815 }],
					});
					const manyUpdated = yield* client["books.updateMany"]({
						where: { year: { $lt: 1900 } },
						updates: { year: 1900 },
					});
					const aggregate = yield* client["books.aggregate"]({
						count: true,
						max: "year",
					});
					const upserted = yield* client["books.upsert"]({
						where: { id: "5" },
						create: { id: "5", title: "Beloved", year: 1987 },
						update: { year: 1988 },
					});
					const manyUpserted = yield* client["books.upsertMany"]({
						data: [
							{
								where: { id: "5" },
								create: { id: "5", title: "Beloved", year: 1987 },
								update: { year: 1988 },
							},
							{
								where: { id: "6" },
								create: { id: "6", title: "Kindred", year: 1979 },
								update: {},
							},
						],
					});
					const manyDeleted = yield* client["books.deleteMany"]({
						where: { id: "6" },
					});
					const deleted = yield* client["books.delete"]({ id: "4" });
					const invalidQuery = yield* client["books.query"]({
						where: { year: { $regex: "19" } },
					}).pipe(Effect.catchTag("InvalidRpcRequestError", Effect.succeed));
					const failure = yield* client["books.findById"]({
						id: "missing",
					}).pipe(Effect.catchTag("NotFoundError", Effect.succeed));
					const streamed = yield* Stream.runCollect(
						client["books.queryStream"]({ sort: { year: "asc" } }),
					);
					return {
						aggregate,
						created,
						deleted,
						duplicate,
						failure,
						invalidQuery,
						manyCreated,
						manyDeleted,
						manyUpdated,
						manyUpserted,
						selected,
						streamed,
						transport,
						unique,
						updated,
						upserted,
						validation,
					};
				}),
			),
		);

		expect(result.created.title).toBe("Snow Crash");
		expect(result.validation._tag).toBe("ValidationError");
		expect(result.duplicate._tag).toBe("DuplicateKeyError");
		expect(result.unique._tag).toBe("UniqueConstraintError");
		expect(result.selected).toEqual([{ title: "Dune" }]);
		expect(result.updated.year).toBe(1993);
		expect(result.manyCreated.created).toHaveLength(1);
		expect(result.manyUpdated.updated).toHaveLength(1);
		expect(Array.isArray(result.aggregate)).toBe(false);
		expect(result.upserted.__action).toBe("created");
		expect(result.manyUpserted.created).toHaveLength(1);
		expect(result.manyUpserted.updated).toHaveLength(1);
		expect(result.manyDeleted.count).toBe(1);
		expect(result.deleted.id).toBe("4");
		expect(result.invalidQuery._tag).toBe("InvalidRpcRequestError");
		expect(result.failure._tag).toBe("NotFoundError");
		expect(result.failure.id).toBe("missing");
		expect(result.streamed.map((row) => row.id)).toEqual(["1", "2", "5", "3"]);
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

	it("interrupts and finalizes the serialized server stream when the client stops", async () => {
		let emitted = 0;
		let finalized = 0;
		const cancellable = Rpc.make("test.cancellable", {
			payload: {},
			success: Schema.Number,
			stream: true,
		});
		const group = RpcGroup.make(cancellable);
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const transport = yield* makeSerializedTransport;
					const stream = Stream.unfold(0, (index) =>
						Effect.sync(() => {
							if (index >= 1_000) return undefined;
							emitted += 1;
							return [index, index + 1] as const;
						}),
					).pipe(
						Stream.ensuring(
							Effect.sync(() => {
								finalized += 1;
							}),
						),
					);
					yield* RpcServer.make(group).pipe(
						Effect.provide(group.toLayer({ "test.cancellable": () => stream })),
						Effect.provideService(RpcServer.Protocol, transport.serverProtocol),
						Effect.forkScoped,
					);
					const client = yield* RpcClient.make(group).pipe(
						Effect.provideService(RpcClient.Protocol, transport.clientProtocol),
					);
					const rows = yield* Stream.runCollect(
						Stream.take(client["test.cancellable"]({}), 1),
					);
					yield* Effect.yieldNow;
					return rows;
				}),
			),
		);

		expect(result).toEqual([0]);
		expect(finalized).toBe(1);
		expect(emitted).toBeLessThan(1_000);
	});
});
