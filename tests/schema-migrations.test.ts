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
