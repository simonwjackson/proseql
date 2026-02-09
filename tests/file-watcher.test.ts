import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer, Ref, Schema, Scope } from "effect"
import {
	createFileWatcher,
	createFileWatchers,
	type FileWatcher,
} from "../core/storage/persistence-effect.js"
import { StorageAdapter } from "../core/storage/storage-service.js"
import { makeInMemoryStorageLayer } from "../core/storage/in-memory-adapter-layer.js"
import { JsonSerializerLayer } from "../core/serializers/json.js"
import { StorageError } from "../core/errors/storage-errors.js"

// ============================================================================
// Helpers
// ============================================================================

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
})

type User = typeof UserSchema.Type

/**
 * Create a test layer with a shared in-memory store so tests can
 * write data and have watchers see the changes.
 */
const makeTestEnv = () => {
	const store = new Map<string, string>()
	const layer = Layer.merge(makeInMemoryStorageLayer(store), JsonSerializerLayer)
	return { store, layer }
}

// ============================================================================
// FileWatcher lifecycle tests
// ============================================================================

describe("FileWatcher", () => {
	describe("acquireRelease lifecycle", () => {
		it("watcher is active after creation", async () => {
			const { store, layer } = makeTestEnv()
			store.set("/data/users.json", JSON.stringify({ "1": { id: "1", name: "Alice" } }))

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const ref = yield* Ref.make<ReadonlyMap<string, User>>(
							new Map([["1", { id: "1", name: "Alice" }]]),
						)

						yield* Effect.scoped(
							Effect.gen(function* () {
								const watcher = yield* createFileWatcher({
									filePath: "/data/users.json",
									schema: UserSchema,
									ref,
								})

								const active = yield* watcher.isActive()
								expect(active).toBe(true)
							}),
						)
					}),
					layer,
				),
			)
		})

		it("watcher is cleaned up when scope closes", async () => {
			const { store, layer } = makeTestEnv()
			store.set("/data/users.json", JSON.stringify({ "1": { id: "1", name: "Alice" } }))

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const ref = yield* Ref.make<ReadonlyMap<string, User>>(
							new Map([["1", { id: "1", name: "Alice" }]]),
						)

						const scope = yield* Scope.make()

						const watcher = yield* Scope.extend(
							createFileWatcher({
								filePath: "/data/users.json",
								schema: UserSchema,
								ref,
							}),
							scope,
						)

						// Still active before scope close
						const activeBefore = yield* watcher.isActive()
						expect(activeBefore).toBe(true)

						// Close the scope — should trigger release
						yield* Scope.close(scope, Exit.void)

						// After scope close, watcher should be inactive
						const activeAfter = yield* watcher.isActive()
						expect(activeAfter).toBe(false)
					}),
					layer,
				),
			)
		})

		it("does not reload after scope is closed", async () => {
			const { store, layer } = makeTestEnv()
			store.set("/data/users.json", JSON.stringify({ "1": { id: "1", name: "Alice" } }))

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const ref = yield* Ref.make<ReadonlyMap<string, User>>(
							new Map([["1", { id: "1", name: "Alice" }]]),
						)

						const scope = yield* Scope.make()

						yield* Scope.extend(
							createFileWatcher({
								filePath: "/data/users.json",
								schema: UserSchema,
								ref,
								debounceMs: 10,
							}),
							scope,
						)

						// Close the scope first
						yield* Scope.close(scope, Exit.void)

						// Write new data — watcher should be dead, no reload
						const storage = yield* StorageAdapter
						yield* storage.write(
							"/data/users.json",
							JSON.stringify({
								"1": { id: "1", name: "Should Not Appear" },
							}),
						)

						yield* Effect.sleep(50)

						// Ref should still have original data
						const data = yield* Ref.get(ref)
						expect(data.get("1")?.name).toBe("Alice")
					}),
					layer,
				),
			)
		})
	})

	describe("file change reload", () => {
		it("updates Ref when file changes via storage adapter", async () => {
			const { store, layer } = makeTestEnv()
			store.set(
				"/data/users.json",
				JSON.stringify({ "1": { id: "1", name: "Alice" } }),
			)

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const ref = yield* Ref.make<ReadonlyMap<string, User>>(
							new Map([["1", { id: "1", name: "Alice" }]]),
						)

						yield* Effect.scoped(
							Effect.gen(function* () {
								yield* createFileWatcher({
									filePath: "/data/users.json",
									schema: UserSchema,
									ref,
									debounceMs: 20,
								})

								// Write new data through the storage adapter (triggers watcher)
								const storage = yield* StorageAdapter
								yield* storage.write(
									"/data/users.json",
									JSON.stringify({
										"1": { id: "1", name: "Alice Updated" },
										"2": { id: "2", name: "Bob" },
									}),
								)

								// Wait for debounce + processing
								yield* Effect.sleep(100)

								const data = yield* Ref.get(ref)
								expect(data.size).toBe(2)
								expect(data.get("1")?.name).toBe("Alice Updated")
								expect(data.get("2")?.name).toBe("Bob")
							}),
						)
					}),
					layer,
				),
			)
		})

		it("coalesces rapid file changes with debounce", async () => {
			const { store, layer } = makeTestEnv()
			store.set(
				"/data/users.json",
				JSON.stringify({ "1": { id: "1", name: "V0" } }),
			)

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const ref = yield* Ref.make<ReadonlyMap<string, User>>(
							new Map([["1", { id: "1", name: "V0" }]]),
						)

						yield* Effect.scoped(
							Effect.gen(function* () {
								yield* createFileWatcher({
									filePath: "/data/users.json",
									schema: UserSchema,
									ref,
									debounceMs: 50,
								})

								// Rapid successive writes via storage adapter
								const storage = yield* StorageAdapter
								for (let i = 1; i <= 5; i++) {
									yield* storage.write(
										"/data/users.json",
										JSON.stringify({ "1": { id: "1", name: `V${i}` } }),
									)
									yield* Effect.sleep(5)
								}

								// Wait for debounce to settle
								yield* Effect.sleep(150)

								const data = yield* Ref.get(ref)
								// Should have the last version
								expect(data.get("1")?.name).toBe("V5")
							}),
						)
					}),
					layer,
				),
			)
		})
	})

	describe("createFileWatchers (multiple)", () => {
		it("creates watchers for multiple files", async () => {
			const { store, layer } = makeTestEnv()
			store.set("/data/users.json", JSON.stringify({ "1": { id: "1", name: "Alice" } }))
			store.set("/data/posts.json", JSON.stringify({ "p1": { id: "p1", name: "Post1" } }))

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const usersRef = yield* Ref.make<ReadonlyMap<string, User>>(
							new Map([["1", { id: "1", name: "Alice" }]]),
						)
						const postsRef = yield* Ref.make<ReadonlyMap<string, User>>(
							new Map([["p1", { id: "p1", name: "Post1" }]]),
						)

						yield* Effect.scoped(
							Effect.gen(function* () {
								const watchers = yield* createFileWatchers([
									{ filePath: "/data/users.json", schema: UserSchema, ref: usersRef },
									{ filePath: "/data/posts.json", schema: UserSchema, ref: postsRef },
								])

								expect(watchers.length).toBe(2)

								for (const w of watchers) {
									expect(yield* w.isActive()).toBe(true)
								}
							}),
						)
					}),
					layer,
				),
			)
		})

		it("all watchers are cleaned up when scope closes", async () => {
			const { store, layer } = makeTestEnv()
			store.set("/data/users.json", JSON.stringify({ "1": { id: "1", name: "Alice" } }))
			store.set("/data/posts.json", JSON.stringify({ "p1": { id: "p1", name: "Post1" } }))

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const usersRef = yield* Ref.make<ReadonlyMap<string, User>>(
							new Map([["1", { id: "1", name: "Alice" }]]),
						)
						const postsRef = yield* Ref.make<ReadonlyMap<string, User>>(
							new Map([["p1", { id: "p1", name: "Post1" }]]),
						)

						const scope = yield* Scope.make()

						const watchers = yield* Scope.extend(
							createFileWatchers([
								{ filePath: "/data/users.json", schema: UserSchema, ref: usersRef },
								{ filePath: "/data/posts.json", schema: UserSchema, ref: postsRef },
							]),
							scope,
						)

						// All active
						for (const w of watchers) {
							expect(yield* w.isActive()).toBe(true)
						}

						// Close scope
						yield* Scope.close(scope, Exit.void)

						// All inactive
						for (const w of watchers) {
							expect(yield* w.isActive()).toBe(false)
						}
					}),
					layer,
				),
			)
		})

		it("each watcher independently reloads its file on change", async () => {
			const { store, layer } = makeTestEnv()
			store.set("/data/users.json", JSON.stringify({ "1": { id: "1", name: "Alice" } }))
			store.set("/data/posts.json", JSON.stringify({ "p1": { id: "p1", name: "Post1" } }))

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const usersRef = yield* Ref.make<ReadonlyMap<string, User>>(
							new Map([["1", { id: "1", name: "Alice" }]]),
						)
						const postsRef = yield* Ref.make<ReadonlyMap<string, User>>(
							new Map([["p1", { id: "p1", name: "Post1" }]]),
						)

						yield* Effect.scoped(
							Effect.gen(function* () {
								yield* createFileWatchers([
									{ filePath: "/data/users.json", schema: UserSchema, ref: usersRef, debounceMs: 20 },
									{ filePath: "/data/posts.json", schema: UserSchema, ref: postsRef, debounceMs: 20 },
								])

								// Update only users file
								const storage = yield* StorageAdapter
								yield* storage.write(
									"/data/users.json",
									JSON.stringify({
										"1": { id: "1", name: "Updated Alice" },
										"2": { id: "2", name: "Bob" },
									}),
								)

								yield* Effect.sleep(100)

								// Users should have updated
								const users = yield* Ref.get(usersRef)
								expect(users.size).toBe(2)
								expect(users.get("1")?.name).toBe("Updated Alice")

								// Posts should be unchanged
								const posts = yield* Ref.get(postsRef)
								expect(posts.size).toBe(1)
								expect(posts.get("p1")?.name).toBe("Post1")
							}),
						)
					}),
					layer,
				),
			)
		})
	})

	describe("error handling", () => {
		it("fails with StorageError when watch fails", async () => {
			// Create an adapter where watch always fails
			const failingAdapter = {
				read: (_path: string) => Effect.succeed("{}"),
				write: (_path: string, _data: string) => Effect.void,
				exists: (_path: string) => Effect.succeed(true),
				remove: (_path: string) => Effect.void,
				ensureDir: (_path: string) => Effect.void,
				watch: (path: string, _onChange: () => void) =>
					Effect.fail(
						new StorageError({
							path,
							operation: "watch" as const,
							message: "Watch not supported",
						}),
					),
			}

			const failingLayer = Layer.merge(
				Layer.succeed(StorageAdapter, failingAdapter),
				JsonSerializerLayer,
			)

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const ref = yield* Ref.make<ReadonlyMap<string, User>>(new Map())

						const exit = yield* Effect.scoped(
							createFileWatcher({
								filePath: "/does/not/matter.json",
								schema: UserSchema,
								ref,
							}),
						).pipe(Effect.exit)

						expect(exit._tag).toBe("Failure")
					}),
					failingLayer,
				),
			)
		})
	})
})
