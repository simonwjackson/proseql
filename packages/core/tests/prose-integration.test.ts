import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type {
	SerializationError,
	UnsupportedFormatError,
} from "../src/errors/storage-errors.js";
import { proseCodec } from "../src/serializers/codecs/prose.js";
import { makeSerializerLayer } from "../src/serializers/format-codec.js";
import { SerializerRegistry } from "../src/serializers/serializer-service.js";

/**
 * Integration tests for prose codec with makeSerializerLayer.
 * Task 9.3: Verify that proseCodec works correctly when registered
 * through the serializer layer and accessed via the registry service.
 */

describe("proseCodec integration with makeSerializerLayer", () => {
	describe("serialize through registry", () => {
		it("serializes records using prose extension", async () => {
			const codec = proseCodec({
				template: '#{id} "{title}" by {author}',
			});
			const ProseLayer = makeSerializerLayer([codec]);

			const run = <A>(
				effect: Effect.Effect<
					A,
					SerializationError | UnsupportedFormatError,
					SerializerRegistry
				>,
			) => Effect.runPromise(Effect.provide(effect, ProseLayer));

			const records = [
				{ id: 1, title: "Dune", author: "Frank Herbert" },
				{ id: 2, title: "Neuromancer", author: "William Gibson" },
			];

			await run(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry;
					const encoded = yield* registry.serialize(records, "prose");

					// Verify the directive is present
					expect(encoded).toContain('@prose #{id} "{title}" by {author}');

					// Verify records are encoded
					expect(encoded).toContain('#1 "Dune" by Frank Herbert');
					expect(encoded).toContain('#2 "Neuromancer" by William Gibson');
				}),
			);
		});

		it("serializes records with overflow fields", async () => {
			const codec = proseCodec({
				template: "#{id} {title}",
				overflow: ["tagged {tags}", "~ {description}"],
			});
			const ProseLayer = makeSerializerLayer([codec]);

			const records = [
				{
					id: 1,
					title: "Dune",
					tags: ["sci-fi", "classic"],
					description: "A masterpiece",
				},
			];

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;
						const encoded = yield* registry.serialize(records, "prose");

						// Verify overflow templates in directive block
						expect(encoded).toContain("tagged {tags}");
						expect(encoded).toContain("~ {description}");

						// Verify overflow values in record
						expect(encoded).toContain("tagged [sci-fi, classic]");
						expect(encoded).toContain("~ A masterpiece");
					}),
					ProseLayer,
				),
			);
		});
	});

	describe("deserialize through registry", () => {
		it("deserializes prose format content", async () => {
			const codec = proseCodec({
				template: '#{id} "{title}" by {author}',
			});
			const ProseLayer = makeSerializerLayer([codec]);

			const proseContent = `@prose #{id} "{title}" by {author}

#1 "Dune" by Frank Herbert
#2 "Neuromancer" by William Gibson`;

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;
						const decoded = yield* registry.deserialize(proseContent, "prose");

						expect(decoded).toEqual([
							{ id: 1, title: "Dune", author: "Frank Herbert" },
							{ id: 2, title: "Neuromancer", author: "William Gibson" },
						]);
					}),
					ProseLayer,
				),
			);
		});

		it("deserializes records with overflow fields", async () => {
			const codec = proseCodec({
				template: "#{id} {title}",
				overflow: ["~ {description}"],
			});
			const ProseLayer = makeSerializerLayer([codec]);

			const proseContent = `@prose #{id} {title}
  ~ {description}

#1 Dune
  ~ A sci-fi classic
#2 Neuromancer
  ~ Cyberpunk pioneer`;

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;
						const decoded = yield* registry.deserialize(proseContent, "prose");

						expect(decoded).toEqual([
							{ id: 1, title: "Dune", description: "A sci-fi classic" },
							{ id: 2, title: "Neuromancer", description: "Cyberpunk pioneer" },
						]);
					}),
					ProseLayer,
				),
			);
		});
	});

	describe("round-trip through registry", () => {
		it("serialize then deserialize produces equivalent records", async () => {
			const codec = proseCodec({
				template: '#{id} "{title}" by {author} ({year})',
				overflow: ["tagged {tags}"],
			});
			const ProseLayer = makeSerializerLayer([codec]);

			const originalRecords = [
				{
					id: 1,
					title: "Dune",
					author: "Frank Herbert",
					year: 1965,
					tags: ["sci-fi"],
				},
				{
					id: 2,
					title: "Neuromancer",
					author: "William Gibson",
					year: 1984,
					tags: ["cyberpunk"],
				},
			];

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;

						// Serialize
						const encoded = yield* registry.serialize(originalRecords, "prose");

						// Deserialize
						const decoded = yield* registry.deserialize(encoded, "prose");

						// Verify round-trip
						expect(decoded).toEqual(originalRecords);
					}),
					ProseLayer,
				),
			);
		});

		it("multiple round-trips produce consistent results", async () => {
			const codec = proseCodec({
				template: "{id}: {name} ({score})",
			});
			const ProseLayer = makeSerializerLayer([codec]);

			const records = [
				{ id: "alice", name: "Alice", score: 95 },
				{ id: "bob", name: "Bob", score: 87 },
			];

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;

						// Round-trip 1
						const encoded1 = yield* registry.serialize(records, "prose");
						const decoded1 = yield* registry.deserialize(encoded1, "prose");

						// Round-trip 2
						const encoded2 = yield* registry.serialize(decoded1, "prose");
						const decoded2 = yield* registry.deserialize(encoded2, "prose");

						// Results should be consistent
						expect(decoded1).toEqual(records);
						expect(decoded2).toEqual(records);
						expect(encoded1).toBe(encoded2);
					}),
					ProseLayer,
				),
			);
		});
	});

	describe("error handling through registry", () => {
		it("wraps encode errors in SerializationError", async () => {
			const codec = proseCodec({
				template: "#{id} {name}",
			});
			const ProseLayer = makeSerializerLayer([codec]);

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;

						// proseCodec.encode throws for non-array input
						const result = yield* registry
							.serialize({ notAnArray: true }, "prose")
							.pipe(
								Effect.matchEffect({
									onFailure: (e) => Effect.succeed(e),
									onSuccess: () => Effect.fail("should not succeed" as const),
								}),
							);

						expect(result._tag).toBe("SerializationError");
						if (result._tag === "SerializationError") {
							expect(result.format).toBe("prose");
							expect(result.message).toContain("Failed to serialize");
							expect(result.message).toContain("expects an array");
						}
					}),
					ProseLayer,
				),
			);
		});

		it("wraps decode errors in SerializationError", async () => {
			const codec = proseCodec({
				template: "#{id} {name}",
			});
			const ProseLayer = makeSerializerLayer([codec]);

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;

						// proseCodec.decode throws for missing directive
						const result = yield* registry
							.deserialize("no directive here\njust text", "prose")
							.pipe(
								Effect.matchEffect({
									onFailure: (e) => Effect.succeed(e),
									onSuccess: () => Effect.fail("should not succeed" as const),
								}),
							);

						expect(result._tag).toBe("SerializationError");
						if (result._tag === "SerializationError") {
							expect(result.format).toBe("prose");
							expect(result.message).toContain("Failed to deserialize");
							expect(result.message).toContain("No @prose directive");
						}
					}),
					ProseLayer,
				),
			);
		});
	});

	describe("registry metadata", () => {
		it("prose extension is registered correctly", async () => {
			const codec = proseCodec({
				template: "#{id} {name}",
			});
			const ProseLayer = makeSerializerLayer([codec]);

			// Verify the extension works by attempting serialization
			// If extension wasn't registered, we'd get UnsupportedFormatError
			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;
						const result = yield* registry.serialize([], "prose");
						// Should succeed without UnsupportedFormatError
						expect(result).toContain("@prose #{id} {name}");
					}),
					ProseLayer,
				),
			);
		});

		it("returns UnsupportedFormatError for unregistered extension", async () => {
			const codec = proseCodec({
				template: "#{id} {name}",
			});
			const ProseLayer = makeSerializerLayer([codec]);

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;
						return yield* registry.serialize([], "unknown").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						);
					}),
					ProseLayer,
				),
			);

			expect(result._tag).toBe("UnsupportedFormatError");
			if (result._tag === "UnsupportedFormatError") {
				expect(result.format).toBe("unknown");
				expect(result.message).toContain(".prose");
			}
		});
	});
});

/**
 * Integration tests for prose codec alongside other codecs.
 * Task 9.4: Verify that prose codec works correctly alongside other codecs
 * in the same registry without extension conflicts.
 */
import { jsonCodec } from "../src/serializers/codecs/json.js";
import { yamlCodec } from "../src/serializers/codecs/yaml.js";

describe("proseCodec alongside other codecs", () => {
	describe("multi-codec registry", () => {
		it("prose codec coexists with json and yaml codecs", async () => {
			const prose = proseCodec({
				template: '#{id} "{title}" by {author}',
			});
			const json = jsonCodec();
			const yaml = yamlCodec();
			const MultiCodecLayer = makeSerializerLayer([prose, json, yaml]);

			const records = [
				{ id: 1, title: "Dune", author: "Frank Herbert" },
				{ id: 2, title: "Neuromancer", author: "William Gibson" },
			];

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;

						// Serialize to all three formats
						const proseOutput = yield* registry.serialize(records, "prose");
						const jsonOutput = yield* registry.serialize(records, "json");
						const yamlOutput = yield* registry.serialize(records, "yaml");

						// Verify each format produces expected output
						expect(proseOutput).toContain('@prose #{id} "{title}" by {author}');
						expect(proseOutput).toContain('#1 "Dune" by Frank Herbert');

						expect(jsonOutput).toContain('"title": "Dune"');
						expect(jsonOutput).toContain('"author": "Frank Herbert"');

						expect(yamlOutput).toContain("title: Dune");
						expect(yamlOutput).toContain("author: Frank Herbert");
					}),
					MultiCodecLayer,
				),
			);
		});

		it("each codec deserializes only its own format", async () => {
			const prose = proseCodec({
				template: '#{id} "{title}" by {author}',
			});
			const json = jsonCodec();
			const yaml = yamlCodec();
			const MultiCodecLayer = makeSerializerLayer([prose, json, yaml]);

			const proseContent = `@prose #{id} "{title}" by {author}

#1 "Dune" by Frank Herbert
#2 "Neuromancer" by William Gibson`;

			const jsonContent = JSON.stringify([
				{ id: 1, title: "Dune", author: "Frank Herbert" },
				{ id: 2, title: "Neuromancer", author: "William Gibson" },
			]);

			const yamlContent = `- id: 1
  title: Dune
  author: Frank Herbert
- id: 2
  title: Neuromancer
  author: William Gibson`;

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;

						// Deserialize each format
						const proseRecords = yield* registry.deserialize(
							proseContent,
							"prose",
						);
						const jsonRecords = yield* registry.deserialize(
							jsonContent,
							"json",
						);
						const yamlRecords = yield* registry.deserialize(
							yamlContent,
							"yaml",
						);

						// All should produce equivalent records
						const expected = [
							{ id: 1, title: "Dune", author: "Frank Herbert" },
							{ id: 2, title: "Neuromancer", author: "William Gibson" },
						];

						expect(proseRecords).toEqual(expected);
						expect(jsonRecords).toEqual(expected);
						expect(yamlRecords).toEqual(expected);
					}),
					MultiCodecLayer,
				),
			);
		});

		it("round-trip through different formats produces consistent data", async () => {
			const prose = proseCodec({
				template: "#{id} {title} ({year})",
			});
			const json = jsonCodec();
			const MultiCodecLayer = makeSerializerLayer([prose, json]);

			const originalRecords = [
				{ id: 1, title: "Dune", year: 1965 },
				{ id: 2, title: "Neuromancer", year: 1984 },
			];

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;

						// Serialize to prose, deserialize, serialize to JSON, deserialize
						const proseOutput = yield* registry.serialize(
							originalRecords,
							"prose",
						);
						const fromProse = yield* registry.deserialize(proseOutput, "prose");
						const jsonOutput = yield* registry.serialize(fromProse, "json");
						const fromJson = yield* registry.deserialize(jsonOutput, "json");

						// Data should be preserved through cross-format round-trips
						expect(fromJson).toEqual(originalRecords);

						// And the reverse: JSON → prose → JSON
						const jsonFirst = yield* registry.serialize(
							originalRecords,
							"json",
						);
						const fromJsonFirst = yield* registry.deserialize(
							jsonFirst,
							"json",
						);
						const proseFromJson = yield* registry.serialize(
							fromJsonFirst,
							"prose",
						);
						const finalRecords = yield* registry.deserialize(
							proseFromJson,
							"prose",
						);

						expect(finalRecords).toEqual(originalRecords);
					}),
					MultiCodecLayer,
				),
			);
		});
	});

	describe("extension isolation", () => {
		it("prose extension does not conflict with json extension", async () => {
			const prose = proseCodec({
				template: "#{id} {name}",
			});
			const json = jsonCodec();
			const MultiCodecLayer = makeSerializerLayer([prose, json]);

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;

						// prose extension should use prose codec
						const proseResult = yield* registry.serialize(
							[{ id: 1, name: "Test" }],
							"prose",
						);
						expect(proseResult).toContain("@prose");
						expect(proseResult).toContain("#1 Test");

						// json extension should use json codec
						const jsonResult = yield* registry.serialize(
							[{ id: 1, name: "Test" }],
							"json",
						);
						expect(jsonResult).toContain('"id": 1');
						expect(jsonResult).not.toContain("@prose");
					}),
					MultiCodecLayer,
				),
			);
		});

		it("error messages list all available formats", async () => {
			const prose = proseCodec({
				template: "#{id} {name}",
			});
			const json = jsonCodec();
			const yaml = yamlCodec();
			const MultiCodecLayer = makeSerializerLayer([prose, json, yaml]);

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;
						return yield* registry.serialize([], "unknown").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						);
					}),
					MultiCodecLayer,
				),
			);

			expect(result._tag).toBe("UnsupportedFormatError");
			if (result._tag === "UnsupportedFormatError") {
				// Error message should mention all available formats
				expect(result.message).toContain(".prose");
				expect(result.message).toContain(".json");
				expect(result.message).toContain(".yaml");
				expect(result.message).toContain(".yml");
			}
		});
	});

	describe("codec ordering", () => {
		it("last codec wins when extensions conflict (but prose has unique extension)", async () => {
			// This test verifies that prose, json, and yaml each own distinct extensions
			// and there's no conflict when combined
			const prose = proseCodec({
				template: "#{id} {name}",
			});
			const json = jsonCodec();
			const yaml = yamlCodec();

			// The extensions should all be distinct
			expect(prose.extensions).toEqual(["prose"]);
			expect(json.extensions).toEqual(["json"]);
			expect(yaml.extensions).toContain("yaml");
			expect(yaml.extensions).toContain("yml");

			// No overlap
			const proseExts = new Set(prose.extensions);
			const jsonExts = new Set(json.extensions);
			const yamlExts = new Set(yaml.extensions);

			for (const ext of proseExts) {
				expect(jsonExts.has(ext)).toBe(false);
				expect(yamlExts.has(ext)).toBe(false);
			}
		});
	});

	describe("error isolation", () => {
		it("prose decode error does not affect json codec", async () => {
			const prose = proseCodec({
				template: "#{id} {name}",
			});
			const json = jsonCodec();
			const MultiCodecLayer = makeSerializerLayer([prose, json]);

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;

						// Prose decode should fail (no @prose directive)
						const proseError = yield* registry
							.deserialize("not a prose file", "prose")
							.pipe(
								Effect.matchEffect({
									onFailure: (e) => Effect.succeed(e),
									onSuccess: () => Effect.fail("should not succeed" as const),
								}),
							);

						expect(proseError._tag).toBe("SerializationError");

						// JSON decode should still work fine
						const jsonResult = yield* registry.deserialize(
							'[{"id": 1}]',
							"json",
						);
						expect(jsonResult).toEqual([{ id: 1 }]);
					}),
					MultiCodecLayer,
				),
			);
		});

		it("json decode error does not affect prose codec", async () => {
			const prose = proseCodec({
				template: "#{id} {name}",
			});
			const json = jsonCodec();
			const MultiCodecLayer = makeSerializerLayer([prose, json]);

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry;

						// JSON decode should fail (invalid JSON)
						const jsonError = yield* registry
							.deserialize("{ invalid json }", "json")
							.pipe(
								Effect.matchEffect({
									onFailure: (e) => Effect.succeed(e),
									onSuccess: () => Effect.fail("should not succeed" as const),
								}),
							);

						expect(jsonError._tag).toBe("SerializationError");

						// Prose decode should still work fine
						const proseContent = `@prose #{id} {name}

#1 Test`;
						const proseResult = yield* registry.deserialize(
							proseContent,
							"prose",
						);
						expect(proseResult).toEqual([{ id: 1, name: "Test" }]);
					}),
					MultiCodecLayer,
				),
			);
		});
	});
});
