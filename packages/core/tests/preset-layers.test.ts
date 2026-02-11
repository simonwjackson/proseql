import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type {
	SerializationError,
	UnsupportedFormatError,
} from "../src/errors/storage-errors.js";
import {
	AllTextFormatsLayer,
	DefaultSerializerLayer,
} from "../src/serializers/presets.js";
import { SerializerRegistry } from "../src/serializers/serializer-service.js";

/**
 * Tests for preset Layers:
 * - AllTextFormatsLayer: dispatches all 7 extensions (json, yaml, yml, json5, jsonc, toml, toon, hjson)
 * - DefaultSerializerLayer: dispatches json/yaml only
 */

const testData = { id: "1", name: "test", active: true, count: 42 };

// Helper to run with AllTextFormatsLayer
const runWithAllFormats = <A>(
	effect: Effect.Effect<
		A,
		SerializationError | UnsupportedFormatError,
		SerializerRegistry
	>,
) => Effect.runPromise(Effect.provide(effect, AllTextFormatsLayer));

// Helper to run with DefaultSerializerLayer
const runWithDefault = <A>(
	effect: Effect.Effect<
		A,
		SerializationError | UnsupportedFormatError,
		SerializerRegistry
	>,
) => Effect.runPromise(Effect.provide(effect, DefaultSerializerLayer));

describe("AllTextFormatsLayer", () => {
	const allExtensions = [
		"json",
		"yaml",
		"yml",
		"json5",
		"jsonc",
		"toml",
		"toon",
		"hjson",
	];

	it("serializes to all 8 extensions (7 codecs, yaml has 2 extensions)", async () => {
		await runWithAllFormats(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry;

				for (const ext of allExtensions) {
					const result = yield* registry.serialize(testData, ext);
					expect(result).toBeTruthy();
					expect(typeof result).toBe("string");
				}
			}),
		);
	});

	it("deserializes from all 8 extensions", async () => {
		await runWithAllFormats(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry;

				for (const ext of allExtensions) {
					// First serialize, then deserialize
					const serialized = yield* registry.serialize(testData, ext);
					const deserialized = yield* registry.deserialize(serialized, ext);

					// TOML strips null values, but our test data has none, so round-trip should work
					expect(deserialized).toEqual(testData);
				}
			}),
		);
	});

	describe("each format produces distinct output", () => {
		it("json produces JSON format", async () => {
			const result = await runWithAllFormats(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry;
					return yield* registry.serialize(testData, "json");
				}),
			);
			expect(result).toContain('"id"');
			expect(result).toContain('"name"');
		});

		it("yaml/yml produces YAML format", async () => {
			const result = await runWithAllFormats(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry;
					return yield* registry.serialize(testData, "yaml");
				}),
			);
			expect(result).toContain("id:");
			expect(result).toContain("name:");
			expect(result).not.toContain('"id"');
		});

		it("yml extension uses same codec as yaml", async () => {
			const [yamlResult, ymlResult] = await runWithAllFormats(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry;
					const yaml = yield* registry.serialize(testData, "yaml");
					const yml = yield* registry.serialize(testData, "yml");
					return [yaml, yml];
				}),
			);
			expect(yamlResult).toEqual(ymlResult);
		});

		it("toml produces TOML format", async () => {
			const result = await runWithAllFormats(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry;
					return yield* registry.serialize(testData, "toml");
				}),
			);
			expect(result).toContain("id =");
			expect(result).toContain("name =");
		});

		it("hjson produces Hjson format", async () => {
			const result = await runWithAllFormats(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry;
					return yield* registry.serialize(testData, "hjson");
				}),
			);
			// Hjson can have unquoted keys or quoted keys, but will have different formatting than JSON
			expect(result).toBeTruthy();
		});
	});

	it("fails with UnsupportedFormatError for unknown extension", async () => {
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry;
					return yield* registry.serialize(testData, "xml").pipe(
						Effect.match({
							onFailure: (e) => e,
							onSuccess: () => {
								throw new Error("should not succeed");
							},
						}),
					);
				}),
				AllTextFormatsLayer,
			),
		);

		expect(result._tag).toBe("UnsupportedFormatError");
		if (result._tag === "UnsupportedFormatError") {
			expect(result.format).toBe("xml");
			expect(result.message).toContain("Available formats");
		}
	});
});

describe("DefaultSerializerLayer", () => {
	describe("supported extensions", () => {
		const supportedExtensions = ["json", "yaml", "yml"];

		it("serializes to json, yaml, and yml", async () => {
			await runWithDefault(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry;

					for (const ext of supportedExtensions) {
						const result = yield* registry.serialize(testData, ext);
						expect(result).toBeTruthy();
						expect(typeof result).toBe("string");
					}
				}),
			);
		});

		it("deserializes from json, yaml, and yml", async () => {
			await runWithDefault(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry;

					for (const ext of supportedExtensions) {
						const serialized = yield* registry.serialize(testData, ext);
						const deserialized = yield* registry.deserialize(serialized, ext);
						expect(deserialized).toEqual(testData);
					}
				}),
			);
		});
	});

	describe("unsupported extensions", () => {
		const unsupportedExtensions = ["json5", "jsonc", "toml", "toon", "hjson"];

		for (const ext of unsupportedExtensions) {
			it(`fails with UnsupportedFormatError for .${ext}`, async () => {
				const result = await Effect.runPromise(
					Effect.provide(
						Effect.gen(function* () {
							const registry = yield* SerializerRegistry;
							return yield* registry.serialize(testData, ext).pipe(
								Effect.match({
									onFailure: (e) => e,
									onSuccess: () => {
										throw new Error("should not succeed");
									},
								}),
							);
						}),
						DefaultSerializerLayer,
					),
				);

				expect(result._tag).toBe("UnsupportedFormatError");
				if (result._tag === "UnsupportedFormatError") {
					expect(result.format).toBe(ext);
					expect(result.message).toContain(`Unsupported format '.${ext}'`);
					expect(result.message).toContain("Available formats");
					// Should list only json and yaml as available
					expect(result.message).toContain(".json");
					expect(result.message).toContain(".yaml");
				}
			});
		}

		it("error message only lists json and yaml as available formats", async () => {
			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;
						return yield* registry.serialize(testData, "xml").pipe(
							Effect.match({
								onFailure: (e) => e,
								onSuccess: () => {
									throw new Error("should not succeed");
								},
							}),
						);
					}),
					DefaultSerializerLayer,
				),
			);

			expect(result._tag).toBe("UnsupportedFormatError");
			if (result._tag === "UnsupportedFormatError") {
				// Parse the available formats from the message
				const availableFormatsMatch = result.message.match(
					/Available formats: (.+)$/,
				);
				expect(availableFormatsMatch).toBeTruthy();
				const availableFormats = availableFormatsMatch?.[1];

				// Should contain json, yaml, yml
				expect(availableFormats).toContain(".json");
				expect(availableFormats).toContain(".yaml");
				expect(availableFormats).toContain(".yml");

				// Should NOT contain formats that are only in AllTextFormatsLayer
				expect(availableFormats).not.toContain(".json5");
				expect(availableFormats).not.toContain(".jsonc");
				expect(availableFormats).not.toContain(".toml");
				expect(availableFormats).not.toContain(".toon");
				expect(availableFormats).not.toContain(".hjson");
			}
		});
	});
});
