import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { OperationError } from "../src/errors/crud-errors.js";
import { createPersistentEffectDatabase } from "../src/factories/database-effect.js";
import { jsonlCodec } from "../src/serializers/codecs/jsonl.js";
import { makeSerializerLayer } from "../src/serializers/format-codec.js";
import { makeInMemoryStorageLayer } from "../src/storage/in-memory-adapter-layer.js";
import { loadData, saveData } from "../src/storage/persistence-effect.js";

// ============================================================================
// Test Schemas
// ============================================================================

const EventSchema = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
	payload: Schema.String,
});

type EventEntity = typeof EventSchema.Type;

// ============================================================================
// Helpers
// ============================================================================

const makeTestEnv = () => {
	const store = new Map<string, string>();
	const layer = Layer.merge(
		makeInMemoryStorageLayer(store),
		makeSerializerLayer([jsonlCodec()]),
	);
	return { store, layer };
};

// ============================================================================
// Tests
// ============================================================================

describe("append-only collections", () => {
	describe("CRUD restrictions", () => {
		it("allows create() on append-only collections", async () => {
			const { store, layer } = makeTestEnv();
			const config = {
				events: {
					schema: EventSchema,
					file: "./data/events.jsonl",
					appendOnly: true as const,
					relationships: {},
				},
			} as const;

			const db = await Effect.runPromise(
				createPersistentEffectDatabase(config, { events: [] }).pipe(
					Effect.provide(layer),
					Effect.scoped,
				),
			);

			const event = await db.events.create({
				id: "e1",
				type: "click",
				payload: "button-1",
			}).runPromise;

			expect(event.id).toBe("e1");
			expect(event.type).toBe("click");
		});

		it("allows createMany() on append-only collections", async () => {
			const { store, layer } = makeTestEnv();
			const config = {
				events: {
					schema: EventSchema,
					file: "./data/events.jsonl",
					appendOnly: true as const,
					relationships: {},
				},
			} as const;

			const db = await Effect.runPromise(
				createPersistentEffectDatabase(config, { events: [] }).pipe(
					Effect.provide(layer),
					Effect.scoped,
				),
			);

			const result = await db.events.createMany([
				{ id: "e1", type: "click", payload: "btn-1" },
				{ id: "e2", type: "hover", payload: "btn-2" },
			]).runPromise;

			expect(result.created.length).toBe(2);
		});

		it("allows findById() on append-only collections", async () => {
			const { store, layer } = makeTestEnv();
			const config = {
				events: {
					schema: EventSchema,
					file: "./data/events.jsonl",
					appendOnly: true as const,
					relationships: {},
				},
			} as const;

			const db = await Effect.runPromise(
				createPersistentEffectDatabase(config, {
					events: [{ id: "e1", type: "click", payload: "btn" }],
				}).pipe(Effect.provide(layer), Effect.scoped),
			);

			const found = await db.events.findById("e1").runPromise;
			expect(found.id).toBe("e1");
		});

		it("allows query() on append-only collections", async () => {
			const { store, layer } = makeTestEnv();
			const config = {
				events: {
					schema: EventSchema,
					file: "./data/events.jsonl",
					appendOnly: true as const,
					relationships: {},
				},
			} as const;

			const db = await Effect.runPromise(
				createPersistentEffectDatabase(config, {
					events: [
						{ id: "e1", type: "click", payload: "btn" },
						{ id: "e2", type: "hover", payload: "link" },
					],
				}).pipe(Effect.provide(layer), Effect.scoped),
			);

			const results = await db.events.query({ where: { type: "click" } })
				.runPromise;
			expect(results.length).toBe(1);
		});

		it("rejects update() on append-only collections with OperationError", async () => {
			const { store, layer } = makeTestEnv();
			const config = {
				events: {
					schema: EventSchema,
					file: "./data/events.jsonl",
					appendOnly: true as const,
					relationships: {},
				},
			} as const;

			const db = await Effect.runPromise(
				createPersistentEffectDatabase(config, {
					events: [{ id: "e1", type: "click", payload: "btn" }],
				}).pipe(Effect.provide(layer), Effect.scoped),
			);

			const error = await Effect.runPromise(
				db.events.update("e1", { type: "hover" }).pipe(Effect.flip),
			);
			expect(error._tag).toBe("OperationError");
			expect((error as OperationError).reason).toBe("append-only");
		});

		it("rejects updateMany() on append-only collections with OperationError", async () => {
			const { store, layer } = makeTestEnv();
			const config = {
				events: {
					schema: EventSchema,
					file: "./data/events.jsonl",
					appendOnly: true as const,
					relationships: {},
				},
			} as const;

			const db = await Effect.runPromise(
				createPersistentEffectDatabase(config, {
					events: [{ id: "e1", type: "click", payload: "btn" }],
				}).pipe(Effect.provide(layer), Effect.scoped),
			);

			const error = await Effect.runPromise(
				db.events.updateMany(() => true, { type: "hover" }).pipe(Effect.flip),
			);
			expect(error._tag).toBe("OperationError");
		});

		it("rejects delete() on append-only collections with OperationError", async () => {
			const { store, layer } = makeTestEnv();
			const config = {
				events: {
					schema: EventSchema,
					file: "./data/events.jsonl",
					appendOnly: true as const,
					relationships: {},
				},
			} as const;

			const db = await Effect.runPromise(
				createPersistentEffectDatabase(config, {
					events: [{ id: "e1", type: "click", payload: "btn" }],
				}).pipe(Effect.provide(layer), Effect.scoped),
			);

			const error = await Effect.runPromise(
				db.events.delete("e1").pipe(Effect.flip),
			);
			expect(error._tag).toBe("OperationError");
		});

		it("rejects deleteMany() on append-only collections with OperationError", async () => {
			const { store, layer } = makeTestEnv();
			const config = {
				events: {
					schema: EventSchema,
					file: "./data/events.jsonl",
					appendOnly: true as const,
					relationships: {},
				},
			} as const;

			const db = await Effect.runPromise(
				createPersistentEffectDatabase(config, {
					events: [{ id: "e1", type: "click", payload: "btn" }],
				}).pipe(Effect.provide(layer), Effect.scoped),
			);

			const error = await Effect.runPromise(
				db.events.deleteMany(() => true).pipe(Effect.flip),
			);
			expect(error._tag).toBe("OperationError");
		});

		it("rejects upsert() on append-only collections with OperationError", async () => {
			const { store, layer } = makeTestEnv();
			const config = {
				events: {
					schema: EventSchema,
					file: "./data/events.jsonl",
					appendOnly: true as const,
					relationships: {},
				},
			} as const;

			const db = await Effect.runPromise(
				createPersistentEffectDatabase(config, { events: [] }).pipe(
					Effect.provide(layer),
					Effect.scoped,
				),
			);

			const error = await Effect.runPromise(
				db.events
					.upsert({
						where: { id: "e1" },
						create: { id: "e1", type: "click", payload: "btn" },
						update: { type: "hover" },
					})
					.pipe(Effect.flip),
			);
			expect(error._tag).toBe("OperationError");
		});
	});

	describe("file persistence", () => {
		it("appends one JSONL line per create()", async () => {
			const { store, layer } = makeTestEnv();
			const config = {
				events: {
					schema: EventSchema,
					file: "./data/events.jsonl",
					appendOnly: true as const,
					relationships: {},
				},
			} as const;

			const db = await Effect.runPromise(
				createPersistentEffectDatabase(config, { events: [] }).pipe(
					Effect.provide(layer),
					Effect.scoped,
				),
			);

			await db.events.create({ id: "e1", type: "click", payload: "btn-1" })
				.runPromise;

			// Check that the file has one line
			const content = store.get("./data/events.jsonl");
			expect(content).toBeDefined();
			const lines = content?.split("\n").filter((l) => l.trim() !== "");
			expect(lines.length).toBe(1);
			const parsed = JSON.parse(lines[0]);
			expect(parsed.id).toBe("e1");
			expect(parsed.type).toBe("click");

			// Create a second entity
			await db.events.create({ id: "e2", type: "hover", payload: "link-1" })
				.runPromise;

			const content2 = store.get("./data/events.jsonl");
			const lines2 = content2?.split("\n").filter((l) => l.trim() !== "");
			expect(lines2.length).toBe(2);
			const parsed2 = JSON.parse(lines2[1]);
			expect(parsed2.id).toBe("e2");
		});

		it("appends multiple lines for createMany()", async () => {
			const { store, layer } = makeTestEnv();
			const config = {
				events: {
					schema: EventSchema,
					file: "./data/events.jsonl",
					appendOnly: true as const,
					relationships: {},
				},
			} as const;

			const db = await Effect.runPromise(
				createPersistentEffectDatabase(config, { events: [] }).pipe(
					Effect.provide(layer),
					Effect.scoped,
				),
			);

			await db.events.createMany([
				{ id: "e1", type: "click", payload: "btn-1" },
				{ id: "e2", type: "hover", payload: "link-1" },
				{ id: "e3", type: "scroll", payload: "page" },
			]).runPromise;

			const content = store.get("./data/events.jsonl");
			const lines = content?.split("\n").filter((l) => l.trim() !== "");
			expect(lines.length).toBe(3);
		});

		it("flush() writes a clean canonical JSONL file", async () => {
			const { store, layer } = makeTestEnv();
			const config = {
				events: {
					schema: EventSchema,
					file: "./data/events.jsonl",
					appendOnly: true as const,
					relationships: {},
				},
			} as const;

			const db = await Effect.runPromise(
				createPersistentEffectDatabase(config, { events: [] }).pipe(
					Effect.provide(layer),
					Effect.scoped,
				),
			);

			// Create some entities
			await db.events.create({ id: "e1", type: "click", payload: "btn" })
				.runPromise;
			await db.events.create({ id: "e2", type: "hover", payload: "link" })
				.runPromise;

			// Flush writes a clean canonical file
			await db.flush();

			const content = store.get("./data/events.jsonl");
			expect(content).toBeDefined();
			const lines = content?.split("\n").filter((l) => l.trim() !== "");
			// After flush, we should have a clean file with all entities
			expect(lines.length).toBe(2);
			// Each line should be valid JSON
			for (const line of lines) {
				const parsed = JSON.parse(line);
				expect(typeof parsed.id).toBe("string");
			}
		});
	});

	describe("JSONL loadData/saveData", () => {
		it("loadData reads a JSONL file into a Map", async () => {
			const { store, layer } = makeTestEnv();
			const jsonl = [
				JSON.stringify({ id: "e1", type: "click", payload: "btn" }),
				JSON.stringify({ id: "e2", type: "hover", payload: "link" }),
			].join("\n");
			store.set("./data/events.jsonl", jsonl);

			const result = await Effect.runPromise(
				Effect.provide(loadData("./data/events.jsonl", EventSchema), layer),
			);

			expect(result.size).toBe(2);
			expect(result.get("e1")?.type).toBe("click");
			expect(result.get("e2")?.type).toBe("hover");
		});

		it("saveData writes a JSONL file with one line per entity", async () => {
			const { store, layer } = makeTestEnv();
			const data: ReadonlyMap<string, EventEntity> = new Map([
				["e1", { id: "e1", type: "click", payload: "btn" }],
				["e2", { id: "e2", type: "hover", payload: "link" }],
			]);

			await Effect.runPromise(
				Effect.provide(
					saveData("./data/events.jsonl", EventSchema, data),
					layer,
				),
			);

			const content = store.get("./data/events.jsonl");
			expect(content).toBeDefined();
			const lines = content?.split("\n").filter((l) => l.trim() !== "");
			expect(lines.length).toBe(2);
			// Verify each line is valid JSON with expected fields
			for (const line of lines) {
				const parsed = JSON.parse(line);
				expect(parsed).toHaveProperty("id");
				expect(parsed).toHaveProperty("type");
			}
		});

		it("round-trips saveData then loadData for JSONL", async () => {
			const { store, layer } = makeTestEnv();
			const original: ReadonlyMap<string, EventEntity> = new Map([
				["e1", { id: "e1", type: "click", payload: "btn" }],
				["e2", { id: "e2", type: "hover", payload: "link" }],
			]);

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						yield* saveData("./data/events.jsonl", EventSchema, original);
						return yield* loadData("./data/events.jsonl", EventSchema);
					}),
					layer,
				),
			);

			expect(result.size).toBe(2);
			expect(result.get("e1")).toEqual({
				id: "e1",
				type: "click",
				payload: "btn",
			});
			expect(result.get("e2")).toEqual({
				id: "e2",
				type: "hover",
				payload: "link",
			});
		});

		it("loadData returns empty map for non-existent JSONL file", async () => {
			const { store, layer } = makeTestEnv();

			const result = await Effect.runPromise(
				Effect.provide(loadData("./data/missing.jsonl", EventSchema), layer),
			);

			expect(result.size).toBe(0);
		});
	});

	describe("startup reload", () => {
		it("loads appended JSONL data on restart", async () => {
			const { store, layer } = makeTestEnv();
			const config = {
				events: {
					schema: EventSchema,
					file: "./data/events.jsonl",
					appendOnly: true as const,
					relationships: {},
				},
			} as const;

			// Pre-populate the store with JSONL content (simulating a previous session)
			store.set(
				"./data/events.jsonl",
				[
					JSON.stringify({
						id: "e1",
						type: "click",
						payload: "btn",
					}),
					JSON.stringify({
						id: "e2",
						type: "hover",
						payload: "link",
					}),
				].join("\n"),
			);

			const db = await Effect.runPromise(
				createPersistentEffectDatabase(config, { events: [] }).pipe(
					Effect.provide(layer),
					Effect.scoped,
				),
			);

			// Data from the file should be loaded
			const e1 = await db.events.findById("e1").runPromise;
			expect(e1.type).toBe("click");
			const e2 = await db.events.findById("e2").runPromise;
			expect(e2.type).toBe("hover");
		});
	});
});
