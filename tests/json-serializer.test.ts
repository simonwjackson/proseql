import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import {
	serializeJson,
	deserializeJson,
	JsonSerializerLayer,
	makeJsonSerializerLayer,
} from "../core/serializers/json.js"
import { SerializerRegistry } from "../core/serializers/serializer-service.js"

// ============================================================================
// Direct Effect-based serialize/deserialize
// ============================================================================

describe("serializeJson", () => {
	it("serializes an object to formatted JSON", async () => {
		const result = await Effect.runPromise(
			serializeJson({ id: "1", name: "Alice" }),
		)
		expect(result).toBe('{\n  "id": "1",\n  "name": "Alice"\n}')
	})

	it("respects custom indent option", async () => {
		const result = await Effect.runPromise(
			serializeJson({ a: 1 }, { indent: 4 }),
		)
		expect(result).toBe('{\n    "a": 1\n}')
	})

	it("produces compact JSON with indent: 0", async () => {
		const result = await Effect.runPromise(
			serializeJson({ a: 1, b: 2 }, { indent: 0 }),
		)
		expect(result).toBe('{"a":1,"b":2}')
	})

	it("uses a custom replacer", async () => {
		const replacer = (_key: string, value: unknown) =>
			typeof value === "number" ? value * 2 : value
		const result = await Effect.runPromise(
			serializeJson({ x: 5 }, { replacer }),
		)
		expect(JSON.parse(result)).toEqual({ x: 10 })
	})

	it("fails with SerializationError for circular references", async () => {
		const circular: Record<string, unknown> = {}
		circular.self = circular
		const result = await Effect.runPromise(
			serializeJson(circular).pipe(
				Effect.matchEffect({
					onFailure: (e) => Effect.succeed(e),
					onSuccess: () => Effect.fail("should not succeed" as const),
				}),
			),
		)
		expect(result._tag).toBe("SerializationError")
		if (result._tag === "SerializationError") {
			expect(result.format).toBe("json")
		}
	})
})

describe("deserializeJson", () => {
	it("deserializes valid JSON string", async () => {
		const result = await Effect.runPromise(
			deserializeJson('{"id":"1","name":"Bob"}'),
		)
		expect(result).toEqual({ id: "1", name: "Bob" })
	})

	it("uses a custom reviver", async () => {
		const reviver = (_key: string, value: unknown) =>
			typeof value === "number" ? value + 100 : value
		const result = await Effect.runPromise(
			deserializeJson('{"val":5}', { reviver }),
		)
		expect(result).toEqual({ val: 105 })
	})

	it("fails with SerializationError for invalid JSON", async () => {
		const result = await Effect.runPromise(
			deserializeJson("{bad json").pipe(
				Effect.matchEffect({
					onFailure: (e) => Effect.succeed(e),
					onSuccess: () => Effect.fail("should not succeed" as const),
				}),
			),
		)
		expect(result._tag).toBe("SerializationError")
		if (result._tag === "SerializationError") {
			expect(result.format).toBe("json")
		}
	})
})

// ============================================================================
// Round-trip
// ============================================================================

describe("JSON round-trip", () => {
	it("serialize then deserialize preserves data", async () => {
		const data = { id: "42", tags: ["a", "b"], nested: { x: 1 } }
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const json = yield* serializeJson(data)
				return yield* deserializeJson(json)
			}),
		)
		expect(result).toEqual(data)
	})
})

// ============================================================================
// JsonSerializerLayer (as SerializerRegistry)
// ============================================================================

describe("JsonSerializerLayer", () => {
	const run = <A>(
		effect: Effect.Effect<A, unknown, SerializerRegistry>,
	) => Effect.runPromise(Effect.provide(effect, JsonSerializerLayer))

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

	it("supports custom options via makeJsonSerializerLayer", async () => {
		const customLayer = makeJsonSerializerLayer({ indent: 0 })
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
