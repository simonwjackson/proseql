import { Effect, Layer, Result, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { createPersistentEffectDatabase } from "../src/factories/database-effect.js";
import { jsonCodec } from "../src/serializers/codecs/json.js";
import { makeSerializerLayer } from "../src/serializers/format-codec.js";
import { makeInMemoryStorageLayer } from "../src/storage/in-memory-adapter-layer.js";

const MetadataSchema = Schema.Struct({
	name: Schema.String,
});

const GamePayload = Schema.Struct({
	metadata: Schema.optional(MetadataSchema),
	userId: Schema.optional(Schema.String),
});

const UserPayload = Schema.Struct({
	name: Schema.String,
});

const GameWithIdSchema = Schema.Struct({
	id: Schema.String,
	metadata: Schema.optional(MetadataSchema),
});

const makeLayer = (store: Map<string, string>) =>
	Layer.merge(
		makeInMemoryStorageLayer(store),
		makeSerializerLayer([jsonCodec()]),
	);

describe("derived id persistence", () => {
	it("loads object-keyed payloads without physical id as hydrated runtime records", async () => {
		const store = new Map<string, string>();
		store.set(
			"/data/games.json",
			JSON.stringify({ g1: { metadata: { name: "Default" } } }),
		);

		const config = {
			games: {
				schema: GamePayload,
				file: "/data/games.json",
				id: { kind: "derivedFromKey", field: "id" },
				relationships: {},
			},
		} as const;

		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createPersistentEffectDatabase(config);
					return yield* db.games.findById("g1");
				}).pipe(Effect.provide(makeLayer(store))),
			),
		);

		expect(result).toEqual({
			id: "g1",
			metadata: { name: "Default" },
		});
	});

	it("writes hydrated runtime records without duplicating id in payload", async () => {
		const store = new Map<string, string>();
		const config = {
			games: {
				schema: GamePayload,
				file: "/data/games.json",
				id: { kind: "derivedFromKey", field: "id" },
				relationships: {},
			},
		} as const;

		const created = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createPersistentEffectDatabase(config);
					const game = yield* db.games.create({
						id: "g1",
						metadata: { name: "Default" },
					});
					yield* Effect.promise(() => db.flush());
					return game;
				}).pipe(Effect.provide(makeLayer(store))),
			),
		);

		expect(created.id).toBe("g1");
		expect(created.metadata?.name).toBe("Default");
		const persisted = JSON.parse(store.get("/data/games.json") ?? "{}");
		expect(persisted).toEqual({
			g1: { metadata: { name: "Default" } },
		});
		expect("id" in persisted.g1).toBe(false);
	});

	it("generates runtime ids and persists them only as object keys", async () => {
		const store = new Map<string, string>();
		const config = {
			games: {
				schema: GamePayload,
				file: "/data/games.json",
				id: { kind: "derivedFromKey", field: "id" },
				relationships: {},
			},
		} as const;

		const created = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createPersistentEffectDatabase(config);
					const game = yield* db.games.create({
						metadata: { name: "Generated" },
					});
					yield* Effect.promise(() => db.flush());
					return game;
				}).pipe(Effect.provide(makeLayer(store))),
			),
		);

		expect(created.id).toEqual(expect.any(String));
		const persisted = JSON.parse(store.get("/data/games.json") ?? "{}");
		expect(Object.keys(persisted)).toEqual([created.id]);
		expect(persisted[created.id]).toEqual({
			metadata: { name: "Generated" },
		});
	});

	it("rejects physical id fields in strict mode even when they match the key", async () => {
		const store = new Map<string, string>();
		store.set(
			"/data/games.json",
			JSON.stringify({ g1: { id: "g1", metadata: { name: "Legacy" } } }),
		);

		const config = {
			games: {
				schema: GamePayload,
				file: "/data/games.json",
				id: { kind: "derivedFromKey", field: "id" },
				relationships: {},
			},
		} as const;

		const result = await Effect.runPromise(
			Effect.result(
				Effect.scoped(createPersistentEffectDatabase(config)).pipe(
					Effect.provide(makeLayer(store)),
				),
			),
		);

		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure._tag).toBe("ValidationError");
			expect(result.failure.message).toContain("must not be present");
		}
	});

	it("skips physical id fields in lenient mode", async () => {
		const store = new Map<string, string>();
		store.set(
			"/data/games.json",
			JSON.stringify({
				bad: { id: "bad", metadata: { name: "Legacy" } },
				good: { metadata: { name: "Current" } },
			}),
		);

		const config = {
			games: {
				schema: GamePayload,
				file: "/data/games.json",
				id: { kind: "derivedFromKey", field: "id" },
				validation: "lenient",
				relationships: {},
			},
		} as const;

		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createPersistentEffectDatabase(config);
					return yield* Stream.runCollect(db.games.query());
				}).pipe(Effect.provide(makeLayer(store))),
			),
		);

		expect(result).toEqual([{ id: "good", metadata: { name: "Current" } }]);
	});

	it("keeps query, select, cursor, uniqueness, and relationships on hydrated records", async () => {
		const store = new Map<string, string>();
		const config = {
			users: {
				schema: UserPayload,
				file: "/data/users.json",
				id: { kind: "derivedFromKey", field: "id" },
				relationships: {
					games: {
						type: "inverse" as const,
						target: "games",
						foreignKey: "userId",
					},
				},
				uniqueFields: ["name"],
			},
			games: {
				schema: GamePayload,
				file: "/data/games.json",
				id: { kind: "derivedFromKey", field: "id" },
				relationships: {
					user: { type: "ref" as const, target: "users" },
				},
			},
		} as const;

		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createPersistentEffectDatabase(config);
					yield* db.users.create({ id: "u1", name: "Alice" });
					yield* db.games.create({
						id: "g1",
						metadata: { name: "Default" },
						userId: "u1",
					});
					const byId = yield* Stream.runCollect(
						db.games.query({ where: { id: "g1" } }),
					);
					const selected = yield* Stream.runCollect(
						db.games.query({ select: { id: true, metadata: true } }),
					);
					const page = yield* db.games.query({
						cursor: { key: "id", limit: 1 },
					});
					const populated = yield* Stream.runCollect(
						db.games.query({ populate: { user: true } }),
					);
					return { byId, selected, page, populated };
				}).pipe(Effect.provide(makeLayer(store))),
			),
		);

		expect(result.byId).toHaveLength(1);
		expect(result.byId[0]?.id).toBe("g1");
		expect(result.selected).toEqual([
			{ id: "g1", metadata: { name: "Default" } },
		]);
		expect(result.page.items[0]?.id).toBe("g1");
		expect(result.populated[0]?.user).toEqual({ id: "u1", name: "Alice" });
	});

	it("rejects derived ids for array-backed formats at startup", async () => {
		const store = new Map<string, string>();
		const config = {
			games: {
				schema: GamePayload,
				file: "/data/games.jsonl",
				id: { kind: "derivedFromKey", field: "id" },
				relationships: {},
			},
		} as const;

		const result = await Effect.runPromise(
			Effect.result(
				Effect.scoped(createPersistentEffectDatabase(config)).pipe(
					Effect.provide(makeLayer(store)),
				),
			),
		);

		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure._tag).toBe("ValidationError");
			expect(result.failure.message).toContain("object-keyed format");
		}
	});

	it("leaves non-derived collections unchanged", async () => {
		const store = new Map<string, string>();
		const config = {
			games: {
				schema: GameWithIdSchema,
				file: "/data/games.json",
				relationships: {},
			},
		} as const;

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createPersistentEffectDatabase(config);
					yield* db.games.create({ id: "g1", metadata: { name: "Default" } });
					yield* Effect.promise(() => db.flush());
				}).pipe(Effect.provide(makeLayer(store))),
			),
		);

		const persisted = JSON.parse(store.get("/data/games.json") ?? "{}");
		expect(persisted.g1.id).toBe("g1");
	});
});
