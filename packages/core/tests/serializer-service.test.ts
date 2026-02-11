import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { SerializerRegistry } from "../core/serializers/serializer-service.js"
import {
	SerializationError,
	UnsupportedFormatError,
} from "../core/errors/storage-errors.js"
import { makeSerializerLayer } from "../core/serializers/format-codec.js"
import { jsonCodec } from "../core/serializers/codecs/json.js"
import { yamlCodec } from "../core/serializers/codecs/yaml.js"

// Single-format layer for basic tests
const JsonOnlyLayer = makeSerializerLayer([jsonCodec()])

// Multi-format layer to verify dispatch
const MultiFormatLayer = makeSerializerLayer([jsonCodec(), yamlCodec()])

describe("SerializerRegistry service", () => {
	describe("single-format registry (JSON only)", () => {
		const run = <A>(
			effect: Effect.Effect<
				A,
				SerializationError | UnsupportedFormatError,
				SerializerRegistry
			>,
		) => Effect.runPromise(Effect.provide(effect, JsonOnlyLayer))

		it("serialize and deserialize round-trip via the service", async () => {
			const data = { id: "1", name: "Alice" }
			const result = await run(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry
					const json = yield* registry.serialize(data, "json")
					return yield* registry.deserialize(json, "json")
				}),
			)
			expect(result).toEqual({ id: "1", name: "Alice" })
		})

		it("unsupported extension fails with UnsupportedFormatError", async () => {
			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry
						return yield* registry.serialize({ a: 1 }, "xml").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						)
					}),
					JsonOnlyLayer,
				),
			)
			expect(result._tag).toBe("UnsupportedFormatError")
			if (result._tag === "UnsupportedFormatError") {
				expect(result.format).toBe("xml")
			}
		})

		it("invalid JSON content fails with SerializationError", async () => {
			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry
						return yield* registry.deserialize("{bad json", "json").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						)
					}),
					JsonOnlyLayer,
				),
			)
			expect(result._tag).toBe("SerializationError")
			if (result._tag === "SerializationError") {
				expect(result.format).toBe("json")
			}
		})
	})

	describe("multi-format registry (JSON + YAML)", () => {
		const run = <A>(
			effect: Effect.Effect<
				A,
				SerializationError | UnsupportedFormatError,
				SerializerRegistry
			>,
		) => Effect.runPromise(Effect.provide(effect, MultiFormatLayer))

		it("dispatches to JSON codec for .json extension", async () => {
			const data = { id: "1", name: "Alice" }
			const result = await run(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry
					const json = yield* registry.serialize(data, "json")
					// Verify it's valid JSON output (not YAML)
					expect(json).toContain('"id"')
					expect(json).toContain('"name"')
					return yield* registry.deserialize(json, "json")
				}),
			)
			expect(result).toEqual({ id: "1", name: "Alice" })
		})

		it("dispatches to YAML codec for .yaml extension", async () => {
			const data = { id: "1", name: "Alice" }
			const result = await run(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry
					const yaml = yield* registry.serialize(data, "yaml")
					// Verify it's YAML output (no quotes around keys by default)
					expect(yaml).toContain("id:")
					expect(yaml).toContain("name:")
					expect(yaml).not.toContain('"id"')
					return yield* registry.deserialize(yaml, "yaml")
				}),
			)
			expect(result).toEqual({ id: "1", name: "Alice" })
		})

		it("dispatches to YAML codec for .yml extension", async () => {
			const data = { greeting: "hello" }
			const result = await run(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry
					const yaml = yield* registry.serialize(data, "yml")
					return yield* registry.deserialize(yaml, "yml")
				}),
			)
			expect(result).toEqual({ greeting: "hello" })
		})

		it("can serialize to one format and deserialize from another (cross-format)", async () => {
			const data = { count: 42, items: ["a", "b", "c"] }
			const result = await run(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry
					// Serialize as JSON
					const json = yield* registry.serialize(data, "json")
					// The JSON content happens to also be valid YAML
					// Deserialize as YAML (YAML is a superset of JSON)
					return yield* registry.deserialize(json, "yaml")
				}),
			)
			expect(result).toEqual({ count: 42, items: ["a", "b", "c"] })
		})

		it("unsupported extension fails even with multiple formats registered", async () => {
			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry
						return yield* registry.serialize({ a: 1 }, "toml").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						)
					}),
					MultiFormatLayer,
				),
			)
			expect(result._tag).toBe("UnsupportedFormatError")
			if (result._tag === "UnsupportedFormatError") {
				expect(result.format).toBe("toml")
				// Error message should list available formats
				expect(result.message).toContain(".json")
				expect(result.message).toContain(".yaml")
			}
		})

		it("invalid YAML content fails with SerializationError", async () => {
			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry
						// Invalid YAML (tabs as indentation are problematic)
						return yield* registry
							.deserialize("key:\n\t- invalid yaml structure\n\t\t- :", "yaml")
							.pipe(
								Effect.matchEffect({
									onFailure: (e) => Effect.succeed(e),
									onSuccess: () => Effect.fail("should not succeed" as const),
								}),
							)
					}),
					MultiFormatLayer,
				),
			)
			expect(result._tag).toBe("SerializationError")
			if (result._tag === "SerializationError") {
				expect(result.format).toBe("yaml")
			}
		})
	})
})
