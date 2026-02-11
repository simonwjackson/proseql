import { describe, it, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import {
	loadData,
	saveData,
	loadCollectionsFromFile,
	saveCollectionsToFile,
} from "../core/storage/persistence-effect.js"
import { makeInMemoryStorageLayer } from "../core/storage/in-memory-adapter-layer.js"
import { JsonSerializerLayer } from "../core/serializers/json.js"
import { YamlSerializerLayer } from "../core/serializers/yaml.js"
import { StorageError, SerializationError } from "../core/errors/storage-errors.js"
import { ValidationError } from "../core/errors/crud-errors.js"
import { MigrationError } from "../core/errors/migration-errors.js"
import type { Migration } from "../core/migrations/migration-types.js"

// ============================================================================
// Test schemas
// ============================================================================

const UserSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	age: Schema.Number,
})

type User = typeof UserSchema.Type

/** Schema with a transform: encoded as string, decoded as number */
const TimestampSchema = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	createdAt: Schema.NumberFromString,
})

type TimestampEntity = typeof TimestampSchema.Type

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

// ============================================================================
// loadData / saveData round-trip
// ============================================================================

describe("persistence-effect: loadData & saveData", () => {
	describe("round-trip", () => {
		it("saveData then loadData returns the same entities", async () => {
			const { layer } = makeTestEnv()

			const original: ReadonlyMap<string, User> = new Map([
				["u1", { id: "u1", name: "Alice", age: 30 }],
				["u2", { id: "u2", name: "Bob", age: 25 }],
			])

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						yield* saveData("/data/users.json", UserSchema, original)
						return yield* loadData("/data/users.json", UserSchema)
					}),
					layer,
				),
			)

			expect(result.size).toBe(2)
			expect(result.get("u1")).toEqual({ id: "u1", name: "Alice", age: 30 })
			expect(result.get("u2")).toEqual({ id: "u2", name: "Bob", age: 25 })
		})

		it("round-trips with an empty map", async () => {
			const { layer } = makeTestEnv()

			const empty: ReadonlyMap<string, User> = new Map()

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						yield* saveData("/data/empty.json", UserSchema, empty)
						return yield* loadData("/data/empty.json", UserSchema)
					}),
					layer,
				),
			)

			expect(result.size).toBe(0)
		})

		it("round-trips with YAML format", async () => {
			const { layer } = makeYamlTestEnv()

			const original: ReadonlyMap<string, User> = new Map([
				["u1", { id: "u1", name: "Alice", age: 30 }],
			])

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						yield* saveData("/data/users.yaml", UserSchema, original)
						return yield* loadData("/data/users.yaml", UserSchema)
					}),
					layer,
				),
			)

			expect(result.size).toBe(1)
			expect(result.get("u1")).toEqual({ id: "u1", name: "Alice", age: 30 })
		})
	})

	// ============================================================================
	// Schema decode on load
	// ============================================================================

	describe("Schema decode on load", () => {
		it("decodes valid data through the schema", async () => {
			const { store, layer } = makeTestEnv()

			// Manually write valid data to the store
			store.set(
				"/data/users.json",
				JSON.stringify({
					u1: { id: "u1", name: "Alice", age: 30 },
					u2: { id: "u2", name: "Bob", age: 25 },
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchema),
					layer,
				),
			)

			expect(result.size).toBe(2)
			expect(result.get("u1")).toEqual({ id: "u1", name: "Alice", age: 30 })
		})

		it("fails with ValidationError for invalid data", async () => {
			const { store, layer } = makeTestEnv()

			// Write data with wrong type for 'age' (string instead of number)
			store.set(
				"/data/users.json",
				JSON.stringify({
					u1: { id: "u1", name: "Alice", age: "not-a-number" },
				}),
			)

			const exit = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchema).pipe(Effect.exit),
					layer,
				),
			)

			expect(exit._tag).toBe("Failure")
		})

		it("ValidationError includes the entity id context", async () => {
			const { store, layer } = makeTestEnv()

			store.set(
				"/data/users.json",
				JSON.stringify({
					badEntity: { id: "badEntity", name: 123 }, // name should be string
				}),
			)

			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchema).pipe(
						Effect.flip,
					),
					layer,
				),
			)

			expect(error._tag).toBe("ValidationError")
			expect((error as ValidationError).message).toContain("badEntity")
		})

		it("returns empty map when file does not exist", async () => {
			const { layer } = makeTestEnv()

			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/nonexistent.json", UserSchema),
					layer,
				),
			)

			expect(result.size).toBe(0)
		})

		it("fails with SerializationError for non-object top-level data", async () => {
			const { store, layer } = makeTestEnv()

			store.set("/data/bad.json", JSON.stringify([1, 2, 3]))

			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/data/bad.json", UserSchema).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("SerializationError")
		})

		it("decodes through a transforming schema (NumberFromString)", async () => {
			const { store, layer } = makeTestEnv()

			// On disk: createdAt is a string ("12345")
			store.set(
				"/data/timestamps.json",
				JSON.stringify({
					t1: { id: "t1", label: "Event A", createdAt: "12345" },
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/timestamps.json", TimestampSchema),
					layer,
				),
			)

			expect(result.size).toBe(1)
			const entity = result.get("t1")!
			// After decode, createdAt should be a number
			expect(entity.createdAt).toBe(12345)
			expect(typeof entity.createdAt).toBe("number")
		})
	})

	// ============================================================================
	// Schema encode on save
	// ============================================================================

	describe("Schema encode on save", () => {
		it("encodes data through the schema before writing", async () => {
			const { store, layer } = makeTestEnv()

			const data: ReadonlyMap<string, User> = new Map([
				["u1", { id: "u1", name: "Alice", age: 30 }],
			])

			await Effect.runPromise(
				Effect.provide(
					saveData("/data/users.json", UserSchema, data),
					layer,
				),
			)

			const stored = store.get("/data/users.json")
			expect(stored).toBeDefined()
			const parsed = JSON.parse(stored!)
			expect(parsed.u1).toEqual({ id: "u1", name: "Alice", age: 30 })
		})

		it("encodes through a transforming schema (number → string on disk)", async () => {
			const { store, layer } = makeTestEnv()

			// In memory: createdAt is a number
			const data: ReadonlyMap<string, TimestampEntity> = new Map([
				["t1", { id: "t1", label: "Event A", createdAt: 12345 }],
			])

			await Effect.runPromise(
				Effect.provide(
					saveData("/data/timestamps.json", TimestampSchema, data),
					layer,
				),
			)

			const stored = store.get("/data/timestamps.json")
			expect(stored).toBeDefined()
			const parsed = JSON.parse(stored!)
			// On disk: createdAt should be encoded as a string
			expect(parsed.t1.createdAt).toBe("12345")
			expect(typeof parsed.t1.createdAt).toBe("string")
		})

		it("encode → decode round-trip preserves data through transform", async () => {
			const { layer } = makeTestEnv()

			const original: ReadonlyMap<string, TimestampEntity> = new Map([
				["t1", { id: "t1", label: "Event A", createdAt: 42 }],
				["t2", { id: "t2", label: "Event B", createdAt: 99 }],
			])

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						yield* saveData("/data/ts.json", TimestampSchema, original)
						return yield* loadData("/data/ts.json", TimestampSchema)
					}),
					layer,
				),
			)

			expect(result.size).toBe(2)
			expect(result.get("t1")?.createdAt).toBe(42)
			expect(result.get("t2")?.createdAt).toBe(99)
		})
	})

	// ============================================================================
	// Version stamping
	// ============================================================================

	describe("version stamping", () => {
		it("saveData stamps _version first in output when version option provided", async () => {
			const { store, layer } = makeTestEnv()

			const data: ReadonlyMap<string, User> = new Map([
				["u1", { id: "u1", name: "Alice", age: 30 }],
				["u2", { id: "u2", name: "Bob", age: 25 }],
			])

			await Effect.runPromise(
				Effect.provide(
					saveData("/data/versioned.json", UserSchema, data, { version: 5 }),
					layer,
				),
			)

			const stored = store.get("/data/versioned.json")
			expect(stored).toBeDefined()
			// Verify _version is the first key in the output
			const parsed = JSON.parse(stored!)
			const keys = Object.keys(parsed)
			expect(keys[0]).toBe("_version")
			expect(parsed._version).toBe(5)
		})

		it("saveData omits _version when version option not provided", async () => {
			const { store, layer } = makeTestEnv()

			const data: ReadonlyMap<string, User> = new Map([
				["u1", { id: "u1", name: "Alice", age: 30 }],
			])

			await Effect.runPromise(
				Effect.provide(
					saveData("/data/unversioned.json", UserSchema, data),
					layer,
				),
			)

			const stored = store.get("/data/unversioned.json")
			expect(stored).toBeDefined()
			const parsed = JSON.parse(stored!)
			expect(parsed._version).toBeUndefined()
		})
	})

	// ============================================================================
	// Version handling on load
	// ============================================================================

	describe("version handling on load", () => {
		it("loads normally when file version equals config version (no migration)", async () => {
			const { store, layer } = makeTestEnv()

			// File already at version 3
			store.set(
				"/data/current.json",
				JSON.stringify({
					_version: 3,
					u1: { id: "u1", name: "Alice", age: 30 },
					u2: { id: "u2", name: "Bob", age: 25 },
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/current.json", UserSchema, {
						version: 3,
						collectionName: "users",
						// No migrations needed since versions match
						migrations: [],
					}),
					layer,
				),
			)

			// Data loads correctly
			expect(result.size).toBe(2)
			expect(result.get("u1")).toEqual({ id: "u1", name: "Alice", age: 30 })
			expect(result.get("u2")).toEqual({ id: "u2", name: "Bob", age: 25 })

			// File should NOT be rewritten (no migration needed)
			const stored = store.get("/data/current.json")
			const parsed = JSON.parse(stored!)
			// _version should still be there since we didn't rewrite
			expect(parsed._version).toBe(3)
		})

		it("strips _version from loaded entities when versions match", async () => {
			const { store, layer } = makeTestEnv()

			store.set(
				"/data/versioned.json",
				JSON.stringify({
					_version: 5,
					u1: { id: "u1", name: "Alice", age: 30 },
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/versioned.json", UserSchema, {
						version: 5,
						collectionName: "users",
					}),
					layer,
				),
			)

			// _version should not appear as an entity
			expect(result.has("_version")).toBe(false)
			expect(result.size).toBe(1)
			expect(result.get("u1")).toEqual({ id: "u1", name: "Alice", age: 30 })
		})

		it("file is not modified when versions match (no write-back)", async () => {
			const { store, layer } = makeTestEnv()

			const originalContent = JSON.stringify({
				_version: 2,
				u1: { id: "u1", name: "Alice", age: 30 },
			})
			store.set("/data/unchanged.json", originalContent)

			await Effect.runPromise(
				Effect.provide(
					loadData("/data/unchanged.json", UserSchema, {
						version: 2,
						collectionName: "users",
						migrations: [],
					}),
					layer,
				),
			)

			// File content should be exactly the same (no write-back occurred)
			expect(store.get("/data/unchanged.json")).toBe(originalContent)
		})
	})

	// ============================================================================
	// Post-migration validation
	// ============================================================================

	describe("post-migration validation", () => {
		// Schema at version 2 expects a 'role' field that didn't exist in version 1
		const UserSchemaV2 = Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			age: Schema.Number,
			role: Schema.String, // Required field added in v2
		})

		it("original file is untouched if post-migration validation fails (loadData)", async () => {
			const { store, layer } = makeTestEnv()

			// File at version 0 with data missing 'role' field
			const originalContent = JSON.stringify({
				_version: 0,
				u1: { id: "u1", name: "Alice", age: 30 },
				u2: { id: "u2", name: "Bob", age: 25 },
			})
			store.set("/data/users.json", originalContent)

			// Migration that renames but doesn't add 'role' (incomplete migration)
			const migrations: ReadonlyArray<Migration> = [
				{
					from: 0,
					to: 1,
					transform: (data) => {
						// Just pass through - doesn't add 'role' field
						return data
					},
				},
			]

			// Attempt to load with schema that requires 'role' field
			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV2, {
						version: 1,
						collectionName: "users",
						migrations,
					}).pipe(Effect.flip),
					layer,
				),
			)

			// Should fail with MigrationError (step: -1 for validation failure)
			expect(error._tag).toBe("MigrationError")
			expect((error as MigrationError).step).toBe(-1)
			expect((error as MigrationError).reason).toBe("post-migration-validation-failed")

			// Original file should be completely unchanged
			expect(store.get("/data/users.json")).toBe(originalContent)
		})

		it("original file is untouched if post-migration validation fails (loadCollectionsFromFile)", async () => {
			const { store, layer } = makeTestEnv()

			// File at version 0 with data missing 'role' field
			const originalContent = JSON.stringify({
				users: {
					_version: 0,
					u1: { id: "u1", name: "Alice", age: 30 },
				},
			})
			store.set("/data/db.json", originalContent)

			// Migration that doesn't add 'role' field
			const migrations: ReadonlyArray<Migration> = [
				{
					from: 0,
					to: 1,
					transform: (data) => data,
				},
			]

			// Attempt to load with schema that requires 'role' field
			const error = await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/db.json", [
						{
							name: "users",
							schema: UserSchemaV2,
							version: 1,
							migrations,
						},
					]).pipe(Effect.flip),
					layer,
				),
			)

			// Should fail with MigrationError (step: -1 for validation failure)
			expect(error._tag).toBe("MigrationError")
			expect((error as MigrationError).step).toBe(-1)
			expect((error as MigrationError).reason).toBe("post-migration-validation-failed")

			// Original file should be completely unchanged
			expect(store.get("/data/db.json")).toBe(originalContent)
		})
	})

	// ============================================================================
	// Error cases
	// ============================================================================

	describe("error cases", () => {
		it("fails with StorageError when file path has no extension", async () => {
			const { layer } = makeTestEnv()

			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/data/noext", UserSchema).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("StorageError")
		})

		it("fails with StorageError on save when file path has no extension", async () => {
			const { layer } = makeTestEnv()

			const error = await Effect.runPromise(
				Effect.provide(
					saveData("/data/noext", UserSchema, new Map()).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("StorageError")
		})
	})
})

// ============================================================================
// loadCollectionsFromFile / saveCollectionsToFile
// ============================================================================

describe("persistence-effect: multi-collection file operations", () => {
	const PostSchema = Schema.Struct({
		id: Schema.String,
		title: Schema.String,
	})

	describe("round-trip", () => {
		it("save then load multiple collections from one file", async () => {
			const { layer } = makeTestEnv()

			const usersData: ReadonlyMap<string, { readonly id: string; readonly name: string; readonly age: number }> = new Map([
				["u1", { id: "u1", name: "Alice", age: 30 }],
			])
			const postsData: ReadonlyMap<string, { readonly id: string; readonly title: string }> = new Map([
				["p1", { id: "p1", title: "Hello" }],
				["p2", { id: "p2", title: "World" }],
			])

			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						yield* saveCollectionsToFile("/data/db.json", [
							{ name: "users", schema: UserSchema, data: usersData },
							{ name: "posts", schema: PostSchema, data: postsData },
						])

						return yield* loadCollectionsFromFile("/data/db.json", [
							{ name: "users", schema: UserSchema },
							{ name: "posts", schema: PostSchema },
						])
					}),
					layer,
				),
			)

			expect(result.users.size).toBe(1)
			expect(result.users.get("u1")?.name).toBe("Alice")
			expect(result.posts.size).toBe(2)
			expect(result.posts.get("p1")?.title).toBe("Hello")
		})
	})

	describe("load behavior", () => {
		it("returns empty maps when file does not exist", async () => {
			const { layer } = makeTestEnv()

			const result = await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/missing.json", [
						{ name: "users", schema: UserSchema },
						{ name: "posts", schema: PostSchema },
					]),
					layer,
				),
			)

			expect(result.users.size).toBe(0)
			expect(result.posts.size).toBe(0)
		})

		it("returns empty map for collections not present in file", async () => {
			const { store, layer } = makeTestEnv()

			store.set(
				"/data/partial.json",
				JSON.stringify({
					users: { u1: { id: "u1", name: "Alice", age: 30 } },
					// no "posts" key
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/partial.json", [
						{ name: "users", schema: UserSchema },
						{ name: "posts", schema: PostSchema },
					]),
					layer,
				),
			)

			expect(result.users.size).toBe(1)
			expect(result.posts.size).toBe(0)
		})

		it("fails with ValidationError when collection data is invalid", async () => {
			const { store, layer } = makeTestEnv()

			store.set(
				"/data/invalid.json",
				JSON.stringify({
					users: { u1: { id: "u1", name: 999, age: "bad" } },
				}),
			)

			const exit = await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/invalid.json", [
						{ name: "users", schema: UserSchema },
					]).pipe(Effect.exit),
					layer,
				),
			)

			expect(exit._tag).toBe("Failure")
		})
	})

	describe("version stamping", () => {
		it("saveCollectionsToFile stamps _version first in collection object", async () => {
			const { store, layer } = makeTestEnv()

			await Effect.runPromise(
				Effect.provide(
					saveCollectionsToFile("/data/versioned.json", [
						{
							name: "users",
							schema: UserSchema,
							data: new Map([["u1", { id: "u1", name: "Alice", age: 30 }]]),
							version: 3,
						},
					]),
					layer,
				),
			)

			const stored = store.get("/data/versioned.json")
			expect(stored).toBeDefined()
			// Verify _version is the first key in the users collection
			const parsed = JSON.parse(stored!)
			const keys = Object.keys(parsed.users)
			expect(keys[0]).toBe("_version")
			expect(parsed.users._version).toBe(3)
		})

		it("saveCollectionsToFile omits _version when not provided", async () => {
			const { store, layer } = makeTestEnv()

			await Effect.runPromise(
				Effect.provide(
					saveCollectionsToFile("/data/unversioned.json", [
						{
							name: "users",
							schema: UserSchema,
							data: new Map([["u1", { id: "u1", name: "Alice", age: 30 }]]),
							// no version specified
						},
					]),
					layer,
				),
			)

			const stored = store.get("/data/unversioned.json")
			expect(stored).toBeDefined()
			const parsed = JSON.parse(stored!)
			expect(parsed.users._version).toBeUndefined()
		})
	})

	describe("save behavior", () => {
		it("writes all collections to a single file", async () => {
			const { store, layer } = makeTestEnv()

			await Effect.runPromise(
				Effect.provide(
					saveCollectionsToFile("/data/all.json", [
						{
							name: "users",
							schema: UserSchema,
							data: new Map([["u1", { id: "u1", name: "Alice", age: 30 }]]),
						},
						{
							name: "posts",
							schema: PostSchema,
							data: new Map([["p1", { id: "p1", title: "Post 1" }]]),
						},
					]),
					layer,
				),
			)

			const stored = store.get("/data/all.json")
			expect(stored).toBeDefined()
			const parsed = JSON.parse(stored!)
			expect(parsed.users.u1).toEqual({ id: "u1", name: "Alice", age: 30 })
			expect(parsed.posts.p1).toEqual({ id: "p1", title: "Post 1" })
		})

		it("encodes through schema transforms on save (multi-collection)", async () => {
			const { store, layer } = makeTestEnv()

			const data: ReadonlyMap<string, TimestampEntity> = new Map([
				["t1", { id: "t1", label: "Event", createdAt: 777 }],
			])

			await Effect.runPromise(
				Effect.provide(
					saveCollectionsToFile("/data/mixed.json", [
						{ name: "events", schema: TimestampSchema, data },
					]),
					layer,
				),
			)

			const stored = store.get("/data/mixed.json")
			const parsed = JSON.parse(stored!)
			// NumberFromString should encode number → string
			expect(parsed.events.t1.createdAt).toBe("777")
		})
	})
})
