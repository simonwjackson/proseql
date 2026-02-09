import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { StorageAdapter } from "../core/storage/storage-service.js"
import {
	makeInMemoryStorageLayer,
	InMemoryStorageLayer,
} from "../core/storage/in-memory-adapter-layer.js"
import { StorageError } from "../core/errors/storage-errors.js"

const run = <A>(effect: Effect.Effect<A, StorageError, StorageAdapter>) =>
	Effect.runPromise(Effect.provide(effect, InMemoryStorageLayer))

describe("InMemoryStorageLayer", () => {
	it("write then read returns the written content", async () => {
		const result = await run(
			Effect.gen(function* () {
				const adapter = yield* StorageAdapter
				yield* adapter.write("/data/users.json", '{"id":"1"}')
				return yield* adapter.read("/data/users.json")
			}),
		)
		expect(result).toBe('{"id":"1"}')
	})

	it("read on missing path fails with StorageError", async () => {
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter
					return yield* adapter.read("/missing.json").pipe(
						Effect.matchEffect({
							onFailure: (e) => Effect.succeed(e),
							onSuccess: () => Effect.fail("should not succeed" as const),
						}),
					)
				}),
				InMemoryStorageLayer,
			),
		)
		expect(result._tag).toBe("StorageError")
		expect(result.operation).toBe("read")
		expect(result.path).toBe("/missing.json")
	})

	it("exists returns true for written paths and false for missing", async () => {
		const result = await run(
			Effect.gen(function* () {
				const adapter = yield* StorageAdapter
				const before = yield* adapter.exists("/file.txt")
				yield* adapter.write("/file.txt", "hello")
				const after = yield* adapter.exists("/file.txt")
				return { before, after }
			}),
		)
		expect(result.before).toBe(false)
		expect(result.after).toBe(true)
	})

	it("remove deletes a written path", async () => {
		const result = await run(
			Effect.gen(function* () {
				const adapter = yield* StorageAdapter
				yield* adapter.write("/file.txt", "data")
				yield* adapter.remove("/file.txt")
				return yield* adapter.exists("/file.txt")
			}),
		)
		expect(result).toBe(false)
	})

	it("remove on missing path fails with StorageError", async () => {
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter
					return yield* adapter.remove("/nope.txt").pipe(
						Effect.matchEffect({
							onFailure: (e) => Effect.succeed(e),
							onSuccess: () => Effect.fail("should not succeed" as const),
						}),
					)
				}),
				InMemoryStorageLayer,
			),
		)
		expect(result._tag).toBe("StorageError")
		expect(result.operation).toBe("delete")
	})

	it("ensureDir succeeds (no-op)", async () => {
		await run(
			Effect.gen(function* () {
				const adapter = yield* StorageAdapter
				yield* adapter.ensureDir("/some/deep/path")
			}),
		)
	})

	it("overwrite replaces existing content", async () => {
		const result = await run(
			Effect.gen(function* () {
				const adapter = yield* StorageAdapter
				yield* adapter.write("/file.txt", "first")
				yield* adapter.write("/file.txt", "second")
				return yield* adapter.read("/file.txt")
			}),
		)
		expect(result).toBe("second")
	})

	it("makeInMemoryStorageLayer accepts an external Map for inspection", async () => {
		const store = new Map<string, string>()
		const layer = makeInMemoryStorageLayer(store)

		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const adapter = yield* StorageAdapter
					yield* adapter.write("/test.txt", "content")
				}),
				layer,
			),
		)

		expect(store.get("/test.txt")).toBe("content")
	})
})
