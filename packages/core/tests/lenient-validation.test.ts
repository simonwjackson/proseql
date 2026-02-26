import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createPersistentEffectDatabase } from "../src/factories/database-effect.js";
import { jsonCodec } from "../src/serializers/codecs/json.js";
import {
	jsonlCodec,
	jsonlDecodeLines,
} from "../src/serializers/codecs/jsonl.js";
import { makeSerializerLayer } from "../src/serializers/format-codec.js";
import { makeInMemoryStorageLayer } from "../src/storage/in-memory-adapter-layer.js";
import { loadData } from "../src/storage/persistence-effect.js";

// ============================================================================
// Test Schema
// ============================================================================

const ItemSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	value: Schema.Number,
});

type Item = typeof ItemSchema.Type;

const makeTestEnv = () => {
	const store = new Map<string, string>();
	const layer = Layer.merge(
		makeInMemoryStorageLayer(store),
		makeSerializerLayer([jsonlCodec(), jsonCodec()]),
	);
	return { store, layer };
};

// ============================================================================
// jsonlDecodeLines
// ============================================================================

describe("jsonlDecodeLines", () => {
	it("should parse valid JSONL lines with correct line numbers", () => {
		const raw =
			'{"id":"a","name":"A","value":1}\n{"id":"b","name":"B","value":2}';
		const result = jsonlDecodeLines(raw);
		expect(result).toHaveLength(2);
		expect(result[0].lineNumber).toBe(1);
		expect(result[0].parsed).toEqual({ id: "a", name: "A", value: 1 });
		expect(result[0].parseError).toBeUndefined();
		expect(result[1].lineNumber).toBe(2);
		expect(result[1].parsed).toEqual({ id: "b", name: "B", value: 2 });
	});

	it("should skip blank lines and track line numbers correctly", () => {
		const raw = '{"id":"a"}\n\n{"id":"b"}';
		const result = jsonlDecodeLines(raw);
		expect(result).toHaveLength(2);
		expect(result[0].lineNumber).toBe(1);
		expect(result[1].lineNumber).toBe(3);
	});

	it("should capture parse errors per line", () => {
		const raw = '{"id":"a"}\n{bad json}\n{"id":"c"}';
		const result = jsonlDecodeLines(raw);
		expect(result).toHaveLength(3);
		expect(result[0].parseError).toBeUndefined();
		expect(result[1].parseError).toBeDefined();
		expect(result[1].lineNumber).toBe(2);
		expect(result[1].parsed).toBeUndefined();
		expect(result[2].parseError).toBeUndefined();
	});
});

// ============================================================================
// Lenient JSONL validation via loadData
// ============================================================================

describe("lenient validation with loadData", () => {
	it("should skip invalid entities and load valid ones in lenient mode", async () => {
		const { store, layer } = makeTestEnv();

		// Line 1: valid, Line 2: invalid (value is string not number), Line 3: valid
		store.set(
			"/data/items.jsonl",
			[
				'{"id":"a","name":"Alpha","value":1}',
				'{"id":"b","name":"Bad","value":"not-a-number"}',
				'{"id":"c","name":"Charlie","value":3}',
			].join("\n"),
		);

		const result = await Effect.runPromise(
			loadData("/data/items.jsonl", ItemSchema, {
				validation: "lenient",
			}).pipe(Effect.provide(layer)),
		);

		// Only valid entities should be loaded
		expect(result.size).toBe(2);
		expect(result.get("a")).toBeDefined();
		expect(result.get("a")?.name).toBe("Alpha");
		expect(result.get("c")).toBeDefined();
		expect(result.get("c")?.name).toBe("Charlie");
		// Invalid entity should be skipped
		expect(result.get("b")).toBeUndefined();
	});

	it("should skip malformed JSON lines in lenient mode", async () => {
		const { store, layer } = makeTestEnv();

		store.set(
			"/data/items.jsonl",
			[
				'{"id":"a","name":"Alpha","value":1}',
				"{this is not json",
				'{"id":"c","name":"Charlie","value":3}',
			].join("\n"),
		);

		const result = await Effect.runPromise(
			loadData("/data/items.jsonl", ItemSchema, {
				validation: "lenient",
			}).pipe(Effect.provide(layer)),
		);

		expect(result.size).toBe(2);
		expect(result.get("a")).toBeDefined();
		expect(result.get("c")).toBeDefined();
	});

	it("should abort on first invalid entity in strict mode (default)", async () => {
		const { store, layer } = makeTestEnv();

		store.set(
			"/data/items.jsonl",
			[
				'{"id":"a","name":"Alpha","value":1}',
				'{"id":"b","name":"Bad","value":"not-a-number"}',
				'{"id":"c","name":"Charlie","value":3}',
			].join("\n"),
		);

		const error = await Effect.runPromise(
			loadData("/data/items.jsonl", ItemSchema).pipe(
				Effect.flip,
				Effect.provide(layer),
			),
		);

		expect(error._tag).toBe("ValidationError");
	});

	it("should abort on invalid entity when validation is explicitly strict", async () => {
		const { store, layer } = makeTestEnv();

		store.set(
			"/data/items.jsonl",
			[
				'{"id":"a","name":"Alpha","value":1}',
				'{"id":"b","name":"Bad","value":"not-a-number"}',
			].join("\n"),
		);

		const error = await Effect.runPromise(
			loadData("/data/items.jsonl", ItemSchema, {
				validation: "strict",
			}).pipe(Effect.flip, Effect.provide(layer)),
		);

		expect(error._tag).toBe("ValidationError");
	});

	it("should return all entities when all are valid in lenient mode", async () => {
		const { store, layer } = makeTestEnv();

		store.set(
			"/data/items.jsonl",
			[
				'{"id":"a","name":"Alpha","value":1}',
				'{"id":"b","name":"Beta","value":2}',
			].join("\n"),
		);

		const result = await Effect.runPromise(
			loadData("/data/items.jsonl", ItemSchema, {
				validation: "lenient",
			}).pipe(Effect.provide(layer)),
		);

		expect(result.size).toBe(2);
		expect(result.get("a")?.name).toBe("Alpha");
		expect(result.get("b")?.name).toBe("Beta");
	});

	it("should return empty map when all entities are invalid in lenient mode", async () => {
		const { store, layer } = makeTestEnv();

		store.set(
			"/data/items.jsonl",
			[
				'{"id":"a","name":"Alpha","value":"bad"}',
				'{"id":"b","name":"Beta","value":"bad"}',
			].join("\n"),
		);

		const result = await Effect.runPromise(
			loadData("/data/items.jsonl", ItemSchema, {
				validation: "lenient",
			}).pipe(Effect.provide(layer)),
		);

		expect(result.size).toBe(0);
	});
});

// ============================================================================
// Lenient validation via JSON (non-JSONL) loadData
// ============================================================================

describe("lenient validation with JSON format", () => {
	it("should skip invalid entities in lenient mode with JSON files", async () => {
		const { store, layer } = makeTestEnv();

		store.set(
			"/data/items.json",
			JSON.stringify({
				a: { id: "a", name: "Alpha", value: 1 },
				b: { id: "b", name: "Bad", value: "not-a-number" },
				c: { id: "c", name: "Charlie", value: 3 },
			}),
		);

		const result = await Effect.runPromise(
			loadData("/data/items.json", ItemSchema, {
				validation: "lenient",
			}).pipe(Effect.provide(layer)),
		);

		expect(result.size).toBe(2);
		expect(result.get("a")).toBeDefined();
		expect(result.get("c")).toBeDefined();
		expect(result.get("b")).toBeUndefined();
	});
});

// ============================================================================
// Lenient validation via database factory
// ============================================================================

describe("lenient validation via database config", () => {
	it("should load valid entities and skip invalid ones with validation: lenient", async () => {
		const { store, layer } = makeTestEnv();

		store.set(
			"/data/items.jsonl",
			[
				'{"id":"a","name":"Alpha","value":1}',
				'{"id":"b","name":"Bad","value":"not-a-number"}',
				'{"id":"c","name":"Charlie","value":3}',
			].join("\n"),
		);

		const config = {
			items: {
				schema: ItemSchema,
				file: "/data/items.jsonl",
				validation: "lenient" as const,
				relationships: {},
			},
		};

		const db = await Effect.runPromise(
			createPersistentEffectDatabase(config).pipe(
				Effect.provide(layer),
				Effect.scoped,
			),
		);

		const all = await db.items.query({}).runPromise;
		expect(all).toHaveLength(2);
		const ids = all.map((item: Item) => item.id).sort();
		expect(ids).toEqual(["a", "c"]);
	});

	it("should abort by default (no validation field) when entity is invalid", async () => {
		const { store, layer } = makeTestEnv();

		store.set(
			"/data/items.jsonl",
			[
				'{"id":"a","name":"Alpha","value":1}',
				'{"id":"b","name":"Bad","value":"not-a-number"}',
			].join("\n"),
		);

		const config = {
			items: {
				schema: ItemSchema,
				file: "/data/items.jsonl",
				relationships: {},
			},
		};

		const result = await Effect.runPromise(
			createPersistentEffectDatabase(config).pipe(
				Effect.flip,
				Effect.provide(layer),
				Effect.scoped,
			),
		);

		expect(result._tag).toBe("ValidationError");
	});
});
