/**
 * Node adapter storage tests - extracted from storage-services.test.ts
 *
 * NOTE: This test file is a placeholder until @proseql/node package is fully set up.
 * It will be updated in task 3.7 to use proper imports from the node package.
 * For now, it imports directly from the core package paths.
 */
import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { StorageAdapter } from "../../core/src/storage/storage-service.js"
import { SerializerRegistry } from "../../core/src/serializers/serializer-service.js"
import { makeNodeStorageLayer } from "../../../core/storage/node-adapter-layer.js"
import { makeSerializerLayer } from "../../core/src/serializers/format-codec.js"
import { jsonCodec } from "../../core/src/serializers/codecs/json.js"
import { promises as fs } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { randomBytes } from "crypto"

// ============================================================================
// Codec-based serializer layers
// ============================================================================

const JsonSerializerLayer = makeSerializerLayer([jsonCodec()])

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
// Node Storage Adapter Tests
// ============================================================================

describe("NodeStorageLayer (filesystem)", () => {
	it("runs the same program against NodeStorageLayer (filesystem)", async () => {
		const tempDir = join(tmpdir(), `ptdb-test-${randomBytes(8).toString("hex")}`)
		await fs.mkdir(tempDir, { recursive: true })

		const nodeLayer = makeNodeStorageLayer()
		const layer = Layer.merge(nodeLayer, JsonSerializerLayer)

		const filePath = join(tempDir, "items.json")
		const fsProgram = writeAndReadBack(filePath, "json")

		try {
			const result = await Effect.runPromise(Effect.provide(fsProgram, layer))
			expect(result).toEqual(sampleData)

			// Verify the file actually exists on disk
			const onDisk = await fs.readFile(filePath, "utf-8")
			expect(JSON.parse(onDisk)).toEqual(sampleData)
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})
})
