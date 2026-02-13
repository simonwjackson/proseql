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
				{ id: 1, title: "Dune", author: "Frank Herbert", year: 1965, tags: ["sci-fi"] },
				{ id: 2, title: "Neuromancer", author: "William Gibson", year: 1984, tags: ["cyberpunk"] },
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
