import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import {
	serializeMessagePack,
	deserializeMessagePack,
	MessagePackSerializerLayer,
} from "../core/serializers/messagepack.js"
import { SerializerRegistry } from "../core/serializers/serializer-service.js"

// ============================================================================
// Direct Effect-based serialize/deserialize
// ============================================================================

describe("serializeMessagePack", () => {
	it("serializes an object to a base64 string", async () => {
		const result = await Effect.runPromise(
			serializeMessagePack({ id: "1", name: "Alice" }),
		)
		expect(typeof result).toBe("string")
		// Should be valid base64
		expect(() => Buffer.from(result, "base64")).not.toThrow()
	})

	it("serializes nested objects", async () => {
		const result = await Effect.runPromise(
			serializeMessagePack({ user: { name: "Bob", age: 30 } }),
		)
		expect(typeof result).toBe("string")
	})

	it("serializes arrays", async () => {
		const result = await Effect.runPromise(
			serializeMessagePack({ tags: ["a", "b", "c"] }),
		)
		expect(typeof result).toBe("string")
	})
})

describe("deserializeMessagePack", () => {
	it("deserializes a valid MessagePack base64 string", async () => {
		const data = { id: "1", name: "Bob" }
		const serialized = await Effect.runPromise(serializeMessagePack(data))
		const result = await Effect.runPromise(deserializeMessagePack(serialized))
		expect(result).toEqual(data)
	})

	it("fails with SerializationError for invalid data", async () => {
		const result = await Effect.runPromise(
			deserializeMessagePack("not-valid-base64!!!").pipe(
				Effect.matchEffect({
					onFailure: (e) => Effect.succeed(e),
					onSuccess: () => Effect.fail("should not succeed" as const),
				}),
			),
		)
		expect(result._tag).toBe("SerializationError")
		if (result._tag === "SerializationError") {
			expect(result.format).toBe("msgpack")
		}
	})
})

// ============================================================================
// Round-trip
// ============================================================================

describe("MessagePack round-trip", () => {
	it("serialize then deserialize preserves data", async () => {
		const data = { id: "42", tags: ["a", "b"], nested: { x: 1 } }
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const encoded = yield* serializeMessagePack(data)
				return yield* deserializeMessagePack(encoded)
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
				const encoded = yield* serializeMessagePack(data)
				return yield* deserializeMessagePack(encoded)
			}),
		)
		expect(result).toEqual(data)
	})

	it("handles empty objects and arrays", async () => {
		for (const data of [{}, []]) {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const encoded = yield* serializeMessagePack(data)
					return yield* deserializeMessagePack(encoded)
				}),
			)
			expect(result).toEqual(data)
		}
	})
})

// ============================================================================
// MessagePackSerializerLayer (as SerializerRegistry)
// ============================================================================

describe("MessagePackSerializerLayer", () => {
	const run = <A>(
		effect: Effect.Effect<A, unknown, SerializerRegistry>,
	) => Effect.runPromise(Effect.provide(effect, MessagePackSerializerLayer))

	it("serialize and deserialize round-trip via the service with 'msgpack' extension", async () => {
		const data = { id: "1", name: "Alice" }
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				const encoded = yield* registry.serialize(data, "msgpack")
				return yield* registry.deserialize(encoded, "msgpack")
			}),
		)
		expect(result).toEqual(data)
	})

	it("supports 'mp' extension", async () => {
		const data = { id: "2", active: true }
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				const encoded = yield* registry.serialize(data, "mp")
				return yield* registry.deserialize(encoded, "mp")
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

	it("fails with SerializationError for invalid MessagePack content", async () => {
		const result = await run(
			Effect.gen(function* () {
				const registry = yield* SerializerRegistry
				return yield* registry.deserialize("not-valid!!!", "msgpack").pipe(
					Effect.matchEffect({
						onFailure: (e) => Effect.succeed(e),
						onSuccess: () => Effect.fail("should not succeed" as const),
					}),
				)
			}),
		)
		expect((result as { _tag: string })._tag).toBe("SerializationError")
	})
})
