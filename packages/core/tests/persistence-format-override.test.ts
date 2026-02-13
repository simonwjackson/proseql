import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { jsonCodec } from "../src/serializers/codecs/json.js";
import { yamlCodec } from "../src/serializers/codecs/yaml.js";
import { makeSerializerLayer } from "../src/serializers/format-codec.js";
import { makeInMemoryStorageLayer } from "../src/storage/in-memory-adapter-layer.js";
import { loadData, saveData } from "../src/storage/persistence-effect.js";

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	age: Schema.Number,
});

type User = typeof UserSchema.Type;

const makeTestEnv = () => {
	const store = new Map<string, string>();
	const layer = Layer.merge(
		makeInMemoryStorageLayer(store),
		makeSerializerLayer([jsonCodec(), yamlCodec()]),
	);
	return { store, layer };
};

describe("persistence format override", () => {
	describe("saveData with format override", () => {
		it("uses format override instead of file extension", async () => {
			const { store, layer } = makeTestEnv();
			const data: ReadonlyMap<string, User> = new Map([
				["u1", { id: "u1", name: "Alice", age: 30 }],
			]);

			await Effect.runPromise(
				Effect.provide(
					saveData("/data/users.md", UserSchema, data, { format: "yaml" }),
					layer,
				),
			);

			// File should contain YAML, not markdown
			const content = store.get("/data/users.md")!;
			expect(content).toContain("id:");
			expect(content).toContain("name: Alice");
		});

		it("falls back to extension when format is not provided", async () => {
			const { store, layer } = makeTestEnv();
			const data: ReadonlyMap<string, User> = new Map([
				["u1", { id: "u1", name: "Alice", age: 30 }],
			]);

			await Effect.runPromise(
				Effect.provide(saveData("/data/users.json", UserSchema, data), layer),
			);

			const content = store.get("/data/users.json")!;
			expect(content).toContain('"id"');
		});
	});

	describe("loadData with format override", () => {
		it("uses format override instead of file extension", async () => {
			const { layer } = makeTestEnv();

			// Save as YAML but to a .md file
			const data: ReadonlyMap<string, User> = new Map([
				["u1", { id: "u1", name: "Alice", age: 30 }],
			]);

			await Effect.runPromise(
				Effect.provide(
					saveData("/data/users.md", UserSchema, data, { format: "yaml" }),
					layer,
				),
			);

			// Load it back using the same format override
			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.md", UserSchema, { format: "yaml" }),
					layer,
				),
			);

			expect(result.size).toBe(1);
			const user = result.get("u1");
			expect(user).toEqual({ id: "u1", name: "Alice", age: 30 });
		});
	});

	describe("round-trip with format override", () => {
		it("save then load with format override preserves data", async () => {
			const { layer } = makeTestEnv();

			const original: ReadonlyMap<string, User> = new Map([
				["u1", { id: "u1", name: "Alice", age: 30 }],
				["u2", { id: "u2", name: "Bob", age: 25 }],
			]);

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						yield* saveData("/notes/people.txt", UserSchema, original, {
							format: "json",
						});
						return yield* loadData("/notes/people.txt", UserSchema, {
							format: "json",
						});
					}),
					layer,
				),
			);

			expect(result.size).toBe(2);
			expect(result.get("u1")).toEqual({ id: "u1", name: "Alice", age: 30 });
			expect(result.get("u2")).toEqual({ id: "u2", name: "Bob", age: 25 });
		});
	});
});
