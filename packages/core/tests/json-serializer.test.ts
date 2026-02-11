import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { makeSerializerLayer } from "../core/serializers/format-codec.js"
import { jsonCodec } from "../core/serializers/codecs/json.js"
import { SerializerRegistry } from "../core/serializers/serializer-service.js"

// ============================================================================
// JSON serialization via SerializerRegistry
// ============================================================================

describe("JSON serialization via registry", () => {
	const JsonLayer = makeSerializerLayer([jsonCodec()])

	const run = <A>(effect: Effect.Effect<A, unknown, SerializerRegistry>) =>
		Effect.runPromise(Effect.provide(effect, JsonLayer))

	it("serializes an object to formatted JSON", async () => {
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.serialize({ id: "1", name: "Alice" }, "json")
			}),
		)
		expect(result).toBe('{\n  "id": "1",\n  "name": "Alice"\n}')
	})

	it("respects custom indent option via codec configuration", async () => {
		const customLayer = makeSerializerLayer([jsonCodec({ indent: 4 })])
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry
					return yield* registry.serialize({ a: 1 }, "json")
				}),
				customLayer,
			),
		)
		expect(result).toBe('{\n    "a": 1\n}')
	})

	it("produces compact JSON with indent: 0", async () => {
		const compactLayer = makeSerializerLayer([jsonCodec({ indent: 0 })])
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry
					return yield* registry.serialize({ a: 1, b: 2 }, "json")
				}),
				compactLayer,
			),
		)
		expect(result).toBe('{"a":1,"b":2}')
	})

	it("fails with SerializationError for circular references", async () => {
		const circular: Record<string, unknown> = {}
		circular.self = circular
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.serialize(circular, "json").pipe(
					Effect.matchEffect({
						onFailure: (e) => Effect.succeed(e),
						onSuccess: () => Effect.fail("should not succeed" as const),
					}),
				)
			}),
		)
		expect((result as { _tag: string })._tag).toBe("SerializationError")
		if ((result as { _tag: string })._tag === "SerializationError") {
			expect((result as { format: string }).format).toBe("json")
		}
	})
})

describe("JSON deserialization via registry", () => {
	const JsonLayer = makeSerializerLayer([jsonCodec()])

	const run = <A>(effect: Effect.Effect<A, unknown, SerializerRegistry>) =>
		Effect.runPromise(Effect.provide(effect, JsonLayer))

	it("deserializes valid JSON string", async () => {
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.deserialize('{"id":"1","name":"Bob"}', "json")
			}),
		)
		expect(result).toEqual({ id: "1", name: "Bob" })
	})

	it("fails with SerializationError for invalid JSON", async () => {
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.deserialize("{bad json", "json").pipe(
					Effect.matchEffect({
						onFailure: (e) => Effect.succeed(e),
						onSuccess: () => Effect.fail("should not succeed" as const),
					}),
				)
			}),
		)
		expect((result as { _tag: string })._tag).toBe("SerializationError")
		if ((result as { _tag: string })._tag === "SerializationError") {
			expect((result as { format: string }).format).toBe("json")
		}
	})
})

// ============================================================================
// Round-trip
// ============================================================================

describe("JSON round-trip", () => {
	const JsonLayer = makeSerializerLayer([jsonCodec()])

	it("serialize then deserialize preserves data", async () => {
		const data = { id: "42", tags: ["a", "b"], nested: { x: 1 } }
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry
					const json = yield* registry.serialize(data, "json")
					return yield* registry.deserialize(json, "json")
				}),
				JsonLayer,
			),
		)
		expect(result).toEqual(data)
	})
})

// ============================================================================
// makeSerializerLayer with jsonCodec (as SerializerRegistry)
// ============================================================================

describe("makeSerializerLayer with jsonCodec", () => {
	const JsonLayer = makeSerializerLayer([jsonCodec()])

	const run = <A>(effect: Effect.Effect<A, unknown, SerializerRegistry>) =>
		Effect.runPromise(Effect.provide(effect, JsonLayer))

	it("serialize and deserialize round-trip via the service", async () => {
		const data = { id: "1", name: "Alice" }
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				const json = yield* registry.serialize(data, "json")
				return yield* registry.deserialize(json, "json")
			}),
		)
		expect(result).toEqual(data)
	})

	it("rejects unsupported extensions with UnsupportedFormatError", async () => {
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.serialize({ a: 1 }, "yaml").pipe(
					Effect.matchEffect({
						onFailure: (e) => Effect.succeed(e),
						onSuccess: () => Effect.fail("should not succeed" as const),
					}),
				)
			}),
		)
		expect((result as { _tag: string })._tag).toBe("UnsupportedFormatError")
	})

	it("fails with SerializationError for invalid JSON content", async () => {
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.deserialize("not valid json", "json").pipe(
					Effect.matchEffect({
						onFailure: (e) => Effect.succeed(e),
						onSuccess: () => Effect.fail("should not succeed" as const),
					}),
				)
			}),
		)
		expect((result as { _tag: string })._tag).toBe("SerializationError")
	})

	it("supports custom options via jsonCodec configuration", async () => {
		const customLayer = makeSerializerLayer([jsonCodec({ indent: 0 })])
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry
					return yield* registry.serialize({ a: 1 }, "json")
				}),
				customLayer,
			),
		)
		expect(result).toBe('{"a":1}')
	})
})
