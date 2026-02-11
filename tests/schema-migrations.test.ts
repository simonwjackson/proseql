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

	describe("last 'to' doesn't match version → error (task 10.3)", () => {
		it("rejects when last migration ends before target version", async () => {
			// Migrations go 0→1→2, but config version is 3
			const error = await Effect.runPromise(
				validateMigrationRegistry("users", 3, migrationsTo2).pipe(
					Effect.flip,
				),
			)

			expect(error._tag).toBe("MigrationError")
			expect(error.reason).toBe("version-mismatch")
			expect(error.message).toContain("Last migration goes to version 2")
			expect(error.message).toContain("collection version is 3")
		})

		it("rejects when last migration ends after target version", async () => {
			// Migrations go 0→1→2→3, but config version is 2
			const error = await Effect.runPromise(
				validateMigrationRegistry("users", 2, allMigrations).pipe(
					Effect.flip,
				),
			)

			expect(error._tag).toBe("MigrationError")
			expect(error.reason).toBe("version-mismatch")
			expect(error.message).toContain("Last migration goes to version 3")
			expect(error.message).toContain("collection version is 2")
		})

		it("rejects single migration with wrong target", async () => {
			// Migration 0→1, but config version is 2
			const error = await Effect.runPromise(
				validateMigrationRegistry("users", 2, migrationsTo1).pipe(
					Effect.flip,
				),
			)

			expect(error._tag).toBe("MigrationError")
			expect(error.reason).toBe("version-mismatch")
			expect(error.message).toContain("Last migration goes to version 1")
			expect(error.message).toContain("collection version is 2")
		})
	})

	describe("duplicate from → error (task 10.4)", () => {
		it("rejects migrations with duplicate from values", async () => {
			// Two migrations both starting from version 0
			const duplicateMigrations: ReadonlyArray<Migration> = [
				{
					from: 0,
					to: 1,
					description: "First migration 0→1",
					transform: (data) => data,
				},
				{
					from: 0,
					to: 1,
					description: "Duplicate migration 0→1",
					transform: (data) => data,
				},
			]

			const error = await Effect.runPromise(
				validateMigrationRegistry("users", 1, duplicateMigrations).pipe(
					Effect.flip,
				),
			)

			expect(error._tag).toBe("MigrationError")
			expect(error.reason).toBe("duplicate-from")
			expect(error.message).toContain("Duplicate migration from version 0")
		})

		it("rejects duplicates anywhere in the chain", async () => {
			// Chain 0→1, 1→2, 1→2 (duplicate at version 1)
			const migrationsWithDuplicate: ReadonlyArray<Migration> = [
				{
					from: 0,
					to: 1,
					transform: (data) => data,
				},
				{
					from: 1,
					to: 2,
					description: "First 1→2",
					transform: (data) => data,
				},
				{
					from: 1,
					to: 2,
					description: "Duplicate 1→2",
					transform: (data) => data,
				},
			]

			const error = await Effect.runPromise(
				validateMigrationRegistry("users", 2, migrationsWithDuplicate).pipe(
					Effect.flip,
				),
			)

			expect(error._tag).toBe("MigrationError")
			expect(error.reason).toBe("duplicate-from")
			expect(error.message).toContain("Duplicate migration from version 1")
		})
	})

	describe("to !== from + 1 → error (task 10.5)", () => {
		it("rejects migration where to > from + 1 (skips versions)", async () => {
			// Migration 0→3 is invalid - it skips versions 1 and 2
			const invalidMigration: ReadonlyArray<Migration> = [
				{
					from: 0,
					to: 3,
					description: "Skips versions 1 and 2",
					transform: (data) => data,
				},
			]

			const error = await Effect.runPromise(
				validateMigrationRegistry("users", 3, invalidMigration).pipe(
					Effect.flip,
				),
			)

			expect(error._tag).toBe("MigrationError")
			expect(error.reason).toBe("invalid-increment")
			expect(error.message).toContain("from=0")
			expect(error.message).toContain("to=3")
			expect(error.message).toContain("to must equal from + 1")
		})

		it("rejects migration where to < from + 1 (same or goes backward)", async () => {
			// Migration 2→2 is invalid - to equals from (no progression)
			const invalidMigration: ReadonlyArray<Migration> = [
				{
					from: 0,
					to: 1,
					transform: (data) => data,
				},
				{
					from: 1,
					to: 2,
					transform: (data) => data,
				},
				{
					from: 2,
					to: 2, // Invalid: stays at same version
					description: "Invalid same-version migration",
					transform: (data) => data,
				},
			]

			const error = await Effect.runPromise(
				validateMigrationRegistry("users", 3, invalidMigration).pipe(
					Effect.flip,
				),
			)

			expect(error._tag).toBe("MigrationError")
			expect(error.reason).toBe("invalid-increment")
			expect(error.message).toContain("from=2")
			expect(error.message).toContain("to=2")
		})

		it("rejects migration where to < from (goes backward)", async () => {
			// Migration 2→1 is invalid - goes backward
			const invalidMigration: ReadonlyArray<Migration> = [
				{
					from: 0,
					to: 1,
					transform: (data) => data,
				},
				{
					from: 1,
					to: 2,
					transform: (data) => data,
				},
				{
					from: 2,
					to: 1, // Invalid: goes backward
					description: "Invalid backward migration",
					transform: (data) => data,
				},
			]

			const error = await Effect.runPromise(
				validateMigrationRegistry("users", 3, invalidMigration).pipe(
					Effect.flip,
				),
			)

			expect(error._tag).toBe("MigrationError")
			expect(error.reason).toBe("invalid-increment")
			expect(error.message).toContain("from=2")
			expect(error.message).toContain("to=1")
		})

		it("rejects first migration in chain with invalid increment", async () => {
			// First migration 0→2 is invalid
			const invalidMigration: ReadonlyArray<Migration> = [
				{
					from: 0,
					to: 2, // Invalid: should be 0→1
					description: "Invalid first migration",
					transform: (data) => data,
				},
			]

			const error = await Effect.runPromise(
				validateMigrationRegistry("users", 2, invalidMigration).pipe(
					Effect.flip,
				),
			)

			expect(error._tag).toBe("MigrationError")
			expect(error.reason).toBe("invalid-increment")
			expect(error.message).toContain("from=0")
			expect(error.message).toContain("to=2")
		})
	})

	describe("empty migrations with version > 0 → error (task 10.6)", () => {
		it("rejects version 1 with empty migrations array", async () => {
			const error = await Effect.runPromise(
				validateMigrationRegistry("users", 1, []).pipe(
					Effect.flip,
				),
			)

			expect(error._tag).toBe("MigrationError")
			expect(error.reason).toBe("empty-registry")
			expect(error.message).toContain("version 1")
			expect(error.message).toContain("no migrations defined")
		})

		it("rejects version 5 with empty migrations array", async () => {
			const error = await Effect.runPromise(
				validateMigrationRegistry("products", 5, []).pipe(
					Effect.flip,
				),
			)

			expect(error._tag).toBe("MigrationError")
			expect(error.reason).toBe("empty-registry")
			expect(error.message).toContain("version 5")
			expect(error.message).toContain("Cannot migrate from version 0 to 5")
		})

		it("accepts version 0 with empty migrations (valid edge case)", async () => {
			// This is valid - version 0 means no migrations ever needed
			const result = await Effect.runPromise(
				validateMigrationRegistry("users", 0, []).pipe(
					Effect.map(() => "success"),
					Effect.catchAll((e) => Effect.succeed(e)),
				),
			)
			expect(result).toBe("success")
		})
	})
})

// ============================================================================
// Tests: Auto-Migrate on Load (Tasks 11.1-11.6)
// ============================================================================

describe("schema-migrations: auto-migrate on load", () => {
	describe("file at version 0, config at version 3 → all migrations run, data correct (task 11.1)", () => {
		it("loadData runs all three migrations (0→1→2→3) and produces correct V3 data", async () => {
			const { store, layer } = makeTestEnv()

			// File at version 0 (no _version field) with V0 data (id, name only)
			store.set(
				"/data/users.json",
				JSON.stringify({
					u1: { id: "u1", name: "Alice Smith" },
					u2: { id: "u2", name: "Bob Jones" },
				}),
			)

			// Load with version 3 config and full migration chain
			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV3, {
						version: 3,
						collectionName: "users",
						migrations: allMigrations,
					}),
					layer,
				),
			)

			// Verify all entities were migrated correctly
			expect(result.size).toBe(2)

			const alice = result.get("u1")!
			expect(alice.firstName).toBe("Alice")
			expect(alice.lastName).toBe("Smith")
			expect(alice.email).toBe("alice.smith@example.com")
			expect(alice.age).toBe(0)

			const bob = result.get("u2")!
			expect(bob.firstName).toBe("Bob")
			expect(bob.lastName).toBe("Jones")
			expect(bob.email).toBe("bob.jones@example.com")
			expect(bob.age).toBe(0)
		})

		it("loadCollectionsFromFile runs all three migrations and produces correct V3 data", async () => {
			const { store, layer } = makeTestEnv()

			// File with version 0 (no _version) in users collection
			store.set(
				"/data/db.json",
				JSON.stringify({
					users: {
						u1: { id: "u1", name: "Charlie Brown" },
					},
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/db.json", [
						{
							name: "users",
							schema: UserSchemaV3,
							version: 3,
							migrations: allMigrations,
						},
					]),
					layer,
				),
			)

			const charlie = result.users.get("u1") as UserV3
			expect(charlie.firstName).toBe("Charlie")
			expect(charlie.lastName).toBe("Brown")
			expect(charlie.email).toBe("charlie.brown@example.com")
			expect(charlie.age).toBe(0)
		})

		it("handles explicit _version: 0 in file same as missing _version", async () => {
			const { store, layer } = makeTestEnv()

			// File with explicit _version: 0
			store.set(
				"/data/users.json",
				JSON.stringify({
					_version: 0,
					u1: { id: "u1", name: "David Lee" },
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV3, {
						version: 3,
						collectionName: "users",
						migrations: allMigrations,
					}),
					layer,
				),
			)

			const david = result.get("u1")!
			expect(david.firstName).toBe("David")
			expect(david.lastName).toBe("Lee")
			expect(david.email).toBe("david.lee@example.com")
			expect(david.age).toBe(0)
		})

		it("transforms are applied in correct order (0→1 then 1→2 then 2→3)", async () => {
			const { store, layer } = makeTestEnv()

			// Use a name that would expose ordering issues
			// If 1→2 ran before 0→1, it would fail because 'name' field wouldn't exist
			// If 2→3 ran before 1→2, firstName/lastName wouldn't exist
			store.set(
				"/data/users.json",
				JSON.stringify({
					u1: { id: "u1", name: "Test User" },
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV3, {
						version: 3,
						collectionName: "users",
						migrations: allMigrations,
					}),
					layer,
				),
			)

			// This would only work if all migrations ran in correct order:
			// 0→1: adds email based on name
			// 1→2: splits name into firstName/lastName
			// 2→3: adds age
			const user = result.get("u1")!
			expect(user.email).toBe("test.user@example.com") // From 0→1 (based on original name)
			expect(user.firstName).toBe("Test") // From 1→2
			expect(user.lastName).toBe("User") // From 1→2
			expect(user.age).toBe(0) // From 2→3
		})
	})

	describe("file at version 2, config at version 3 → only migration 2→3 runs (task 11.2)", () => {
		it("loadData runs only migration 2→3 when file is at version 2", async () => {
			const { store, layer } = makeTestEnv()

			// File at version 2 with V2 data (has firstName, lastName, email but no age)
			// Uses custom email that wouldn't be generated by migration 0→1
			store.set(
				"/data/users.json",
				JSON.stringify({
					_version: 2,
					u1: {
						id: "u1",
						firstName: "Alice",
						lastName: "Smith",
						email: "custom.email@test.com", // Not the generated format
					},
					u2: {
						id: "u2",
						firstName: "Bob",
						lastName: "Jones",
						email: "bob.custom@other.org", // Different domain
					},
				}),
			)

			// Load with version 3 config and full migration chain
			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV3, {
						version: 3,
						collectionName: "users",
						migrations: allMigrations,
					}),
					layer,
				),
			)

			// Verify entities were migrated correctly
			expect(result.size).toBe(2)

			const alice = result.get("u1")!
			// These fields should be unchanged (0→1 and 1→2 didn't run)
			expect(alice.firstName).toBe("Alice")
			expect(alice.lastName).toBe("Smith")
			expect(alice.email).toBe("custom.email@test.com") // Preserved, not regenerated
			// Only 2→3 ran, adding age
			expect(alice.age).toBe(0)

			const bob = result.get("u2")!
			expect(bob.firstName).toBe("Bob")
			expect(bob.lastName).toBe("Jones")
			expect(bob.email).toBe("bob.custom@other.org") // Preserved, not regenerated
			expect(bob.age).toBe(0)
		})

		it("loadCollectionsFromFile runs only migration 2→3 when collection is at version 2", async () => {
			const { store, layer } = makeTestEnv()

			// File with version 2 in users collection
			store.set(
				"/data/db.json",
				JSON.stringify({
					users: {
						_version: 2,
						u1: {
							id: "u1",
							firstName: "Charlie",
							lastName: "Brown",
							email: "charlie@peanuts.com",
						},
					},
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/db.json", [
						{
							name: "users",
							schema: UserSchemaV3,
							version: 3,
							migrations: allMigrations,
						},
					]),
					layer,
				),
			)

			const charlie = result.users.get("u1") as UserV3
			// Preserved from V2
			expect(charlie.firstName).toBe("Charlie")
			expect(charlie.lastName).toBe("Brown")
			expect(charlie.email).toBe("charlie@peanuts.com") // Not regenerated
			// Added by 2→3
			expect(charlie.age).toBe(0)
		})

		it("only applicable migration runs - file at version 1 runs 1→2 and 2→3", async () => {
			const { store, layer } = makeTestEnv()

			// File at version 1 with V1 data (has id, name, email)
			// Uses custom email that would be different from 0→1 generation
			store.set(
				"/data/users.json",
				JSON.stringify({
					_version: 1,
					u1: {
						id: "u1",
						name: "David Lee",
						email: "david.original@preserved.com", // Custom email
					},
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV3, {
						version: 3,
						collectionName: "users",
						migrations: allMigrations,
					}),
					layer,
				),
			)

			const david = result.get("u1")!
			// 0→1 didn't run (email preserved, not regenerated)
			expect(david.email).toBe("david.original@preserved.com")
			// 1→2 ran (name split)
			expect(david.firstName).toBe("David")
			expect(david.lastName).toBe("Lee")
			// 2→3 ran (age added)
			expect(david.age).toBe(0)
		})
	})

	describe("migrated data written back to file with new _version (task 11.3)", () => {
		it("loadData writes migrated data back to file after successful migration", async () => {
			const { store, layer } = makeTestEnv()

			// File at version 0 (no _version field) with V0 data
			store.set(
				"/data/users.json",
				JSON.stringify({
					u1: { id: "u1", name: "Alice Smith" },
				}),
			)

			// Load with version 3 config - triggers migration 0→1→2→3
			await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV3, {
						version: 3,
						collectionName: "users",
						migrations: allMigrations,
					}),
					layer,
				),
			)

			// Verify file was rewritten with migrated data
			const stored = store.get("/data/users.json")
			expect(stored).toBeDefined()
			const parsed = JSON.parse(stored!)

			// Should have new _version stamped
			expect(parsed._version).toBe(3)

			// Should contain migrated entity data (V3 format)
			const alice = parsed.u1
			expect(alice.firstName).toBe("Alice")
			expect(alice.lastName).toBe("Smith")
			expect(alice.email).toBe("alice.smith@example.com")
			expect(alice.age).toBe(0)

			// Should not have 'name' field (was split into firstName/lastName)
			expect(alice.name).toBeUndefined()
		})

		it("loadData writes correct version after partial migration (2→3)", async () => {
			const { store, layer } = makeTestEnv()

			// File at version 2 with V2 data
			store.set(
				"/data/users.json",
				JSON.stringify({
					_version: 2,
					u1: {
						id: "u1",
						firstName: "Bob",
						lastName: "Jones",
						email: "bob@custom.org",
					},
				}),
			)

			// Load with version 3 config - triggers migration 2→3 only
			await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV3, {
						version: 3,
						collectionName: "users",
						migrations: allMigrations,
					}),
					layer,
				),
			)

			// Verify file was rewritten
			const stored = store.get("/data/users.json")
			const parsed = JSON.parse(stored!)

			// Should have new _version 3
			expect(parsed._version).toBe(3)

			// Entity should have age added (from 2→3 migration)
			expect(parsed.u1.age).toBe(0)

			// Original fields preserved
			expect(parsed.u1.firstName).toBe("Bob")
			expect(parsed.u1.lastName).toBe("Jones")
			expect(parsed.u1.email).toBe("bob@custom.org")
		})

		it("loadCollectionsFromFile writes migrated collection back to file", async () => {
			const { store, layer } = makeTestEnv()

			// File with version 0 (no _version) in users collection
			store.set(
				"/data/db.json",
				JSON.stringify({
					users: {
						u1: { id: "u1", name: "Charlie Brown" },
					},
				}),
			)

			// Load with version 3 config
			await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/db.json", [
						{
							name: "users",
							schema: UserSchemaV3,
							version: 3,
							migrations: allMigrations,
						},
					]),
					layer,
				),
			)

			// Verify file was rewritten
			const stored = store.get("/data/db.json")
			expect(stored).toBeDefined()
			const parsed = JSON.parse(stored!)

			// Collection should have new _version
			expect(parsed.users._version).toBe(3)

			// Entity should be migrated
			const charlie = parsed.users.u1
			expect(charlie.firstName).toBe("Charlie")
			expect(charlie.lastName).toBe("Brown")
			expect(charlie.email).toBe("charlie.brown@example.com")
			expect(charlie.age).toBe(0)
		})

		it("file unchanged when already at target version (no migration needed)", async () => {
			const { store, layer } = makeTestEnv()

			// File already at version 3 with valid V3 data
			const originalContent = JSON.stringify({
				_version: 3,
				u1: {
					id: "u1",
					firstName: "David",
					lastName: "Lee",
					email: "david@example.com",
					age: 25,
				},
			})
			store.set("/data/users.json", originalContent)

			// Load with version 3 config - no migration should run
			await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV3, {
						version: 3,
						collectionName: "users",
						migrations: allMigrations,
					}),
					layer,
				),
			)

			// File content should be unchanged (no write-back when no migration)
			const stored = store.get("/data/users.json")
			expect(stored).toBe(originalContent)
		})

		it("multiple entities all migrated and written back", async () => {
			const { store, layer } = makeTestEnv()

			// File at version 0 with multiple entities
			store.set(
				"/data/users.json",
				JSON.stringify({
					u1: { id: "u1", name: "Alice Smith" },
					u2: { id: "u2", name: "Bob Jones" },
					u3: { id: "u3", name: "Charlie Brown" },
				}),
			)

			await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV3, {
						version: 3,
						collectionName: "users",
						migrations: allMigrations,
					}),
					layer,
				),
			)

			const stored = store.get("/data/users.json")
			const parsed = JSON.parse(stored!)

			// All entities should be migrated
			expect(parsed._version).toBe(3)
			expect(Object.keys(parsed).filter((k) => k !== "_version")).toHaveLength(3)

			// Verify each entity
			expect(parsed.u1.firstName).toBe("Alice")
			expect(parsed.u1.age).toBe(0)

			expect(parsed.u2.firstName).toBe("Bob")
			expect(parsed.u2.age).toBe(0)

			expect(parsed.u3.firstName).toBe("Charlie")
			expect(parsed.u3.age).toBe(0)
		})
	})

	describe("file at current version → no migrations, normal load (task 11.4)", () => {
		it("loadData loads data normally when file version matches config version", async () => {
			const { store, layer } = makeTestEnv()

			// File already at version 3 with valid V3 data
			store.set(
				"/data/users.json",
				JSON.stringify({
					_version: 3,
					u1: {
						id: "u1",
						firstName: "Alice",
						lastName: "Smith",
						email: "alice@example.com",
						age: 25,
					},
					u2: {
						id: "u2",
						firstName: "Bob",
						lastName: "Jones",
						email: "bob@example.com",
						age: 30,
					},
				}),
			)

			// Load with version 3 config - no migration should run
			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV3, {
						version: 3,
						collectionName: "users",
						migrations: allMigrations,
					}),
					layer,
				),
			)

			// Data should be loaded normally
			expect(result.size).toBe(2)

			const alice = result.get("u1")!
			expect(alice.firstName).toBe("Alice")
			expect(alice.lastName).toBe("Smith")
			expect(alice.email).toBe("alice@example.com")
			expect(alice.age).toBe(25) // Original value preserved (not reset to 0 by migration)

			const bob = result.get("u2")!
			expect(bob.firstName).toBe("Bob")
			expect(bob.lastName).toBe("Jones")
			expect(bob.email).toBe("bob@example.com")
			expect(bob.age).toBe(30) // Original value preserved
		})

		it("loadData does not write back to file when no migration needed", async () => {
			const { store, layer } = makeTestEnv()

			// File already at version 3
			const originalContent = JSON.stringify({
				_version: 3,
				u1: {
					id: "u1",
					firstName: "David",
					lastName: "Lee",
					email: "david@example.com",
					age: 42,
				},
			})
			store.set("/data/users.json", originalContent)

			// Load with version 3 config
			await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV3, {
						version: 3,
						collectionName: "users",
						migrations: allMigrations,
					}),
					layer,
				),
			)

			// File content should be exactly unchanged
			const stored = store.get("/data/users.json")
			expect(stored).toBe(originalContent)
		})

		it("loadCollectionsFromFile loads normally when collection at current version", async () => {
			const { store, layer } = makeTestEnv()

			// File with collection already at version 3
			store.set(
				"/data/db.json",
				JSON.stringify({
					users: {
						_version: 3,
						u1: {
							id: "u1",
							firstName: "Charlie",
							lastName: "Brown",
							email: "charlie@peanuts.com",
							age: 8,
						},
					},
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/db.json", [
						{
							name: "users",
							schema: UserSchemaV3,
							version: 3,
							migrations: allMigrations,
						},
					]),
					layer,
				),
			)

			// Data should be loaded normally
			const charlie = result.users.get("u1") as UserV3
			expect(charlie.firstName).toBe("Charlie")
			expect(charlie.lastName).toBe("Brown")
			expect(charlie.email).toBe("charlie@peanuts.com")
			expect(charlie.age).toBe(8) // Original value preserved
		})

		it("loadCollectionsFromFile does not write back when no migration needed", async () => {
			const { store, layer } = makeTestEnv()

			// File with collection already at version 3
			const originalContent = JSON.stringify({
				users: {
					_version: 3,
					u1: {
						id: "u1",
						firstName: "Eve",
						lastName: "Wilson",
						email: "eve@example.com",
						age: 35,
					},
				},
			})
			store.set("/data/db.json", originalContent)

			await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/db.json", [
						{
							name: "users",
							schema: UserSchemaV3,
							version: 3,
							migrations: allMigrations,
						},
					]),
					layer,
				),
			)

			// File content should be exactly unchanged
			const stored = store.get("/data/db.json")
			expect(stored).toBe(originalContent)
		})

		it("_version stripped from loaded data even when no migration runs", async () => {
			const { store, layer } = makeTestEnv()

			// File at version 3
			store.set(
				"/data/users.json",
				JSON.stringify({
					_version: 3,
					u1: {
						id: "u1",
						firstName: "Frank",
						lastName: "Miller",
						email: "frank@example.com",
						age: 50,
					},
				}),
			)

			const result = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV3, {
						version: 3,
						collectionName: "users",
						migrations: allMigrations,
					}),
					layer,
				),
			)

			// _version should not appear as an entity key
			expect(result.has("_version")).toBe(false)
			expect(result.size).toBe(1)
		})

		it("works with single migration chain at version 1", async () => {
			const { store, layer } = makeTestEnv()

			// File already at version 1
			store.set(
				"/data/users.json",
				JSON.stringify({
					_version: 1,
					u1: { id: "u1", name: "Grace", email: "grace@example.com" },
				}),
			)

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

			expect(result.size).toBe(1)
			const grace = result.get("u1")!
			expect(grace.name).toBe("Grace")
			expect(grace.email).toBe("grace@example.com")
		})
	})

	describe("failed transform → original file untouched, MigrationError (task 11.5)", () => {
		it("loadData fails with MigrationError when transform throws", async () => {
			const { store, layer } = makeTestEnv()

			// Original file content at version 0
			const originalContent = JSON.stringify({
				u1: { id: "u1", name: "Alice Smith" },
			})
			store.set("/data/users.json", originalContent)

			// Migration that throws an error during transform
			const failingMigration: Migration = {
				from: 0,
				to: 1,
				description: "Failing migration",
				transform: () => {
					throw new Error("Simulated transform failure")
				},
			}

			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV1, {
						version: 1,
						collectionName: "users",
						migrations: [failingMigration],
					}).pipe(Effect.flip),
					layer,
				),
			)

			// Verify MigrationError is returned
			expect(error._tag).toBe("MigrationError")
			const migrationError = error as MigrationError
			expect(migrationError.reason).toBe("transform-failed")
			expect(migrationError.collection).toBe("users")
			expect(migrationError.fromVersion).toBe(0)
			expect(migrationError.toVersion).toBe(1)
			expect(migrationError.step).toBe(0) // First (and only) migration step
			expect(migrationError.message).toContain("Simulated transform failure")

			// Verify original file is untouched
			const storedContent = store.get("/data/users.json")
			expect(storedContent).toBe(originalContent)
		})

		it("loadData fails when transform throws non-Error object", async () => {
			const { store, layer } = makeTestEnv()

			const originalContent = JSON.stringify({
				u1: { id: "u1", name: "Bob Jones" },
			})
			store.set("/data/users.json", originalContent)

			// Migration that throws a string (not an Error object)
			const failingMigration: Migration = {
				from: 0,
				to: 1,
				description: "Throws string",
				transform: () => {
					throw "string error message"
				},
			}

			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV1, {
						version: 1,
						collectionName: "users",
						migrations: [failingMigration],
					}).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("MigrationError")
			const migrationError = error as MigrationError
			expect(migrationError.reason).toBe("transform-failed")
			expect(migrationError.message).toContain("string error message")

			// Original file untouched
			expect(store.get("/data/users.json")).toBe(originalContent)
		})

		it("original file untouched when second migration in chain fails", async () => {
			const { store, layer } = makeTestEnv()

			// File at version 0
			const originalContent = JSON.stringify({
				u1: { id: "u1", name: "Charlie Brown" },
			})
			store.set("/data/users.json", originalContent)

			// First migration succeeds, second fails
			const successMigration: Migration = {
				from: 0,
				to: 1,
				transform: (data) => {
					const result: Record<string, unknown> = {}
					for (const [id, entity] of Object.entries(data)) {
						result[id] = { ...(entity as object), email: "added@example.com" }
					}
					return result
				},
			}

			const failingMigration: Migration = {
				from: 1,
				to: 2,
				description: "Second migration fails",
				transform: () => {
					throw new Error("Second step failure")
				},
			}

			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV2, {
						version: 2,
						collectionName: "users",
						migrations: [successMigration, failingMigration],
					}).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("MigrationError")
			const migrationError = error as MigrationError
			expect(migrationError.reason).toBe("transform-failed")
			expect(migrationError.fromVersion).toBe(1)
			expect(migrationError.toVersion).toBe(2)
			expect(migrationError.step).toBe(1) // Second migration (index 1)
			expect(migrationError.message).toContain("Second step failure")

			// Original file untouched - no partial migration written
			expect(store.get("/data/users.json")).toBe(originalContent)
		})

		it("loadCollectionsFromFile fails with MigrationError when transform throws", async () => {
			const { store, layer } = makeTestEnv()

			const originalContent = JSON.stringify({
				users: {
					u1: { id: "u1", name: "David Lee" },
				},
			})
			store.set("/data/db.json", originalContent)

			const failingMigration: Migration = {
				from: 0,
				to: 1,
				transform: () => {
					throw new Error("Collection migration failed")
				},
			}

			const error = await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/db.json", [
						{
							name: "users",
							schema: UserSchemaV1,
							version: 1,
							migrations: [failingMigration],
						},
					]).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("MigrationError")
			const migrationError = error as MigrationError
			expect(migrationError.reason).toBe("transform-failed")
			expect(migrationError.collection).toBe("users")
			expect(migrationError.message).toContain("Collection migration failed")

			// Original file untouched
			expect(store.get("/data/db.json")).toBe(originalContent)
		})

		it("file unchanged when migration fails partway through multi-collection file", async () => {
			const { store, layer } = makeTestEnv()

			// Two collections in file, second one's migration fails
			const originalContent = JSON.stringify({
				users: {
					u1: { id: "u1", name: "Eve" },
				},
				products: {
					p1: { id: "p1", title: "Widget" },
				},
			})
			store.set("/data/db.json", originalContent)

			// Product schema for v1 (adds price field)
			const ProductSchemaV1 = Schema.Struct({
				id: Schema.String,
				title: Schema.String,
				price: Schema.Number,
			})

			// Users migration succeeds
			const userMigration: Migration = {
				from: 0,
				to: 1,
				transform: (data) => {
					const result: Record<string, unknown> = {}
					for (const [id, entity] of Object.entries(data)) {
						result[id] = { ...(entity as object), email: "user@example.com" }
					}
					return result
				},
			}

			// Products migration fails
			const productMigration: Migration = {
				from: 0,
				to: 1,
				transform: () => {
					throw new Error("Product migration exploded")
				},
			}

			const error = await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/db.json", [
						{
							name: "users",
							schema: UserSchemaV1,
							version: 1,
							migrations: [userMigration],
						},
						{
							name: "products",
							schema: ProductSchemaV1,
							version: 1,
							migrations: [productMigration],
						},
					]).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("MigrationError")
			const migrationError = error as MigrationError
			expect(migrationError.collection).toBe("products")
			expect(migrationError.message).toContain("Product migration exploded")

			// Original file untouched - even though users migration succeeded,
			// we fail atomically and don't write back partial results
			expect(store.get("/data/db.json")).toBe(originalContent)
		})
	})

	describe("post-migration validation failure → original file untouched, MigrationError with step: -1 (task 11.6)", () => {
		it("loadData fails with MigrationError (step: -1) when migrated data fails schema validation", async () => {
			const { store, layer } = makeTestEnv()

			// Original file content at version 0
			const originalContent = JSON.stringify({
				u1: { id: "u1", name: "Alice Smith" },
			})
			store.set("/data/users.json", originalContent)

			// Migration that runs successfully but produces data that doesn't match V3 schema.
			// It adds email but NOT firstName, lastName, or age - which V3 requires.
			const brokenMigration: Migration = {
				from: 0,
				to: 1,
				description: "Migration produces invalid V1 data (missing email)",
				transform: (data) => {
					// Intentionally produce data that doesn't match UserSchemaV1
					// UserSchemaV1 requires email, but we don't add it
					const result: Record<string, unknown> = {}
					for (const [id, entity] of Object.entries(data)) {
						// Just copy data without adding required 'email' field
						result[id] = { ...(entity as object) }
					}
					return result
				},
			}

			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV1, {
						version: 1,
						collectionName: "users",
						migrations: [brokenMigration],
					}).pipe(Effect.flip),
					layer,
				),
			)

			// Verify MigrationError is returned with step: -1 (post-migration validation)
			expect(error._tag).toBe("MigrationError")
			const migrationError = error as MigrationError
			expect(migrationError.step).toBe(-1)
			expect(migrationError.reason).toBe("post-migration-validation-failed")
			expect(migrationError.collection).toBe("users")
			expect(migrationError.fromVersion).toBe(0)
			expect(migrationError.toVersion).toBe(1)
			expect(migrationError.message).toContain("Post-migration validation failed")
			expect(migrationError.message).toContain("u1") // Entity ID in error

			// Verify original file is untouched
			const storedContent = store.get("/data/users.json")
			expect(storedContent).toBe(originalContent)
		})

		it("loadData fails when migration produces wrong type for required field", async () => {
			const { store, layer } = makeTestEnv()

			// Original file at version 0
			const originalContent = JSON.stringify({
				u1: { id: "u1", name: "Bob Jones" },
			})
			store.set("/data/users.json", originalContent)

			// Migration that produces data with wrong type for email (number instead of string)
			const wrongTypeMigration: Migration = {
				from: 0,
				to: 1,
				description: "Migration produces wrong type for email",
				transform: (data) => {
					const result: Record<string, unknown> = {}
					for (const [id, entity] of Object.entries(data)) {
						result[id] = {
							...(entity as object),
							email: 12345, // Wrong type: number instead of string
						}
					}
					return result
				},
			}

			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV1, {
						version: 1,
						collectionName: "users",
						migrations: [wrongTypeMigration],
					}).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("MigrationError")
			const migrationError = error as MigrationError
			expect(migrationError.step).toBe(-1)
			expect(migrationError.reason).toBe("post-migration-validation-failed")
			expect(migrationError.message).toContain("Post-migration validation failed")

			// Original file untouched
			expect(store.get("/data/users.json")).toBe(originalContent)
		})

		it("loadData fails when last migration in chain produces invalid data", async () => {
			const { store, layer } = makeTestEnv()

			// Original file at version 1 (needs 1→2 and 2→3 migrations)
			const originalContent = JSON.stringify({
				_version: 1,
				u1: { id: "u1", name: "Charlie Brown", email: "charlie@example.com" },
			})
			store.set("/data/users.json", originalContent)

			// Migration 1→2: splits name correctly
			const migration1to2Valid: Migration = {
				from: 1,
				to: 2,
				transform: (data) => {
					const result: Record<string, unknown> = {}
					for (const [id, entity] of Object.entries(data)) {
						const e = entity as { id: string; name: string; email: string }
						const parts = e.name.split(" ")
						result[id] = {
							id: e.id,
							firstName: parts[0] || "",
							lastName: parts.slice(1).join(" ") || "",
							email: e.email,
						}
					}
					return result
				},
			}

			// Migration 2→3: intentionally produces invalid data (age as string instead of number)
			const migration2to3Invalid: Migration = {
				from: 2,
				to: 3,
				description: "Produces invalid age type",
				transform: (data) => {
					const result: Record<string, unknown> = {}
					for (const [id, entity] of Object.entries(data)) {
						result[id] = {
							...(entity as object),
							age: "not a number", // Wrong type - should be number
						}
					}
					return result
				},
			}

			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV3, {
						version: 3,
						collectionName: "users",
						migrations: [migration1to2Valid, migration2to3Invalid],
					}).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("MigrationError")
			const migrationError = error as MigrationError
			expect(migrationError.step).toBe(-1)
			expect(migrationError.reason).toBe("post-migration-validation-failed")
			expect(migrationError.fromVersion).toBe(1) // Started from version 1
			expect(migrationError.toVersion).toBe(3) // Target version

			// Original file untouched - even though 1→2 ran successfully
			expect(store.get("/data/users.json")).toBe(originalContent)
		})

		it("loadCollectionsFromFile fails with MigrationError (step: -1) when migrated data fails validation", async () => {
			const { store, layer } = makeTestEnv()

			const originalContent = JSON.stringify({
				users: {
					u1: { id: "u1", name: "David Lee" },
				},
			})
			store.set("/data/db.json", originalContent)

			// Migration that produces invalid data (missing required email field)
			const brokenMigration: Migration = {
				from: 0,
				to: 1,
				transform: (data) => {
					// Just pass through without adding email
					return data
				},
			}

			const error = await Effect.runPromise(
				Effect.provide(
					loadCollectionsFromFile("/data/db.json", [
						{
							name: "users",
							schema: UserSchemaV1,
							version: 1,
							migrations: [brokenMigration],
						},
					]).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("MigrationError")
			const migrationError = error as MigrationError
			expect(migrationError.step).toBe(-1)
			expect(migrationError.reason).toBe("post-migration-validation-failed")
			expect(migrationError.collection).toBe("users")
			expect(migrationError.message).toContain("Post-migration validation failed")

			// Original file untouched
			expect(store.get("/data/db.json")).toBe(originalContent)
		})

		it("all transforms succeed but one entity fails validation → original file untouched", async () => {
			const { store, layer } = makeTestEnv()

			// File with multiple entities, one will fail validation
			const originalContent = JSON.stringify({
				u1: { id: "u1", name: "Eve Wilson" },
				u2: { id: "u2", name: "Frank Miller" },
				u3: { id: "u3", name: "Grace Lee" },
			})
			store.set("/data/users.json", originalContent)

			// Migration that produces valid data for some entities but invalid for one
			const partiallyBrokenMigration: Migration = {
				from: 0,
				to: 1,
				transform: (data) => {
					const result: Record<string, unknown> = {}
					for (const [id, entity] of Object.entries(data)) {
						if (id === "u2") {
							// u2 gets invalid email (number instead of string)
							result[id] = { ...(entity as object), email: 999 }
						} else {
							// Other entities get valid email
							result[id] = { ...(entity as object), email: "valid@example.com" }
						}
					}
					return result
				},
			}

			const error = await Effect.runPromise(
				Effect.provide(
					loadData("/data/users.json", UserSchemaV1, {
						version: 1,
						collectionName: "users",
						migrations: [partiallyBrokenMigration],
					}).pipe(Effect.flip),
					layer,
				),
			)

			expect(error._tag).toBe("MigrationError")
			const migrationError = error as MigrationError
			expect(migrationError.step).toBe(-1)
			expect(migrationError.reason).toBe("post-migration-validation-failed")
			// The error message should reference the failing entity
			expect(migrationError.message).toContain("u2")

			// Original file untouched - none of the entities should be written
			expect(store.get("/data/users.json")).toBe(originalContent)
		})
	})
})

// ============================================================================
// Tests: Dry Run (Tasks 12.1-12.4)
// ============================================================================

import { dryRunMigrations } from "../core/migrations/migration-runner.js"
import { Ref } from "effect"

describe("schema-migrations: dry run", () => {
	describe("collection needing migration → listed with correct chain (task 12.1)", () => {
		it("dryRunMigrations reports collection at version 0 needing full migration chain", async () => {
			const { store, layer } = makeTestEnv()

			// File at version 0 (no _version) with V0 data
			store.set(
				"/data/users.json",
				JSON.stringify({
					u1: { id: "u1", name: "Alice Smith" },
				}),
			)

			// Database config: users collection at version 3 with full migration chain
			const config = {
				users: {
					schema: UserSchemaV3,
					file: "/data/users.json",
					version: 3,
					migrations: allMigrations,
					relationships: {},
				},
			}

			// Create empty state refs (not needed for dry-run file inspection)
			const stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, { readonly id: string }>>> = {}

			const result = await Effect.runPromise(
				Effect.provide(dryRunMigrations(config, stateRefs), layer),
			)

			// Should report one collection
			expect(result.collections).toHaveLength(1)

			const usersResult = result.collections[0]
			expect(usersResult.name).toBe("users")
			expect(usersResult.filePath).toBe("/data/users.json")
			expect(usersResult.currentVersion).toBe(0)
			expect(usersResult.targetVersion).toBe(3)
			expect(usersResult.status).toBe("needs-migration")

			// Should list all three migrations in correct order
			expect(usersResult.migrationsToApply).toHaveLength(3)
			expect(usersResult.migrationsToApply[0]).toEqual({
				from: 0,
				to: 1,
				description: "Add email field",
			})
			expect(usersResult.migrationsToApply[1]).toEqual({
				from: 1,
				to: 2,
				description: "Split name into firstName and lastName",
			})
			expect(usersResult.migrationsToApply[2]).toEqual({
				from: 2,
				to: 3,
				description: "Add age field",
			})
		})

		it("dryRunMigrations reports collection at version 2 needing only 2→3 migration", async () => {
			const { store, layer } = makeTestEnv()

			// File at version 2 with V2 data
			store.set(
				"/data/users.json",
				JSON.stringify({
					_version: 2,
					u1: {
						id: "u1",
						firstName: "Alice",
						lastName: "Smith",
						email: "alice@example.com",
					},
				}),
			)

			const config = {
				users: {
					schema: UserSchemaV3,
					file: "/data/users.json",
					version: 3,
					migrations: allMigrations,
					relationships: {},
				},
			}

			const stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, { readonly id: string }>>> = {}

			const result = await Effect.runPromise(
				Effect.provide(dryRunMigrations(config, stateRefs), layer),
			)

			expect(result.collections).toHaveLength(1)

			const usersResult = result.collections[0]
			expect(usersResult.name).toBe("users")
			expect(usersResult.currentVersion).toBe(2)
			expect(usersResult.targetVersion).toBe(3)
			expect(usersResult.status).toBe("needs-migration")

			// Should only list the 2→3 migration
			expect(usersResult.migrationsToApply).toHaveLength(1)
			expect(usersResult.migrationsToApply[0]).toEqual({
				from: 2,
				to: 3,
				description: "Add age field",
			})
		})

		it("dryRunMigrations reports multiple collections needing migration", async () => {
			const { store, layer } = makeTestEnv()

			// Two collections at different versions
			store.set(
				"/data/users.json",
				JSON.stringify({
					u1: { id: "u1", name: "Alice" },
				}),
			)
			store.set(
				"/data/profiles.json",
				JSON.stringify({
					_version: 1,
					p1: { id: "p1", name: "Alice", email: "a@b.c" },
				}),
			)

			const config = {
				users: {
					schema: UserSchemaV3,
					file: "/data/users.json",
					version: 3,
					migrations: allMigrations,
					relationships: {},
				},
				profiles: {
					schema: UserSchemaV3,
					file: "/data/profiles.json",
					version: 3,
					migrations: allMigrations,
					relationships: {},
				},
			}

			const stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, { readonly id: string }>>> = {}

			const result = await Effect.runPromise(
				Effect.provide(dryRunMigrations(config, stateRefs), layer),
			)

			expect(result.collections).toHaveLength(2)

			// Find results by name (order may vary)
			const usersResult = result.collections.find((c) => c.name === "users")!
			const profilesResult = result.collections.find((c) => c.name === "profiles")!

			// Users at version 0 → needs all 3 migrations
			expect(usersResult.currentVersion).toBe(0)
			expect(usersResult.status).toBe("needs-migration")
			expect(usersResult.migrationsToApply).toHaveLength(3)

			// Profiles at version 1 → needs migrations 1→2 and 2→3
			expect(profilesResult.currentVersion).toBe(1)
			expect(profilesResult.status).toBe("needs-migration")
			expect(profilesResult.migrationsToApply).toHaveLength(2)
			expect(profilesResult.migrationsToApply[0].from).toBe(1)
			expect(profilesResult.migrationsToApply[1].from).toBe(2)
		})

		it("dryRunMigrations handles migration without description", async () => {
			const { store, layer } = makeTestEnv()

			store.set(
				"/data/users.json",
				JSON.stringify({
					u1: { id: "u1", name: "Alice", email: "a@b.c" },
				}),
			)

			// Migration without description field
			const migrationNoDesc: Migration = {
				from: 0,
				to: 1,
				transform: (data) => data,
			}

			const config = {
				users: {
					schema: UserSchemaV1,
					file: "/data/users.json",
					version: 1,
					migrations: [migrationNoDesc],
					relationships: {},
				},
			}

			const stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, { readonly id: string }>>> = {}

			const result = await Effect.runPromise(
				Effect.provide(dryRunMigrations(config, stateRefs), layer),
			)

			expect(result.collections).toHaveLength(1)
			expect(result.collections[0].migrationsToApply).toHaveLength(1)
			// Migration without description should not have description field
			expect(result.collections[0].migrationsToApply[0]).toEqual({
				from: 0,
				to: 1,
			})
			expect(result.collections[0].migrationsToApply[0].description).toBeUndefined()
		})
	})

	describe("collection at current version → up-to-date (task 12.2)", () => {
		it("dryRunMigrations reports 'up-to-date' when file version matches config version", async () => {
			const { store, layer } = makeTestEnv()

			// File at version 3 (matches config version)
			store.set(
				"/data/users.json",
				JSON.stringify({
					_version: 3,
					u1: {
						id: "u1",
						firstName: "Alice",
						lastName: "Smith",
						email: "alice@example.com",
						age: 25,
					},
				}),
			)

			const config = {
				users: {
					schema: UserSchemaV3,
					file: "/data/users.json",
					version: 3,
					migrations: allMigrations,
					relationships: {},
				},
			}

			const stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, { readonly id: string }>>> = {}

			const result = await Effect.runPromise(
				Effect.provide(dryRunMigrations(config, stateRefs), layer),
			)

			expect(result.collections).toHaveLength(1)

			const usersResult = result.collections[0]
			expect(usersResult.name).toBe("users")
			expect(usersResult.filePath).toBe("/data/users.json")
			expect(usersResult.currentVersion).toBe(3)
			expect(usersResult.targetVersion).toBe(3)
			expect(usersResult.status).toBe("up-to-date")

			// No migrations should be applied
			expect(usersResult.migrationsToApply).toHaveLength(0)
		})

		it("dryRunMigrations reports 'up-to-date' for single-version collection at version 1", async () => {
			const { store, layer } = makeTestEnv()

			// File at version 1
			store.set(
				"/data/users.json",
				JSON.stringify({
					_version: 1,
					u1: { id: "u1", name: "Alice", email: "alice@example.com" },
				}),
			)

			const config = {
				users: {
					schema: UserSchemaV1,
					file: "/data/users.json",
					version: 1,
					migrations: migrationsTo1,
					relationships: {},
				},
			}

			const stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, { readonly id: string }>>> = {}

			const result = await Effect.runPromise(
				Effect.provide(dryRunMigrations(config, stateRefs), layer),
			)

			expect(result.collections).toHaveLength(1)

			const usersResult = result.collections[0]
			expect(usersResult.status).toBe("up-to-date")
			expect(usersResult.currentVersion).toBe(1)
			expect(usersResult.targetVersion).toBe(1)
			expect(usersResult.migrationsToApply).toHaveLength(0)
		})

		it("dryRunMigrations reports 'up-to-date' for version 0 collection (no migrations needed)", async () => {
			const { store, layer } = makeTestEnv()

			// File without _version (implicitly version 0)
			store.set(
				"/data/users.json",
				JSON.stringify({
					u1: { id: "u1", name: "Alice" },
				}),
			)

			// Config at version 0 with no migrations
			const config = {
				users: {
					schema: UserSchemaV0,
					file: "/data/users.json",
					version: 0,
					migrations: [],
					relationships: {},
				},
			}

			const stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, { readonly id: string }>>> = {}

			const result = await Effect.runPromise(
				Effect.provide(dryRunMigrations(config, stateRefs), layer),
			)

			expect(result.collections).toHaveLength(1)

			const usersResult = result.collections[0]
			expect(usersResult.status).toBe("up-to-date")
			expect(usersResult.currentVersion).toBe(0)
			expect(usersResult.targetVersion).toBe(0)
			expect(usersResult.migrationsToApply).toHaveLength(0)
		})

		it("dryRunMigrations reports mixed statuses when some collections up-to-date and others need migration", async () => {
			const { store, layer } = makeTestEnv()

			// Users already at version 3
			store.set(
				"/data/users.json",
				JSON.stringify({
					_version: 3,
					u1: {
						id: "u1",
						firstName: "Alice",
						lastName: "Smith",
						email: "alice@example.com",
						age: 25,
					},
				}),
			)

			// Products at version 1 needing migration to version 3
			store.set(
				"/data/products.json",
				JSON.stringify({
					_version: 1,
					p1: { id: "p1", name: "Widget", email: "widget@example.com" },
				}),
			)

			const config = {
				users: {
					schema: UserSchemaV3,
					file: "/data/users.json",
					version: 3,
					migrations: allMigrations,
					relationships: {},
				},
				products: {
					schema: UserSchemaV3,
					file: "/data/products.json",
					version: 3,
					migrations: allMigrations,
					relationships: {},
				},
			}

			const stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, { readonly id: string }>>> = {}

			const result = await Effect.runPromise(
				Effect.provide(dryRunMigrations(config, stateRefs), layer),
			)

			expect(result.collections).toHaveLength(2)

			// Find results by name
			const usersResult = result.collections.find((c) => c.name === "users")!
			const productsResult = result.collections.find((c) => c.name === "products")!

			// Users should be up-to-date
			expect(usersResult.status).toBe("up-to-date")
			expect(usersResult.migrationsToApply).toHaveLength(0)

			// Products should need migration
			expect(productsResult.status).toBe("needs-migration")
			expect(productsResult.migrationsToApply).toHaveLength(2)
			expect(productsResult.migrationsToApply[0].from).toBe(1)
			expect(productsResult.migrationsToApply[1].from).toBe(2)
		})
	})

	describe("collection with no file → 'no-file' (task 12.3)", () => {
		it("dryRunMigrations reports 'no-file' when file does not exist", async () => {
			const { store, layer } = makeTestEnv()

			// Do NOT create any file in the store - file does not exist

			const config = {
				users: {
					schema: UserSchemaV3,
					file: "/data/users.json",
					version: 3,
					migrations: allMigrations,
					relationships: {},
				},
			}

			const stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, { readonly id: string }>>> = {}

			const result = await Effect.runPromise(
				Effect.provide(dryRunMigrations(config, stateRefs), layer),
			)

			expect(result.collections).toHaveLength(1)

			const usersResult = result.collections[0]
			expect(usersResult.name).toBe("users")
			expect(usersResult.filePath).toBe("/data/users.json")
			expect(usersResult.status).toBe("no-file")
			// When no file exists, currentVersion defaults to 0
			expect(usersResult.currentVersion).toBe(0)
			expect(usersResult.targetVersion).toBe(3)
			// No migrations listed when file doesn't exist
			expect(usersResult.migrationsToApply).toHaveLength(0)
		})

		it("dryRunMigrations reports 'no-file' for multiple missing collections", async () => {
			const { store, layer } = makeTestEnv()

			// No files created - both collections are missing files

			const config = {
				users: {
					schema: UserSchemaV3,
					file: "/data/users.json",
					version: 3,
					migrations: allMigrations,
					relationships: {},
				},
				products: {
					schema: UserSchemaV1,
					file: "/data/products.json",
					version: 1,
					migrations: migrationsTo1,
					relationships: {},
				},
			}

			const stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, { readonly id: string }>>> = {}

			const result = await Effect.runPromise(
				Effect.provide(dryRunMigrations(config, stateRefs), layer),
			)

			expect(result.collections).toHaveLength(2)

			// Both collections should report no-file
			const usersResult = result.collections.find((c) => c.name === "users")!
			const productsResult = result.collections.find((c) => c.name === "products")!

			expect(usersResult.status).toBe("no-file")
			expect(usersResult.currentVersion).toBe(0)
			expect(usersResult.migrationsToApply).toHaveLength(0)

			expect(productsResult.status).toBe("no-file")
			expect(productsResult.currentVersion).toBe(0)
			expect(productsResult.migrationsToApply).toHaveLength(0)
		})

		it("dryRunMigrations handles mixed: some files exist, some don't", async () => {
			const { store, layer } = makeTestEnv()

			// Users file exists at version 2
			store.set(
				"/data/users.json",
				JSON.stringify({
					_version: 2,
					u1: {
						id: "u1",
						firstName: "Alice",
						lastName: "Smith",
						email: "alice@example.com",
					},
				}),
			)

			// Products file does NOT exist

			const config = {
				users: {
					schema: UserSchemaV3,
					file: "/data/users.json",
					version: 3,
					migrations: allMigrations,
					relationships: {},
				},
				products: {
					schema: UserSchemaV1,
					file: "/data/products.json",
					version: 1,
					migrations: migrationsTo1,
					relationships: {},
				},
			}

			const stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, { readonly id: string }>>> = {}

			const result = await Effect.runPromise(
				Effect.provide(dryRunMigrations(config, stateRefs), layer),
			)

			expect(result.collections).toHaveLength(2)

			// Find results by name
			const usersResult = result.collections.find((c) => c.name === "users")!
			const productsResult = result.collections.find((c) => c.name === "products")!

			// Users should need migration (file exists at version 2, config is version 3)
			expect(usersResult.status).toBe("needs-migration")
			expect(usersResult.currentVersion).toBe(2)
			expect(usersResult.targetVersion).toBe(3)
			expect(usersResult.migrationsToApply).toHaveLength(1)
			expect(usersResult.migrationsToApply[0].from).toBe(2)

			// Products should report no-file
			expect(productsResult.status).toBe("no-file")
			expect(productsResult.currentVersion).toBe(0)
			expect(productsResult.targetVersion).toBe(1)
			expect(productsResult.migrationsToApply).toHaveLength(0)
		})

		it("dryRunMigrations reports 'no-file' for version 0 collection without file", async () => {
			const { store, layer } = makeTestEnv()

			// No file created

			const config = {
				users: {
					schema: UserSchemaV0,
					file: "/data/users.json",
					version: 0,
					migrations: [],
					relationships: {},
				},
			}

			const stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, { readonly id: string }>>> = {}

			const result = await Effect.runPromise(
				Effect.provide(dryRunMigrations(config, stateRefs), layer),
			)

			expect(result.collections).toHaveLength(1)

			const usersResult = result.collections[0]
			expect(usersResult.status).toBe("no-file")
			expect(usersResult.currentVersion).toBe(0)
			expect(usersResult.targetVersion).toBe(0)
			expect(usersResult.migrationsToApply).toHaveLength(0)
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
