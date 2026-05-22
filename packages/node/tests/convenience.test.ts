import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	createNodeDatabase,
	makeNodePersistenceLayer,
} from "../src/convenience.js";

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	year: Schema.Number,
});

const GamePayloadSchema = Schema.Struct({
	name: Schema.String,
	systemId: Schema.String,
});

const SystemPayloadSchema = Schema.Struct({
	name: Schema.String,
});

const makeTempDir = () =>
	join(tmpdir(), `proseql-convenience-${randomBytes(8).toString("hex")}`);

const makeDocumentSourceConfig = (root: string) =>
	({
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
				root,
				include: "**/*.yaml",
				format: "yaml",
				collections: "all",
				outbox: "generated/outbox.yaml",
			},
		],
	}) as const;

describe("makeNodePersistenceLayer", () => {
	it("creates a working layer from config", async () => {
		const tempDir = makeTempDir();
		await fs.mkdir(tempDir, { recursive: true });

		const config = {
			books: {
				schema: BookSchema,
				file: join(tempDir, "books.json"),
				relationships: {},
			},
		} as const;

		const layer = makeNodePersistenceLayer(config);

		// Layer should provide both StorageAdapter and SerializerRegistry
		// Verify by creating a database through it
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { createPersistentEffectDatabase } = yield* Effect.promise(
						() => import("@proseql/core"),
					);
					const db = yield* createPersistentEffectDatabase(config);
					yield* db.books.create({ id: "1", title: "Dune", year: 1965 });
					return yield* db.books.findById("1");
				}).pipe(Effect.provide(layer)),
			),
		);

		expect(result.title).toBe("Dune");
		await fs.rm(tempDir, { recursive: true, force: true });
	});
});

describe("createNodeDatabase", () => {
	it("returns a functional database without manual layer wiring", async () => {
		const tempDir = makeTempDir();
		await fs.mkdir(tempDir, { recursive: true });

		const config = {
			books: {
				schema: BookSchema,
				file: join(tempDir, "books.json"),
				relationships: {},
			},
		} as const;

		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createNodeDatabase(config);
					yield* db.books.create({ id: "1", title: "Dune", year: 1965 });
					const book = yield* db.books.findById("1");
					return book;
				}),
			),
		);

		expect(result.title).toBe("Dune");
		expect(result.year).toBe(1965);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("round-trips data to yaml files", async () => {
		const tempDir = makeTempDir();
		await fs.mkdir(tempDir, { recursive: true });
		const filePath = join(tempDir, "books.yaml");

		const config = {
			books: {
				schema: BookSchema,
				file: filePath,
				relationships: {},
			},
		} as const;

		// Create and flush
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createNodeDatabase(config);
					yield* db.books.create({ id: "1", title: "Dune", year: 1965 });
					yield* Effect.promise(() => db.flush());
				}),
			),
		);

		// Verify file was written as YAML
		const content = await fs.readFile(filePath, "utf-8");
		expect(content).toContain("title: Dune");

		// Load in a new database instance and verify
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createNodeDatabase(config);
					return yield* db.books.findById("1");
				}),
			),
		);

		expect(result.title).toBe("Dune");
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("supports initial data", async () => {
		const tempDir = makeTempDir();
		await fs.mkdir(tempDir, { recursive: true });

		const config = {
			books: {
				schema: BookSchema,
				file: join(tempDir, "books.json"),
				relationships: {},
			},
		} as const;

		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* createNodeDatabase(config, {
						books: [{ id: "1", title: "Dune", year: 1965 }],
					});
					return yield* db.books.findById("1");
				}),
			),
		);

		expect(result.title).toBe("Dune");
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("loads document sources from real nested YAML files", async () => {
		const tempDir = makeTempDir();
		await fs.mkdir(join(tempDir, "nested"), { recursive: true });
		await fs.writeFile(
			join(tempDir, "base.yaml"),
			`games:\n  smw:\n    name: Super Mario World\n    systemId: snes\nsystems:\n  snes:\n    name: Super Nintendo\n`,
		);
		await fs.writeFile(
			join(tempDir, "nested", "more.yaml"),
			`games:\n  sonic:\n    name: Sonic the Hedgehog\n    systemId: genesis\nsystems:\n  genesis:\n    name: Genesis\n`,
		);

		try {
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createNodeDatabase(
							makeDocumentSourceConfig(tempDir),
							undefined,
							{ writeDebounce: 60_000 },
						);
						const games = yield* Stream.runCollect(db.games.query());
						return {
							gameIds: games.map((game) => game.id).sort(),
							snes: yield* db.systems.findById("snes"),
						};
					}),
				),
			);

			expect(result.gameIds).toEqual(["smw", "sonic"]);
			expect(result.snes).toEqual({ id: "snes", name: "Super Nintendo" });
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("reloads document sources when nested real YAML files change", async () => {
		const tempDir = makeTempDir();
		const nestedDir = join(tempDir, "nested");
		await fs.mkdir(nestedDir, { recursive: true });
		const nestedPath = join(nestedDir, "more.yaml");
		await fs.writeFile(
			nestedPath,
			`games:\n  sonic:\n    name: Sonic the Hedgehog\n    systemId: genesis\n`,
		);

		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createNodeDatabase(
							makeDocumentSourceConfig(tempDir),
							undefined,
							{ writeDebounce: 60_000 },
						);

						yield* Effect.promise(() =>
							fs.writeFile(
								nestedPath,
								`games:\n  sonic:\n    name: Sonic Reloaded\n    systemId: genesis\n`,
							),
						);
						yield* Effect.sleep("250 millis");

						expect(yield* db.games.findById("sonic")).toEqual({
							id: "sonic",
							name: "Sonic Reloaded",
							systemId: "genesis",
						});
					}),
				),
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("writes created document-source records to a real outbox file", async () => {
		const tempDir = makeTempDir();
		await fs.mkdir(tempDir, { recursive: true });
		await fs.writeFile(
			join(tempDir, "base.yaml"),
			`systems:\n  snes:\n    name: Super Nintendo\n`,
		);
		const outboxPath = join(tempDir, "generated", "outbox.yaml");

		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createNodeDatabase(
							makeDocumentSourceConfig(tempDir),
							undefined,
							{ writeDebounce: 60_000 },
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

			const content = await fs.readFile(outboxPath, "utf-8");
			expect(content).toContain("games:");
			expect(content).toContain("smw:");
			expect(content).toContain("name: Super Mario World");
			expect(content).not.toContain("id: smw");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("flushes document-source updates and deletes to each record origin", async () => {
		const tempDir = makeTempDir();
		await fs.mkdir(tempDir, { recursive: true });
		const basePath = join(tempDir, "base.yaml");
		const morePath = join(tempDir, "more.yaml");
		await fs.writeFile(
			basePath,
			`games:\n  smw:\n    name: Super Mario World\n    systemId: snes\nsystems:\n  snes:\n    name: Super Nintendo\n`,
		);
		await fs.writeFile(
			morePath,
			`games:\n  sonic:\n    name: Sonic the Hedgehog\n    systemId: genesis\nsystems:\n  genesis:\n    name: Genesis\n`,
		);

		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const db = yield* createNodeDatabase(
							makeDocumentSourceConfig(tempDir),
							undefined,
							{ writeDebounce: 60_000 },
						);
						yield* db.games.update("smw", { name: "SMW" });
						yield* db.games.delete("sonic");
						yield* Effect.promise(() => db.flush());
					}),
				),
			);

			const baseContent = await fs.readFile(basePath, "utf-8");
			const moreContent = await fs.readFile(morePath, "utf-8");
			expect(baseContent).toContain("name: SMW");
			expect(baseContent).toContain("systems:");
			expect(moreContent).not.toContain("sonic:");
			expect(moreContent).toContain("systems:");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
