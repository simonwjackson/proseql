import { OperationError, type ProseQLPlugin } from "@proseql/core";
import { createEffectDatabase } from "@proseql/effect";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { RpcTest } from "effect/unstable/rpc";
import { describe, expect, it } from "vitest";
import { makeRpcGroup } from "../src/index.js";
import { makeRpcHandlers, makeRpcHandlersFromDatabase } from "../src/server.js";

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	genre: Schema.String,
});
const config = { books: { schema: BookSchema, relationships: {} } } as const;
type BookRpcClient = Effect.Success<
	ReturnType<
		typeof RpcTest.makeClient<
			ReturnType<
				typeof makeRpcGroup<typeof config>
			> extends import("effect/unstable/rpc").RpcGroup.RpcGroup<infer Rpcs>
				? Rpcs
				: never
		>
	>
>;

const books = [
	{ id: "b1", title: "Dune", author: "Frank Herbert", year: 1965, genre: "sf" },
	{
		id: "b2",
		title: "Neuromancer",
		author: "William Gibson",
		year: 1984,
		genre: "sf",
	},
	{
		id: "b3",
		title: "Pride and Prejudice",
		author: "Jane Austen",
		year: 1813,
		genre: "classic",
	},
];

const withClient = <A>(
	initialData: { readonly books: ReadonlyArray<(typeof books)[number]> },
	use: (client: BookRpcClient) => Effect.Effect<A, unknown>,
) =>
	Effect.runPromise(
		Effect.scoped(
			Effect.flatMap(RpcTest.makeClient(makeRpcGroup(config)), use).pipe(
				Effect.provide(makeRpcHandlers(config, initialData)),
			),
		),
	);

describe("WASM-backed RPC handlers", () => {
	it("executes ordinary, bulk, upsert, aggregate, and collected query operations", async () => {
		await withClient({ books: [] }, (client) =>
			Effect.gen(function* () {
				const created = yield* client["books.create"]({
					data: {
						id: "b1",
						title: "Dune",
						author: "Frank Herbert",
						year: 1965,
						genre: "sf",
					},
				});
				expect(created.title).toBe("Dune");
				yield* client["books.createMany"]({ data: books.slice(1) });
				expect((yield* client["books.findById"]({ id: "b2" })).title).toBe(
					"Neuromancer",
				);

				const queried = yield* client["books.query"]({
					where: { year: { $gte: 1900 }, genre: { $in: ["sf"] } },
					sort: { year: "desc" },
				});
				expect(Array.isArray(queried) && queried.map((row) => row.id)).toEqual([
					"b2",
					"b1",
				]);

				const updated = yield* client["books.update"]({
					id: "b1",
					updates: { year: 1966 },
				});
				expect(updated.year).toBe(1966);
				const bulkUpdated = yield* client["books.updateMany"]({
					where: {
						$or: [
							{ year: { $lt: 1900 } },
							{ author: { $startsWith: "William" } },
						],
					},
					updates: { genre: "featured" },
				});
				expect(bulkUpdated.count).toBe(2);

				const aggregate = yield* client["books.aggregate"]({
					count: true,
					avg: "year",
				});
				expect(Array.isArray(aggregate)).toBe(false);
				if (!Array.isArray(aggregate)) expect(aggregate.count).toBe(3);

				const createdUpsert = yield* client["books.upsert"]({
					where: { id: "b4" },
					create: {
						id: "b4",
						title: "Pattern Recognition",
						author: "William Gibson",
						year: 2003,
						genre: "sf",
					},
					update: { year: 2004 },
				});
				expect(createdUpsert.__action).toBe("created");
				const many = yield* client["books.upsertMany"]({
					data: [
						{
							where: { id: "b4" },
							create: createdUpsert,
							update: { year: 2004 },
						},
						{
							where: { id: "b5" },
							create: {
								id: "b5",
								title: "Emma",
								author: "Jane Austen",
								year: 1815,
								genre: "classic",
							},
							update: {},
						},
					],
				});
				expect(many.updated).toHaveLength(1);
				expect(many.created).toHaveLength(1);

				const deletedMany = yield* client["books.deleteMany"]({
					where: { id: { $in: ["b3", "b5"] } },
					options: { limit: 1 },
				});
				expect(deletedMany.count).toBe(1);
				expect((yield* client["books.delete"]({ id: "b1" })).id).toBe("b1");
			}),
		);
	});

	it("preserves typed validation and not-found failures at the public client", async () => {
		await withClient({ books }, (client) =>
			Effect.gen(function* () {
				const notFound = yield* client["books.findById"]({
					id: "missing",
				}).pipe(
					Effect.catchTag("NotFoundError", (error) => Effect.succeed(error)),
				);
				expect(notFound._tag).toBe("NotFoundError");
				expect(notFound.id).toBe("missing");

				const validation = yield* client["books.create"]({
					data: { id: "invalid", title: "Incomplete" },
				}).pipe(
					Effect.catchTag("ValidationError", (error) => Effect.succeed(error)),
				);
				expect(validation._tag).toBe("ValidationError");
				expect(validation.issues.length).toBeGreaterThan(0);
			}),
		);
	});

	it("matches direct query shapes for select, populate, search, sort, pagination, and cursor pages", async () => {
		const AuthorSchema = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
		});
		const RelatedBookSchema = Schema.Struct({
			id: Schema.String,
			title: Schema.String,
			authorId: Schema.String,
			year: Schema.Number,
		});
		const relatedConfig = {
			books: {
				schema: RelatedBookSchema,
				relationships: {
					author: {
						type: "ref" as const,
						target: "authors" as const,
						foreignKey: "authorId",
					},
				},
			},
			authors: { schema: AuthorSchema, relationships: {} },
		} as const;
		const initial = {
			books: [
				{ id: "1", title: "Dune", authorId: "a1", year: 1965 },
				{ id: "2", title: "Neuromancer", authorId: "a2", year: 1984 },
				{ id: "3", title: "Children of Dune", authorId: "a1", year: 1976 },
			],
			authors: [
				{ id: "a1", name: "Frank Herbert" },
				{ id: "a2", name: "William Gibson" },
			],
		};
		await Effect.runPromise(
			Effect.gen(function* () {
				const db = yield* createEffectDatabase(relatedConfig, initial);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcTest.makeClient(
							makeRpcGroup(relatedConfig),
						);
						const cases = [
							{},
							{ select: ["title"] },
							{ populate: { author: true } },
							{ where: { $search: { query: "dune", fields: ["title"] } } },
							{ sort: { year: "desc" as const } },
							{ sort: { year: "asc" as const }, limit: 1, offset: 1 },
						] as const;
						for (const query of cases) {
							const direct = yield* Effect.promise(
								() => db.books.query(query as never).runPromise,
							);
							const remote = yield* client["books.query"](query);
							expect(remote).toEqual(direct);
						}
						const cursor = {
							cursor: { key: "year", limit: 2 },
							sort: { year: "asc" as const },
						};
						const directPage = yield* Effect.promise(
							() => db.books.query(cursor).runPromise,
						);
						const remotePage = yield* client["books.query"](cursor);
						expect(remotePage).toEqual(directPage);
					}).pipe(
						Effect.provide(makeRpcHandlersFromDatabase(relatedConfig, db)),
					),
				);
			}),
		);
	});

	it("rejects unsupported filters before a bulk mutation", async () => {
		await withClient({ books }, (client) =>
			Effect.gen(function* () {
				const error = yield* client["books.updateMany"]({
					where: { title: { $regex: "Dune" } },
					updates: { genre: "changed" },
				}).pipe(Effect.catchTag("InvalidRpcRequestError", Effect.succeed));
				expect(error._tag).toBe("InvalidRpcRequestError");
				const malformed = yield* client["books.deleteMany"]({
					where: { year: { $in: "not-an-array" } },
				}).pipe(Effect.catchTag("InvalidRpcRequestError", Effect.succeed));
				expect(malformed.path).toBe("where.year.$in");
				const rows = yield* client["books.query"]({});
				expect(
					Array.isArray(rows) && rows.every((row) => row.genre !== "changed"),
				).toBe(true);
			}),
		);
	});

	it("shares mutations with a direct @proseql/effect database", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const db = yield* createEffectDatabase(config, { books: [] });
				yield* Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcTest.makeClient(makeRpcGroup(config));
						yield* client["books.create"]({
							data: {
								id: "shared",
								title: "Shared",
								author: "Author",
								year: 2026,
								genre: "test",
							},
						});
						expect((yield* db.books.findById("shared")).title).toBe("Shared");
					}).pipe(Effect.provide(makeRpcHandlersFromDatabase(config, db))),
				);
			}),
		);
	});

	const lifecyclePlugin = (onShutdown: () => void): ProseQLPlugin => ({
		name: "rpc-owned-database-lifecycle",
		shutdown: () => Effect.sync(onShutdown),
	});

	it("closes an owned database exactly once when its handler scope ends", async () => {
		let shutdowns = 0;
		const incrementShutdowns = () => {
			shutdowns += 1;
		};
		let leakedClient: BookRpcClient | undefined;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					leakedClient = yield* RpcTest.makeClient(makeRpcGroup(config));
					expect((yield* leakedClient["books.query"]({})).length).toBe(3);
				}).pipe(
					Effect.provide(
						makeRpcHandlers(
							config,
							{ books },
							{
								plugins: [lifecyclePlugin(incrementShutdowns)],
							},
						),
					),
				),
			),
		);
		expect(shutdowns).toBe(1);
		if (leakedClient === undefined) throw new Error("client was not acquired");
		const closed = await Effect.runPromiseExit(leakedClient["books.query"]({}));
		expect(closed._tag).toBe("Failure");
		expect(shutdowns).toBe(1);
	});

	it("closes an owned database exactly once when its handler scope is interrupted", async () => {
		let shutdowns = 0;
		const incrementShutdowns = () => {
			shutdowns += 1;
		};
		await Effect.runPromise(
			Effect.gen(function* () {
				const acquired = yield* Deferred.make<void>();
				const fiber = yield* Effect.forkChild(
					Effect.scoped(
						Effect.gen(function* () {
							yield* RpcTest.makeClient(makeRpcGroup(config));
							yield* Deferred.succeed(acquired, undefined);
							yield* Effect.never;
						}).pipe(
							Effect.provide(
								makeRpcHandlers(
									config,
									{ books },
									{
										plugins: [lifecyclePlugin(incrementShutdowns)],
									},
								),
							),
						),
					),
				);
				yield* Deferred.await(acquired);
				yield* Fiber.interrupt(fiber);
			}),
		);
		expect(shutdowns).toBe(1);
	});

	it("closes an owned database exactly once when its handler scope fails", async () => {
		let shutdowns = 0;
		const incrementShutdowns = () => {
			shutdowns += 1;
		};
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* RpcTest.makeClient(makeRpcGroup(config));
					yield* Effect.fail("handler-scope-failed");
				}).pipe(
					Effect.provide(
						makeRpcHandlers(
							config,
							{ books },
							{
								plugins: [lifecyclePlugin(incrementShutdowns)],
							},
						),
					),
					Effect.result,
				),
			),
		);
		expect(result._tag).toBe("Failure");
		expect(shutdowns).toBe(1);
	});

	it("does not close a database borrowed by makeRpcHandlersFromDatabase", async () => {
		let shutdowns = 0;
		const incrementShutdowns = () => {
			shutdowns += 1;
		};
		const db = await Effect.runPromise(
			createEffectDatabase(
				config,
				{ books },
				{
					plugins: [lifecyclePlugin(incrementShutdowns)],
				},
			),
		);
		await Effect.runPromise(
			Effect.scoped(
				RpcTest.makeClient(makeRpcGroup(config)).pipe(
					Effect.flatMap((client) => client["books.findById"]({ id: "b1" })),
					Effect.provide(makeRpcHandlersFromDatabase(config, db)),
				),
			),
		);
		expect(shutdowns).toBe(0);
		expect((await Effect.runPromise(db.books.findById("b1"))).title).toBe(
			"Dune",
		);
		await (db as typeof db & { close: () => Promise<void> }).close();
		expect(shutdowns).toBe(1);
		await expect(
			Effect.runPromise(db.books.findById("b1")),
		).rejects.toBeInstanceOf(OperationError);
	});
});
