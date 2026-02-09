import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { SerializerRegistry, type SerializerRegistryShape } from "../core/serializers/serializer-service.js"
import { SerializationError, UnsupportedFormatError } from "../core/errors/storage-errors.js"

// A minimal JSON-only registry for testing the service definition
const makeTestRegistry = (): SerializerRegistryShape => ({
	serialize: (data, extension) =>
		Effect.suspend(() => {
			if (extension !== "json") {
				return Effect.fail(
					new UnsupportedFormatError({
						format: extension,
						message: `No serializer for '.${extension}'`,
					}),
				)
			}
			try {
				return Effect.succeed(JSON.stringify(data, null, 2))
			} catch (err) {
				return Effect.fail(
					new SerializationError({
						format: "json",
						message: `JSON serialize failed: ${err instanceof Error ? err.message : "unknown"}`,
						cause: err,
					}),
				)
			}
		}),
	deserialize: (content, extension) =>
		Effect.suspend(() => {
			if (extension !== "json") {
				return Effect.fail(
					new UnsupportedFormatError({
						format: extension,
						message: `No serializer for '.${extension}'`,
					}),
				)
			}
			try {
				return Effect.succeed(JSON.parse(content) as unknown)
			} catch (err) {
				return Effect.fail(
					new SerializationError({
						format: "json",
						message: `JSON deserialize failed: ${err instanceof Error ? err.message : "unknown"}`,
						cause: err,
					}),
				)
			}
		}),
})

const TestSerializerLayer: Layer.Layer<SerializerRegistry> = Layer.succeed(
	SerializerRegistry,
	makeTestRegistry(),
)

const run = <A>(
	effect: Effect.Effect<A, SerializationError | UnsupportedFormatError, SerializerRegistry>,
) => Effect.runPromise(Effect.provide(effect, TestSerializerLayer))

describe("SerializerRegistry service", () => {
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
				TestSerializerLayer,
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
				TestSerializerLayer,
			),
		)
		expect(result._tag).toBe("SerializationError")
		if (result._tag === "SerializationError") {
			expect(result.format).toBe("json")
		}
	})
})
