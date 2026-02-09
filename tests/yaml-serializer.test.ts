import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import {
	serializeYaml,
	deserializeYaml,
	YamlSerializerLayer,
	makeYamlSerializerLayer,
} from "../core/serializers/yaml.js"
import { SerializerRegistry } from "../core/serializers/serializer-service.js"

// ============================================================================
// Direct Effect-based serialize/deserialize
// ============================================================================

describe("serializeYaml", () => {
	it("serializes an object to YAML", async () => {
		const result = await Effect.runPromise(
			serializeYaml({ id: "1", name: "Alice" }),
		)
		expect(result).toContain("id: \"1\"")
		expect(result).toContain("name: Alice")
	})

	it("serializes nested objects", async () => {
		const result = await Effect.runPromise(
			serializeYaml({ user: { name: "Bob", age: 30 } }),
		)
		expect(result).toContain("user:")
		expect(result).toContain("name: Bob")
		expect(result).toContain("age: 30")
	})

	it("serializes arrays", async () => {
		const result = await Effect.runPromise(
			serializeYaml({ tags: ["a", "b", "c"] }),
		)
		expect(result).toContain("tags:")
		expect(result).toContain("- a")
		expect(result).toContain("- b")
		expect(result).toContain("- c")
	})

	it("respects custom indent option", async () => {
		const result = await Effect.runPromise(
			serializeYaml({ nested: { key: "value" } }, { indent: 4 }),
		)
		expect(result).toContain("    key: value")
	})
})

describe("deserializeYaml", () => {
	it("deserializes valid YAML string", async () => {
		const result = await Effect.runPromise(
			deserializeYaml("id: \"1\"\nname: Bob\n"),
		)
		expect(result).toEqual({ id: "1", name: "Bob" })
	})

	it("deserializes YAML arrays", async () => {
		const result = await Effect.runPromise(
			deserializeYaml("- a\n- b\n- c\n"),
		)
		expect(result).toEqual(["a", "b", "c"])
	})

	it("deserializes nested YAML", async () => {
		const result = await Effect.runPromise(
			deserializeYaml("user:\n  name: Alice\n  age: 25\n"),
		)
		expect(result).toEqual({ user: { name: "Alice", age: 25 } })
	})

	it("fails with SerializationError for invalid YAML", async () => {
		// Use content that the yaml parser will reject
		const invalidYaml = ":\n  - :\n    :\n  bad: [unterminated"
		const result = await Effect.runPromise(
			deserializeYaml(invalidYaml).pipe(
				Effect.matchEffect({
					onFailure: (e) => Effect.succeed(e),
					onSuccess: () => Effect.fail("should not succeed" as const),
				}),
			),
		)
		expect(result._tag).toBe("SerializationError")
		if (result._tag === "SerializationError") {
			expect(result.format).toBe("yaml")
		}
	})
})

// ============================================================================
// Round-trip
// ============================================================================

describe("YAML round-trip", () => {
	it("serialize then deserialize preserves data", async () => {
		const data = { id: "42", tags: ["a", "b"], nested: { x: 1 } }
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const yaml = yield* serializeYaml(data)
				return yield* deserializeYaml(yaml)
			}),
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
			Effect.gen(function* () {
				const yaml = yield* serializeYaml(data)
				return yield* deserializeYaml(yaml)
			}),
		)
		expect(result).toEqual(data)
	})
})

// ============================================================================
// YamlSerializerLayer (as SerializerRegistry)
// ============================================================================

describe("YamlSerializerLayer", () => {
	const run = <A>(
		effect: Effect.Effect<A, unknown, SerializerRegistry>,
	) => Effect.runPromise(Effect.provide(effect, YamlSerializerLayer))

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

	it("supports custom options via makeYamlSerializerLayer", async () => {
		const customLayer = makeYamlSerializerLayer({ indent: 4 })
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
