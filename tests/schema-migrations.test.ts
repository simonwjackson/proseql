import { describe, it, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import {
	loadData,
	saveData,
	loadCollectionsFromFile,
	saveCollectionsToFile,
} from "../core/storage/persistence-effect.js"
import { makeInMemoryStorageLayer } from "../core/storage/in-memory-adapter-layer.js"
import { makeSerializerLayer } from "../core/serializers/format-codec.js"
import { jsonCodec } from "../core/serializers/codecs/json.js"
import { yamlCodec } from "../core/serializers/codecs/yaml.js"
import { MigrationError } from "../core/errors/migration-errors.js"
import { validateMigrationRegistry } from "../core/migrations/migration-runner.js"
import type { Migration } from "../core/migrations/migration-types.js"

// ============================================================================
// Test Helpers: In-memory storage and layer factories
// ============================================================================

/**
 * Create a test environment with in-memory storage and JSON serialization.
 * Returns the underlying store Map for inspection in tests.
 */
const makeTestEnv = () => {
	const store = new Map<string, string>()
	const layer = Layer.merge(makeInMemoryStorageLayer(store), makeSerializerLayer([jsonCodec()]))
	return { store, layer }
}

/**
 * Create a test environment with in-memory storage and YAML serialization.
 */
const makeYamlTestEnv = () => {
	const store = new Map<string, string>()
	const layer = Layer.merge(makeInMemoryStorageLayer(store), makeSerializerLayer([yamlCodec()]))
	return { store, layer }
}

// ============================================================================
// Sample Schemas at Multiple Versions
// ============================================================================

/**
 * Version 0 (legacy) schema: users have only id and name
 */
const UserSchemaV0 = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
})

type UserV0 = typeof UserSchemaV0.Type

/**
 * Version 1 schema: adds email field
 */
const UserSchemaV1 = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
})

type UserV1 = typeof UserSchemaV1.Type

/**
 * Version 2 schema: splits name into firstName + lastName
 */
const UserSchemaV2 = Schema.Struct({
	id: Schema.String,
	firstName: Schema.String,
	lastName: Schema.String,
	email: Schema.String,
})

type UserV2 = typeof UserSchemaV2.Type

/**
 * Version 3 schema: adds age field (optional with default)
 */
const UserSchemaV3 = Schema.Struct({
	id: Schema.String,
	firstName: Schema.String,
	lastName: Schema.String,
	email: Schema.String,
	age: Schema.Number,
})

type UserV3 = typeof UserSchemaV3.Type

// ============================================================================
// Sample Migrations
// ============================================================================

/**
 * Migration 0→1: Add email field with placeholder value
 */
const migration0to1: Migration = {
	from: 0,
	to: 1,
	description: "Add email field",
	transform: (data) => {
		const result: Record<string, unknown> = {}
		for (const [id, entity] of Object.entries(data)) {
			const e = entity as { id: string; name: string }
			result[id] = {
				...e,
				email: `${e.name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
			}
		}
		return result
	},
}

/**
 * Migration 1→2: Split name into firstName + lastName
 */
const migration1to2: Migration = {
	from: 1,
	to: 2,
	description: "Split name into firstName and lastName",
	transform: (data) => {
		const result: Record<string, unknown> = {}
		for (const [id, entity] of Object.entries(data)) {
			const e = entity as { id: string; name: string; email: string }
			const parts = e.name.split(" ")
			const firstName = parts[0] || ""
			const lastName = parts.slice(1).join(" ") || ""
			result[id] = {
				id: e.id,
				firstName,
				lastName,
				email: e.email,
			}
		}
		return result
	},
}

/**
 * Migration 2→3: Add age field with default value
 */
const migration2to3: Migration = {
	from: 2,
	to: 3,
	description: "Add age field",
	transform: (data) => {
		const result: Record<string, unknown> = {}
		for (const [id, entity] of Object.entries(data)) {
			result[id] = {
				...(entity as object),
				age: 0,
			}
		}
		return result
	},
}

/**
 * Complete migration chain from version 0 to version 3
 */
const allMigrations: ReadonlyArray<Migration> = [
	migration0to1,
	migration1to2,
	migration2to3,
]

/**
 * Migrations from version 0 to version 1 only
 */
const migrationsTo1: ReadonlyArray<Migration> = [migration0to1]

/**
 * Migrations from version 0 to version 2
 */
const migrationsTo2: ReadonlyArray<Migration> = [migration0to1, migration1to2]

// ============================================================================
// Tests: Schema Versioning (Tasks 9.2-9.6)
// ============================================================================

describe("schema-migrations: schema versioning", () => {
	describe("save versioned collection → file contains _version (task 9.2)", () => {
		it("saveData stamps _version when version option provided", async () => {
			const { store, layer } = makeTestEnv()

			const data: ReadonlyMap<string, UserV1> = new Map([
				["u1", { id: "u1", name: "Alice", email: "alice@example.com" }],
			])

			await Effect.runPromise(
				Effect.provide(
					saveData("/data/users.json", UserSchemaV1, data, { version: 1 }),
					layer,
				),
			)

			const stored = store.get("/data/users.json")
			expect(stored).toBeDefined()
			const parsed = JSON.parse(stored!)
			expect(parsed._version).toBe(1)
		})

		it("_version appears first in the output object", async () => {
			const { store, layer } = makeTestEnv()

			const data: ReadonlyMap<string, UserV1> = new Map([
				["u1", { id: "u1", name: "Alice", email: "alice@example.com" }],
				["u2", { id: "u2", name: "Bob", email: "bob@example.com" }],
			])

			await Effect.runPromise(
				Effect.provide(
					saveData("/data/users.json", UserSchemaV1, data, { version: 3 }),
					layer,
				),
			)

			const stored = store.get("/data/users.json")
			const parsed = JSON.parse(stored!)
			const keys = Object.keys(parsed)
			expect(keys[0]).toBe("_version")
		})

		it("saveCollectionsToFile stamps _version per-collection", async () => {
			const { store, layer } = makeTestEnv()

			await Effect.runPromise(
				Effect.provide(
					saveCollectionsToFile("/data/db.json", [
						{
							name: "users",
							schema: UserSchemaV1,
							data: new Map([["u1", { id: "u1", name: "Alice", email: "a@b.c" }]]),
							version: 2,
						},
					]),
					layer,
				),
			)

			const stored = store.get("/data/db.json")
			const parsed = JSON.parse(stored!)
			expect(parsed.users._version).toBe(2)
		})
	})

	describe("load file at current version → entities loaded, _version stripped (task 9.3)", () => {
		it("loadData strips _version from entity map", async () => {
			const { store, layer } = makeTestEnv()

			store.set(
				"/data/users.json",
				JSON.stringify({
					_version: 1,
					u1: { id: "u1", name: "Alice", email: "alice@example.com" },
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV1, {
						version: 1,
						collectionName: "users",
					}),
					layer,
				),
			)

			expect(result.has("_version")).toBe(false)
			expect(result.size).toBe(1)
			expect(result.get("u1")).toEqual({
				id: "u1",
				name: "Alice",
				email: "alice@example.com",
			})
		})

		it("loadCollectionsFromFile strips _version from each collection", async () => {
			const { store, layer } = makeTestEnv()

			store.set(
				"/data/db.json",
				JSON.stringify({
					users: {
						_version: 1,
						u1: { id: "u1", name: "Alice", email: "alice@example.com" },
					},
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/db.json", [
						{ name: "users", schema: UserSchemaV1, version: 1 },
					]),
					layer,
				),
			)

			expect(result.users.has("_version")).toBe(false)
			expect(result.users.size).toBe(1)
		})
	})

	describe("load file without _version → treated as version 0 (task 9.4)", () => {
		it("loadData treats missing _version as version 0", async () => {
			const { store, layer } = makeTestEnv()

			// File without _version at all (legacy data)
			store.set(
				"/data/users.json",
				JSON.stringify({
					u1: { id: "u1", name: "Alice" },
				}),
			)

			// Load with version 1 config and migration from 0 to 1
			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV1, {
						version: 1,
						collectionName: "users",
						migrations: migrationsTo1,
					}),
					layer,
				),
			)

			// Migration should have run, adding email
			expect(result.size).toBe(1)
			const user = result.get("u1")!
			expect(user.email).toBe("alice@example.com")
		})

		it("loadCollectionsFromFile treats missing _version as version 0", async () => {
			const { store, layer } = makeTestEnv()

			store.set(
				"/data/db.json",
				JSON.stringify({
					users: {
						u1: { id: "u1", name: "Bob" },
					},
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/db.json", [
						{
							name: "users",
							schema: UserSchemaV1,
							version: 1,
							migrations: migrationsTo1,
						},
					]),
					layer,
				),
			)

			const user = result.users.get("u1") as UserV1
			expect(user.email).toBe("bob@example.com")
		})
	})

	describe("load file with version ahead → MigrationError (task 9.5)", () => {
		it("loadData fails when file version > config version", async () => {
			const { store, layer } = makeTestEnv()

			// File at version 5, config at version 3
			store.set(
				"/data/users.json",
				JSON.stringify({
					_version: 5,
					u1: { id: "u1", name: "Alice", email: "alice@example.com" },
				}),
			)

			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV1, {
						version: 3,
						collectionName: "users",
					}).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("MigrationError")
			const migrationError = error as MigrationError
			expect(migrationError.reason).toBe("version-ahead")
			expect(migrationError.message).toContain("ahead")
		})

		it("loadCollectionsFromFile fails when collection version ahead", async () => {
			const { store, layer } = makeTestEnv()

			store.set(
				"/data/db.json",
				JSON.stringify({
					users: {
						_version: 10,
						u1: { id: "u1", name: "Alice", email: "alice@example.com" },
					},
				}),
			)

			const error = await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/db.json", [
						{ name: "users", schema: UserSchemaV1, version: 2 },
					]).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("MigrationError")
			expect((error as MigrationError).reason).toBe("version-ahead")
		})
	})

	describe("unversioned collection → _version not written or checked (task 9.6)", () => {
		it("saveData without version option does not write _version", async () => {
			const { store, layer } = makeTestEnv()

			const data: ReadonlyMap<string, UserV1> = new Map([
				["u1", { id: "u1", name: "Alice", email: "alice@example.com" }],
			])

			await Effect.runPromise(
				Effect.provide(
					saveData("/data/users.json", UserSchemaV1, data),
					layer,
				),
			)

			const stored = store.get("/data/users.json")
			const parsed = JSON.parse(stored!)
			expect(parsed._version).toBeUndefined()
		})

		it("loadData without version option ignores _version in file", async () => {
			const { store, layer } = makeTestEnv()

			// File has _version but we're loading as unversioned
			store.set(
				"/data/users.json",
				JSON.stringify({
					_version: 99,
					u1: { id: "u1", name: "Alice", email: "alice@example.com" },
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV1),
					layer,
				),
			)

			// Should load successfully, ignoring _version
			expect(result.size).toBe(1)
			expect(result.get("u1")?.name).toBe("Alice")
			// _version should not appear as an entity
			expect(result.has("_version")).toBe(false)
		})

		it("saveCollectionsToFile without version omits _version from collection", async () => {
			const { store, layer } = makeTestEnv()

			await Effect.runPromise(
				Effect.provide(
					saveCollectionsToFile("/data/db.json", [
						{
							name: "users",
							schema: UserSchemaV1,
							data: new Map([["u1", { id: "u1", name: "Alice", email: "a@b.c" }]]),
							// no version specified
						},
					]),
					layer,
				),
			)

			const stored = store.get("/data/db.json")
			const parsed = JSON.parse(stored!)
			expect(parsed.users._version).toBeUndefined()
		})

		it("loadCollectionsFromFile without version ignores _version in file", async () => {
			const { store, layer } = makeTestEnv()

			store.set(
				"/data/db.json",
				JSON.stringify({
					users: {
						_version: 99,
						u1: { id: "u1", name: "Alice", email: "alice@example.com" },
					},
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/db.json", [
						{ name: "users", schema: UserSchemaV1 },
					]),
					layer,
				),
			)

			expect(result.users.size).toBe(1)
			expect(result.users.has("_version")).toBe(false)
		})
	})
})

// ============================================================================
// Tests: Migration Registry Validation (Tasks 10.1-10.6)
// ============================================================================

describe("schema-migrations: migration registry validation", () => {
	describe("valid contiguous chain → accepted (task 10.1)", () => {
		it("accepts valid chain 0→1→2→3", async () => {
			const result = await Effect.runPromise(
				validateMigrationRegistry("users", 3, allMigrations).pipe(
					Effect.map(() => "success"),
					Effect.catchAll((e) => Effect.succeed(e)),
				),
			)
			expect(result).toBe("success")
		})

		it("accepts single migration 0→1", async () => {
			const result = await Effect.runPromise(
				validateMigrationRegistry("users", 1, migrationsTo1).pipe(
					Effect.map(() => "success"),
					Effect.catchAll((e) => Effect.succeed(e)),
				),
			)
			expect(result).toBe("success")
		})

		it("accepts version 0 with no migrations", async () => {
			const result = await Effect.runPromise(
				validateMigrationRegistry("users", 0, []).pipe(
					Effect.map(() => "success"),
					Effect.catchAll((e) => Effect.succeed(e)),
				),
			)
			expect(result).toBe("success")
		})

		it("accepts unordered migrations that form valid chain", async () => {
			// Pass migrations out of order - validation should still work
			const unordered: ReadonlyArray<Migration> = [
				migration2to3,
				migration0to1,
				migration1to2,
			]
			const result = await Effect.runPromise(
				validateMigrationRegistry("users", 3, unordered).pipe(
					Effect.map(() => "success"),
					Effect.catchAll((e) => Effect.succeed(e)),
				),
			)
			expect(result).toBe("success")
		})
	})

	describe("gap in chain → error (task 10.2)", () => {
		it("rejects chain with gap (0→1, 2→3 missing 1→2)", async () => {
			// Gap: have 0→1 and 2→3, but missing 1→2
			const migrationsWithGap: ReadonlyArray<Migration> = [
				migration0to1,
				migration2to3,
			]

			const error = await Effect.runPromise(
				validateMigrationRegistry("users", 3, migrationsWithGap).pipe(
					Effect.flip,
				),
			)

			expect(error._tag).toBe("MigrationError")
			expect(error.reason).toBe("gap-in-chain")
			expect(error.message).toContain("Gap in migration chain")
			expect(error.message).toContain("1")
			expect(error.message).toContain("2")
		})

		it("rejects chain that doesn't start at 0", async () => {
			// Missing the start - have 1→2 and 2→3 but no 0→1
			const migrationsWithoutStart: ReadonlyArray<Migration> = [
				migration1to2,
				migration2to3,
			]

			const error = await Effect.runPromise(
				validateMigrationRegistry("users", 3, migrationsWithoutStart).pipe(
					Effect.flip,
				),
			)

			expect(error._tag).toBe("MigrationError")
			expect(error.reason).toBe("missing-start")
			expect(error.message).toContain("must start at version 0")
		})
	})
})

// ============================================================================
// Exported test helpers and schemas for use in other test files
// ============================================================================

export {
	makeTestEnv,
	makeYamlTestEnv,
	UserSchemaV0,
	UserSchemaV1,
	UserSchemaV2,
	UserSchemaV3,
	migration0to1,
	migration1to2,
	migration2to3,
	allMigrations,
	migrationsTo1,
	migrationsTo2,
}

export type { UserV0, UserV1, UserV2, UserV3 }
