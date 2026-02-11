import { describe, it, expect } from "vitest"
import { Effect, Schema, Ref } from "effect"
import { createEffectDatabase } from "../core/factories/database-effect.js"
import type { CollectionIndexes } from "../core/types/index-types.js"
import { buildIndexes, normalizeIndexes } from "../core/indexes/index-manager.js"

// ============================================================================
// Test Schemas
// ============================================================================

const UserSchema = Schema.Struct({
	id: Schema.String,
	email: Schema.String,
	name: Schema.String,
	age: Schema.Number,
	role: Schema.optional(Schema.String),
	companyId: Schema.optional(Schema.String),
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type User = Schema.Schema.Type<typeof UserSchema>

const ProductSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	category: Schema.String,
	subcategory: Schema.optional(Schema.String),
	price: Schema.Number,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type Product = Schema.Schema.Type<typeof ProductSchema>

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a database config with an indexed users collection.
 * Index on "email" for single-field index testing.
 */
const createIndexedUsersConfig = () =>
	({
		users: {
			schema: UserSchema,
			indexes: ["email"] as ReadonlyArray<string>,
			relationships: {} as const,
		},
	}) as const

/**
 * Creates a database config with both single and compound indexes.
 * - Single index on "email"
 * - Compound index on ["category", "subcategory"]
 */
const createMultiIndexConfig = () =>
	({
		users: {
			schema: UserSchema,
			indexes: ["email", "role"] as ReadonlyArray<string>,
			relationships: {} as const,
		},
		products: {
			schema: ProductSchema,
			indexes: [
				"category",
				["category", "subcategory"],
			] as ReadonlyArray<string | ReadonlyArray<string>>,
			relationships: {} as const,
		},
	}) as const

/**
 * Creates a database config with no indexes for baseline comparison.
 */
const createUnindexedConfig = () =>
	({
		users: {
			schema: UserSchema,
			relationships: {} as const,
		},
	}) as const

/**
 * Creates sample user data for testing.
 */
const createSampleUsers = (): ReadonlyArray<User> => [
	{ id: "u1", email: "alice@example.com", name: "Alice", age: 30, role: "admin", companyId: "c1" },
	{ id: "u2", email: "bob@example.com", name: "Bob", age: 25, role: "user", companyId: "c1" },
	{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35, role: "user", companyId: "c2" },
	{ id: "u4", email: "alice@example.com", name: "Alice Smith", age: 28, role: "admin" }, // Duplicate email
]

/**
 * Creates sample product data for testing.
 */
const createSampleProducts = (): ReadonlyArray<Product> => [
	{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
	{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
	{ id: "p3", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
	{ id: "p4", name: "Chair", category: "furniture", subcategory: "office", price: 199 },
	{ id: "p5", name: "Monitor", category: "electronics", subcategory: "computers", price: 399 },
]

/**
 * Creates sample users with null/undefined values in indexed fields.
 */
const createUsersWithNullValues = (): ReadonlyArray<Record<string, unknown>> => [
	{ id: "u1", email: "alice@example.com", name: "Alice", age: 30, role: "admin" },
	{ id: "u2", email: null, name: "Bob", age: 25, role: "user" }, // null email
	{ id: "u3", name: "Charlie", age: 35, role: "user" }, // undefined email (missing)
	{ id: "u4", email: "dave@example.com", name: "Dave", age: 40 }, // undefined role
]

/**
 * Helper to create a database with indexed collection and initial data.
 */
const createIndexedDatabase = <Config extends Record<string, { readonly schema: Schema.Schema<{ readonly id: string }, unknown>; readonly indexes?: ReadonlyArray<string | ReadonlyArray<string>>; readonly relationships: Record<string, unknown> }>>(
	config: Config,
	initialData?: { readonly [K in keyof Config]?: ReadonlyArray<Record<string, unknown>> },
) => createEffectDatabase(config, initialData)

/**
 * Helper to inspect index state for a collection.
 * This is an internal testing utility that accesses the index structure
 * via the buildIndexes function directly.
 */
const inspectIndexState = async (
	normalizedIndexes: ReadonlyArray<ReadonlyArray<string>>,
	entities: ReadonlyArray<{ readonly id: string }>,
): Promise<CollectionIndexes> =>
	Effect.runPromise(buildIndexes(normalizedIndexes, entities))

/**
 * Helper to get the index map for a specific field(s).
 */
const getIndexMap = async (
	indexes: CollectionIndexes,
	fields: ReadonlyArray<string>,
): Promise<Map<unknown, Set<string>>> => {
	const indexKey = JSON.stringify(fields)
	const indexRef = indexes.get(indexKey)
	if (!indexRef) {
		return new Map()
	}
	return Effect.runPromise(Ref.get(indexRef))
}

// ============================================================================
// Tests - Index Declaration and Building (Task 6.1)
// ============================================================================

describe("Indexing - Test Helpers", () => {
	describe("createIndexedDatabase", () => {
		it("should create a database with indexed collection", async () => {
			const config = createIndexedUsersConfig()
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: createSampleUsers().slice(0, 3) }),
			)

			expect(db).toBeDefined()
			expect(db.users).toBeDefined()
			expect(typeof db.users.query).toBe("function")
			expect(typeof db.users.create).toBe("function")
		})

		it("should create a database with multiple indexes", async () => {
			const config = createMultiIndexConfig()
			const db = await Effect.runPromise(
				createIndexedDatabase(config, {
					users: createSampleUsers().slice(0, 3),
					products: createSampleProducts(),
				}),
			)

			expect(db).toBeDefined()
			expect(db.users).toBeDefined()
			expect(db.products).toBeDefined()
		})

		it("should create a database without indexes (baseline)", async () => {
			const config = createUnindexedConfig()
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: createSampleUsers().slice(0, 3) }),
			)

			expect(db).toBeDefined()
			expect(db.users).toBeDefined()
		})
	})

	describe("inspectIndexState", () => {
		it("should build indexes from initial data", async () => {
			const normalized = normalizeIndexes(["email"])
			const users = createSampleUsers().slice(0, 3)
			const indexes = await inspectIndexState(normalized, users)

			expect(indexes.size).toBe(1)
			expect(indexes.has('["email"]')).toBe(true)
		})

		it("should build compound indexes", async () => {
			const normalized = normalizeIndexes([["category", "subcategory"]])
			const products = createSampleProducts()
			const indexes = await inspectIndexState(normalized, products)

			expect(indexes.size).toBe(1)
			expect(indexes.has('["category","subcategory"]')).toBe(true)
		})
	})

	describe("getIndexMap", () => {
		it("should retrieve index map for single-field index", async () => {
			const normalized = normalizeIndexes(["email"])
			const users = createSampleUsers().slice(0, 3)
			const indexes = await inspectIndexState(normalized, users)
			const indexMap = await getIndexMap(indexes, ["email"])

			expect(indexMap.has("alice@example.com")).toBe(true)
			expect(indexMap.has("bob@example.com")).toBe(true)
			expect(indexMap.has("charlie@example.com")).toBe(true)
		})

		it("should return empty map for non-existent index", async () => {
			const normalized = normalizeIndexes(["email"])
			const users = createSampleUsers().slice(0, 3)
			const indexes = await inspectIndexState(normalized, users)
			const indexMap = await getIndexMap(indexes, ["nonexistent"])

			expect(indexMap.size).toBe(0)
		})
	})
})

// Export helpers for use in other test files
export {
	UserSchema,
	ProductSchema,
	createIndexedUsersConfig,
	createMultiIndexConfig,
	createUnindexedConfig,
	createSampleUsers,
	createSampleProducts,
	createUsersWithNullValues,
	createIndexedDatabase,
	inspectIndexState,
	getIndexMap,
}
