import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { StorageAdapter } from "../src/storage/storage-service.js"
import { SerializerRegistry } from "../src/serializers/serializer-service.js"
import {
	makeInMemoryStorageLayer,
	InMemoryStorageLayer,
} from "../src/storage/in-memory-adapter-layer.js"
import { makeSerializerLayer } from "../src/serializers/format-codec.js"
import { jsonCodec } from "../src/serializers/codecs/json.js"
import { yamlCodec } from "../src/serializers/codecs/yaml.js"

// ============================================================================
// Codec-based serializer layers
// ============================================================================

const JsonSerializerLayer = makeSerializerLayer([jsonCodec()])
const YamlSerializerLayer = makeSerializerLayer([yamlCodec()])

// ============================================================================
// Helpers
// ============================================================================

const sampleData = {
	users: [
		{ id: "1", name: "Alice", age: 30 },
		{ id: "2", name: "Bob", age: 25 },
	],
}

/**
 * A program that writes serialized data through StorageAdapter, reads it back,
 * and deserializes. This same program runs against different Layer combinations.
 */
const writeAndReadBack = (path: string, extension: string) =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter
		const serializer = yield* SerializerRegistry
		const serialized = yield* serializer.serialize(sampleData, extension)
		yield* storage.write(path, serialized)
		const raw = yield* serializer.deserialize(yield* storage.read(path), extension)
		return raw
	})

// ============================================================================
// Integrated: StorageAdapter + SerializerRegistry
// ============================================================================

describe("Storage + Serializer integration", () => {
	describe("in-memory storage with JSON serializer", () => {
		const TestLayer = Layer.merge(InMemoryStorageLayer, JsonSerializerLayer)

		it("write serialized data, read back, and deserialize round-trips", async () => {
			const result = await Effect.runPromise(
				Effect.provide(writeAndReadBack("/data/users.json", "json"), TestLayer),
			)
			expect(result).toEqual(sampleData)
		})

		it("stored content is valid JSON string", async () => {
			const store = new Map<string, string>()
			const layer = Layer.merge(makeInMemoryStorageLayer(store), JsonSerializerLayer)

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const storage = yield* StorageAdapter
						const serializer = yield* SerializerRegistry
						const serialized = yield* serializer.serialize(sampleData, "json")
						yield* storage.write("/data/users.json", serialized)
					}),
					layer,
				),
			)

			const stored = store.get("/data/users.json")
			expect(stored).toBeDefined()
			expect(JSON.parse(stored!)).toEqual(sampleData)
		})
	})

	describe("in-memory storage with YAML serializer", () => {
		const TestLayer = Layer.merge(InMemoryStorageLayer, YamlSerializerLayer)

		it("write serialized data, read back, and deserialize round-trips", async () => {
			const result = await Effect.runPromise(
				Effect.provide(writeAndReadBack("/data/users.yaml", "yaml"), TestLayer),
			)
			expect(result).toEqual(sampleData)
		})

		it("also works with yml extension", async () => {
			const result = await Effect.runPromise(
				Effect.provide(writeAndReadBack("/data/users.yml", "yml"), TestLayer),
			)
			expect(result).toEqual(sampleData)
		})
	})

})

// ============================================================================
// Layer swapping: same program, different layers (in-memory only)
// ============================================================================

describe("Layer swapping", () => {
	const program = writeAndReadBack("/collections/items.json", "json")

	it("runs the same program against InMemoryStorageLayer", async () => {
		const layer = Layer.merge(InMemoryStorageLayer, JsonSerializerLayer)
		const result = await Effect.runPromise(Effect.provide(program, layer))
		expect(result).toEqual(sampleData)
	})

	it("swapping serializer layer changes the stored format", async () => {
		const store = new Map<string, string>()
		const storageLLayer = makeInMemoryStorageLayer(store)

		// Write with JSON
		const jsonLayer = Layer.merge(storageLLayer, JsonSerializerLayer)
		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const storage = yield* StorageAdapter
					const serializer = yield* SerializerRegistry
					yield* storage.write("/data.json", yield* serializer.serialize({ x: 1 }, "json"))
				}),
				jsonLayer,
			),
		)
		const jsonContent = store.get("/data.json")!
		expect(jsonContent).toContain('"x"')

		// Write with YAML to a different key
		const yamlLayer = Layer.merge(storageLLayer, YamlSerializerLayer)
		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const storage = yield* StorageAdapter
					const serializer = yield* SerializerRegistry
					yield* storage.write("/data.yaml", yield* serializer.serialize({ x: 1 }, "yaml"))
				}),
				yamlLayer,
			),
		)
		const yamlContent = store.get("/data.yaml")!
		expect(yamlContent).toContain("x: 1")

		// Both should deserialize to the same value
		const fromJson = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const serializer = yield* SerializerRegistry
					return yield* serializer.deserialize(jsonContent, "json")
				}),
				jsonLayer,
			),
		)
		const fromYaml = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const serializer = yield* SerializerRegistry
					return yield* serializer.deserialize(yamlContent, "yaml")
				}),
				yamlLayer,
			),
		)
		expect(fromJson).toEqual(fromYaml)
	})
})

// ============================================================================
// Serialization round-trips across formats
// ============================================================================

describe("Cross-format serialization round-trips", () => {
	const complexData = {
		id: "abc-123",
		name: "Test Entity",
		count: 42,
		ratio: 3.14,
		active: true,
		tags: ["alpha", "beta", "gamma"],
		metadata: { nested: { deep: "value" }, list: [1, 2, 3] },
		nullable: null,
	}

	const roundTrip = (extension: string, layer: Layer.Layer<SerializerRegistry>) =>
		Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const serializer = yield* SerializerRegistry
					const encoded = yield* serializer.serialize(complexData, extension)
					return yield* serializer.deserialize(encoded, extension)
				}),
				layer,
			),
		)

	it("JSON preserves complex data", async () => {
		expect(await roundTrip("json", JsonSerializerLayer)).toEqual(complexData)
	})

	it("YAML preserves complex data", async () => {
		expect(await roundTrip("yaml", YamlSerializerLayer)).toEqual(complexData)
	})
})

// ============================================================================
// Error propagation through integrated stack
// ============================================================================

describe("Error propagation through integrated stack", () => {
	it("StorageError propagates when reading missing file", async () => {
		const layer = Layer.merge(InMemoryStorageLayer, JsonSerializerLayer)

		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const storage = yield* StorageAdapter
					const serializer = yield* SerializerRegistry
					const raw = yield* storage.read("/nonexistent.json")
					return yield* serializer.deserialize(raw, "json")
				}).pipe(
					Effect.matchEffect({
						onFailure: (e) => Effect.succeed(e),
						onSuccess: () => Effect.fail("should not succeed" as const),
					}),
				),
				layer,
			),
		)
		expect(result._tag).toBe("StorageError")
	})

	it("UnsupportedFormatError propagates for wrong extension", async () => {
		const layer = Layer.merge(InMemoryStorageLayer, JsonSerializerLayer)

		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const storage = yield* StorageAdapter
					const serializer = yield* SerializerRegistry
					yield* storage.write("/data.xml", "<data/>")
					const raw = yield* storage.read("/data.xml")
					return yield* serializer.deserialize(raw, "xml")
				}).pipe(
					Effect.matchEffect({
						onFailure: (e) => Effect.succeed(e),
						onSuccess: () => Effect.fail("should not succeed" as const),
					}),
				),
				layer,
			),
		)
		expect(result._tag).toBe("UnsupportedFormatError")
	})

	it("SerializationError propagates for corrupt content", async () => {
		const layer = Layer.merge(InMemoryStorageLayer, JsonSerializerLayer)

		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const storage = yield* StorageAdapter
					const serializer = yield* SerializerRegistry
					yield* storage.write("/data.json", "not valid json {{{")
					const raw = yield* storage.read("/data.json")
					return yield* serializer.deserialize(raw, "json")
				}).pipe(
					Effect.matchEffect({
						onFailure: (e) => Effect.succeed(e),
						onSuccess: () => Effect.fail("should not succeed" as const),
					}),
				),
				layer,
			),
		)
		expect(result._tag).toBe("SerializationError")
	})
})
