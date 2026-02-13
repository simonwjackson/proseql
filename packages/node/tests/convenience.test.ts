import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
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

const makeTempDir = () =>
	join(tmpdir(), `proseql-convenience-${randomBytes(8).toString("hex")}`);

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
});
