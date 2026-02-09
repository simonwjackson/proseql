import { describe, it, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { createDebouncedWriter, saveData } from "../core/storage/persistence-effect.js"
import { StorageAdapter } from "../core/storage/storage-service.js"
import { makeInMemoryStorageLayer } from "../core/storage/in-memory-adapter-layer.js"
import { JsonSerializerLayer } from "../core/serializers/json.js"
import { StorageError } from "../core/errors/storage-errors.js"

// ============================================================================
// Helpers
// ============================================================================

const TestLayer = Layer.merge(makeInMemoryStorageLayer(), JsonSerializerLayer)

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
})

type User = typeof UserSchema.Type

/**
 * Create a write-counting storage layer to observe how many writes actually happen.
 */
const makeCountingStorageLayer = () => {
	const store = new Map<string, string>()
	let writeCount = 0

	const adapter = {
		read: (path: string) =>
			Effect.suspend(() => {
				const content = store.get(path)
				if (content === undefined) {
					return Effect.fail(
						new StorageError({
							path,
							operation: "read" as const,
							message: `File not found: ${path}`,
						}),
					)
				}
				return Effect.succeed(content)
			}),
		write: (path: string, data: string) =>
			Effect.sync(() => {
				store.set(path, data)
				writeCount++
			}),
		exists: (path: string) => Effect.sync(() => store.has(path)),
		remove: (path: string) => Effect.void,
		ensureDir: (_path: string) => Effect.void,
		watch: (_path: string, _onChange: () => void) =>
			Effect.succeed(() => {}),
	}

	return {
		layer: Layer.succeed(StorageAdapter, adapter),
		store,
		getWriteCount: () => writeCount,
		resetWriteCount: () => {
			writeCount = 0
		},
	}
}

// ============================================================================
// DebouncedWriter creation
// ============================================================================

describe("DebouncedWriter", () => {
	describe("creation", () => {
		it("creates with default delay", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const writer = yield* createDebouncedWriter()
					const count = yield* writer.pendingCount()
					expect(count).toBe(0)
				}),
			)
		})

		it("creates with custom delay", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const writer = yield* createDebouncedWriter(500)
					const count = yield* writer.pendingCount()
					expect(count).toBe(0)
				}),
			)
		})
	})

	describe("triggerSave", () => {
		it("schedules a pending write", async () => {
			const { layer, getWriteCount } = makeCountingStorageLayer()
			const TestEnv = Layer.merge(layer, JsonSerializerLayer)

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const writer = yield* createDebouncedWriter(50)
						const data: ReadonlyMap<string, User> = new Map([
							["1", { id: "1", name: "Alice" }],
						])

						yield* writer.triggerSave(
							"/data/users.json",
							saveData("/data/users.json", UserSchema, data),
						)

						// Should be pending
						const count = yield* writer.pendingCount()
						expect(count).toBe(1)

						// No write yet
						expect(getWriteCount()).toBe(0)
					}),
					TestEnv,
				),
			)
		})

		it("executes write after delay", async () => {
			const { layer, store, getWriteCount } = makeCountingStorageLayer()
			const TestEnv = Layer.merge(layer, JsonSerializerLayer)

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const writer = yield* createDebouncedWriter(30)
						const data: ReadonlyMap<string, User> = new Map([
							["1", { id: "1", name: "Alice" }],
						])

						yield* writer.triggerSave(
							"/data/users.json",
							saveData("/data/users.json", UserSchema, data),
						)

						// Wait for debounce to elapse
						yield* Effect.sleep(80)

						expect(getWriteCount()).toBe(1)
						expect(store.has("/data/users.json")).toBe(true)

						// Should no longer be pending
						const count = yield* writer.pendingCount()
						expect(count).toBe(0)
					}),
					TestEnv,
				),
			)
		})
	})

	describe("coalescing", () => {
		it("multiple rapid saves to the same key coalesce into one write", async () => {
			const { layer, store, getWriteCount } = makeCountingStorageLayer()
			const TestEnv = Layer.merge(layer, JsonSerializerLayer)

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const writer = yield* createDebouncedWriter(50)

						// Fire 10 saves rapidly with different data
						for (let i = 0; i < 10; i++) {
							const data: ReadonlyMap<string, User> = new Map([
								["1", { id: "1", name: `Version${i}` }],
							])
							yield* writer.triggerSave(
								"/data/users.json",
								saveData("/data/users.json", UserSchema, data),
							)
						}

						// Only 1 pending (the last one replaced all previous)
						const count = yield* writer.pendingCount()
						expect(count).toBe(1)

						// Wait for debounce
						yield* Effect.sleep(100)

						// Only one write should have occurred
						expect(getWriteCount()).toBe(1)

						// The written data should be the last version
						const stored = store.get("/data/users.json")
						expect(stored).toBeDefined()
						const parsed = JSON.parse(stored!)
						expect(parsed["1"].name).toBe("Version9")
					}),
					TestEnv,
				),
			)
		})

		it("saves to different keys are independent", async () => {
			const { layer, store, getWriteCount } = makeCountingStorageLayer()
			const TestEnv = Layer.merge(layer, JsonSerializerLayer)

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const writer = yield* createDebouncedWriter(30)

						const usersData: ReadonlyMap<string, User> = new Map([
							["1", { id: "1", name: "Alice" }],
						])
						const postsData: ReadonlyMap<string, User> = new Map([
							["p1", { id: "p1", name: "PostTitle" }],
						])

						yield* writer.triggerSave(
							"/data/users.json",
							saveData("/data/users.json", UserSchema, usersData),
						)
						yield* writer.triggerSave(
							"/data/posts.json",
							saveData("/data/posts.json", UserSchema, postsData),
						)

						// Both should be pending
						const count = yield* writer.pendingCount()
						expect(count).toBe(2)

						// Wait for debounce
						yield* Effect.sleep(80)

						// Both writes should have occurred
						expect(getWriteCount()).toBe(2)
						expect(store.has("/data/users.json")).toBe(true)
						expect(store.has("/data/posts.json")).toBe(true)
					}),
					TestEnv,
				),
			)
		})
	})

	describe("custom debounce delay", () => {
		it("respects custom delay of 200ms", async () => {
			const { layer, getWriteCount } = makeCountingStorageLayer()
			const TestEnv = Layer.merge(layer, JsonSerializerLayer)

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const writer = yield* createDebouncedWriter(200)
						const data: ReadonlyMap<string, User> = new Map([
							["1", { id: "1", name: "Alice" }],
						])

						yield* writer.triggerSave(
							"/data/users.json",
							saveData("/data/users.json", UserSchema, data),
						)

						// After 50ms, still no write
						yield* Effect.sleep(50)
						expect(getWriteCount()).toBe(0)

						// After 100ms total, still no write
						yield* Effect.sleep(50)
						expect(getWriteCount()).toBe(0)

						// After 250ms total, write should have occurred
						yield* Effect.sleep(150)
						expect(getWriteCount()).toBe(1)
					}),
					TestEnv,
				),
			)
		})
	})

	describe("flush", () => {
		it("immediately executes all pending writes", async () => {
			const { layer, store, getWriteCount } = makeCountingStorageLayer()
			const TestEnv = Layer.merge(layer, JsonSerializerLayer)

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const writer = yield* createDebouncedWriter(5000) // Very long delay

						const usersData: ReadonlyMap<string, User> = new Map([
							["1", { id: "1", name: "Alice" }],
						])
						const postsData: ReadonlyMap<string, User> = new Map([
							["p1", { id: "p1", name: "Post" }],
						])

						yield* writer.triggerSave(
							"/data/users.json",
							saveData("/data/users.json", UserSchema, usersData),
						)
						yield* writer.triggerSave(
							"/data/posts.json",
							saveData("/data/posts.json", UserSchema, postsData),
						)

						expect(getWriteCount()).toBe(0)

						// Flush immediately
						yield* writer.flush()

						// Both writes should have executed
						expect(getWriteCount()).toBe(2)
						expect(store.has("/data/users.json")).toBe(true)
						expect(store.has("/data/posts.json")).toBe(true)

						// Pending should be empty
						const count = yield* writer.pendingCount()
						expect(count).toBe(0)
					}),
					TestEnv,
				),
			)
		})

		it("flush with no pending writes is a no-op", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const writer = yield* createDebouncedWriter()
					yield* Effect.provide(writer.flush(), TestLayer)
					const count = yield* writer.pendingCount()
					expect(count).toBe(0)
				}),
			)
		})

		it("flush uses the latest data for each key", async () => {
			const { layer, store, getWriteCount } = makeCountingStorageLayer()
			const TestEnv = Layer.merge(layer, JsonSerializerLayer)

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const writer = yield* createDebouncedWriter(5000)

						// Trigger multiple saves for same key
						for (let i = 0; i < 5; i++) {
							const data: ReadonlyMap<string, User> = new Map([
								["1", { id: "1", name: `V${i}` }],
							])
							yield* writer.triggerSave(
								"/data/users.json",
								saveData("/data/users.json", UserSchema, data),
							)
						}

						yield* writer.flush()

						expect(getWriteCount()).toBe(1)
						const stored = store.get("/data/users.json")
						expect(stored).toBeDefined()
						const parsed = JSON.parse(stored!)
						expect(parsed["1"].name).toBe("V4")
					}),
					TestEnv,
				),
			)
		})
	})

	describe("pendingCount", () => {
		it("tracks pending writes accurately", async () => {
			const { layer } = makeCountingStorageLayer()
			const TestEnv = Layer.merge(layer, JsonSerializerLayer)

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const writer = yield* createDebouncedWriter(5000)

						expect(yield* writer.pendingCount()).toBe(0)

						yield* writer.triggerSave(
							"a",
							saveData("/a.json", UserSchema, new Map()),
						)
						expect(yield* writer.pendingCount()).toBe(1)

						yield* writer.triggerSave(
							"b",
							saveData("/b.json", UserSchema, new Map()),
						)
						expect(yield* writer.pendingCount()).toBe(2)

						// Replacing an existing key doesn't increase count
						yield* writer.triggerSave(
							"a",
							saveData("/a.json", UserSchema, new Map()),
						)
						expect(yield* writer.pendingCount()).toBe(2)

						yield* writer.flush()
						expect(yield* writer.pendingCount()).toBe(0)
					}),
					TestEnv,
				),
			)
		})
	})
})
