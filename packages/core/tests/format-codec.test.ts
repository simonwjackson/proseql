import {
	describe,
	it,
	expect,
	vi,
	beforeEach,
	afterEach,
	type MockInstance,
} from "vitest"
import { Effect } from "effect"
import { SerializerRegistry } from "../src/serializers/serializer-service.js"
import {
	SerializationError,
	UnsupportedFormatError,
} from "../src/errors/storage-errors.js"
import {
	makeSerializerLayer,
	type FormatCodec,
} from "../src/serializers/format-codec.js"
import { jsonCodec } from "../src/serializers/codecs/json.js"
import { yamlCodec } from "../src/serializers/codecs/yaml.js"

describe("makeSerializerLayer", () => {
	describe("multi-format dispatch", () => {
		const MultiFormatLayer = makeSerializerLayer([jsonCodec(), yamlCodec()])

		const run = <A>(
			effect: Effect.Effect<
				A,
				SerializationError | UnsupportedFormatError,
				SerializerRegistry
			>,
		) => Effect.runPromise(Effect.provide(effect, MultiFormatLayer))

		it("dispatches to correct codec based on extension", async () => {
			const data = { id: "1", name: "test" }

			await run(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry

					// JSON dispatch
					const json = yield* registry.serialize(data, "json")
					expect(json).toContain('"id"')
					expect(json).toContain('"name"')

					// YAML dispatch
					const yaml = yield* registry.serialize(data, "yaml")
					expect(yaml).toContain("id:")
					expect(yaml).toContain("name:")
					expect(yaml).not.toContain('"id"')

					// YML alias dispatch (yaml codec handles both yaml and yml)
					const yml = yield* registry.serialize(data, "yml")
					expect(yml).toContain("id:")
				}),
			)
		})

		it("deserializes using the correct codec", async () => {
			const jsonContent = '{"a": 1, "b": 2}'
			const yamlContent = "a: 1\nb: 2\n"

			await run(
				Effect.gen(function* () {
					const registry = yield* SerializerRegistry

					const fromJson = yield* registry.deserialize(jsonContent, "json")
					expect(fromJson).toEqual({ a: 1, b: 2 })

					const fromYaml = yield* registry.deserialize(yamlContent, "yaml")
					expect(fromYaml).toEqual({ a: 1, b: 2 })
				}),
			)
		})
	})

	describe("unknown extension error", () => {
		const SingleFormatLayer = makeSerializerLayer([jsonCodec()])

		it("fails with UnsupportedFormatError for unregistered extension", async () => {
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
					SingleFormatLayer,
				),
			)

			expect(result._tag).toBe("UnsupportedFormatError")
			if (result._tag === "UnsupportedFormatError") {
				expect(result.format).toBe("xml")
				expect(result.message).toContain(".xml")
				expect(result.message).toContain("Available formats")
				expect(result.message).toContain(".json")
			}
		})

		it("fails with UnsupportedFormatError on deserialize for unregistered extension", async () => {
			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry
						return yield* registry.deserialize("{}", "toml").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						)
					}),
					SingleFormatLayer,
				),
			)

			expect(result._tag).toBe("UnsupportedFormatError")
			if (result._tag === "UnsupportedFormatError") {
				expect(result.format).toBe("toml")
			}
		})

		it("shows 'No formats registered' when registry is empty", async () => {
			const EmptyLayer = makeSerializerLayer([])

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry
						return yield* registry.serialize({ a: 1 }, "json").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						)
					}),
					EmptyLayer,
				),
			)

			expect(result._tag).toBe("UnsupportedFormatError")
			if (result._tag === "UnsupportedFormatError") {
				expect(result.message).toContain("No formats registered")
			}
		})
	})

	describe("duplicate extension warning", () => {
		let warnSpy: MockInstance

		beforeEach(() => {
			warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		})

		afterEach(() => {
			warnSpy.mockRestore()
		})

		it("logs warning when duplicate extension is registered", () => {
			// Two codecs both claiming "json" extension
			const codec1: FormatCodec = {
				name: "json-v1",
				extensions: ["json"],
				encode: (data) => JSON.stringify(data),
				decode: (raw) => JSON.parse(raw),
			}
			const codec2: FormatCodec = {
				name: "json-v2",
				extensions: ["json"],
				encode: (data) => JSON.stringify(data, null, 4),
				decode: (raw) => JSON.parse(raw),
			}

			makeSerializerLayer([codec1, codec2])

			expect(warnSpy).toHaveBeenCalledOnce()
			expect(warnSpy).toHaveBeenCalledWith(
				"Duplicate extension '.json': 'json-v1' overwritten by 'json-v2'",
			)
		})

		it("last codec wins for duplicate extensions", async () => {
			const codec1: FormatCodec = {
				name: "json-compact",
				extensions: ["json"],
				encode: (data) => JSON.stringify(data), // no indentation
				decode: (raw) => JSON.parse(raw),
			}
			const codec2: FormatCodec = {
				name: "json-pretty",
				extensions: ["json"],
				encode: (data) => JSON.stringify(data, null, 4), // 4-space indentation
				decode: (raw) => JSON.parse(raw),
			}

			const layer = makeSerializerLayer([codec1, codec2])

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry
						return yield* registry.serialize({ a: 1 }, "json")
					}),
					layer,
				),
			)

			// Should use codec2's 4-space indentation
			expect(result).toBe('{\n    "a": 1\n}')
		})

		it("does not log warning when extensions are unique", () => {
			makeSerializerLayer([jsonCodec(), yamlCodec()])

			expect(warnSpy).not.toHaveBeenCalled()
		})

		it("logs multiple warnings for multiple duplicates", () => {
			const codec1: FormatCodec = {
				name: "format-a",
				extensions: ["ext1", "ext2"],
				encode: () => "",
				decode: () => null,
			}
			const codec2: FormatCodec = {
				name: "format-b",
				extensions: ["ext1", "ext2", "ext3"],
				encode: () => "",
				decode: () => null,
			}

			makeSerializerLayer([codec1, codec2])

			expect(warnSpy).toHaveBeenCalledTimes(2)
			expect(warnSpy).toHaveBeenCalledWith(
				"Duplicate extension '.ext1': 'format-a' overwritten by 'format-b'",
			)
			expect(warnSpy).toHaveBeenCalledWith(
				"Duplicate extension '.ext2': 'format-a' overwritten by 'format-b'",
			)
		})
	})

	describe("error propagation from codecs", () => {
		it("wraps encode errors in SerializationError", async () => {
			const failingCodec: FormatCodec = {
				name: "failing-encoder",
				extensions: ["fail"],
				encode: () => {
					throw new Error("Encode failed: circular reference")
				},
				decode: (raw) => JSON.parse(raw),
			}

			const layer = makeSerializerLayer([failingCodec])

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry
						return yield* registry.serialize({ a: 1 }, "fail").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						)
					}),
					layer,
				),
			)

			expect(result._tag).toBe("SerializationError")
			if (result._tag === "SerializationError") {
				expect(result.format).toBe("failing-encoder")
				expect(result.message).toContain("Failed to serialize")
				expect(result.message).toContain("failing-encoder")
				expect(result.message).toContain("circular reference")
			}
		})

		it("wraps decode errors in SerializationError", async () => {
			const failingCodec: FormatCodec = {
				name: "failing-decoder",
				extensions: ["fail"],
				encode: (data) => JSON.stringify(data),
				decode: () => {
					throw new Error("Decode failed: invalid syntax")
				},
			}

			const layer = makeSerializerLayer([failingCodec])

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry
						return yield* registry.deserialize("{}", "fail").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						)
					}),
					layer,
				),
			)

			expect(result._tag).toBe("SerializationError")
			if (result._tag === "SerializationError") {
				expect(result.format).toBe("failing-decoder")
				expect(result.message).toContain("Failed to deserialize")
				expect(result.message).toContain("failing-decoder")
				expect(result.message).toContain("invalid syntax")
			}
		})

		it("preserves error cause from codec", async () => {
			const originalError = new TypeError("Cannot stringify BigInt")
			const failingCodec: FormatCodec = {
				name: "bigint-codec",
				extensions: ["bigint"],
				encode: () => {
					throw originalError
				},
				decode: (raw) => JSON.parse(raw),
			}

			const layer = makeSerializerLayer([failingCodec])

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry
						return yield* registry.serialize({ value: 1n }, "bigint").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						)
					}),
					layer,
				),
			)

			expect(result._tag).toBe("SerializationError")
			if (result._tag === "SerializationError") {
				expect(result.cause).toBe(originalError)
			}
		})

		it("handles non-Error throws from codecs", async () => {
			const failingCodec: FormatCodec = {
				name: "string-thrower",
				extensions: ["strerr"],
				encode: () => {
					throw "string error" // eslint-disable-line no-throw-literal
				},
				decode: (raw) => JSON.parse(raw),
			}

			const layer = makeSerializerLayer([failingCodec])

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const registry = yield* SerializerRegistry
						return yield* registry.serialize({ a: 1 }, "strerr").pipe(
							Effect.matchEffect({
								onFailure: (e) => Effect.succeed(e),
								onSuccess: () => Effect.fail("should not succeed" as const),
							}),
						)
					}),
					layer,
				),
			)

			expect(result._tag).toBe("SerializationError")
			if (result._tag === "SerializationError") {
				expect(result.message).toContain("Unknown error")
			}
		})
	})
})
