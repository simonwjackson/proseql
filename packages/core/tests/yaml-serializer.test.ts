import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { makeSerializerLayer } from "../src/serializers/format-codec.js"
import { yamlCodec } from "../src/serializers/codecs/yaml.js"
import { SerializerRegistry } from "../src/serializers/serializer-service.js"

// ============================================================================
// YAML serialization via SerializerRegistry
// ============================================================================

describe("YAML serialization via registry", () => {
	const YamlLayer = makeSerializerLayer([yamlCodec()])

	const run = <A>(effect: Effect.Effect<A, unknown, SerializerRegistry>) =>
		Effect.runPromise(Effect.provide(effect, YamlLayer))

	it("serializes an object to YAML", async () => {
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.serialize({ id: "1", name: "Alice" }, "yaml")
			}),
		)
		expect(result).toContain("id: \"1\"")
		expect(result).toContain("name: Alice")
	})

	it("serializes nested objects", async () => {
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.serialize(
					{ user: { name: "Bob", age: 30 } },
					"yaml",
				)
			}),
		)
		expect(result).toContain("user:")
		expect(result).toContain("name: Bob")
		expect(result).toContain("age: 30")
	})

	it("serializes arrays", async () => {
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.serialize({ tags: ["a", "b", "c"] }, "yaml")
			}),
		)
		expect(result).toContain("tags:")
		expect(result).toContain("- a")
		expect(result).toContain("- b")
		expect(result).toContain("- c")
	})

	it("respects custom indent option via codec configuration", async () => {
		const customLayer = makeSerializerLayer([yamlCodec({ indent: 4 })])
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry
					return yield* registry.serialize(
						{ nested: { key: "value" } },
						"yaml",
					)
				}),
				customLayer,
			),
		)
		expect(result).toContain("    key: value")
	})
})

describe("YAML deserialization via registry", () => {
	const YamlLayer = makeSerializerLayer([yamlCodec()])

	const run = <A>(effect: Effect.Effect<A, unknown, SerializerRegistry>) =>
		Effect.runPromise(Effect.provide(effect, YamlLayer))

	it("deserializes valid YAML string", async () => {
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.deserialize("id: \"1\"\nname: Bob\n", "yaml")
			}),
		)
		expect(result).toEqual({ id: "1", name: "Bob" })
	})

	it("deserializes YAML arrays", async () => {
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.deserialize("- a\n- b\n- c\n", "yaml")
			}),
		)
		expect(result).toEqual(["a", "b", "c"])
	})

	it("deserializes nested YAML", async () => {
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.deserialize(
					"user:\n  name: Alice\n  age: 25\n",
					"yaml",
				)
			}),
		)
		expect(result).toEqual({ user: { name: "Alice", age: 25 } })
	})

	it("fails with SerializationError for invalid YAML", async () => {
		// Use content that the yaml parser will reject
		const invalidYaml = ":\n  - :\n    :\n  bad: [unterminated"
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.deserialize(invalidYaml, "yaml").pipe(
					Effect.matchEffect({
						onFailure: (e) => Effect.succeed(e),
						onSuccess: () => Effect.fail("should not succeed" as const),
					}),
				)
			}),
		)
		expect((result as { _tag: string })._tag).toBe("SerializationError")
		if ((result as { _tag: string })._tag === "SerializationError") {
			expect((result as { format: string }).format).toBe("yaml")
		}
	})
})

// ============================================================================
// Round-trip
// ============================================================================

describe("YAML round-trip", () => {
	const YamlLayer = makeSerializerLayer([yamlCodec()])

	it("serialize then deserialize preserves data", async () => {
		const data = { id: "42", tags: ["a", "b"], nested: { x: 1 } }
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry
					const yaml = yield* registry.serialize(data, "yaml")
					return yield* registry.deserialize(yaml, "yaml")
				}),
				YamlLayer,
			),
		)
		expect(result).toEqual(data)
	})

	it("handles various data types", async () => {
		const data = {
			str: "hello",
			num: 42,
			float: 3.14,
			bool: true,
			nullVal: null,
			arr: [1, 2, 3],
		}
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry
					const yaml = yield* registry.serialize(data, "yaml")
					return yield* registry.deserialize(yaml, "yaml")
				}),
				YamlLayer,
			),
		)
		expect(result).toEqual(data)
	})
})

// ============================================================================
// makeSerializerLayer with yamlCodec (as SerializerRegistry)
// ============================================================================

describe("makeSerializerLayer with yamlCodec", () => {
	const YamlLayer = makeSerializerLayer([yamlCodec()])

	const run = <A>(effect: Effect.Effect<A, unknown, SerializerRegistry>) =>
		Effect.runPromise(Effect.provide(effect, YamlLayer))

	it("serialize and deserialize round-trip via the service with 'yaml' extension", async () => {
		const data = { id: "1", name: "Alice" }
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				const yaml = yield* registry.serialize(data, "yaml")
				return yield* registry.deserialize(yaml, "yaml")
			}),
		)
		expect(result).toEqual(data)
	})

	it("supports 'yml' extension", async () => {
		const data = { id: "2", active: true }
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				const yaml = yield* registry.serialize(data, "yml")
				return yield* registry.deserialize(yaml, "yml")
			}),
		)
		expect(result).toEqual(data)
	})

	it("rejects unsupported extensions with UnsupportedFormatError", async () => {
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.serialize({ a: 1 }, "json").pipe(
					Effect.matchEffect({
						onFailure: (e) => Effect.succeed(e),
						onSuccess: () => Effect.fail("should not succeed" as const),
					}),
				)
			}),
		)
		expect((result as { _tag: string })._tag).toBe("UnsupportedFormatError")
	})

	it("fails with SerializationError for invalid YAML content", async () => {
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.deserialize("bad: [unterminated", "yaml").pipe(
					Effect.matchEffect({
						onFailure: (e) => Effect.succeed(e),
						onSuccess: () => Effect.fail("should not succeed" as const),
					}),
				)
			}),
		)
		expect((result as { _tag: string })._tag).toBe("SerializationError")
	})

	it("supports custom options via yamlCodec configuration", async () => {
		const customLayer = makeSerializerLayer([yamlCodec({ indent: 4 })])
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry
					return yield* registry.serialize({ nested: { key: "val" } }, "yaml")
				}),
				customLayer,
			),
		)
		expect(result).toContain("    key: val")
	})
})
