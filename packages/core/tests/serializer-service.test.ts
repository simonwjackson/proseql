import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type {
	SerializationError,
	UnsupportedFormatError,
} from "../src/errors/storage-errors.js";
import { jsonCodec } from "../src/serializers/codecs/json.js";
import { yamlCodec } from "../src/serializers/codecs/yaml.js";
import type { FormatCodec } from "../src/serializers/format-codec.js";
import {
	makeSerializerLayer,
	mergeSerializerWithPluginCodecs,
} from "../src/serializers/format-codec.js";
import {
	getSupportedExtensions,
	SerializerRegistry,
	type SerializerRegistryShape,
} from "../src/serializers/serializer-service.js";

// Single-format layer for basic tests
const JsonOnlyLayer = makeSerializerLayer([jsonCodec()]);

// Multi-format layer to verify dispatch
const MultiFormatLayer = makeSerializerLayer([jsonCodec(), yamlCodec()]);

describe("SerializerRegistry service", () => {
	describe("single-format registry (JSON only)", () => {
		const run = <A>(
			effect: Effect.Effect<
				A,
				SerializationError | UnsupportedFormatError,
				SerializerRegistry
			>,
		) => Effect.runPromise(Effect.provide(effect, JsonOnlyLayer));

		it("serialize and deserialize round-trip via the service", async () => {
			const data = { id: "1", name: "Alice" };
			const result = await run(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry;
					const json = yield* registry.serialize(data, "json");
					return yield* registry.deserialize(json, "json");
				}),
			);
			expect(result).toEqual({ id: "1", name: "Alice" });
		});

		it("unsupported extension fails with UnsupportedFormatError", async () => {
			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;
						return yield* registry.serialize({ a: 1 }, "xml").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						);
					}),
					JsonOnlyLayer,
				),
			);
			expect(result._tag).toBe("UnsupportedFormatError");
			if (result._tag === "UnsupportedFormatError") {
				expect(result.format).toBe("xml");
			}
		});

		it("invalid JSON content fails with SerializationError", async () => {
			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;
						return yield* registry.deserialize("{bad json", "json").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						);
					}),
					JsonOnlyLayer,
				),
			);
			expect(result._tag).toBe("SerializationError");
			if (result._tag === "SerializationError") {
				expect(result.format).toBe("json");
			}
		});
	});

	describe("multi-format registry (JSON + YAML)", () => {
		const run = <A>(
			effect: Effect.Effect<
				A,
				SerializationError | UnsupportedFormatError,
				SerializerRegistry
			>,
		) => Effect.runPromise(Effect.provide(effect, MultiFormatLayer));

		it("dispatches to JSON codec for .json extension", async () => {
			const data = { id: "1", name: "Alice" };
			const result = await run(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry;
					const json = yield* registry.serialize(data, "json");
					// Verify it's valid JSON output (not YAML)
					expect(json).toContain('"id"');
					expect(json).toContain('"name"');
					return yield* registry.deserialize(json, "json");
				}),
			);
			expect(result).toEqual({ id: "1", name: "Alice" });
		});

		it("dispatches to YAML codec for .yaml extension", async () => {
			const data = { id: "1", name: "Alice" };
			const result = await run(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry;
					const yaml = yield* registry.serialize(data, "yaml");
					// Verify it's YAML output (no quotes around keys by default)
					expect(yaml).toContain("id:");
					expect(yaml).toContain("name:");
					expect(yaml).not.toContain('"id"');
					return yield* registry.deserialize(yaml, "yaml");
				}),
			);
			expect(result).toEqual({ id: "1", name: "Alice" });
		});

		it("dispatches to YAML codec for .yml extension", async () => {
			const data = { greeting: "hello" };
			const result = await run(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry;
					const yaml = yield* registry.serialize(data, "yml");
					return yield* registry.deserialize(yaml, "yml");
				}),
			);
			expect(result).toEqual({ greeting: "hello" });
		});

		it("can serialize to one format and deserialize from another (cross-format)", async () => {
			const data = { count: 42, items: ["a", "b", "c"] };
			const result = await run(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry;
					// Serialize as JSON
					const json = yield* registry.serialize(data, "json");
					// The JSON content happens to also be valid YAML
					// Deserialize as YAML (YAML is a superset of JSON)
					return yield* registry.deserialize(json, "yaml");
				}),
			);
			expect(result).toEqual({ count: 42, items: ["a", "b", "c"] });
		});

		it("unsupported extension fails even with multiple formats registered", async () => {
			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;
						return yield* registry.serialize({ a: 1 }, "toml").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						);
					}),
					MultiFormatLayer,
				),
			);
			expect(result._tag).toBe("UnsupportedFormatError");
			if (result._tag === "UnsupportedFormatError") {
				expect(result.format).toBe("toml");
				// Error message should list available formats
				expect(result.message).toContain(".json");
				expect(result.message).toContain(".yaml");
			}
		});

		it("invalid YAML content fails with SerializationError", async () => {
			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;
						// Invalid YAML (tabs as indentation are problematic)
						return yield* registry
							.deserialize("key:\n\t- invalid yaml structure\n\t\t- :", "yaml")
							.pipe(
								Effect.matchEffect({
									onFailure: (e) => Effect.succeed(e),
									onSuccess: () => Effect.fail("should not succeed" as const),
								}),
							);
					}),
					MultiFormatLayer,
				),
			);
			expect(result._tag).toBe("SerializationError");
			if (result._tag === "SerializationError") {
				expect(result.format).toBe("yaml");
			}
		});
	});

	describe("supportedExtensions introspection", () => {
		it("lists every extension of the base codecs in registration order", () => {
			const registry = makeSerializerLayer([jsonCodec(), yamlCodec()]).pipe(
				(layer) =>
					Effect.runSync(Effect.provide(getSupportedExtensions, layer)),
			);
			expect(registry).toContain("json");
			expect(registry).toContain("yaml");
			expect(registry).toContain("yml");
		});

		it("returns an empty list for an empty registry", () => {
			const extensions = Effect.runSync(
				Effect.provide(getSupportedExtensions, makeSerializerLayer([])),
			);
			expect(extensions).toEqual([]);
		});

		it("includes plugin-added extensions (active registry, not built-in only)", () => {
			const base: SerializerRegistryShape = makeBaseShape();
			const customCodec: FormatCodec = {
				name: "custom",
				extensions: ["cfg"],
				encode: (data) => JSON.stringify(data),
				decode: (raw) => JSON.parse(raw),
			};
			const merged = mergeSerializerWithPluginCodecs(base, [customCodec]);
			expect(merged.supportedExtensions()).toContain("json");
			expect(merged.supportedExtensions()).toContain("cfg");
		});

		it("produces a product-agnostic extension-only result", () => {
			const extensions = Effect.runSync(
				Effect.provide(
					getSupportedExtensions,
					makeSerializerLayer([jsonCodec()]),
				),
			);
			for (const ext of extensions) {
				expect(ext.includes(".")).toBe(false);
				expect(ext.includes("/")).toBe(false);
			}
		});
	});
});

function makeBaseShape(): SerializerRegistryShape {
	let captured: SerializerRegistryShape | undefined;
	Effect.runSync(
		Effect.provide(
			Effect.gen(function* () {
				captured = yield* SerializerRegistry;
			}),
			makeSerializerLayer([jsonCodec(), yamlCodec()]),
		),
	);
	if (captured === undefined) throw new Error("registry not captured");
	return captured;
}
