import { Effect, Layer, Result, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { OperationError } from "../src/errors/crud-errors.js";
import { SourceConfigError } from "../src/errors/source-errors.js";
import { createPersistentEffectDatabase } from "../src/factories/database-effect.js";
import { jsonCodec } from "../src/serializers/codecs/json.js";
import { yamlCodec } from "../src/serializers/codecs/yaml.js";
import { makeSerializerLayer } from "../src/serializers/format-codec.js";
import { makeInMemoryStorageLayer } from "../src/storage/in-memory-adapter-layer.js";
import { StorageAdapter } from "../src/storage/storage-service.js";

const FoodSchema = Schema.Struct({
	name: Schema.String,
	macros: Schema.Struct({
		cal: Schema.Number,
		fat: Schema.optional(Schema.Number),
	}),
});

const makeLayer = (store: Map<string, string>) =>
	Layer.merge(
		makeInMemoryStorageLayer(store),
		makeSerializerLayer([yamlCodec(), jsonCodec()]),
	);

const graphConfig = (overrides: Record<string, unknown> = {}) =>
	({
		collections: {
			foods: {
				schema: FoodSchema,
				id: { kind: "derivedFromKey", field: "id" },
				relationships: {},
			},
		},
		sources: [
			{
				id: "config-graph",
				kind: "documentGraph",
				include: "**/*.{yaml,json}",
				roots: [{ root: "/a" }, { root: "/b" }],
			},
		],
		...overrides,
	}) as const;

const seedStore = () =>
	new Map<string, string>([
		[
			"/a/base.yaml",
			"foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
		],
		["/b/over.yaml", "foods:\n  apple:\n    macros: { fat: 2 }\n"],
		[
			"/b/banana.json",
			'{ "foods": { "banana": { "name": "Banana", "macros": { "cal": 90 } } } }',
		],
	]);

describe("documentGraph database integration", () => {
	it("loads merged graph data and exposes it through normal read APIs", async () => {
		const store = seedStore();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(graphConfig(), undefined, {
							writeDebounce: 60_000,
						}),
						makeLayer(store),
					);
					const foods = yield* Stream.runCollect(db.foods.query());
					expect(foods.map((f) => f.id).sort()).toEqual(["apple", "banana"]);
					expect(yield* db.foods.findById("apple")).toEqual({
						id: "apple",
						name: "Apple",
						macros: { cal: 10, fat: 2 },
					});
				}),
			),
		);
	});

	it("rejects every mutation on a graph-owned collection without changing state", async () => {
		const store = seedStore();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(graphConfig(), undefined, {
							writeDebounce: 60_000,
						}),
						makeLayer(store),
					);

					const attempts: Array<Effect.Effect<unknown, unknown>> = [
						db.foods.create({ id: "x", name: "X", macros: { cal: 1 } }),
						db.foods.createMany([{ id: "x", name: "X", macros: { cal: 1 } }]),
						db.foods.update("apple", { name: "Mutated" }),
						db.foods.updateMany({ where: {} }, { name: "Mutated" }),
						db.foods.delete("apple"),
						db.foods.deleteMany({ where: {} }),
						db.foods.upsert({ id: "apple", name: "X", macros: { cal: 1 } }),
						db.foods.upsertMany([
							{ id: "apple", name: "X", macros: { cal: 1 } },
						]),
					];

					for (const attempt of attempts) {
						const result = yield* Effect.result(attempt);
						expect(Result.isFailure(result)).toBe(true);
						if (Result.isFailure(result)) {
							expect(result.failure).toBeInstanceOf(OperationError);
							expect((result.failure as OperationError).reason).toBe(
								"read-only-source",
							);
						}
					}

					// State unchanged.
					expect(yield* db.foods.findById("apple")).toMatchObject({
						name: "Apple",
					});
				}),
			),
		);
	});

	it("rejects mutation of a graph-owned collection inside $transaction", async () => {
		const store = seedStore();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(graphConfig(), undefined, {
							writeDebounce: 60_000,
						}),
						makeLayer(store),
					);

					const result = yield* Effect.result(
						db.$transaction((tx) =>
							tx.foods.update("apple", { name: "Mutated" }),
						),
					);
					expect(Result.isFailure(result)).toBe(true);

					// State unchanged after the failed transaction.
					expect(yield* db.foods.findById("apple")).toMatchObject({
						name: "Apple",
					});
				}),
			),
		);
	});

	it("does not write any file when a mutation is attempted or flushed", async () => {
		const store = seedStore();
		const before = new Map(store);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(graphConfig(), undefined, {
							writeDebounce: 60_000,
						}),
						makeLayer(store),
					);
					yield* Effect.result(
						db.foods.create({ id: "x", name: "X", macros: { cal: 1 } }),
					);
					yield* Effect.promise(() => db.flush());
				}),
			),
		);
		expect(store.size).toBe(before.size);
		for (const [path, content] of before) {
			expect(store.get(path)).toBe(content);
		}
	});

	it("fails database creation when initialData targets a graph-owned collection", async () => {
		const store = seedStore();
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.result(
					Effect.provide(
						createPersistentEffectDatabase(
							graphConfig(),
							{ foods: [{ id: "x", name: "X", macros: { cal: 1 } }] },
							{ writeDebounce: 60_000 },
						),
						makeLayer(store),
					),
				),
			),
		);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure).toBeInstanceOf(SourceConfigError);
		}
	});

	it("fails database creation when the initial graph is invalid", async () => {
		const store = new Map<string, string>([
			["/a/bad.yaml", "foods:\n  apple:\n    macros: { cal: not-a-number }\n"],
		]);
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.result(
					Effect.provide(
						createPersistentEffectDatabase(
							graphConfig({
								sources: [
									{
										id: "config-graph",
										kind: "documentGraph",
										include: "**/*.yaml",
										roots: [{ root: "/a" }],
									},
								],
							}),
							undefined,
							{ writeDebounce: 60_000 },
						),
						makeLayer(store),
					),
				),
			),
		);
		expect(Result.isFailure(result)).toBe(true);
	});
});

describe("documentGraph watcher reloads", () => {
	const reloadConfig = () =>
		({
			collections: {
				foods: {
					schema: FoodSchema,
					id: { kind: "derivedFromKey", field: "id" },
					relationships: {},
				},
			},
			sources: [
				{
					id: "config-graph",
					kind: "documentGraph",
					include: "**/*.yaml",
					roots: [{ root: "/a" }],
				},
			],
		}) as const;

	it("reflects new data after a valid fragment change", async () => {
		const store = new Map<string, string>([
			[
				"/a/base.yaml",
				"foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
			],
		]);
		const layer = makeLayer(store);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createPersistentEffectDatabase(
						reloadConfig(),
						undefined,
						{ writeDebounce: 60_000 },
					);
					const storage = yield* StorageAdapter;
					yield* storage.write(
						"/a/base.yaml",
						"foods:\n  apple:\n    name: Apple\n    macros: { cal: 50 }\n",
					);
					yield* Effect.sleep("200 millis");
					expect(yield* db.foods.findById("apple")).toMatchObject({
						macros: { cal: 50 },
					});
				}),
			).pipe(Effect.provide(layer)),
		);
	});

	it("keeps last-known-good on an invalid reload, then recovers when fixed", async () => {
		const store = new Map<string, string>([
			[
				"/a/base.yaml",
				"foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
			],
		]);
		const layer = makeLayer(store);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createPersistentEffectDatabase(
						reloadConfig(),
						undefined,
						{ writeDebounce: 60_000 },
					);
					const storage = yield* StorageAdapter;

					// Invalid reload: cal is not a number.
					yield* storage.write(
						"/a/base.yaml",
						"foods:\n  apple:\n    name: Apple\n    macros: { cal: nope }\n",
					);
					yield* Effect.sleep("200 millis");
					expect(yield* db.foods.findById("apple")).toMatchObject({
						macros: { cal: 10 },
					});

					// Fix it: the graph recovers.
					yield* storage.write(
						"/a/base.yaml",
						"foods:\n  apple:\n    name: Apple\n    macros: { cal: 11 }\n",
					);
					yield* Effect.sleep("200 millis");
					expect(yield* db.foods.findById("apple")).toMatchObject({
						macros: { cal: 11 },
					});
				}),
			).pipe(Effect.provide(layer)),
		);
	});

	it("does not detect an optional root that was absent at startup", async () => {
		const store = new Map<string, string>([
			[
				"/a/base.yaml",
				"foods:\n  apple:\n    name: Apple\n    macros: { cal: 10 }\n",
			],
		]);
		const layer = makeLayer(store);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createPersistentEffectDatabase(
						{
							collections: {
								foods: {
									schema: FoodSchema,
									id: { kind: "derivedFromKey", field: "id" },
									relationships: {},
								},
							},
							sources: [
								{
									id: "config-graph",
									kind: "documentGraph",
									include: "**/*.yaml",
									roots: [{ root: "/a" }, { root: "/late", optional: true }],
								},
							],
						} as const,
						undefined,
						{ writeDebounce: 60_000 },
					);
					const storage = yield* StorageAdapter;

					// The /late root did not exist at startup, so it is not watched.
					yield* storage.write(
						"/late/extra.yaml",
						"foods:\n  banana:\n    name: Banana\n    macros: { cal: 90 }\n",
					);
					yield* Effect.sleep("200 millis");
					const result = yield* Effect.result(db.foods.findById("banana"));
					expect(Result.isFailure(result)).toBe(true);
				}),
			).pipe(Effect.provide(layer)),
		);
	});
});
