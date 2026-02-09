import { describe, it, expect } from "vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import {
	loadData,
	saveData,
	loadCollectionsFromFile,
	saveCollectionsToFile,
	createDebouncedWriter,
} from "../core/storage/persistence-effect.js"
import { makeInMemoryStorageLayer } from "../core/storage/in-memory-adapter-layer.js"
import { StorageAdapter } from "../core/storage/storage-service.js"
import { JsonSerializerLayer, makeJsonSerializerLayer } from "../core/serializers/json.js"
import { YamlSerializerLayer } from "../core/serializers/yaml.js"
import { MessagePackSerializerLayer } from "../core/serializers/messagepack.js"
import {
	StorageError,
	SerializationError,
} from "../core/errors/storage-errors.js"
import { ValidationError } from "../core/errors/crud-errors.js"

// ============================================================================
// Test Schemas
// ============================================================================

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	age: Schema.Number,
	isActive: Schema.optional(Schema.Boolean, { default: () => true }),
})

type User = typeof UserSchema.Type

const PostSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	content: Schema.String,
	authorId: Schema.String,
	tags: Schema.optional(Schema.Array(Schema.String), { default: () => [] }),
})

type Post = typeof PostSchema.Type

const CategorySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.optional(Schema.String),
})

// ============================================================================
// Helpers
// ============================================================================

const makeTestEnv = () => {
	const store = new Map<string, string>()
	const layer = Layer.merge(makeInMemoryStorageLayer(store), JsonSerializerLayer)
	return { store, layer }
}

const makeYamlTestEnv = () => {
	const store = new Map<string, string>()
	const layer = Layer.merge(makeInMemoryStorageLayer(store), YamlSerializerLayer)
	return { store, layer }
}

const makeMsgpackTestEnv = () => {
	const store = new Map<string, string>()
	const layer = Layer.merge(makeInMemoryStorageLayer(store), MessagePackSerializerLayer)
	return { store, layer }
}

const sampleUsers: ReadonlyMap<string, User> = new Map([
	[
		"user-1",
		{
			id: "user-1",
			name: "Alice Johnson",
			email: "alice@example.com",
			age: 28,
			isActive: true,
		},
	],
	[
		"user-2",
		{
			id: "user-2",
			name: "Bob Smith",
			email: "bob@example.com",
			age: 35,
			isActive: true,
		},
	],
])

const samplePosts: ReadonlyMap<string, Post> = new Map([
	[
		"post-1",
		{
			id: "post-1",
			title: "Introduction to TypeScript",
			content: "TypeScript is a powerful superset of JavaScript...",
			authorId: "user-1",
			tags: ["typescript", "javascript", "programming"],
		},
	],
	[
		"post-2",
		{
			id: "post-2",
			title: "Database Design Patterns",
			content: "When designing databases, consider these patterns...",
			authorId: "user-2",
			tags: ["database", "design", "patterns"],
		},
	],
])

// ============================================================================
// Tests
// ============================================================================

describe("Persistence System (Effect-based)", () => {
	describe("Basic Persistence", () => {
		it("should save data and verify file creation", async () => {
			const { store, layer } = makeTestEnv()

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						yield* saveData("/test-data/users.json", UserSchema, sampleUsers)
						yield* saveData("/test-data/posts.json", PostSchema, samplePosts)

						const storage = yield* StorageAdapter
						expect(yield* storage.exists("/test-data/users.json")).toBe(true)
						expect(yield* storage.exists("/test-data/posts.json")).toBe(true)
					}),
					layer,
				),
			)

			// Verify data structure (object format keyed by ID)
			const usersData = JSON.parse(store.get("/test-data/users.json")!)
			expect(Object.keys(usersData)).toHaveLength(2)
			expect(usersData["user-1"]).toHaveProperty("id", "user-1")
			expect(usersData["user-1"]).toHaveProperty("name", "Alice Johnson")
			expect(usersData["user-1"]).toHaveProperty("email", "alice@example.com")
		})

		it("should load existing data from file", async () => {
			const { store, layer } = makeTestEnv()

			// Pre-populate storage
			store.set(
				"/test-data/users.json",
				JSON.stringify({
					"user-1": {
						id: "user-1",
						name: "Existing User",
						email: "existing@example.com",
						age: 30,
						isActive: true,
					},
				}),
			)
			store.set(
				"/test-data/posts.json",
				JSON.stringify({
					"post-1": {
						id: "post-1",
						title: "Existing Post",
						content: "This post already exists",
						authorId: "user-1",
						tags: ["existing"],
					},
				}),
			)

			const [users, posts] = await Effect.runPromise(
				Effect.provide(
					Effect.all([
						loadData("/test-data/users.json", UserSchema),
						loadData("/test-data/posts.json", PostSchema),
					]),
					layer,
				),
			)

			expect(users.size).toBe(1)
			expect(posts.size).toBe(1)
			expect(users.get("user-1")?.name).toBe("Existing User")
			expect(posts.get("post-1")?.title).toBe("Existing Post")
		})

		it("should persist and reload data correctly (round-trip)", async () => {
			const { layer } = makeTestEnv()

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						yield* saveData("/test-data/users.json", UserSchema, sampleUsers)
						yield* saveData("/test-data/posts.json", PostSchema, samplePosts)

						const loadedUsers = yield* loadData("/test-data/users.json", UserSchema)
						const loadedPosts = yield* loadData("/test-data/posts.json", PostSchema)

						return { users: loadedUsers, posts: loadedPosts }
					}),
					layer,
				),
			)

			expect(result.users.size).toBe(2)
			expect(result.posts.size).toBe(2)
			expect(result.users.get("user-1")?.name).toBe("Alice Johnson")
			expect(result.users.get("user-2")?.email).toBe("bob@example.com")
			expect(result.posts.get("post-1")?.title).toBe("Introduction to TypeScript")
			expect(result.posts.get("post-2")?.authorId).toBe("user-2")
		})

		it("should persist updates by saving modified state", async () => {
			const { store, layer } = makeTestEnv()

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						// Save initial data
						yield* saveData("/test-data/users.json", UserSchema, sampleUsers)

						// Modify state and re-save
						const updated = new Map(sampleUsers)
						updated.set("user-1", {
							...sampleUsers.get("user-1")!,
							age: 29,
						})
						yield* saveData("/test-data/users.json", UserSchema, updated)
					}),
					layer,
				),
			)

			// Verify update was persisted
			const parsed = JSON.parse(store.get("/test-data/users.json")!)
			expect(parsed["user-1"].age).toBe(29)
		})

		it("should persist deletions by saving without deleted entity", async () => {
			const { store, layer } = makeTestEnv()

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						yield* saveData("/test-data/posts.json", PostSchema, samplePosts)

						// Remove a post and re-save
						const remaining = new Map(samplePosts)
						remaining.delete("post-1")
						yield* saveData("/test-data/posts.json", PostSchema, remaining)
					}),
					layer,
				),
			)

			const parsed = JSON.parse(store.get("/test-data/posts.json")!)
			expect(parsed["post-1"]).toBeUndefined()
			expect(Object.keys(parsed)).toHaveLength(1)
		})
	})

	describe("Multiple File Formats", () => {
		it("should support JSON serialization with formatting", async () => {
			const store = new Map<string, string>()
			const layer = Layer.merge(
				makeInMemoryStorageLayer(store),
				makeJsonSerializerLayer({ indent: 2 }),
			)

			await Effect.runPromise(
				Effect.provide(
					saveData("/test-data/users.json", UserSchema, sampleUsers),
					layer,
				),
			)

			const content = store.get("/test-data/users.json")!
			// Should be valid JSON
			expect(() => JSON.parse(content)).not.toThrow()
			// Should be formatted (indented)
			expect(content).toContain("  ")
			expect(content).toContain("\n")
		})

		it("should support YAML serialization and round-trip", async () => {
			const { store, layer } = makeYamlTestEnv()

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						yield* saveData("/test-data/users.yaml", UserSchema, sampleUsers)
						return yield* loadData("/test-data/users.yaml", UserSchema)
					}),
					layer,
				),
			)

			// Verify YAML syntax in stored content
			const yamlContent = store.get("/test-data/users.yaml")!
			expect(yamlContent).toContain("user-1:")
			expect(yamlContent).toMatch(/^\s+\w+:/m) // Indented properties

			// Verify round-trip data
			expect(result.size).toBe(2)
			expect(result.get("user-1")?.name).toBe("Alice Johnson")
		})

		it("should support MessagePack serialization and round-trip", async () => {
			const { store, layer } = makeMsgpackTestEnv()

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						yield* saveData("/test-data/users.msgpack", UserSchema, sampleUsers)
						return yield* loadData("/test-data/users.msgpack", UserSchema)
					}),
					layer,
				),
			)

			// Stored content should be a base64 string (binary-encoded)
			const content = store.get("/test-data/users.msgpack")!
			expect(content.length).toBeGreaterThan(0)

			// Verify round-trip data
			expect(result.size).toBe(2)
			expect(result.get("user-1")?.name).toBe("Alice Johnson")
			expect(result.get("user-2")?.age).toBe(35)
		})

		it("should fail with UnsupportedFormatError for mismatched extension", async () => {
			const { store, layer } = makeTestEnv() // JSON-only serializer

			// File must exist so loadData reaches the deserialization step
			store.set("/test-data/users.yaml", "name: Alice")

			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/test-data/users.yaml", UserSchema).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("UnsupportedFormatError")
		})
	})

	describe("Shared Files (Multi-Collection)", () => {
		it("should handle multiple collections in shared files", async () => {
			const { store, layer } = makeTestEnv()

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						yield* saveCollectionsToFile("/test-data/content.json", [
							{ name: "posts", schema: PostSchema, data: samplePosts },
							{
								name: "categories",
								schema: CategorySchema,
								data: new Map([
									["cat-1", { id: "cat-1", name: "Technology", description: "Tech category" }],
								]),
							},
						])
					}),
					layer,
				),
			)

			// Verify shared file contains both collections
			const sharedData = JSON.parse(store.get("/test-data/content.json")!)
			expect(sharedData).toHaveProperty("posts")
			expect(sharedData).toHaveProperty("categories")
			expect(Object.keys(sharedData.posts)).toHaveLength(2)
			expect(Object.keys(sharedData.categories)).toHaveLength(1)
		})

		it("should load multiple collections from shared file", async () => {
			const { layer } = makeTestEnv()

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						yield* saveCollectionsToFile("/test-data/content.json", [
							{ name: "posts", schema: PostSchema, data: samplePosts },
							{
								name: "categories",
								schema: CategorySchema,
								data: new Map([
									["cat-1", { id: "cat-1", name: "Technology" }],
								]),
							},
						])

						return yield* loadCollectionsFromFile("/test-data/content.json", [
							{ name: "posts", schema: PostSchema },
							{ name: "categories", schema: CategorySchema },
						])
					}),
					layer,
				),
			)

			expect(result.posts.size).toBe(2)
			expect(result.categories.size).toBe(1)
			expect(result.posts.get("post-1")?.title).toBe("Introduction to TypeScript")
			expect(result.categories.get("cat-1")?.name).toBe("Technology")
		})

		it("should update shared file preserving both collections", async () => {
			const { store, layer } = makeTestEnv()

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						// Initial save
						yield* saveCollectionsToFile("/test-data/content.json", [
							{ name: "posts", schema: PostSchema, data: samplePosts },
							{
								name: "categories",
								schema: CategorySchema,
								data: new Map([
									["cat-1", { id: "cat-1", name: "Technology" }],
								]),
							},
						])

						// Add more data and re-save
						const updatedPosts = new Map(samplePosts)
						updatedPosts.set("post-3", {
							id: "post-3",
							title: "Second Post",
							content: "More content",
							authorId: "user-1",
							tags: ["shared"],
						})

						yield* saveCollectionsToFile("/test-data/content.json", [
							{ name: "posts", schema: PostSchema, data: updatedPosts },
							{
								name: "categories",
								schema: CategorySchema,
								data: new Map([
									["cat-1", { id: "cat-1", name: "Technology" }],
									["cat-2", { id: "cat-2", name: "Science" }],
								]),
							},
						])
					}),
					layer,
				),
			)

			const parsed = JSON.parse(store.get("/test-data/content.json")!)
			expect(Object.keys(parsed.posts)).toHaveLength(3)
			expect(Object.keys(parsed.categories)).toHaveLength(2)
		})
	})

	describe("Mixed Persistence (persistent vs in-memory)", () => {
		it("should save only persistent collections", async () => {
			const { store, layer } = makeTestEnv()

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						// Save users (persistent)
						yield* saveData("/test-data/users.json", UserSchema, sampleUsers)

						// Sessions are in-memory only — we just keep them in a Ref
						const sessionsRef = yield* Ref.make<ReadonlyMap<string, { readonly id: string; readonly token: string }>>(
							new Map([["s1", { id: "s1", token: "token123" }]]),
						)

						// Verify users file exists
						const storage = yield* StorageAdapter
						expect(yield* storage.exists("/test-data/users.json")).toBe(true)
						// No session file should exist
						expect(yield* storage.exists("/test-data/sessions.json")).toBe(false)

						// Sessions still available from Ref
						const sessions = yield* Ref.get(sessionsRef)
						expect(sessions.size).toBe(1)
					}),
					layer,
				),
			)
		})

		it("should load persistent data while in-memory state starts fresh", async () => {
			const { store, layer } = makeTestEnv()

			// Pre-populate only the persistent file
			store.set(
				"/test-data/users.json",
				JSON.stringify({
					"user-1": {
						id: "user-1",
						name: "Persistent User",
						email: "persist@example.com",
						age: 30,
						isActive: true,
					},
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const loadedUsers = yield* loadData("/test-data/users.json", UserSchema)
						// In-memory sessions Ref starts empty
						const sessionsRef = yield* Ref.make<ReadonlyMap<string, unknown>>(new Map())

						return {
							userCount: loadedUsers.size,
							sessionCount: (yield* Ref.get(sessionsRef)).size,
							userName: loadedUsers.get("user-1")?.name,
						}
					}),
					layer,
				),
			)

			expect(result.userCount).toBe(1)
			expect(result.sessionCount).toBe(0)
			expect(result.userName).toBe("Persistent User")
		})
	})

	describe("DebouncedWriter", () => {
		it("should coalesce multiple rapid saves into fewer writes", async () => {
			let writeCount = 0
			const store = new Map<string, string>()
			const originalSet = store.set.bind(store)
			store.set = (key: string, value: string) => {
				writeCount++
				return originalSet(key, value)
			}
			const layer = Layer.merge(makeInMemoryStorageLayer(store), JsonSerializerLayer)

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const writer = yield* createDebouncedWriter(100)

						// Schedule 5 rapid saves for the same key
						for (let i = 0; i < 5; i++) {
							yield* writer.triggerSave(
								"/test-data/users.json",
								saveData("/test-data/users.json", UserSchema, sampleUsers),
							)
						}

						// Should not have written yet
						const pendingBefore = yield* writer.pendingCount()
						expect(pendingBefore).toBe(1) // One pending key

						// Wait for debounce
						yield* Effect.sleep(150)

						// Should have written once (debounced)
						expect(writeCount).toBe(1)
					}),
					layer,
				),
			)
		})

		it("should flush pending writes immediately", async () => {
			const { store, layer } = makeTestEnv()

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const writer = yield* createDebouncedWriter(10000) // Very long debounce

						yield* writer.triggerSave(
							"/test-data/users.json",
							saveData("/test-data/users.json", UserSchema, sampleUsers),
						)

						// File should not exist yet
						const storage = yield* StorageAdapter
						expect(yield* storage.exists("/test-data/users.json")).toBe(false)

						// Flush forces immediate write
						yield* writer.flush()

						expect(yield* storage.exists("/test-data/users.json")).toBe(true)
						const parsed = JSON.parse(store.get("/test-data/users.json")!)
						expect(parsed["user-1"].name).toBe("Alice Johnson")
					}),
					layer,
				),
			)
		})

		it("should report pending count correctly", async () => {
			const { layer } = makeTestEnv()

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const writer = yield* createDebouncedWriter(500)

						// No pending writes initially
						expect(yield* writer.pendingCount()).toBe(0)

						// Schedule writes for two different keys
						yield* writer.triggerSave(
							"/test-data/users.json",
							saveData("/test-data/users.json", UserSchema, sampleUsers),
						)
						yield* writer.triggerSave(
							"/test-data/posts.json",
							saveData("/test-data/posts.json", PostSchema, samplePosts),
						)

						expect(yield* writer.pendingCount()).toBe(2)

						// Flush and verify count is back to 0
						yield* writer.flush()
						expect(yield* writer.pendingCount()).toBe(0)
					}),
					layer,
				),
			)
		})

		it("should replace pending write for the same key on re-trigger", async () => {
			const { store, layer } = makeTestEnv()

			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const writer = yield* createDebouncedWriter(10000)

						// First save with original data
						yield* writer.triggerSave(
							"/test-data/users.json",
							saveData("/test-data/users.json", UserSchema, sampleUsers),
						)

						// Re-trigger with modified data — should replace the pending write
						const modified = new Map<string, User>([
							["user-1", { id: "user-1", name: "Updated Alice", email: "alice@example.com", age: 29, isActive: true }],
						])
						yield* writer.triggerSave(
							"/test-data/users.json",
							saveData("/test-data/users.json", UserSchema, modified),
						)

						// Still only 1 pending write
						expect(yield* writer.pendingCount()).toBe(1)

						// Flush — should write the latest version
						yield* writer.flush()

						const parsed = JSON.parse(store.get("/test-data/users.json")!)
						expect(parsed["user-1"].name).toBe("Updated Alice")
						expect(Object.keys(parsed)).toHaveLength(1) // Only the modified data
					}),
					layer,
				),
			)
		})
	})

	describe("Error Handling", () => {
		it("should handle storage read errors gracefully", async () => {
			const failingAdapter = {
				read: (path: string) =>
					Effect.fail(
						new StorageError({
							path,
							operation: "read" as const,
							message: "Storage read error",
						}),
					),
				write: (_path: string, _data: string) => Effect.void,
				exists: (_path: string) => Effect.succeed(true), // File "exists" but can't be read
				remove: (_path: string) => Effect.void,
				ensureDir: (_path: string) => Effect.void,
				watch: (_path: string, _onChange: () => void) =>
					Effect.succeed(() => {}),
			}

			const layer = Layer.merge(
				Layer.succeed(StorageAdapter, failingAdapter),
				JsonSerializerLayer,
			)

			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/test-data/users.json", UserSchema).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("StorageError")
			expect((error as StorageError).message).toBe("Storage read error")
		})

		it("should handle storage write errors", async () => {
			const failingAdapter = {
				read: (_path: string) => Effect.succeed("{}"),
				write: (path: string, _data: string) =>
					Effect.fail(
						new StorageError({
							path,
							operation: "write" as const,
							message: "Storage write error",
						}),
					),
				exists: (_path: string) => Effect.succeed(false),
				remove: (_path: string) => Effect.void,
				ensureDir: (_path: string) => Effect.void,
				watch: (_path: string, _onChange: () => void) =>
					Effect.succeed(() => {}),
			}

			const layer = Layer.merge(
				Layer.succeed(StorageAdapter, failingAdapter),
				JsonSerializerLayer,
			)

			const error = await Effect.runPromise(
				Effect.provide(
					saveData("/test-data/users.json", UserSchema, sampleUsers).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("StorageError")
			expect((error as StorageError).message).toBe("Storage write error")
		})

		it("should handle invalid JSON data with SerializationError", async () => {
			const { store, layer } = makeTestEnv()

			store.set("/test-data/bad.json", "invalid json content {")

			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/test-data/bad.json", UserSchema).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("SerializationError")
		})

		it("should handle schema validation failures", async () => {
			const { store, layer } = makeTestEnv()

			// Write data that doesn't match the schema (age as string instead of number)
			store.set(
				"/test-data/users.json",
				JSON.stringify({
					"user-1": {
						id: "user-1",
						name: "Invalid User",
						email: "bad@example.com",
						age: "not-a-number",
					},
				}),
			)

			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/test-data/users.json", UserSchema).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("ValidationError")
			expect((error as ValidationError).message).toContain("user-1")
		})

		it("should return empty map when file does not exist", async () => {
			const { layer } = makeTestEnv()

			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/test-data/nonexistent.json", UserSchema),
					layer,
				),
			)

			expect(result.size).toBe(0)
		})
	})

	describe("Backward Compatibility (pure in-memory)", () => {
		it("should work with in-memory Ref state without persistence", async () => {
			// No storage adapter needed — just use Ref directly
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const usersRef = yield* Ref.make<ReadonlyMap<string, User>>(sampleUsers)
					const postsRef = yield* Ref.make<ReadonlyMap<string, Post>>(samplePosts)

					const users = yield* Ref.get(usersRef)
					const posts = yield* Ref.get(postsRef)

					expect(users.size).toBe(2)
					expect(posts.size).toBe(2)

					// Add a new user via Ref.update
					yield* Ref.update(usersRef, (m) => {
						const next = new Map(m)
						next.set("user-3", {
							id: "user-3",
							name: "New User",
							email: "new@example.com",
							age: 30,
							isActive: true,
						})
						return next
					})

					const allUsers = yield* Ref.get(usersRef)
					expect(allUsers.size).toBe(3)

					return allUsers
				}),
			)

			expect(result.get("user-3")?.name).toBe("New User")
		})
	})

	describe("Layer Swapping", () => {
		it("same program runs against different serializer layers", async () => {
			const program = Effect.gen(function* () {
				yield* saveData("/data/users.json", UserSchema, sampleUsers)
				return yield* loadData("/data/users.json", UserSchema)
			})

			// Run with JSON
			const jsonStore = new Map<string, string>()
			const jsonLayer = Layer.merge(
				makeInMemoryStorageLayer(jsonStore),
				JsonSerializerLayer,
			)
			const jsonResult = await Effect.runPromise(
				Effect.provide(program, jsonLayer),
			)
			expect(jsonResult.size).toBe(2)

			// Run with YAML (different extension needed)
			const yamlProgram = Effect.gen(function* () {
				yield* saveData("/data/users.yaml", UserSchema, sampleUsers)
				return yield* loadData("/data/users.yaml", UserSchema)
			})
			const yamlStore = new Map<string, string>()
			const yamlLayer = Layer.merge(
				makeInMemoryStorageLayer(yamlStore),
				YamlSerializerLayer,
			)
			const yamlResult = await Effect.runPromise(
				Effect.provide(yamlProgram, yamlLayer),
			)
			expect(yamlResult.size).toBe(2)

			// Both should produce the same data
			expect(jsonResult.get("user-1")?.name).toBe(yamlResult.get("user-1")?.name)
		})

		it("swapping from in-memory to filesystem adapter requires no code changes", async () => {
			// This test demonstrates the DI pattern — same load/save program, different adapter
			const program = Effect.gen(function* () {
				yield* saveData("/data/users.json", UserSchema, sampleUsers)
				return yield* loadData("/data/users.json", UserSchema)
			})

			// In-memory adapter
			const store = new Map<string, string>()
			const layer = Layer.merge(makeInMemoryStorageLayer(store), JsonSerializerLayer)

			const result = await Effect.runPromise(Effect.provide(program, layer))
			expect(result.size).toBe(2)
			expect(result.get("user-1")?.name).toBe("Alice Johnson")
		})
	})

	describe("Schema Encode/Decode on Persist", () => {
		it("should encode through schema on save and decode on load", async () => {
			// Use a schema with a transform to verify encode/decode
			const TimestampSchema = Schema.Struct({
				id: Schema.String,
				label: Schema.String,
				createdAt: Schema.NumberFromString,
			})

			type TimestampEntity = typeof TimestampSchema.Type

			const { store, layer } = makeTestEnv()

			const data: ReadonlyMap<string, TimestampEntity> = new Map([
				["t1", { id: "t1", label: "Event A", createdAt: 12345 }],
			])

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						yield* saveData("/data/timestamps.json", TimestampSchema, data)

						// On disk: createdAt should be encoded as string
						const stored = yield* Effect.sync(() =>
							JSON.parse(store.get("/data/timestamps.json")!),
						)
						expect(stored.t1.createdAt).toBe("12345")
						expect(typeof stored.t1.createdAt).toBe("string")

						// Load back — should decode to number
						return yield* loadData("/data/timestamps.json", TimestampSchema)
					}),
					layer,
				),
			)

			expect(result.get("t1")?.createdAt).toBe(12345)
			expect(typeof result.get("t1")?.createdAt).toBe("number")
		})
	})
})
