import { Effect, Fiber, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { StorageError } from "../src/errors/storage-errors.js";
import {
	createEffectDatabase,
	createPersistentEffectDatabase,
} from "../src/factories/database-effect.js";
import { yamlCodec } from "../src/serializers/codecs/yaml.js";
import { makeSerializerLayer } from "../src/serializers/format-codec.js";
import { makeInMemoryStorageLayer } from "../src/storage/in-memory-adapter-layer.js";
import {
	StorageAdapter,
	type StorageAdapterShape,
} from "../src/storage/storage-service.js";

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
});

const GamePayloadSchema = Schema.Struct({
	name: Schema.String,
	systemId: Schema.String,
});

const SystemPayloadSchema = Schema.Struct({
	name: Schema.String,
});

const sourceConfig = {
	collections: {
		games: {
			schema: GamePayloadSchema,
			id: { kind: "derivedFromKey", field: "id" },
			relationships: {},
		},
		systems: {
			schema: SystemPayloadSchema,
			id: { kind: "derivedFromKey", field: "id" },
			relationships: {},
		},
	},
	sources: [
		{
			id: "library",
			kind: "documents",
			root: "/config",
			include: "**/*.yaml",
			format: "yaml",
			collections: "all",
			outbox: "/config/generated.yaml",
		},
	],
} as const;

const makeYamlLayer = (store: Map<string, string>) =>
	Layer.merge(
		makeInMemoryStorageLayer(store),
		makeSerializerLayer([yamlCodec()]),
	);

describe("source-oriented database config", () => {
	it("uses config.collections as runtime collections and does not expose sources metadata", async () => {
		const db = await Effect.runPromise(
			createEffectDatabase(
				{
					collections: {
						books: {
							schema: BookSchema,
							relationships: {},
						},
					},
					sources: [
						{
							id: "library",
							kind: "documents",
							root: "/data",
							format: "yaml",
							collections: "all",
							outbox: "/data/generated.yaml",
						},
					],
				} as const,
				{ books: [{ id: "b1", title: "Dune" }] },
			),
		);

		expect(await Effect.runPromise(db.books.findById("b1"))).toEqual({
			id: "b1",
			title: "Dune",
		});
		expect("sources" in db).toBe(false);
		expect("collections" in db).toBe(false);
	});

	it("loads merged records from document sources through normal collections", async () => {
		const store = new Map<string, string>([
			[
				"/config/base.yaml",
				`games:\n  smw:\n    name: Super Mario World\n    systemId: snes\nsystems:\n  snes:\n    name: Super Nintendo\n`,
			],
			[
				"/config/more.yaml",
				`games:\n  sonic:\n    name: Sonic the Hedgehog\n    systemId: genesis\nsystems:\n  genesis:\n    name: Genesis\n`,
			],
		]);

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(sourceConfig, undefined, {
							writeDebounce: 60_000,
						}),
						makeYamlLayer(store),
					);

					const games = yield* Stream.runCollect(db.games.query());
					expect(games.map((game) => game.id).sort()).toEqual(["smw", "sonic"]);
					expect(yield* db.systems.findById("snes")).toEqual({
						id: "snes",
						name: "Super Nintendo",
					});
				}),
			),
		);
	});

	it("writes newly-created records to the document source outbox on flush", async () => {
		const store = new Map<string, string>([
			["/config/base.yaml", "systems:\n  snes:\n    name: Super Nintendo\n"],
		]);

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(sourceConfig, undefined, {
							writeDebounce: 60_000,
						}),
						makeYamlLayer(store),
					);

					yield* db.games.create({
						id: "smw",
						name: "Super Mario World",
						systemId: "snes",
					});
					yield* Effect.promise(() => db.flush());

					expect(store.get("/config/generated.yaml")).toContain("games:");
					expect(store.get("/config/generated.yaml")).toContain("smw:");
					expect(store.get("/config/generated.yaml")).toContain(
						"name: Super Mario World",
					);
					expect(store.get("/config/generated.yaml")).not.toContain("id: smw");
				}),
			),
		);
	});

	it("updates existing records in their origin document", async () => {
		const store = new Map<string, string>([
			[
				"/config/base.yaml",
				`games:\n  smw:\n    name: Super Mario World\n    systemId: snes\nsystems:\n  snes:\n    name: Super Nintendo\n`,
			],
		]);

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(sourceConfig, undefined, {
							writeDebounce: 60_000,
						}),
						makeYamlLayer(store),
					);

					yield* db.games.update("smw", { name: "SMW" });
					yield* Effect.promise(() => db.flush());

					expect(store.get("/config/base.yaml")).toContain("name: SMW");
					expect(store.get("/config/base.yaml")).toContain("systems:");
					expect(store.has("/config/generated.yaml")).toBe(false);
				}),
			),
		);
	});

	it("deletes existing records from their origin document and leaves the file", async () => {
		const store = new Map<string, string>([
			[
				"/config/base.yaml",
				`games:\n  smw:\n    name: Super Mario World\n    systemId: snes\nsystems:\n  snes:\n    name: Super Nintendo\n`,
			],
		]);

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* Effect.provide(
						createPersistentEffectDatabase(sourceConfig, undefined, {
							writeDebounce: 60_000,
						}),
						makeYamlLayer(store),
					);

					yield* db.games.delete("smw");
					yield* Effect.promise(() => db.flush());

					expect(store.has("/config/base.yaml")).toBe(true);
					expect(store.get("/config/base.yaml")).not.toContain("smw:");
					expect(store.get("/config/base.yaml")).toContain("systems:");
				}),
			),
		);
	});

	it("surfaces document-source persistence errors through flush", async () => {
		const store = new Map<string, string>([
			["/config/base.yaml", "systems:\n  snes:\n    name: Super Nintendo\n"],
		]);
		const storageLayer = makeInMemoryStorageLayer(store);
		const baseStorage = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					return yield* StorageAdapter;
				}),
				storageLayer,
			),
		);
		const failingStorage: StorageAdapterShape = {
			...baseStorage,
			write: (path, data) =>
				path === "/config/generated.yaml"
					? Effect.fail(
							new StorageError({
								path,
								operation: "write",
								message: "configured write failure",
							}),
						)
					: baseStorage.write(path, data),
		};
		const layer = Layer.merge(
			Layer.succeed(StorageAdapter, failingStorage),
			makeSerializerLayer([yamlCodec()]),
		);

		let caught: unknown;
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Effect.provide(
							createPersistentEffectDatabase(sourceConfig, undefined, {
								writeDebounce: 60_000,
							}),
							layer,
						);

						yield* db.games.create({
							id: "smw",
							name: "Super Mario World",
							systemId: "snes",
						});
						yield* Effect.promise(() => db.flush());
					}),
				),
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(StorageError);
		expect((caught as StorageError).message).toBe("configured write failure");
	});

	describe("document-source watcher reloads", () => {
		it("updates a collection when a matched YAML file changes", async () => {
			const store = new Map<string, string>([
				[
					"/config/base.yaml",
					`games:\n  smw:\n    name: Super Mario World\n    systemId: snes\n`,
				],
			]);
			const layer = makeYamlLayer(store);

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createPersistentEffectDatabase(
							sourceConfig,
							undefined,
							{
								writeDebounce: 60_000,
							},
						);
						const storage = yield* StorageAdapter;

						yield* storage.write(
							"/config/base.yaml",
							`games:\n  smw:\n    name: SMW Reloaded\n    systemId: snes\n`,
						);
						yield* Effect.sleep("150 millis");

						expect(yield* db.games.findById("smw")).toEqual({
							id: "smw",
							name: "SMW Reloaded",
							systemId: "snes",
						});
					}),
				).pipe(Effect.provide(layer)),
			);
		});

		it("loads a newly-added matched YAML file after debounce", async () => {
			const store = new Map<string, string>([
				[
					"/config/base.yaml",
					`games:\n  smw:\n    name: Super Mario World\n    systemId: snes\n`,
				],
			]);
			const layer = makeYamlLayer(store);

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createPersistentEffectDatabase(
							sourceConfig,
							undefined,
							{
								writeDebounce: 60_000,
							},
						);
						const storage = yield* StorageAdapter;

						yield* storage.write(
							"/config/more.yaml",
							`games:\n  sonic:\n    name: Sonic the Hedgehog\n    systemId: genesis\n`,
						);
						yield* Effect.sleep("150 millis");

						expect(yield* db.games.findById("sonic")).toEqual({
							id: "sonic",
							name: "Sonic the Hedgehog",
							systemId: "genesis",
						});
					}),
				).pipe(Effect.provide(layer)),
			);
		});

		it("removes origin records when a matched YAML file is removed", async () => {
			const store = new Map<string, string>([
				[
					"/config/base.yaml",
					`games:\n  smw:\n    name: Super Mario World\n    systemId: snes\n`,
				],
				[
					"/config/more.yaml",
					`games:\n  sonic:\n    name: Sonic the Hedgehog\n    systemId: genesis\n`,
				],
			]);
			const layer = makeYamlLayer(store);

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createPersistentEffectDatabase(
							sourceConfig,
							undefined,
							{
								writeDebounce: 60_000,
							},
						);
						const storage = yield* StorageAdapter;

						yield* storage.remove("/config/more.yaml");
						yield* Effect.sleep("150 millis");

						const games = yield* Stream.runCollect(db.games.query());
						expect(games.map((game) => game.id).sort()).toEqual(["smw"]);

						yield* db.games.create({
							id: "sonic",
							name: "Sonic Restored",
							systemId: "genesis",
						});
						yield* Effect.promise(() => db.flush());

						expect(store.has("/config/more.yaml")).toBe(false);
						expect(store.get("/config/generated.yaml")).toContain("sonic:");
					}),
				).pipe(Effect.provide(layer)),
			);
		});

		it("keeps previous good data when a reload introduces a duplicate record", async () => {
			const store = new Map<string, string>([
				[
					"/config/base.yaml",
					`games:\n  smw:\n    name: Super Mario World\n    systemId: snes\n`,
				],
			]);
			const layer = makeYamlLayer(store);

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createPersistentEffectDatabase(
							sourceConfig,
							undefined,
							{
								writeDebounce: 60_000,
							},
						);
						const storage = yield* StorageAdapter;

						yield* storage.write(
							"/config/duplicate.yaml",
							`games:\n  smw:\n    name: Duplicate\n    systemId: snes\n`,
						);
						yield* Effect.sleep("150 millis");

						expect(yield* db.games.findById("smw")).toEqual({
							id: "smw",
							name: "Super Mario World",
							systemId: "snes",
						});
						const games = yield* Stream.runCollect(db.games.query());
						expect(games.map((game) => game.id).sort()).toEqual(["smw"]);
					}),
				).pipe(Effect.provide(layer)),
			);
		});

		it("keeps previous good data when a reload introduces an unknown collection", async () => {
			const store = new Map<string, string>([
				[
					"/config/base.yaml",
					`games:\n  smw:\n    name: Super Mario World\n    systemId: snes\n`,
				],
			]);
			const layer = makeYamlLayer(store);

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createPersistentEffectDatabase(
							sourceConfig,
							undefined,
							{
								writeDebounce: 60_000,
							},
						);
						const storage = yield* StorageAdapter;

						yield* storage.write(
							"/config/base.yaml",
							`games:\n  smw:\n    name: Changed But Invalid\n    systemId: snes\nunknowns:\n  x:\n    name: Invalid\n`,
						);
						yield* Effect.sleep("150 millis");

						expect(yield* db.games.findById("smw")).toEqual({
							id: "smw",
							name: "Super Mario World",
							systemId: "snes",
						});
					}),
				).pipe(Effect.provide(layer)),
			);
		});

		it("publishes reload events to watchById subscribers", async () => {
			const store = new Map<string, string>([
				[
					"/config/base.yaml",
					`games:\n  smw:\n    name: Super Mario World\n    systemId: snes\n`,
				],
			]);
			const layer = makeYamlLayer(store);

			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createPersistentEffectDatabase(
							sourceConfig,
							undefined,
							{
								writeDebounce: 60_000,
							},
						);
						const storage = yield* StorageAdapter;
						const stream = yield* db.games.watchById("smw");
						const emissions: Array<{
							readonly id: string;
							readonly name: string;
							readonly systemId: string;
						} | null> = [];
						const consumerFiber = yield* Effect.forkIn(
							Stream.runForEach(stream, (emission) =>
								Effect.sync(() => {
									emissions.push(emission);
								}),
							),
							yield* Effect.scope,
						);

						yield* Effect.sleep("30 millis");
						expect(emissions).toHaveLength(1);
						expect(emissions[0]?.name).toBe("Super Mario World");

						yield* storage.write(
							"/config/base.yaml",
							`games:\n  smw:\n    name: SMW Reloaded\n    systemId: snes\n`,
						);
						yield* Effect.sleep("150 millis");

						expect(emissions).toHaveLength(2);
						expect(emissions[1]?.name).toBe("SMW Reloaded");

						yield* Fiber.interrupt(consumerFiber);
					}),
				).pipe(Effect.provide(layer)),
			);
		});
	});
});
