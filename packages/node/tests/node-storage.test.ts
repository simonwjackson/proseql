/**
 * Node adapter storage tests - extracted from storage-services.test.ts
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	jsonCodec,
	makeSerializerLayer,
	SerializerRegistryService as SerializerRegistry,
	StorageAdapterService as StorageAdapter,
} from "@proseql/core";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { makeNodeStorageLayer } from "../src/node-adapter-layer.js";

// ============================================================================
// Codec-based serializer layers
// ============================================================================

const JsonSerializerLayer = makeSerializerLayer([jsonCodec()]);

// ============================================================================
// Helpers
// ============================================================================

const sampleData = {
	users: [
		{ id: "1", name: "Alice", age: 30 },
		{ id: "2", name: "Bob", age: 25 },
	],
};

/**
 * A program that writes serialized data through StorageAdapter, reads it back,
 * and deserializes. This same program runs against different Layer combinations.
 */
const writeAndReadBack = (path: string, extension: string) =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter;
		const serializer = yield* SerializerRegistry;
		const serialized = yield* serializer.serialize(sampleData, extension);
		yield* storage.write(path, serialized);
		const raw = yield* serializer.deserialize(
			yield* storage.read(path),
			extension,
		);
		return raw;
	});

// ============================================================================
// Node Storage Adapter Tests
// ============================================================================

describe("NodeStorageLayer (filesystem)", () => {
	it("runs the same program against NodeStorageLayer (filesystem)", async () => {
		const tempDir = join(
			tmpdir(),
			`ptdb-test-${randomBytes(8).toString("hex")}`,
		);
		await fs.mkdir(tempDir, { recursive: true });

		const nodeLayer = makeNodeStorageLayer();
		const layer = Layer.merge(nodeLayer, JsonSerializerLayer);

		const filePath = join(tempDir, "items.json");
		const fsProgram = writeAndReadBack(filePath, "json");

		try {
			const result = await Effect.runPromise(Effect.provide(fsProgram, layer));
			expect(result).toEqual(sampleData);

			// Verify the file actually exists on disk
			const onDisk = await fs.readFile(filePath, "utf-8");
			expect(JSON.parse(onDisk)).toEqual(sampleData);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
