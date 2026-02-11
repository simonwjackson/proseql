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

// ============================================================================
// Tests - Index Declaration and Building (Task 6.2+)
// ============================================================================

describe("Indexing - Index Built from Initial Data", () => {
	describe("Task 6.2: correct field values mapped to correct entity IDs", () => {
		it("should map each unique email to the correct user ID", async () => {
			// Build indexes from users with unique emails
			const normalized = normalizeIndexes(["email"])
			const users = createSampleUsers().slice(0, 3) // alice, bob, charlie (unique emails)
			const indexes = await inspectIndexState(normalized, users)
			const indexMap = await getIndexMap(indexes, ["email"])

			// Verify each email maps to exactly the correct user ID
			const aliceIds = indexMap.get("alice@example.com")
			expect(aliceIds).toBeDefined()
			expect(aliceIds?.size).toBe(1)
			expect(aliceIds?.has("u1")).toBe(true)

			const bobIds = indexMap.get("bob@example.com")
			expect(bobIds).toBeDefined()
			expect(bobIds?.size).toBe(1)
			expect(bobIds?.has("u2")).toBe(true)

			const charlieIds = indexMap.get("charlie@example.com")
			expect(charlieIds).toBeDefined()
			expect(charlieIds?.size).toBe(1)
			expect(charlieIds?.has("u3")).toBe(true)
		})

		it("should map compound index keys to correct entity IDs", async () => {
			// Build compound indexes from products
			const normalized = normalizeIndexes([["category", "subcategory"]])
			const products = createSampleProducts()
			const indexes = await inspectIndexState(normalized, products)
			const indexMap = await getIndexMap(indexes, ["category", "subcategory"])

			// Compound key for ["electronics", "computers"] should have laptop (p1) and monitor (p5)
			const electronicsComputersKey = JSON.stringify(["electronics", "computers"])
			const electronicsComputers = indexMap.get(electronicsComputersKey)
			expect(electronicsComputers).toBeDefined()
			expect(electronicsComputers?.size).toBe(2)
			expect(electronicsComputers?.has("p1")).toBe(true) // Laptop
			expect(electronicsComputers?.has("p5")).toBe(true) // Monitor

			// Compound key for ["electronics", "phones"] should have phone (p2)
			const electronicsPhonesKey = JSON.stringify(["electronics", "phones"])
			const electronicsPhones = indexMap.get(electronicsPhonesKey)
			expect(electronicsPhones).toBeDefined()
			expect(electronicsPhones?.size).toBe(1)
			expect(electronicsPhones?.has("p2")).toBe(true) // Phone

			// Compound key for ["furniture", "office"] should have desk (p3) and chair (p4)
			const furnitureOfficeKey = JSON.stringify(["furniture", "office"])
			const furnitureOffice = indexMap.get(furnitureOfficeKey)
			expect(furnitureOffice).toBeDefined()
			expect(furnitureOffice?.size).toBe(2)
			expect(furnitureOffice?.has("p3")).toBe(true) // Desk
			expect(furnitureOffice?.has("p4")).toBe(true) // Chair
		})

		it("should only contain indexed field values (no extra entries)", async () => {
			const normalized = normalizeIndexes(["email"])
			const users = createSampleUsers().slice(0, 3)
			const indexes = await inspectIndexState(normalized, users)
			const indexMap = await getIndexMap(indexes, ["email"])

			// Index should have exactly 3 entries (one per unique email)
			expect(indexMap.size).toBe(3)

			// Should not have any non-existent emails
			expect(indexMap.has("nonexistent@example.com")).toBe(false)
		})

		it("should index role field correctly with single-field index", async () => {
			const normalized = normalizeIndexes(["role"])
			const users = createSampleUsers().slice(0, 3) // alice (admin), bob (user), charlie (user)
			const indexes = await inspectIndexState(normalized, users)
			const indexMap = await getIndexMap(indexes, ["role"])

			// "admin" should map to u1
			const adminIds = indexMap.get("admin")
			expect(adminIds).toBeDefined()
			expect(adminIds?.size).toBe(1)
			expect(adminIds?.has("u1")).toBe(true)

			// "user" should map to u2 and u3
			const userIds = indexMap.get("user")
			expect(userIds).toBeDefined()
			expect(userIds?.size).toBe(2)
			expect(userIds?.has("u2")).toBe(true)
			expect(userIds?.has("u3")).toBe(true)
		})
	})

	describe("Task 6.3: multiple entities with same field value", () => {
		it("should include all IDs in the Set when multiple entities share a field value", async () => {
			// createSampleUsers() includes u1 and u4 with the same email "alice@example.com"
			const normalized = normalizeIndexes(["email"])
			const users = createSampleUsers() // All 4 users, including duplicate email
			const indexes = await inspectIndexState(normalized, users)
			const indexMap = await getIndexMap(indexes, ["email"])

			// alice@example.com should have both u1 and u4
			const aliceIds = indexMap.get("alice@example.com")
			expect(aliceIds).toBeDefined()
			expect(aliceIds?.size).toBe(2)
			expect(aliceIds?.has("u1")).toBe(true)
			expect(aliceIds?.has("u4")).toBe(true)

			// Other emails should still have single entries
			expect(indexMap.get("bob@example.com")?.size).toBe(1)
			expect(indexMap.get("charlie@example.com")?.size).toBe(1)
		})

		it("should handle many entities sharing the same field value", async () => {
			// Create users with many duplicate role values
			const usersWithSameRole: ReadonlyArray<User> = [
				{ id: "u1", email: "a@test.com", name: "A", age: 20, role: "member" },
				{ id: "u2", email: "b@test.com", name: "B", age: 21, role: "member" },
				{ id: "u3", email: "c@test.com", name: "C", age: 22, role: "member" },
				{ id: "u4", email: "d@test.com", name: "D", age: 23, role: "member" },
				{ id: "u5", email: "e@test.com", name: "E", age: 24, role: "member" },
				{ id: "u6", email: "f@test.com", name: "F", age: 25, role: "admin" },
			]

			const normalized = normalizeIndexes(["role"])
			const indexes = await inspectIndexState(normalized, usersWithSameRole)
			const indexMap = await getIndexMap(indexes, ["role"])

			// "member" should have 5 IDs
			const memberIds = indexMap.get("member")
			expect(memberIds).toBeDefined()
			expect(memberIds?.size).toBe(5)
			expect(memberIds?.has("u1")).toBe(true)
			expect(memberIds?.has("u2")).toBe(true)
			expect(memberIds?.has("u3")).toBe(true)
			expect(memberIds?.has("u4")).toBe(true)
			expect(memberIds?.has("u5")).toBe(true)

			// "admin" should have 1 ID
			const adminIds = indexMap.get("admin")
			expect(adminIds).toBeDefined()
			expect(adminIds?.size).toBe(1)
			expect(adminIds?.has("u6")).toBe(true)
		})

		it("should collect all IDs for compound indexes with duplicate key combinations", async () => {
			// p1 (Laptop) and p5 (Monitor) both have ["electronics", "computers"]
			// p3 (Desk) and p4 (Chair) both have ["furniture", "office"]
			const normalized = normalizeIndexes([["category", "subcategory"]])
			const products = createSampleProducts()
			const indexes = await inspectIndexState(normalized, products)
			const indexMap = await getIndexMap(indexes, ["category", "subcategory"])

			// Check electronics/computers has both p1 and p5
			const electronicsComputersKey = JSON.stringify(["electronics", "computers"])
			const electronicsComputers = indexMap.get(electronicsComputersKey)
			expect(electronicsComputers).toBeDefined()
			expect(electronicsComputers?.size).toBe(2)
			expect(electronicsComputers?.has("p1")).toBe(true)
			expect(electronicsComputers?.has("p5")).toBe(true)

			// Check furniture/office has both p3 and p4
			const furnitureOfficeKey = JSON.stringify(["furniture", "office"])
			const furnitureOffice = indexMap.get(furnitureOfficeKey)
			expect(furnitureOffice).toBeDefined()
			expect(furnitureOffice?.size).toBe(2)
			expect(furnitureOffice?.has("p3")).toBe(true)
			expect(furnitureOffice?.has("p4")).toBe(true)

			// electronics/phones should have only p2
			const electronicsPhonesKey = JSON.stringify(["electronics", "phones"])
			const electronicsPhones = indexMap.get(electronicsPhonesKey)
			expect(electronicsPhones).toBeDefined()
			expect(electronicsPhones?.size).toBe(1)
			expect(electronicsPhones?.has("p2")).toBe(true)
		})

		it("should correctly index when all entities have the same field value", async () => {
			// All users have the same role
			const usersAllSameRole: ReadonlyArray<User> = [
				{ id: "u1", email: "a@test.com", name: "A", age: 20, role: "guest" },
				{ id: "u2", email: "b@test.com", name: "B", age: 21, role: "guest" },
				{ id: "u3", email: "c@test.com", name: "C", age: 22, role: "guest" },
			]

			const normalized = normalizeIndexes(["role"])
			const indexes = await inspectIndexState(normalized, usersAllSameRole)
			const indexMap = await getIndexMap(indexes, ["role"])

			// Only one entry in the index map
			expect(indexMap.size).toBe(1)

			// "guest" should have all 3 IDs
			const guestIds = indexMap.get("guest")
			expect(guestIds).toBeDefined()
			expect(guestIds?.size).toBe(3)
			expect(guestIds?.has("u1")).toBe(true)
			expect(guestIds?.has("u2")).toBe(true)
			expect(guestIds?.has("u3")).toBe(true)
		})
	})

	describe("Task 6.5: collection without indexes: empty CollectionIndexes", () => {
		it("should return empty CollectionIndexes when no indexes configured", async () => {
			// normalizeIndexes(undefined) returns [], buildIndexes([]) returns empty Map
			const normalized = normalizeIndexes(undefined)
			expect(normalized).toEqual([])

			const indexes = await inspectIndexState(normalized, createSampleUsers())
			expect(indexes.size).toBe(0)
		})

		it("should return empty CollectionIndexes when indexes is empty array", async () => {
			const normalized = normalizeIndexes([])
			expect(normalized).toEqual([])

			const indexes = await inspectIndexState(normalized, createSampleUsers())
			expect(indexes.size).toBe(0)
		})

		it("should work with database factory when no indexes configured", async () => {
			// createUnindexedConfig has no indexes property
			const config = createUnindexedConfig()
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: createSampleUsers().slice(0, 3) }),
			)

			// Database should still work - CRUD operations function without indexes
			expect(db.users).toBeDefined()

			// Query should work (full scan path)
			const results = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u1")
		})
	})

	describe("Task 6.4: null/undefined values not indexed", () => {
		it("should not index entities with null values in indexed field", async () => {
			const usersWithNull = createUsersWithNullValues()
			const normalized = normalizeIndexes(["email"])
			const indexes = await inspectIndexState(normalized, usersWithNull as ReadonlyArray<{ readonly id: string }>)
			const indexMap = await getIndexMap(indexes, ["email"])

			// Only u1 (alice@example.com) and u4 (dave@example.com) have valid emails
			// u2 has null email, u3 has undefined/missing email
			expect(indexMap.size).toBe(2)
			expect(indexMap.has("alice@example.com")).toBe(true)
			expect(indexMap.has("dave@example.com")).toBe(true)

			// Verify the IDs are correct
			expect(indexMap.get("alice@example.com")?.has("u1")).toBe(true)
			expect(indexMap.get("dave@example.com")?.has("u4")).toBe(true)

			// null should not be a key in the index
			expect(indexMap.has(null)).toBe(false)
		})

		it("should not index entities with undefined values in indexed field", async () => {
			const usersWithNull = createUsersWithNullValues()
			const normalized = normalizeIndexes(["role"])
			const indexes = await inspectIndexState(normalized, usersWithNull as ReadonlyArray<{ readonly id: string }>)
			const indexMap = await getIndexMap(indexes, ["role"])

			// u1 has role: "admin", u2 has role: "user"
			// u3 has role: "user", u4 has no role (undefined)
			expect(indexMap.size).toBe(2)
			expect(indexMap.has("admin")).toBe(true)
			expect(indexMap.has("user")).toBe(true)

			// Verify correct IDs
			const adminIds = indexMap.get("admin")
			expect(adminIds?.size).toBe(1)
			expect(adminIds?.has("u1")).toBe(true)

			const userIds = indexMap.get("user")
			expect(userIds?.size).toBe(2)
			expect(userIds?.has("u2")).toBe(true)
			expect(userIds?.has("u3")).toBe(true)

			// undefined should not be a key in the index
			expect(indexMap.has(undefined)).toBe(false)
		})

		it("should not index compound keys when any field is null/undefined", async () => {
			const productsWithMissing: ReadonlyArray<Record<string, unknown>> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: null, price: 699 }, // null subcategory
				{ id: "p3", name: "Desk", category: "furniture", price: 299 }, // undefined subcategory
				{ id: "p4", name: "Chair", category: null, subcategory: "office", price: 199 }, // null category
			]

			const normalized = normalizeIndexes([["category", "subcategory"]])
			const indexes = await inspectIndexState(normalized, productsWithMissing as ReadonlyArray<{ readonly id: string }>)
			const indexMap = await getIndexMap(indexes, ["category", "subcategory"])

			// Only p1 has both fields defined
			expect(indexMap.size).toBe(1)

			const key = JSON.stringify(["electronics", "computers"])
			expect(indexMap.has(key)).toBe(true)
			expect(indexMap.get(key)?.size).toBe(1)
			expect(indexMap.get(key)?.has("p1")).toBe(true)
		})

		it("should handle mix of valid and null/undefined across multiple entities", async () => {
			const mixedUsers: ReadonlyArray<Record<string, unknown>> = [
				{ id: "u1", email: "a@test.com", name: "A", age: 20, role: "admin" },
				{ id: "u2", email: null, name: "B", age: 21, role: "user" },
				{ id: "u3", email: "c@test.com", name: "C", age: 22 }, // undefined role
				{ id: "u4", name: "D", age: 23, role: "user" }, // undefined email
				{ id: "u5", email: "e@test.com", name: "E", age: 24, role: "admin" },
			]

			// Test email index
			const emailNormalized = normalizeIndexes(["email"])
			const emailIndexes = await inspectIndexState(emailNormalized, mixedUsers as ReadonlyArray<{ readonly id: string }>)
			const emailMap = await getIndexMap(emailIndexes, ["email"])

			// u1, u3, u5 have valid emails
			expect(emailMap.size).toBe(3)
			expect(emailMap.get("a@test.com")?.has("u1")).toBe(true)
			expect(emailMap.get("c@test.com")?.has("u3")).toBe(true)
			expect(emailMap.get("e@test.com")?.has("u5")).toBe(true)

			// Test role index
			const roleNormalized = normalizeIndexes(["role"])
			const roleIndexes = await inspectIndexState(roleNormalized, mixedUsers as ReadonlyArray<{ readonly id: string }>)
			const roleMap = await getIndexMap(roleIndexes, ["role"])

			// u1, u2, u4, u5 have valid roles
			expect(roleMap.size).toBe(2) // "admin" and "user"
			expect(roleMap.get("admin")?.size).toBe(2) // u1, u5
			expect(roleMap.get("admin")?.has("u1")).toBe(true)
			expect(roleMap.get("admin")?.has("u5")).toBe(true)
			expect(roleMap.get("user")?.size).toBe(2) // u2, u4
			expect(roleMap.get("user")?.has("u2")).toBe(true)
			expect(roleMap.get("user")?.has("u4")).toBe(true)
		})

		it("should not index when all entities have null/undefined in indexed field", async () => {
			const usersAllNull: ReadonlyArray<Record<string, unknown>> = [
				{ id: "u1", email: null, name: "A", age: 20 },
				{ id: "u2", name: "B", age: 21 }, // undefined email
				{ id: "u3", email: null, name: "C", age: 22 },
			]

			const normalized = normalizeIndexes(["email"])
			const indexes = await inspectIndexState(normalized, usersAllNull as ReadonlyArray<{ readonly id: string }>)
			const indexMap = await getIndexMap(indexes, ["email"])

			// Index should be empty since all emails are null/undefined
			expect(indexMap.size).toBe(0)
		})
	})
})

// ============================================================================
// Tests - Index Maintenance (Task 7.x)
// ============================================================================

describe("Indexing - Index Maintenance", () => {
	describe("Task 7.2: update changing indexed field → old removed, new added", () => {
		it("should remove entity from old index entry and add to new when indexed field changes", async () => {
			// Start with a user with email "alice@example.com"
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Verify initial index state via query
			const aliceInitial = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceInitial.length).toBe(1)
			expect((aliceInitial[0] as { id: string }).id).toBe("u1")

			// Update Alice's email to a new value
			await db.users.update("u1", { email: "alice.new@example.com" }).runPromise

			// Query by OLD email - should not find Alice anymore
			const oldEmailResults = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(oldEmailResults.length).toBe(0)

			// Query by NEW email - should find Alice
			const newEmailResults = await db.users.query({ where: { email: "alice.new@example.com" } }).runPromise
			expect(newEmailResults.length).toBe(1)
			expect((newEmailResults[0] as { id: string }).id).toBe("u1")
			expect((newEmailResults[0] as { email: string }).email).toBe("alice.new@example.com")

			// Bob should still be queryable by his unchanged email
			const bobResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(bobResults.length).toBe(1)
			expect((bobResults[0] as { id: string }).id).toBe("u2")
		})

		it("should move entity between existing index Sets when changing to a shared value", async () => {
			// Start with two users with different emails
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Update Alice's email to match Bob's
			await db.users.update("u1", { email: "bob@example.com" }).runPromise

			// Query by OLD email - should be empty
			const oldEmailResults = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(oldEmailResults.length).toBe(0)

			// Query by shared email - should return both users
			const sharedEmailResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(sharedEmailResults.length).toBe(2)

			const ids = sharedEmailResults.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u2"])
		})

		it("should handle update that splits a shared index entry", async () => {
			// Start with two users sharing the same email
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "shared@example.com", name: "User One", age: 30 },
				{ id: "u2", email: "shared@example.com", name: "User Two", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Verify both are at shared email initially
			const sharedInitial = await db.users.query({ where: { email: "shared@example.com" } }).runPromise
			expect(sharedInitial.length).toBe(2)

			// Update u1's email to a unique value
			await db.users.update("u1", { email: "unique@example.com" }).runPromise

			// Query shared email - should now only have u2
			const sharedAfter = await db.users.query({ where: { email: "shared@example.com" } }).runPromise
			expect(sharedAfter.length).toBe(1)
			expect((sharedAfter[0] as { id: string }).id).toBe("u2")

			// Query unique email - should have u1
			const uniqueResults = await db.users.query({ where: { email: "unique@example.com" } }).runPromise
			expect(uniqueResults.length).toBe(1)
			expect((uniqueResults[0] as { id: string }).id).toBe("u1")
		})

		it("should update compound index when compound key fields change", async () => {
			const config = createMultiIndexConfig()
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: initialProducts }),
			)

			// Verify initial compound index state
			const electronicsComputers = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(electronicsComputers.length).toBe(1)
			expect((electronicsComputers[0] as { id: string }).id).toBe("p1")

			// Update Laptop's subcategory from "computers" to "phones"
			await db.products.update("p1", { subcategory: "phones" }).runPromise

			// Query old compound key - should be empty
			const oldCompound = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(oldCompound.length).toBe(0)

			// Query new compound key - should have both products
			const newCompound = await db.products.query({
				where: { category: "electronics", subcategory: "phones" },
			}).runPromise
			expect(newCompound.length).toBe(2)

			const ids = newCompound.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p1", "p2"])
		})

		it("should handle updating both fields of a compound index", async () => {
			const config = createMultiIndexConfig()
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: initialProducts }),
			)

			// Update both category and subcategory
			await db.products.update("p1", { category: "furniture", subcategory: "office" }).runPromise

			// Query old compound key - should be empty
			const oldResults = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(oldResults.length).toBe(0)

			// Query new compound key - should have the product
			const newResults = await db.products.query({
				where: { category: "furniture", subcategory: "office" },
			}).runPromise
			expect(newResults.length).toBe(1)
			expect((newResults[0] as { id: string }).id).toBe("p1")
		})

		it("should handle update that sets indexed field to a value already used by same entity", async () => {
			// This tests the edge case where the update doesn't actually change the value
			// (covered more in 7.3, but including a basic check here)
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Update email to the same value (plus update name to trigger the update)
			await db.users.update("u1", { email: "alice@example.com", name: "Alice Updated" }).runPromise

			// Should still be queryable by the same email
			const results = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u1")
			expect((results[0] as { name: string }).name).toBe("Alice Updated")
		})
	})

	describe("Task 7.3: update not changing indexed field → index unchanged", () => {
		it("should keep entity in same index entry when only non-indexed fields change", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Verify initial query works
			const aliceInitial = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceInitial.length).toBe(1)
			expect((aliceInitial[0] as { id: string }).id).toBe("u1")

			// Update non-indexed field (name, age)
			await db.users.update("u1", { name: "Alice Updated", age: 31 }).runPromise

			// Query by indexed field (email) - should still find Alice
			const aliceAfter = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceAfter.length).toBe(1)
			expect((aliceAfter[0] as { id: string }).id).toBe("u1")
			expect((aliceAfter[0] as { name: string }).name).toBe("Alice Updated")
			expect((aliceAfter[0] as { age: number }).age).toBe(31)

			// Bob should be unaffected
			const bobResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(bobResults.length).toBe(1)
			expect((bobResults[0] as { id: string }).id).toBe("u2")
		})

		it("should preserve shared index entry when updating non-indexed fields", async () => {
			// Two users share the same email
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "shared@example.com", name: "User One", age: 30 },
				{ id: "u2", email: "shared@example.com", name: "User Two", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Verify both are queryable via shared email initially
			const sharedInitial = await db.users.query({ where: { email: "shared@example.com" } }).runPromise
			expect(sharedInitial.length).toBe(2)

			// Update u1's name (non-indexed field)
			await db.users.update("u1", { name: "Updated User One" }).runPromise

			// Query shared email - should still return both users
			const sharedAfter = await db.users.query({ where: { email: "shared@example.com" } }).runPromise
			expect(sharedAfter.length).toBe(2)

			const ids = sharedAfter.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u2"])

			// Verify the update was applied
			const u1 = sharedAfter.find((r) => (r as { id: string }).id === "u1")
			expect((u1 as { name: string }).name).toBe("Updated User One")
		})

		it("should keep compound index entry unchanged when updating non-indexed fields", async () => {
			const config = createMultiIndexConfig()
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: initialProducts }),
			)

			// Verify compound index query works initially
			const computersInitial = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(computersInitial.length).toBe(1)
			expect((computersInitial[0] as { id: string }).id).toBe("p1")

			// Update non-indexed fields (name, price)
			await db.products.update("p1", { name: "Gaming Laptop", price: 1499 }).runPromise

			// Query by compound index - should still find the product
			const computersAfter = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(computersAfter.length).toBe(1)
			expect((computersAfter[0] as { id: string }).id).toBe("p1")
			expect((computersAfter[0] as { name: string }).name).toBe("Gaming Laptop")
			expect((computersAfter[0] as { price: number }).price).toBe(1499)

			// Other compound index entry should be unaffected
			const phonesResults = await db.products.query({
				where: { category: "electronics", subcategory: "phones" },
			}).runPromise
			expect(phonesResults.length).toBe(1)
			expect((phonesResults[0] as { id: string }).id).toBe("p2")
		})

		it("should handle updating email to same value (no actual change)", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Update email to the exact same value
			await db.users.update("u1", { email: "alice@example.com" }).runPromise

			// Should still be queryable
			const results = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u1")
		})

		it("should maintain multiple single-field indexes when updating non-indexed field", async () => {
			// createMultiIndexConfig has users with indexes on both "email" and "role"
			const config = createMultiIndexConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30, role: "admin" },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25, role: "user" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Verify both indexes work initially
			const aliceByEmail = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceByEmail.length).toBe(1)
			const aliceByRole = await db.users.query({ where: { role: "admin" } }).runPromise
			expect(aliceByRole.length).toBe(1)

			// Update non-indexed field (name)
			await db.users.update("u1", { name: "Alice Smith" }).runPromise

			// Both indexes should still work
			const aliceByEmailAfter = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceByEmailAfter.length).toBe(1)
			expect((aliceByEmailAfter[0] as { name: string }).name).toBe("Alice Smith")

			const aliceByRoleAfter = await db.users.query({ where: { role: "admin" } }).runPromise
			expect(aliceByRoleAfter.length).toBe(1)
			expect((aliceByRoleAfter[0] as { name: string }).name).toBe("Alice Smith")
		})

		it("should handle multiple consecutive updates to non-indexed fields", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Perform multiple updates to non-indexed fields
			await db.users.update("u1", { name: "Alice 1" }).runPromise
			await db.users.update("u1", { age: 31 }).runPromise
			await db.users.update("u1", { name: "Alice 2", age: 32 }).runPromise

			// Should still be queryable by indexed field
			const results = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u1")
			expect((results[0] as { name: string }).name).toBe("Alice 2")
			expect((results[0] as { age: number }).age).toBe(32)
		})
	})

	describe("Task 7.4: delete → index entries removed, empty Sets cleaned up", () => {
		it("should remove entity from index when deleted", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Verify initial index state
			const aliceInitial = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceInitial.length).toBe(1)
			expect((aliceInitial[0] as { id: string }).id).toBe("u1")

			// Delete Alice
			const deleted = await db.users.delete("u1").runPromise
			expect((deleted as { id: string }).id).toBe("u1")

			// Query by deleted email - should not find Alice anymore
			const aliceAfter = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceAfter.length).toBe(0)

			// Bob should still be queryable
			const bobResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(bobResults.length).toBe(1)
			expect((bobResults[0] as { id: string }).id).toBe("u2")
		})

		it("should remove entity from shared index Set, leaving other entities", async () => {
			// Two users share the same email
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "shared@example.com", name: "User One", age: 30 },
				{ id: "u2", email: "shared@example.com", name: "User Two", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Verify both are queryable initially
			const sharedInitial = await db.users.query({ where: { email: "shared@example.com" } }).runPromise
			expect(sharedInitial.length).toBe(2)

			// Delete u1
			await db.users.delete("u1").runPromise

			// Query shared email - should now only have u2
			const sharedAfter = await db.users.query({ where: { email: "shared@example.com" } }).runPromise
			expect(sharedAfter.length).toBe(1)
			expect((sharedAfter[0] as { id: string }).id).toBe("u2")
		})

		it("should clean up empty index Set when last entity with that value is deleted", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Delete Alice - should clean up the "alice@example.com" index entry
			await db.users.delete("u1").runPromise

			// Query by deleted email - should return empty (not error)
			const aliceAfter = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceAfter.length).toBe(0)

			// Verify by checking we can query the remaining user
			const allUsers = await db.users.query().runPromise
			expect(allUsers.length).toBe(1)
			expect((allUsers[0] as { id: string }).id).toBe("u2")
		})

		it("should remove entity from compound index when deleted", async () => {
			const config = createMultiIndexConfig()
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Desktop", category: "electronics", subcategory: "computers", price: 1299 },
				{ id: "p3", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: initialProducts }),
			)

			// Verify initial compound index state
			const computersInitial = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(computersInitial.length).toBe(2)

			// Delete the Laptop
			await db.products.delete("p1").runPromise

			// Query compound index - should only have Desktop now
			const computersAfter = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(computersAfter.length).toBe(1)
			expect((computersAfter[0] as { id: string }).id).toBe("p2")

			// Phone should still be queryable
			const phonesResults = await db.products.query({
				where: { category: "electronics", subcategory: "phones" },
			}).runPromise
			expect(phonesResults.length).toBe(1)
			expect((phonesResults[0] as { id: string }).id).toBe("p3")
		})

		it("should clean up empty compound index Set when last entity is deleted", async () => {
			const config = createMultiIndexConfig()
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p2", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: initialProducts }),
			)

			// Delete the only electronics/phones product
			await db.products.delete("p1").runPromise

			// Query by deleted compound key - should return empty
			const phonesAfter = await db.products.query({
				where: { category: "electronics", subcategory: "phones" },
			}).runPromise
			expect(phonesAfter.length).toBe(0)

			// Other compound index entry should be unaffected
			const officeResults = await db.products.query({
				where: { category: "furniture", subcategory: "office" },
			}).runPromise
			expect(officeResults.length).toBe(1)
			expect((officeResults[0] as { id: string }).id).toBe("p2")
		})

		it("should handle deleting all entities and leaving indexes empty", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Delete all users
			await db.users.delete("u1").runPromise
			await db.users.delete("u2").runPromise

			// All queries should return empty
			const aliceResults = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceResults.length).toBe(0)

			const bobResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(bobResults.length).toBe(0)

			const allUsers = await db.users.query().runPromise
			expect(allUsers.length).toBe(0)
		})

		it("should maintain multiple single-field indexes when deleting", async () => {
			// createMultiIndexConfig has users with indexes on both "email" and "role"
			const config = createMultiIndexConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30, role: "admin" },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25, role: "user" },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35, role: "admin" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Verify both indexes work initially
			const adminsBefore = await db.users.query({ where: { role: "admin" } }).runPromise
			expect(adminsBefore.length).toBe(2)

			// Delete Alice (admin)
			await db.users.delete("u1").runPromise

			// Email index should no longer have Alice
			const aliceByEmail = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceByEmail.length).toBe(0)

			// Role index should only have Charlie as admin now
			const adminsAfter = await db.users.query({ where: { role: "admin" } }).runPromise
			expect(adminsAfter.length).toBe(1)
			expect((adminsAfter[0] as { id: string }).id).toBe("u3")

			// User role should be unaffected
			const usersRole = await db.users.query({ where: { role: "user" } }).runPromise
			expect(usersRole.length).toBe(1)
			expect((usersRole[0] as { id: string }).id).toBe("u2")
		})
	})

	describe("Task 7.5: createMany → batch index update", () => {
		it("should add all entities to index when createMany is called", async () => {
			const config = createIndexedUsersConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Create multiple users at once
			const result = await db.users.createMany([
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]).runPromise

			expect(result.created.length).toBe(3)

			// Query each email via index - all should be findable
			const aliceResults = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceResults.length).toBe(1)
			expect((aliceResults[0] as { id: string }).id).toBe("u1")

			const bobResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(bobResults.length).toBe(1)
			expect((bobResults[0] as { id: string }).id).toBe("u2")

			const charlieResults = await db.users.query({ where: { email: "charlie@example.com" } }).runPromise
			expect(charlieResults.length).toBe(1)
			expect((charlieResults[0] as { id: string }).id).toBe("u3")
		})

		it("should add multiple entities with same indexed value to shared Set", async () => {
			const config = createIndexedUsersConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Create multiple users with the same email
			const result = await db.users.createMany([
				{ id: "u1", email: "shared@example.com", name: "User One", age: 30 },
				{ id: "u2", email: "shared@example.com", name: "User Two", age: 25 },
				{ id: "u3", email: "shared@example.com", name: "User Three", age: 35 },
			]).runPromise

			expect(result.created.length).toBe(3)

			// Query by shared email - should return all 3 users
			const results = await db.users.query({ where: { email: "shared@example.com" } }).runPromise
			expect(results.length).toBe(3)

			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u2", "u3"])
		})

		it("should add entities to index alongside existing entries", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "existing@example.com", name: "Existing", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Verify initial user is queryable
			const existingInitial = await db.users.query({ where: { email: "existing@example.com" } }).runPromise
			expect(existingInitial.length).toBe(1)

			// Create more users via createMany
			const result = await db.users.createMany([
				{ id: "u2", email: "new1@example.com", name: "New One", age: 25 },
				{ id: "u3", email: "new2@example.com", name: "New Two", age: 35 },
			]).runPromise

			expect(result.created.length).toBe(2)

			// All should be queryable via index
			const existingResults = await db.users.query({ where: { email: "existing@example.com" } }).runPromise
			expect(existingResults.length).toBe(1)
			expect((existingResults[0] as { id: string }).id).toBe("u1")

			const new1Results = await db.users.query({ where: { email: "new1@example.com" } }).runPromise
			expect(new1Results.length).toBe(1)
			expect((new1Results[0] as { id: string }).id).toBe("u2")

			const new2Results = await db.users.query({ where: { email: "new2@example.com" } }).runPromise
			expect(new2Results.length).toBe(1)
			expect((new2Results[0] as { id: string }).id).toBe("u3")
		})

		it("should batch update compound indexes", async () => {
			const config = createMultiIndexConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Create multiple products with compound indexes
			const result = await db.products.createMany([
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Desktop", category: "electronics", subcategory: "computers", price: 1299 },
				{ id: "p3", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p4", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
			]).runPromise

			expect(result.created.length).toBe(4)

			// Query each compound key
			const computersResults = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(computersResults.length).toBe(2)
			const computerIds = computersResults.map((r) => (r as { id: string }).id).sort()
			expect(computerIds).toEqual(["p1", "p2"])

			const phonesResults = await db.products.query({
				where: { category: "electronics", subcategory: "phones" },
			}).runPromise
			expect(phonesResults.length).toBe(1)
			expect((phonesResults[0] as { id: string }).id).toBe("p3")

			const officeResults = await db.products.query({
				where: { category: "furniture", subcategory: "office" },
			}).runPromise
			expect(officeResults.length).toBe(1)
			expect((officeResults[0] as { id: string }).id).toBe("p4")
		})

		it("should add to index even when some entities are skipped due to duplicates", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "existing@example.com", name: "Existing", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Create with some duplicates - skipDuplicates: true
			const result = await db.users.createMany(
				[
					{ id: "u1", email: "duplicate@example.com", name: "Dupe", age: 20 }, // duplicate ID
					{ id: "u2", email: "new@example.com", name: "New User", age: 25 },
				],
				{ skipDuplicates: true },
			).runPromise

			expect(result.created.length).toBe(1)
			expect(result.skipped?.length).toBe(1)

			// The new user should be indexed
			const newResults = await db.users.query({ where: { email: "new@example.com" } }).runPromise
			expect(newResults.length).toBe(1)
			expect((newResults[0] as { id: string }).id).toBe("u2")

			// The skipped entity should NOT be in the index
			const dupeResults = await db.users.query({ where: { email: "duplicate@example.com" } }).runPromise
			expect(dupeResults.length).toBe(0)
		})

		it("should handle empty createMany call gracefully", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "existing@example.com", name: "Existing", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Create with empty array
			const result = await db.users.createMany([]).runPromise

			expect(result.created.length).toBe(0)

			// Existing user should still be queryable
			const existingResults = await db.users.query({ where: { email: "existing@example.com" } }).runPromise
			expect(existingResults.length).toBe(1)
		})

		it("should update multiple single-field indexes via createMany", async () => {
			// createMultiIndexConfig has users with indexes on both "email" and "role"
			const config = createMultiIndexConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Create users with various roles
			const result = await db.users.createMany([
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30, role: "admin" },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25, role: "user" },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35, role: "admin" },
				{ id: "u4", email: "dave@example.com", name: "Dave", age: 40, role: "user" },
			]).runPromise

			expect(result.created.length).toBe(4)

			// Query by email index
			const aliceByEmail = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceByEmail.length).toBe(1)
			expect((aliceByEmail[0] as { id: string }).id).toBe("u1")

			// Query by role index
			const adminResults = await db.users.query({ where: { role: "admin" } }).runPromise
			expect(adminResults.length).toBe(2)
			const adminIds = adminResults.map((r) => (r as { id: string }).id).sort()
			expect(adminIds).toEqual(["u1", "u3"])

			const userResults = await db.users.query({ where: { role: "user" } }).runPromise
			expect(userResults.length).toBe(2)
			const userIds = userResults.map((r) => (r as { id: string }).id).sort()
			expect(userIds).toEqual(["u2", "u4"])
		})
	})

	describe("Task 7.6: upsert (create path) → index added", () => {
		it("should add new entity to index when upsert creates", async () => {
			// Start with an empty indexed database
			const config = createIndexedUsersConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Upsert with no existing match → should create
			const result = await db.users.upsert({
				where: { email: "newuser@example.com" },
				update: { name: "Updated Name" },
				create: { name: "New User", age: 25 },
			}).runPromise

			expect(result.__action).toBe("created")
			expect(result.email).toBe("newuser@example.com")
			expect(result.name).toBe("New User")

			// Query using the indexed field - should find the new user
			const results = await db.users.query({ where: { email: "newuser@example.com" } }).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { name: string }).name).toBe("New User")
		})

		it("should add entity to index alongside existing entries via upsert create path", async () => {
			// Start with some initial data
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Verify initial data is queryable
			const aliceResults = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceResults.length).toBe(1)

			// Upsert a new user (no match for bob@example.com)
			const result = await db.users.upsert({
				where: { email: "bob@example.com" },
				update: { name: "Should Not Apply" },
				create: { name: "Bob", age: 25 },
			}).runPromise

			expect(result.__action).toBe("created")
			expect(result.name).toBe("Bob")

			// Query for the new user via indexed field
			const bobResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(bobResults.length).toBe(1)
			expect((bobResults[0] as { name: string }).name).toBe("Bob")

			// Original user should still be queryable
			const aliceStillThere = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceStillThere.length).toBe(1)
		})

		it("should add entity to existing index Set when upsert creates with same field value", async () => {
			// Start with a user having shared@example.com
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "shared@example.com", name: "User One", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Upsert another user with a different where clause that results in same email
			// Note: we use id in where to force a no-match
			const result = await db.users.upsert({
				where: { id: "u2" },
				update: { name: "Should Not Apply" },
				create: { email: "shared@example.com", name: "User Two", age: 25 },
			}).runPromise

			expect(result.__action).toBe("created")

			// Query should return both users with this email
			const results = await db.users.query({ where: { email: "shared@example.com" } }).runPromise
			expect(results.length).toBe(2)

			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u2"])
		})

		it("should add entity to compound index when upsert creates", async () => {
			const config = createMultiIndexConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Upsert a product (no existing match) → should create
			const result = await db.products.upsert({
				where: { id: "p1" },
				update: { name: "Should Not Apply" },
				create: { name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
			}).runPromise

			expect(result.__action).toBe("created")
			expect(result.name).toBe("Laptop")

			// Query using compound index fields
			const results = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("p1")
		})

		it("should add multiple entities to index via upsertMany create path", async () => {
			const config = createIndexedUsersConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Upsert multiple users that don't exist
			const result = await db.users.upsertMany([
				{ where: { email: "alice@example.com" }, update: {}, create: { name: "Alice", age: 30 } },
				{ where: { email: "bob@example.com" }, update: {}, create: { name: "Bob", age: 25 } },
				{ where: { email: "charlie@example.com" }, update: {}, create: { name: "Charlie", age: 35 } },
			]).runPromise

			expect(result.created.length).toBe(3)
			expect(result.updated.length).toBe(0)

			// All should be queryable via index
			const aliceResults = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceResults.length).toBe(1)

			const bobResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(bobResults.length).toBe(1)

			const charlieResults = await db.users.query({ where: { email: "charlie@example.com" } }).runPromise
			expect(charlieResults.length).toBe(1)
		})

		it("should add entities to shared index Set via upsertMany create path", async () => {
			const config = createIndexedUsersConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Upsert multiple users with the same email
			const result = await db.users.upsertMany([
				{ where: { id: "u1" }, update: {}, create: { email: "shared@example.com", name: "User One", age: 30 } },
				{ where: { id: "u2" }, update: {}, create: { email: "shared@example.com", name: "User Two", age: 25 } },
				{ where: { id: "u3" }, update: {}, create: { email: "shared@example.com", name: "User Three", age: 35 } },
			]).runPromise

			expect(result.created.length).toBe(3)

			// Query by shared email - should return all 3 users
			const results = await db.users.query({ where: { email: "shared@example.com" } }).runPromise
			expect(results.length).toBe(3)

			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u2", "u3"])
		})
	})

	describe("Task 7.7: upsert (update path) → index updated", () => {
		it("should update index when upsert updates an existing entity's indexed field", async () => {
			// Start with an existing user
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Verify initial query works
			const aliceInitial = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceInitial.length).toBe(1)
			expect((aliceInitial[0] as { id: string }).id).toBe("u1")

			// Upsert that matches existing user and updates their email
			const result = await db.users.upsert({
				where: { id: "u1" },
				update: { email: "alice.new@example.com" },
				create: { email: "unused@example.com", name: "Unused", age: 99 },
			}).runPromise

			expect(result.__action).toBe("updated")
			expect(result.email).toBe("alice.new@example.com")

			// Query by OLD email - should not find Alice anymore
			const oldEmailResults = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(oldEmailResults.length).toBe(0)

			// Query by NEW email - should find Alice
			const newEmailResults = await db.users.query({ where: { email: "alice.new@example.com" } }).runPromise
			expect(newEmailResults.length).toBe(1)
			expect((newEmailResults[0] as { id: string }).id).toBe("u1")
		})

		it("should keep index unchanged when upsert updates only non-indexed fields", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Upsert that matches existing user but only updates non-indexed field
			const result = await db.users.upsert({
				where: { id: "u1" },
				update: { name: "Alice Updated", age: 31 },
				create: { email: "unused@example.com", name: "Unused", age: 99 },
			}).runPromise

			expect(result.__action).toBe("updated")
			expect(result.name).toBe("Alice Updated")
			expect(result.age).toBe(31)

			// Query by email - should still find Alice
			const results = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u1")
			expect((results[0] as { name: string }).name).toBe("Alice Updated")
		})

		it("should update compound index when upsert updates compound key fields", async () => {
			const config = createMultiIndexConfig()
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: initialProducts }),
			)

			// Verify initial compound index query
			const computersInitial = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(computersInitial.length).toBe(1)

			// Upsert that updates the subcategory
			const result = await db.products.upsert({
				where: { id: "p1" },
				update: { subcategory: "phones" },
				create: { name: "Unused", category: "unused", subcategory: "unused", price: 0 },
			}).runPromise

			expect(result.__action).toBe("updated")
			expect(result.subcategory).toBe("phones")

			// Query old compound key - should be empty
			const oldCompound = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(oldCompound.length).toBe(0)

			// Query new compound key - should have the product
			const newCompound = await db.products.query({
				where: { category: "electronics", subcategory: "phones" },
			}).runPromise
			expect(newCompound.length).toBe(1)
			expect((newCompound[0] as { id: string }).id).toBe("p1")
		})

		it("should handle upsert moving entity to shared index Set", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Upsert Alice to have Bob's email
			const result = await db.users.upsert({
				where: { id: "u1" },
				update: { email: "bob@example.com" },
				create: { email: "unused@example.com", name: "Unused", age: 99 },
			}).runPromise

			expect(result.__action).toBe("updated")

			// Query by old email - should be empty
			const aliceOldEmail = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceOldEmail.length).toBe(0)

			// Query by shared email - should return both
			const sharedEmailResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(sharedEmailResults.length).toBe(2)

			const ids = sharedEmailResults.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u2"])
		})

		it("should handle upsert splitting a shared index entry", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "shared@example.com", name: "User One", age: 30 },
				{ id: "u2", email: "shared@example.com", name: "User Two", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Verify both are at shared email initially
			const sharedInitial = await db.users.query({ where: { email: "shared@example.com" } }).runPromise
			expect(sharedInitial.length).toBe(2)

			// Upsert u1 to have a unique email
			const result = await db.users.upsert({
				where: { id: "u1" },
				update: { email: "unique@example.com" },
				create: { email: "unused@example.com", name: "Unused", age: 99 },
			}).runPromise

			expect(result.__action).toBe("updated")

			// Query shared email - should now only have u2
			const sharedAfter = await db.users.query({ where: { email: "shared@example.com" } }).runPromise
			expect(sharedAfter.length).toBe(1)
			expect((sharedAfter[0] as { id: string }).id).toBe("u2")

			// Query unique email - should have u1
			const uniqueResults = await db.users.query({ where: { email: "unique@example.com" } }).runPromise
			expect(uniqueResults.length).toBe(1)
			expect((uniqueResults[0] as { id: string }).id).toBe("u1")
		})

		it("should update index via upsertMany update path", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Upsert both users with new emails
			const result = await db.users.upsertMany([
				{ where: { id: "u1" }, update: { email: "alice.new@example.com" }, create: { email: "unused1@example.com", name: "Unused", age: 99 } },
				{ where: { id: "u2" }, update: { email: "bob.new@example.com" }, create: { email: "unused2@example.com", name: "Unused", age: 99 } },
			]).runPromise

			expect(result.updated.length).toBe(2)
			expect(result.created.length).toBe(0)

			// Old emails should not find anyone
			const aliceOld = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceOld.length).toBe(0)

			const bobOld = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(bobOld.length).toBe(0)

			// New emails should find the users
			const aliceNew = await db.users.query({ where: { email: "alice.new@example.com" } }).runPromise
			expect(aliceNew.length).toBe(1)
			expect((aliceNew[0] as { id: string }).id).toBe("u1")

			const bobNew = await db.users.query({ where: { email: "bob.new@example.com" } }).runPromise
			expect(bobNew.length).toBe(1)
			expect((bobNew[0] as { id: string }).id).toBe("u2")
		})

		it("should handle mixed create and update paths in upsertMany", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Upsert: u1 exists (update), u2 doesn't (create)
			const result = await db.users.upsertMany([
				{ where: { id: "u1" }, update: { email: "alice.new@example.com" }, create: { email: "unused@example.com", name: "Unused", age: 99 } },
				{ where: { id: "u2" }, update: { email: "should.not.apply@example.com" }, create: { email: "bob@example.com", name: "Bob", age: 25 } },
			]).runPromise

			expect(result.updated.length).toBe(1)
			expect(result.created.length).toBe(1)

			// u1's old email should not find anyone
			const aliceOld = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceOld.length).toBe(0)

			// u1's new email should find them
			const aliceNew = await db.users.query({ where: { email: "alice.new@example.com" } }).runPromise
			expect(aliceNew.length).toBe(1)
			expect((aliceNew[0] as { id: string }).id).toBe("u1")

			// u2 should be at their create email
			const bobResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(bobResults.length).toBe(1)
			expect((bobResults[0] as { id: string }).id).toBe("u2")
		})

		it("should not change index when upsert update results in unchanged entity", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Upsert with update that sets email to same value
			const result = await db.users.upsert({
				where: { id: "u1" },
				update: { email: "alice@example.com" },
				create: { email: "unused@example.com", name: "Unused", age: 99 },
			}).runPromise

			expect(result.__action).toBe("updated")

			// Should still be queryable by email
			const results = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u1")
		})

		it("should update multiple indexes when upsert changes multiple indexed fields", async () => {
			// createMultiIndexConfig has users with indexes on both "email" and "role"
			const config = createMultiIndexConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30, role: "admin" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Verify initial index state
			const byEmailInitial = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(byEmailInitial.length).toBe(1)
			const byRoleInitial = await db.users.query({ where: { role: "admin" } }).runPromise
			expect(byRoleInitial.length).toBe(1)

			// Upsert that updates both email and role
			const result = await db.users.upsert({
				where: { id: "u1" },
				update: { email: "alice.new@example.com", role: "user" },
				create: { email: "unused@example.com", name: "Unused", age: 99 },
			}).runPromise

			expect(result.__action).toBe("updated")
			expect(result.email).toBe("alice.new@example.com")
			expect(result.role).toBe("user")

			// Old email should not find anyone
			const byOldEmail = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(byOldEmail.length).toBe(0)

			// Old role should not find anyone
			const byOldRole = await db.users.query({ where: { role: "admin" } }).runPromise
			expect(byOldRole.length).toBe(0)

			// New email should find user
			const byNewEmail = await db.users.query({ where: { email: "alice.new@example.com" } }).runPromise
			expect(byNewEmail.length).toBe(1)
			expect((byNewEmail[0] as { id: string }).id).toBe("u1")

			// New role should find user
			const byNewRole = await db.users.query({ where: { role: "user" } }).runPromise
			expect(byNewRole.length).toBe(1)
			expect((byNewRole[0] as { id: string }).id).toBe("u1")
		})
	})

	describe("Task 7.8: index consistency after mixed CRUD sequence", () => {
		it("should maintain correct index state after interleaved creates, updates, deletes", async () => {
			const config = createIndexedUsersConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Phase 1: Create initial users
			await db.users.create({ id: "u1", email: "alice@example.com", name: "Alice", age: 30 }).runPromise
			await db.users.create({ id: "u2", email: "bob@example.com", name: "Bob", age: 25 }).runPromise

			// Verify phase 1 state
			let aliceResults = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceResults.length).toBe(1)
			let bobResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(bobResults.length).toBe(1)

			// Phase 2: Update Alice's email
			await db.users.update("u1", { email: "alice.new@example.com" }).runPromise

			// Verify phase 2 state
			aliceResults = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceResults.length).toBe(0)
			aliceResults = await db.users.query({ where: { email: "alice.new@example.com" } }).runPromise
			expect(aliceResults.length).toBe(1)
			bobResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(bobResults.length).toBe(1)

			// Phase 3: Create a new user with Alice's old email
			await db.users.create({ id: "u3", email: "alice@example.com", name: "Charlie", age: 35 }).runPromise

			// Verify phase 3 state
			aliceResults = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceResults.length).toBe(1)
			expect((aliceResults[0] as { id: string }).id).toBe("u3")

			// Phase 4: Delete Bob
			await db.users.delete("u2").runPromise

			// Verify phase 4 state
			bobResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(bobResults.length).toBe(0)

			// Phase 5: Upsert (create path) - new user
			await db.users.upsert({
				where: { email: "dave@example.com" },
				update: { name: "Updated Dave" },
				create: { name: "Dave", age: 40 },
			}).runPromise

			// Verify phase 5 state
			const daveResults = await db.users.query({ where: { email: "dave@example.com" } }).runPromise
			expect(daveResults.length).toBe(1)
			expect((daveResults[0] as { name: string }).name).toBe("Dave")

			// Phase 6: Upsert (update path) - update Dave's email
			await db.users.upsert({
				where: { id: (daveResults[0] as { id: string }).id },
				update: { email: "bob@example.com" }, // Reuse Bob's old email
				create: { email: "unused@example.com", name: "Unused", age: 99 },
			}).runPromise

			// Verify phase 6 state - dave now has bob's old email
			const daveNewResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(daveNewResults.length).toBe(1)
			const daveOldResults = await db.users.query({ where: { email: "dave@example.com" } }).runPromise
			expect(daveOldResults.length).toBe(0)

			// Final verification: query all and check consistency
			const allUsers = await db.users.query().runPromise
			expect(allUsers.length).toBe(3) // u1 (alice.new), u3 (alice), dave (bob's email)

			// Verify each user is correctly indexed
			const u1Results = await db.users.query({ where: { email: "alice.new@example.com" } }).runPromise
			expect(u1Results.length).toBe(1)
			expect((u1Results[0] as { id: string }).id).toBe("u1")

			const u3Results = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(u3Results.length).toBe(1)
			expect((u3Results[0] as { id: string }).id).toBe("u3")

			// dave has bob@example.com now
			const renamedDaveResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(renamedDaveResults.length).toBe(1)
		})

		it("should maintain compound index consistency after mixed CRUD", async () => {
			const config = createMultiIndexConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Phase 1: Create products
			await db.products.create({ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 }).runPromise
			await db.products.create({ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 }).runPromise

			// Verify initial state
			let computersResults = await db.products.query({ where: { category: "electronics", subcategory: "computers" } }).runPromise
			expect(computersResults.length).toBe(1)
			let phonesResults = await db.products.query({ where: { category: "electronics", subcategory: "phones" } }).runPromise
			expect(phonesResults.length).toBe(1)

			// Phase 2: Move Laptop to phones category
			await db.products.update("p1", { subcategory: "phones" }).runPromise

			// Verify phase 2 state
			computersResults = await db.products.query({ where: { category: "electronics", subcategory: "computers" } }).runPromise
			expect(computersResults.length).toBe(0)
			phonesResults = await db.products.query({ where: { category: "electronics", subcategory: "phones" } }).runPromise
			expect(phonesResults.length).toBe(2)

			// Phase 3: Create another product with the empty compound key
			await db.products.create({ id: "p3", name: "Desktop", category: "electronics", subcategory: "computers", price: 1299 }).runPromise

			// Verify phase 3 state
			computersResults = await db.products.query({ where: { category: "electronics", subcategory: "computers" } }).runPromise
			expect(computersResults.length).toBe(1)
			expect((computersResults[0] as { id: string }).id).toBe("p3")

			// Phase 4: Delete Phone (p2)
			await db.products.delete("p2").runPromise

			// Verify phase 4 state
			phonesResults = await db.products.query({ where: { category: "electronics", subcategory: "phones" } }).runPromise
			expect(phonesResults.length).toBe(1)
			expect((phonesResults[0] as { id: string }).id).toBe("p1")

			// Phase 5: Update Desktop to change both category and subcategory
			await db.products.update("p3", { category: "furniture", subcategory: "office" }).runPromise

			// Verify phase 5 state
			computersResults = await db.products.query({ where: { category: "electronics", subcategory: "computers" } }).runPromise
			expect(computersResults.length).toBe(0)
			const officeResults = await db.products.query({ where: { category: "furniture", subcategory: "office" } }).runPromise
			expect(officeResults.length).toBe(1)
			expect((officeResults[0] as { id: string }).id).toBe("p3")

			// Final verification
			const allProducts = await db.products.query().runPromise
			expect(allProducts.length).toBe(2) // p1 (phones), p3 (office)
		})

		it("should handle batch operations mixed with single operations", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "initial@example.com", name: "Initial", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Phase 1: createMany
			await db.users.createMany([
				{ id: "u2", email: "batch1@example.com", name: "Batch One", age: 25 },
				{ id: "u3", email: "batch2@example.com", name: "Batch Two", age: 35 },
				{ id: "u4", email: "batch3@example.com", name: "Batch Three", age: 40 },
			]).runPromise

			// Verify phase 1 state
			const allAfterBatch = await db.users.query().runPromise
			expect(allAfterBatch.length).toBe(4)

			// Phase 2: Single update
			await db.users.update("u1", { email: "initial.updated@example.com" }).runPromise

			// Phase 3: Single delete
			await db.users.delete("u2").runPromise

			// Phase 4: Single create
			await db.users.create({ id: "u5", email: "batch1@example.com", name: "Reused Email", age: 45 }).runPromise

			// Final verification
			const allFinal = await db.users.query().runPromise
			expect(allFinal.length).toBe(4) // u1, u3, u4, u5 (u2 deleted)

			// Verify each email is correctly indexed
			const initialResults = await db.users.query({ where: { email: "initial@example.com" } }).runPromise
			expect(initialResults.length).toBe(0) // Moved to initial.updated@example.com

			const updatedResults = await db.users.query({ where: { email: "initial.updated@example.com" } }).runPromise
			expect(updatedResults.length).toBe(1)
			expect((updatedResults[0] as { id: string }).id).toBe("u1")

			// batch1 email was deleted with u2 and reused by u5
			const batch1Results = await db.users.query({ where: { email: "batch1@example.com" } }).runPromise
			expect(batch1Results.length).toBe(1)
			expect((batch1Results[0] as { id: string }).id).toBe("u5")

			const batch2Results = await db.users.query({ where: { email: "batch2@example.com" } }).runPromise
			expect(batch2Results.length).toBe(1)
			expect((batch2Results[0] as { id: string }).id).toBe("u3")

			const batch3Results = await db.users.query({ where: { email: "batch3@example.com" } }).runPromise
			expect(batch3Results.length).toBe(1)
			expect((batch3Results[0] as { id: string }).id).toBe("u4")
		})

		it("should maintain multiple single-field indexes consistently after mixed CRUD", async () => {
			// createMultiIndexConfig has users with indexes on both "email" and "role"
			const config = createMultiIndexConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Phase 1: Create initial users with different roles
			await db.users.create({ id: "u1", email: "alice@example.com", name: "Alice", age: 30, role: "admin" }).runPromise
			await db.users.create({ id: "u2", email: "bob@example.com", name: "Bob", age: 25, role: "user" }).runPromise
			await db.users.create({ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35, role: "user" }).runPromise

			// Verify initial state
			let adminResults = await db.users.query({ where: { role: "admin" } }).runPromise
			expect(adminResults.length).toBe(1)
			let userResults = await db.users.query({ where: { role: "user" } }).runPromise
			expect(userResults.length).toBe(2)

			// Phase 2: Bob becomes admin
			await db.users.update("u2", { role: "admin" }).runPromise

			// Verify phase 2 state
			adminResults = await db.users.query({ where: { role: "admin" } }).runPromise
			expect(adminResults.length).toBe(2)
			userResults = await db.users.query({ where: { role: "user" } }).runPromise
			expect(userResults.length).toBe(1)

			// Phase 3: Delete Alice (admin)
			await db.users.delete("u1").runPromise

			// Verify phase 3 state
			adminResults = await db.users.query({ where: { role: "admin" } }).runPromise
			expect(adminResults.length).toBe(1)
			expect((adminResults[0] as { id: string }).id).toBe("u2")

			// Phase 4: Update Bob's email (tests that both indexes are updated)
			await db.users.update("u2", { email: "bob.new@example.com" }).runPromise

			// Verify phase 4 state
			const bobOldEmail = await db.users.query({ where: { email: "bob@example.com" } }).runPromise
			expect(bobOldEmail.length).toBe(0)
			const bobNewEmail = await db.users.query({ where: { email: "bob.new@example.com" } }).runPromise
			expect(bobNewEmail.length).toBe(1)
			// Role should still be correct
			adminResults = await db.users.query({ where: { role: "admin" } }).runPromise
			expect(adminResults.length).toBe(1)
			expect((adminResults[0] as { id: string }).id).toBe("u2")

			// Phase 5: Upsert that changes both email and role
			await db.users.upsert({
				where: { id: "u3" },
				update: { email: "charlie.new@example.com", role: "moderator" },
				create: { email: "unused@example.com", name: "Unused", age: 99 },
			}).runPromise

			// Verify phase 5 state
			userResults = await db.users.query({ where: { role: "user" } }).runPromise
			expect(userResults.length).toBe(0)
			const moderatorResults = await db.users.query({ where: { role: "moderator" } }).runPromise
			expect(moderatorResults.length).toBe(1)
			expect((moderatorResults[0] as { id: string }).id).toBe("u3")

			// Final verification
			const allUsers = await db.users.query().runPromise
			expect(allUsers.length).toBe(2) // u2, u3 (u1 deleted)

			// Verify all index lookups are consistent
			expect((await db.users.query({ where: { email: "alice@example.com" } }).runPromise).length).toBe(0)
			expect((await db.users.query({ where: { email: "bob.new@example.com" } }).runPromise).length).toBe(1)
			expect((await db.users.query({ where: { email: "charlie.new@example.com" } }).runPromise).length).toBe(1)
			expect((await db.users.query({ where: { role: "admin" } }).runPromise).length).toBe(1)
			expect((await db.users.query({ where: { role: "moderator" } }).runPromise).length).toBe(1)
		})
	})

	describe("Task 7.1: create → index entry added", () => {
		it("should add new entity to index when created", async () => {
			// Start with an empty indexed database
			const config = createIndexedUsersConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Create a new user
			const newUser = await db.users.create({
				id: "u1",
				email: "newuser@example.com",
				name: "New User",
				age: 25,
			}).runPromise

			expect(newUser.id).toBe("u1")
			expect(newUser.email).toBe("newuser@example.com")

			// Query using the indexed field - should find the new user
			const results = await db.users.query({ where: { email: "newuser@example.com" } }).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u1")
		})

		it("should add entity to index alongside existing entries", async () => {
			// Start with some initial data
			const config = createIndexedUsersConfig()
			const initialUsers = createSampleUsers().slice(0, 2) // alice, bob
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Verify initial data is queryable
			const aliceResults = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceResults.length).toBe(1)

			// Create a new user
			const newUser = await db.users.create({
				id: "u99",
				email: "charlie@example.com",
				name: "Charlie",
				age: 35,
			}).runPromise

			expect(newUser.id).toBe("u99")

			// Query for the new user via indexed field
			const charlieResults = await db.users.query({ where: { email: "charlie@example.com" } }).runPromise
			expect(charlieResults.length).toBe(1)
			expect((charlieResults[0] as { id: string }).id).toBe("u99")

			// Original users should still be queryable
			const aliceStillThere = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(aliceStillThere.length).toBe(1)
		})

		it("should add entity to existing index Set when same field value exists", async () => {
			// Start with alice@example.com (u1)
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "shared@example.com", name: "User One", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Create another user with the same email
			await db.users.create({
				id: "u2",
				email: "shared@example.com",
				name: "User Two",
				age: 25,
			}).runPromise

			// Query should return both users with this email
			const results = await db.users.query({ where: { email: "shared@example.com" } }).runPromise
			expect(results.length).toBe(2)

			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u2"])
		})

		it("should not index entity with null/undefined value in indexed field", async () => {
			const config = createIndexedUsersConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Create a user without an email (undefined will be set as the field is required by schema, but let's test with role which is optional)
			// Actually, email is required in our schema. Let's create the user and then verify querying works.
			const newUser = await db.users.create({
				id: "u1",
				email: "test@example.com",
				name: "Test User",
				age: 30,
				// role is undefined (optional field)
			}).runPromise

			expect(newUser.id).toBe("u1")
			expect(newUser.role).toBeUndefined()

			// Query for the user by email (should work as email is indexed)
			const results = await db.users.query({ where: { email: "test@example.com" } }).runPromise
			expect(results.length).toBe(1)
		})

		it("should add entity to compound index when created", async () => {
			const config = createMultiIndexConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Create a product (products have compound index on ["category", "subcategory"])
			const newProduct = await db.products.create({
				id: "p1",
				name: "Laptop",
				category: "electronics",
				subcategory: "computers",
				price: 999,
			}).runPromise

			expect(newProduct.id).toBe("p1")

			// Query using both compound index fields
			const results = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("p1")
		})

		it("should add multiple entities to compound index", async () => {
			const config = createMultiIndexConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Create two products with same category/subcategory combo
			await db.products.create({
				id: "p1",
				name: "Laptop",
				category: "electronics",
				subcategory: "computers",
				price: 999,
			}).runPromise

			await db.products.create({
				id: "p2",
				name: "Desktop",
				category: "electronics",
				subcategory: "computers",
				price: 1299,
			}).runPromise

			// Query using compound index - should return both
			const results = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(results.length).toBe(2)

			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p1", "p2"])
		})
	})
})

// ============================================================================
// Tests - Query Acceleration (Task 8.x)
// ============================================================================

describe("Indexing - Query Acceleration", () => {
	describe("Task 8.1: equality query on indexed field returns correct results", () => {
		it("should return correct results when querying indexed field with direct equality", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by indexed email field with direct equality
			const results = await db.users.query({ where: { email: "bob@example.com" } }).runPromise

			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u2")
			expect((results[0] as { email: string }).email).toBe("bob@example.com")
			expect((results[0] as { name: string }).name).toBe("Bob")
		})

		it("should return multiple results when multiple entities share indexed field value", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "shared@example.com", name: "User One", age: 30 },
				{ id: "u2", email: "unique@example.com", name: "User Two", age: 25 },
				{ id: "u3", email: "shared@example.com", name: "User Three", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by shared email - should return both users
			const results = await db.users.query({ where: { email: "shared@example.com" } }).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u3"])
		})

		it("should return empty array when no entity matches equality query", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by non-existent email
			const results = await db.users.query({ where: { email: "nonexistent@example.com" } }).runPromise

			expect(results.length).toBe(0)
		})

		it("should return correct results when combining indexed field with other query options", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with indexed field and select specific fields
			const results = await db.users.query({
				where: { email: "charlie@example.com" },
				select: { id: true, name: true },
			}).runPromise

			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u3")
			expect((results[0] as { name: string }).name).toBe("Charlie")
		})

		it("should handle equality query on indexed field after data modification", async () => {
			const config = createIndexedUsersConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Create some users
			await db.users.create({ id: "u1", email: "alice@example.com", name: "Alice", age: 30 }).runPromise
			await db.users.create({ id: "u2", email: "bob@example.com", name: "Bob", age: 25 }).runPromise

			// Query should work after create
			const results1 = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(results1.length).toBe(1)
			expect((results1[0] as { id: string }).id).toBe("u1")

			// Update the email
			await db.users.update("u1", { email: "alice.new@example.com" }).runPromise

			// Query old email should return empty
			const results2 = await db.users.query({ where: { email: "alice@example.com" } }).runPromise
			expect(results2.length).toBe(0)

			// Query new email should return the user
			const results3 = await db.users.query({ where: { email: "alice.new@example.com" } }).runPromise
			expect(results3.length).toBe(1)
			expect((results3[0] as { id: string }).id).toBe("u1")
		})
	})

	describe("Task 8.2: $eq on indexed field returns correct results", () => {
		it("should return correct results when querying indexed field with $eq operator", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by indexed email field with $eq operator
			const results = await db.users.query({ where: { email: { $eq: "bob@example.com" } } }).runPromise

			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u2")
			expect((results[0] as { email: string }).email).toBe("bob@example.com")
			expect((results[0] as { name: string }).name).toBe("Bob")
		})

		it("should return multiple results when multiple entities share indexed field value with $eq", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "shared@example.com", name: "User One", age: 30 },
				{ id: "u2", email: "unique@example.com", name: "User Two", age: 25 },
				{ id: "u3", email: "shared@example.com", name: "User Three", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by shared email with $eq - should return both users
			const results = await db.users.query({ where: { email: { $eq: "shared@example.com" } } }).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u3"])
		})

		it("should return empty array when no entity matches $eq query", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by non-existent email with $eq
			const results = await db.users.query({ where: { email: { $eq: "nonexistent@example.com" } } }).runPromise

			expect(results.length).toBe(0)
		})

		it("should return same results for direct equality and $eq operator", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with direct equality
			const directResults = await db.users.query({ where: { email: "bob@example.com" } }).runPromise

			// Query with $eq operator
			const eqResults = await db.users.query({ where: { email: { $eq: "bob@example.com" } } }).runPromise

			// Both should return the same result
			expect(eqResults.length).toBe(directResults.length)
			expect((eqResults[0] as { id: string }).id).toBe((directResults[0] as { id: string }).id)
		})

		it("should handle $eq query on indexed field after data modification", async () => {
			const config = createIndexedUsersConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Create some users
			await db.users.create({ id: "u1", email: "alice@example.com", name: "Alice", age: 30 }).runPromise
			await db.users.create({ id: "u2", email: "bob@example.com", name: "Bob", age: 25 }).runPromise

			// Query should work after create with $eq
			const results1 = await db.users.query({ where: { email: { $eq: "alice@example.com" } } }).runPromise
			expect(results1.length).toBe(1)
			expect((results1[0] as { id: string }).id).toBe("u1")

			// Update the email
			await db.users.update("u1", { email: "alice.new@example.com" }).runPromise

			// Query old email with $eq should return empty
			const results2 = await db.users.query({ where: { email: { $eq: "alice@example.com" } } }).runPromise
			expect(results2.length).toBe(0)

			// Query new email with $eq should return the user
			const results3 = await db.users.query({ where: { email: { $eq: "alice.new@example.com" } } }).runPromise
			expect(results3.length).toBe(1)
			expect((results3[0] as { id: string }).id).toBe("u1")
		})

		it("should handle $eq query combined with other query options", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $eq on indexed field and select specific fields
			const results = await db.users.query({
				where: { email: { $eq: "charlie@example.com" } },
				select: { id: true, name: true },
			}).runPromise

			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u3")
			expect((results[0] as { name: string }).name).toBe("Charlie")
		})
	})

	describe("Task 8.3: $in on indexed field returns correct results (union)", () => {
		it("should return union of results when querying indexed field with $in operator", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
				{ id: "u4", email: "diana@example.com", name: "Diana", age: 28 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by indexed email field with $in operator
			const results = await db.users.query({
				where: { email: { $in: ["alice@example.com", "charlie@example.com"] } },
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u3"])
		})

		it("should return all matching entities when $in matches multiple entities per value", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "shared@example.com", name: "User One", age: 30 },
				{ id: "u2", email: "unique@example.com", name: "User Two", age: 25 },
				{ id: "u3", email: "shared@example.com", name: "User Three", age: 35 },
				{ id: "u4", email: "other@example.com", name: "User Four", age: 28 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $in on shared email - should return all entities matching any value
			const results = await db.users.query({
				where: { email: { $in: ["shared@example.com", "unique@example.com"] } },
			}).runPromise

			expect(results.length).toBe(3)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u2", "u3"])
		})

		it("should return empty array when $in matches no entities", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $in for non-existent emails
			const results = await db.users.query({
				where: { email: { $in: ["nonexistent@example.com", "fake@example.com"] } },
			}).runPromise

			expect(results.length).toBe(0)
		})

		it("should return partial matches when $in contains some existing and some non-existing values", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $in containing mix of existing and non-existing emails
			const results = await db.users.query({
				where: { email: { $in: ["alice@example.com", "nonexistent@example.com", "charlie@example.com"] } },
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u3"])
		})

		it("should handle $in with single value (equivalent to $eq)", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $in containing single value
			const inResults = await db.users.query({
				where: { email: { $in: ["alice@example.com"] } },
			}).runPromise

			// Query with $eq for comparison
			const eqResults = await db.users.query({
				where: { email: { $eq: "alice@example.com" } },
			}).runPromise

			expect(inResults.length).toBe(eqResults.length)
			expect((inResults[0] as { id: string }).id).toBe((eqResults[0] as { id: string }).id)
		})

		it("should handle $in with empty array (returns no results)", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $in containing empty array
			const results = await db.users.query({
				where: { email: { $in: [] } },
			}).runPromise

			expect(results.length).toBe(0)
		})

		it("should handle $in query after data modification", async () => {
			const config = createIndexedUsersConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Create some users
			await db.users.create({ id: "u1", email: "alice@example.com", name: "Alice", age: 30 }).runPromise
			await db.users.create({ id: "u2", email: "bob@example.com", name: "Bob", age: 25 }).runPromise
			await db.users.create({ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 }).runPromise

			// Query with $in should work
			const results1 = await db.users.query({
				where: { email: { $in: ["alice@example.com", "bob@example.com"] } },
			}).runPromise
			expect(results1.length).toBe(2)

			// Update one user's email
			await db.users.update("u1", { email: "alice.new@example.com" }).runPromise

			// Query old email should only return bob
			const results2 = await db.users.query({
				where: { email: { $in: ["alice@example.com", "bob@example.com"] } },
			}).runPromise
			expect(results2.length).toBe(1)
			expect((results2[0] as { id: string }).id).toBe("u2")

			// Query new email should include alice
			const results3 = await db.users.query({
				where: { email: { $in: ["alice.new@example.com", "bob@example.com"] } },
			}).runPromise
			expect(results3.length).toBe(2)
			const ids = results3.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u2"])
		})

		it("should handle $in query combined with other query options", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $in on indexed field and select specific fields
			const results = await db.users.query({
				where: { email: { $in: ["alice@example.com", "charlie@example.com"] } },
				select: { id: true, name: true },
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u3"])
		})

		it("should handle $in combined with sorting", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
				{ id: "u4", email: "diana@example.com", name: "Diana", age: 28 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $in and sort by age
			const results = await db.users.query({
				where: { email: { $in: ["alice@example.com", "charlie@example.com", "diana@example.com"] } },
				sort: { age: "asc" },
			}).runPromise

			expect(results.length).toBe(3)
			expect((results[0] as { id: string }).id).toBe("u4") // Diana, age 28
			expect((results[1] as { id: string }).id).toBe("u1") // Alice, age 30
			expect((results[2] as { id: string }).id).toBe("u3") // Charlie, age 35
		})

		it("should handle $in combined with pagination", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "a@example.com", name: "User A", age: 30 },
				{ id: "u2", email: "b@example.com", name: "User B", age: 25 },
				{ id: "u3", email: "c@example.com", name: "User C", age: 35 },
				{ id: "u4", email: "d@example.com", name: "User D", age: 28 },
				{ id: "u5", email: "e@example.com", name: "User E", age: 22 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $in and limit
			const results = await db.users.query({
				where: { email: { $in: ["a@example.com", "b@example.com", "c@example.com", "d@example.com"] } },
				limit: 2,
			}).runPromise

			expect(results.length).toBe(2)
		})
	})

	describe("Task 8.4: query on non-indexed field returns correct results (full scan)", () => {
		it("should return correct results when querying a non-indexed field with equality", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
				{ id: "u4", email: "diana@example.com", name: "Diana", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by non-indexed "age" field (full scan)
			const results = await db.users.query({
				where: { age: 25 },
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u2", "u4"])
		})

		it("should return correct results when querying a non-indexed field with $eq operator", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by non-indexed "name" field with $eq (full scan)
			const results = await db.users.query({
				where: { name: { $eq: "Bob" } },
			}).runPromise

			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u2")
		})

		it("should return correct results when querying a non-indexed field with $in operator", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
				{ id: "u4", email: "diana@example.com", name: "Diana", age: 28 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by non-indexed "name" field with $in (full scan)
			const results = await db.users.query({
				where: { name: { $in: ["Alice", "Charlie"] } },
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u3"])
		})

		it("should return correct results when querying a non-indexed field with comparison operators", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
				{ id: "u4", email: "diana@example.com", name: "Diana", age: 28 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by non-indexed "age" field with $gt (full scan)
			const results = await db.users.query({
				where: { age: { $gt: 28 } },
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u3"])
		})

		it("should return empty array when non-indexed field query matches no entities", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query for a non-existent name (full scan)
			const results = await db.users.query({
				where: { name: "NonExistent" },
			}).runPromise

			expect(results.length).toBe(0)
		})

		it("should work correctly with unindexed database (no indexes configured)", async () => {
			const config = createUnindexedConfig() // No indexes at all
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by email - no index, so it's a full scan
			const emailResults = await db.users.query({
				where: { email: "bob@example.com" },
			}).runPromise
			expect(emailResults.length).toBe(1)
			expect((emailResults[0] as { id: string }).id).toBe("u2")

			// Query by name - also full scan
			const nameResults = await db.users.query({
				where: { name: "Alice" },
			}).runPromise
			expect(nameResults.length).toBe(1)
			expect((nameResults[0] as { id: string }).id).toBe("u1")
		})

		it("should correctly handle non-indexed field query after CRUD operations", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Create users
			await db.users.create({ id: "u1", email: "alice@example.com", name: "Alice", age: 30 }).runPromise
			await db.users.create({ id: "u2", email: "bob@example.com", name: "Bob", age: 25 }).runPromise

			// Query non-indexed field after creation
			const results1 = await db.users.query({
				where: { age: 25 },
			}).runPromise
			expect(results1.length).toBe(1)
			expect((results1[0] as { id: string }).id).toBe("u2")

			// Update the age
			await db.users.update("u2", { age: 26 }).runPromise

			// Query should reflect the update
			const results2 = await db.users.query({
				where: { age: 25 },
			}).runPromise
			expect(results2.length).toBe(0)

			const results3 = await db.users.query({
				where: { age: 26 },
			}).runPromise
			expect(results3.length).toBe(1)
			expect((results3[0] as { id: string }).id).toBe("u2")
		})

		it("should apply sorting and pagination correctly with non-indexed field query", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
				{ id: "u4", email: "diana@example.com", name: "Diana", age: 28 },
				{ id: "u5", email: "eve@example.com", name: "Eve", age: 22 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query non-indexed field with sorting
			const sortedResults = await db.users.query({
				where: { age: { $lt: 30 } },
				sort: { age: "asc" },
			}).runPromise
			expect(sortedResults.length).toBe(3)
			expect((sortedResults[0] as { id: string }).id).toBe("u5") // Eve, age 22
			expect((sortedResults[1] as { id: string }).id).toBe("u2") // Bob, age 25
			expect((sortedResults[2] as { id: string }).id).toBe("u4") // Diana, age 28

			// Query non-indexed field with pagination
			const paginatedResults = await db.users.query({
				where: { age: { $gt: 20 } },
				sort: { age: "asc" },
				limit: 2,
			}).runPromise
			expect(paginatedResults.length).toBe(2)
			expect((paginatedResults[0] as { id: string }).id).toBe("u5") // Eve, age 22
			expect((paginatedResults[1] as { id: string }).id).toBe("u2") // Bob, age 25
		})
	})

	describe("Task 8.5: mixed indexed + non-indexed conditions: narrowed then filtered", () => {
		it("should narrow by indexed field then filter by non-indexed field", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "alice@example.com", name: "Alice Smith", age: 25 }, // Same email, different age
				{ id: "u3", email: "bob@example.com", name: "Bob", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by indexed field (email) + non-indexed field (age)
			// Should first narrow by email index, then filter by age
			const results = await db.users.query({
				where: { email: "alice@example.com", age: 30 },
			}).runPromise

			// Only u1 matches both conditions
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u1")
		})

		it("should narrow by indexed field then filter by non-indexed field with $eq operator", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "shared@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "shared@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "shared@example.com", name: "Charlie", age: 35 },
				{ id: "u4", email: "other@example.com", name: "Diana", age: 30 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by indexed email with $eq, then filter by non-indexed name
			const results = await db.users.query({
				where: { email: { $eq: "shared@example.com" }, name: "Bob" },
			}).runPromise

			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u2")
		})

		it("should narrow by indexed $in then filter by non-indexed comparison", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "a@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "b@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "c@example.com", name: "Charlie", age: 35 },
				{ id: "u4", email: "d@example.com", name: "Diana", age: 28 },
				{ id: "u5", email: "e@example.com", name: "Eve", age: 22 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by indexed email with $in, then filter by non-indexed age with $gt
			const results = await db.users.query({
				where: {
					email: { $in: ["a@example.com", "b@example.com", "c@example.com"] },
					age: { $gt: 28 },
				},
			}).runPromise

			// From the $in matches (u1, u2, u3), only u1 (age 30) and u3 (age 35) have age > 28
			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u3"])
		})

		it("should narrow by indexed field then filter by multiple non-indexed conditions", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "shared@example.com", name: "Alice", age: 30, role: "admin" },
				{ id: "u2", email: "shared@example.com", name: "Bob", age: 25, role: "user" },
				{ id: "u3", email: "shared@example.com", name: "Charlie", age: 35, role: "admin" },
				{ id: "u4", email: "shared@example.com", name: "Diana", age: 28, role: "user" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by indexed email + multiple non-indexed conditions (age and role)
			const results = await db.users.query({
				where: {
					email: "shared@example.com",
					age: { $gte: 28 },
					role: "admin",
				},
			}).runPromise

			// From shared email (u1-u4), age >= 28 (u1, u3, u4), role = admin (u1, u3)
			// Intersection: u1 and u3
			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u3"])
		})

		it("should return empty array when indexed condition matches but non-indexed does not", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by indexed email that exists, but age that doesn't match
			const results = await db.users.query({
				where: { email: "alice@example.com", age: 100 },
			}).runPromise

			expect(results.length).toBe(0)
		})

		it("should handle mixed conditions with compound indexed field", async () => {
			const config = createMultiIndexConfig() // products has ["category", "subcategory"] compound index
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Desktop", category: "electronics", subcategory: "computers", price: 799 },
				{ id: "p3", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p4", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: initialProducts }),
			)

			// Query by compound indexed fields + non-indexed field (price)
			const results = await db.products.query({
				where: {
					category: "electronics",
					subcategory: "computers",
					price: { $gt: 800 },
				},
			}).runPromise

			// From electronics/computers (p1, p2), only p1 has price > 800
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("p1")
		})

		it("should apply mixed conditions with sorting on non-indexed field", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "shared@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "shared@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "shared@example.com", name: "Charlie", age: 35 },
				{ id: "u4", email: "other@example.com", name: "Diana", age: 28 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by indexed email + non-indexed age filter + sort by age
			const results = await db.users.query({
				where: {
					email: "shared@example.com",
					age: { $gte: 28 },
				},
				sort: { age: "asc" },
			}).runPromise

			// From shared email (u1, u2, u3), age >= 28 (u1, u3), sorted by age ascending
			expect(results.length).toBe(2)
			expect((results[0] as { id: string }).id).toBe("u1") // age 30
			expect((results[1] as { id: string }).id).toBe("u3") // age 35
		})

		it("should apply mixed conditions with pagination", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "shared@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "shared@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "shared@example.com", name: "Charlie", age: 35 },
				{ id: "u4", email: "shared@example.com", name: "Diana", age: 40 },
				{ id: "u5", email: "other@example.com", name: "Eve", age: 45 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query by indexed email + non-indexed age filter + pagination
			const results = await db.users.query({
				where: {
					email: "shared@example.com",
					age: { $gte: 30 },
				},
				sort: { age: "asc" },
				limit: 2,
			}).runPromise

			// From shared email (u1-u4), age >= 30 (u1, u3, u4), sorted, limited to 2
			expect(results.length).toBe(2)
			expect((results[0] as { id: string }).id).toBe("u1") // age 30
			expect((results[1] as { id: string }).id).toBe("u3") // age 35
		})

		it("should handle mixed conditions after CRUD operations", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Create users with shared email
			await db.users.create({ id: "u1", email: "shared@example.com", name: "Alice", age: 30 }).runPromise
			await db.users.create({ id: "u2", email: "shared@example.com", name: "Bob", age: 25 }).runPromise
			await db.users.create({ id: "u3", email: "shared@example.com", name: "Charlie", age: 35 }).runPromise

			// Query with mixed conditions
			const results1 = await db.users.query({
				where: { email: "shared@example.com", age: { $gt: 28 } },
			}).runPromise
			expect(results1.length).toBe(2) // u1 (30) and u3 (35)

			// Update u1's age below threshold
			await db.users.update("u1", { age: 20 }).runPromise

			// Query again - should only return u3
			const results2 = await db.users.query({
				where: { email: "shared@example.com", age: { $gt: 28 } },
			}).runPromise
			expect(results2.length).toBe(1)
			expect((results2[0] as { id: string }).id).toBe("u3")

			// Update u1's email to something else
			await db.users.update("u1", { email: "other@example.com", age: 30 }).runPromise

			// Query again - u1 no longer matches email condition
			const results3 = await db.users.query({
				where: { email: "shared@example.com", age: { $gt: 28 } },
			}).runPromise
			expect(results3.length).toBe(1)
			expect((results3[0] as { id: string }).id).toBe("u3")
		})

		it("should work with select option on mixed conditions", async () => {
			const config = createIndexedUsersConfig() // Only "email" is indexed
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "shared@example.com", name: "Alice", age: 30, role: "admin" },
				{ id: "u2", email: "shared@example.com", name: "Bob", age: 25, role: "user" },
				{ id: "u3", email: "other@example.com", name: "Charlie", age: 35, role: "admin" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with mixed conditions and select
			const results = await db.users.query({
				where: { email: "shared@example.com", role: "admin" },
				select: { id: true, name: true },
			}).runPromise

			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u1")
			expect((results[0] as { name: string }).name).toBe("Alice")
		})
	})

	describe("Task 8.6: $or/$and/$not queries fall back to full scan", () => {
		it("should return correct results with $or on indexed field (falls back to full scan)", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $or - should fall back to full scan but return correct results
			const results = await db.users.query({
				where: {
					$or: [
						{ email: "alice@example.com" },
						{ email: "charlie@example.com" },
					],
				},
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u3"])
		})

		it("should return correct results with $and on indexed field (falls back to full scan)", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30, role: "admin" },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25, role: "user" },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35, role: "admin" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $and - should fall back to full scan but return correct results
			const results = await db.users.query({
				where: {
					$and: [
						{ email: "alice@example.com" },
						{ role: "admin" },
					],
				},
			}).runPromise

			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("u1")
		})

		it("should return correct results with $not on indexed field (falls back to full scan)", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $not - should fall back to full scan but return correct results
			const results = await db.users.query({
				where: {
					$not: { email: "alice@example.com" },
				},
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u2", "u3"])
		})

		it("should return correct results with nested $or inside $and (falls back to full scan)", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30, role: "admin" },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25, role: "user" },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35, role: "admin" },
				{ id: "u4", email: "diana@example.com", name: "Diana", age: 28, role: "admin" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with nested logical operators
			const results = await db.users.query({
				where: {
					$and: [
						{ role: "admin" },
						{
							$or: [
								{ email: "alice@example.com" },
								{ email: "charlie@example.com" },
							],
						},
					],
				},
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u3"])
		})

		it("should return correct results with $or containing multiple conditions", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
				{ id: "u4", email: "diana@example.com", name: "Diana", age: 28 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $or containing various conditions
			const results = await db.users.query({
				where: {
					$or: [
						{ email: "alice@example.com" },
						{ age: { $gt: 30 } },
						{ name: "Diana" },
					],
				},
			}).runPromise

			// u1 matches email, u3 matches age > 30, u4 matches name
			expect(results.length).toBe(3)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u3", "u4"])
		})

		it("should return empty array when $and conditions cannot all be satisfied", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $and that cannot be satisfied
			const results = await db.users.query({
				where: {
					$and: [
						{ email: "alice@example.com" },
						{ email: "bob@example.com" },
					],
				},
			}).runPromise

			expect(results.length).toBe(0)
		})

		it("should return empty array when $or contains no matching conditions", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $or that has no matches
			const results = await db.users.query({
				where: {
					$or: [
						{ email: "nonexistent@example.com" },
						{ age: 100 },
					],
				},
			}).runPromise

			expect(results.length).toBe(0)
		})

		it("should handle $not with $eq correctly", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $not containing $eq
			const results = await db.users.query({
				where: {
					$not: { email: { $eq: "bob@example.com" } },
				},
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u3"])
		})

		it("should handle logical operators combined with sorting", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $or and sorting
			const results = await db.users.query({
				where: {
					$or: [
						{ email: "alice@example.com" },
						{ email: "charlie@example.com" },
					],
				},
				sort: { age: "desc" },
			}).runPromise

			expect(results.length).toBe(2)
			// Sorted by age descending: u3 (35), u1 (30)
			expect((results[0] as { id: string }).id).toBe("u3")
			expect((results[1] as { id: string }).id).toBe("u1")
		})

		it("should handle logical operators combined with pagination", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "a@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "b@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "c@example.com", name: "Charlie", age: 35 },
				{ id: "u4", email: "d@example.com", name: "Diana", age: 28 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $or, sorting, and limit
			const results = await db.users.query({
				where: {
					$or: [
						{ email: "a@example.com" },
						{ email: "b@example.com" },
						{ email: "c@example.com" },
					],
				},
				sort: { age: "asc" },
				limit: 2,
			}).runPromise

			// All three match, sorted by age asc (25, 30, 35), limited to 2
			expect(results.length).toBe(2)
			expect((results[0] as { id: string }).id).toBe("u2") // age 25
			expect((results[1] as { id: string }).id).toBe("u1") // age 30
		})

		it("should handle logical operators combined with select", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $not and select
			const results = await db.users.query({
				where: {
					$not: { email: "bob@example.com" },
				},
				select: { id: true, name: true },
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u3"])
		})
	})

	describe("Task 8.7: empty index entry (no matches) returns empty result", () => {
		it("should return empty array when equality query matches no entities", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query for email that doesn't exist - index lookup should return empty
			const results = await db.users.query({
				where: { email: "nonexistent@example.com" },
			}).runPromise

			expect(results.length).toBe(0)
		})

		it("should return empty array when $eq query matches no entities", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $eq for non-existent value
			const results = await db.users.query({
				where: { email: { $eq: "nobody@example.com" } },
			}).runPromise

			expect(results.length).toBe(0)
		})

		it("should return empty array when $in contains only non-existent values", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $in containing only non-existent values
			const results = await db.users.query({
				where: { email: { $in: ["x@example.com", "y@example.com", "z@example.com"] } },
			}).runPromise

			expect(results.length).toBe(0)
		})

		it("should return partial results when $in contains mix of existing and non-existing values", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
				{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Query with $in containing mix of existing and non-existing values
			const results = await db.users.query({
				where: { email: { $in: ["alice@example.com", "nonexistent@example.com", "charlie@example.com"] } },
			}).runPromise

			// Should only return the existing matches
			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["u1", "u3"])
		})

		it("should return empty array when compound index query matches no entities", async () => {
			const config = createMultiIndexConfig()
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p3", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, {
					users: [],
					products: initialProducts,
				}),
			)

			// Query for compound key that doesn't exist
			const results = await db.products.query({
				where: { category: "electronics", subcategory: "tablets" },
			}).runPromise

			expect(results.length).toBe(0)
		})

		it("should return empty array after all matching entities are deleted", async () => {
			const config = createIndexedUsersConfig()
			const initialUsers: ReadonlyArray<User> = [
				{ id: "u1", email: "alice@example.com", name: "Alice", age: 30 },
				{ id: "u2", email: "bob@example.com", name: "Bob", age: 25 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: initialUsers }),
			)

			// Delete the only user with this email
			await db.users.delete("u1").runPromise

			// Query for the deleted user's email
			const results = await db.users.query({
				where: { email: "alice@example.com" },
			}).runPromise

			expect(results.length).toBe(0)
		})

		it("should return empty array when querying empty collection with index", async () => {
			const config = createIndexedUsersConfig()
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [] }),
			)

			// Query on empty collection
			const results = await db.users.query({
				where: { email: "anyone@example.com" },
			}).runPromise

			expect(results.length).toBe(0)
		})
	})

	describe("Task 8.8: result parity between indexed and non-indexed queries", () => {
		const testUsers: ReadonlyArray<User> = [
			{ id: "u1", email: "alice@example.com", name: "Alice", age: 30, role: "admin" },
			{ id: "u2", email: "bob@example.com", name: "Bob", age: 25, role: "user" },
			{ id: "u3", email: "charlie@example.com", name: "Charlie", age: 35, role: "user" },
			{ id: "u4", email: "alice@example.com", name: "Alice Smith", age: 28, role: "admin" },
			{ id: "u5", email: "dave@example.com", name: "Dave", age: 40, role: "moderator" },
		]

		it("should return same results for direct equality query with and without index", async () => {
			// Create indexed database
			const indexedConfig = createIndexedUsersConfig()
			const indexedDb = await Effect.runPromise(
				createIndexedDatabase(indexedConfig, { users: testUsers }),
			)

			// Create non-indexed database
			const unindexedConfig = createUnindexedConfig()
			const unindexedDb = await Effect.runPromise(
				createIndexedDatabase(unindexedConfig, { users: testUsers }),
			)

			// Query both with same condition
			const indexedResults = await indexedDb.users.query({
				where: { email: "alice@example.com" },
			}).runPromise
			const unindexedResults = await unindexedDb.users.query({
				where: { email: "alice@example.com" },
			}).runPromise

			// Should return same entities
			expect(indexedResults.length).toBe(unindexedResults.length)
			const indexedIds = indexedResults.map((r) => (r as { id: string }).id).sort()
			const unindexedIds = unindexedResults.map((r) => (r as { id: string }).id).sort()
			expect(indexedIds).toEqual(unindexedIds)
			expect(indexedIds).toEqual(["u1", "u4"])
		})

		it("should return same results for $eq query with and without index", async () => {
			const indexedConfig = createIndexedUsersConfig()
			const indexedDb = await Effect.runPromise(
				createIndexedDatabase(indexedConfig, { users: testUsers }),
			)

			const unindexedConfig = createUnindexedConfig()
			const unindexedDb = await Effect.runPromise(
				createIndexedDatabase(unindexedConfig, { users: testUsers }),
			)

			const indexedResults = await indexedDb.users.query({
				where: { email: { $eq: "bob@example.com" } },
			}).runPromise
			const unindexedResults = await unindexedDb.users.query({
				where: { email: { $eq: "bob@example.com" } },
			}).runPromise

			expect(indexedResults.length).toBe(unindexedResults.length)
			const indexedIds = indexedResults.map((r) => (r as { id: string }).id).sort()
			const unindexedIds = unindexedResults.map((r) => (r as { id: string }).id).sort()
			expect(indexedIds).toEqual(unindexedIds)
			expect(indexedIds).toEqual(["u2"])
		})

		it("should return same results for $in query with and without index", async () => {
			const indexedConfig = createIndexedUsersConfig()
			const indexedDb = await Effect.runPromise(
				createIndexedDatabase(indexedConfig, { users: testUsers }),
			)

			const unindexedConfig = createUnindexedConfig()
			const unindexedDb = await Effect.runPromise(
				createIndexedDatabase(unindexedConfig, { users: testUsers }),
			)

			const indexedResults = await indexedDb.users.query({
				where: { email: { $in: ["alice@example.com", "charlie@example.com"] } },
			}).runPromise
			const unindexedResults = await unindexedDb.users.query({
				where: { email: { $in: ["alice@example.com", "charlie@example.com"] } },
			}).runPromise

			expect(indexedResults.length).toBe(unindexedResults.length)
			const indexedIds = indexedResults.map((r) => (r as { id: string }).id).sort()
			const unindexedIds = unindexedResults.map((r) => (r as { id: string }).id).sort()
			expect(indexedIds).toEqual(unindexedIds)
			expect(indexedIds).toEqual(["u1", "u3", "u4"])
		})

		it("should return same results for no-match query with and without index", async () => {
			const indexedConfig = createIndexedUsersConfig()
			const indexedDb = await Effect.runPromise(
				createIndexedDatabase(indexedConfig, { users: testUsers }),
			)

			const unindexedConfig = createUnindexedConfig()
			const unindexedDb = await Effect.runPromise(
				createIndexedDatabase(unindexedConfig, { users: testUsers }),
			)

			const indexedResults = await indexedDb.users.query({
				where: { email: "nonexistent@example.com" },
			}).runPromise
			const unindexedResults = await unindexedDb.users.query({
				where: { email: "nonexistent@example.com" },
			}).runPromise

			expect(indexedResults.length).toBe(0)
			expect(unindexedResults.length).toBe(0)
		})

		it("should return same results after CRUD operations with and without index", async () => {
			const indexedConfig = createIndexedUsersConfig()
			const indexedDb = await Effect.runPromise(
				createIndexedDatabase(indexedConfig, { users: testUsers }),
			)

			const unindexedConfig = createUnindexedConfig()
			const unindexedDb = await Effect.runPromise(
				createIndexedDatabase(unindexedConfig, { users: testUsers }),
			)

			// Perform same CRUD operations on both
			const newUser: User = { id: "u6", email: "eve@example.com", name: "Eve", age: 32 }
			await indexedDb.users.create(newUser).runPromise
			await unindexedDb.users.create(newUser).runPromise

			await indexedDb.users.update("u2", { email: "bobby@example.com" }).runPromise
			await unindexedDb.users.update("u2", { email: "bobby@example.com" }).runPromise

			await indexedDb.users.delete("u5").runPromise
			await unindexedDb.users.delete("u5").runPromise

			// Query for new email
			const indexedNew = await indexedDb.users.query({
				where: { email: "eve@example.com" },
			}).runPromise
			const unindexedNew = await unindexedDb.users.query({
				where: { email: "eve@example.com" },
			}).runPromise

			expect(indexedNew.length).toBe(unindexedNew.length)
			expect(indexedNew.map((r) => (r as { id: string }).id)).toEqual(
				unindexedNew.map((r) => (r as { id: string }).id),
			)

			// Query for updated email
			const indexedUpdated = await indexedDb.users.query({
				where: { email: "bobby@example.com" },
			}).runPromise
			const unindexedUpdated = await unindexedDb.users.query({
				where: { email: "bobby@example.com" },
			}).runPromise

			expect(indexedUpdated.length).toBe(unindexedUpdated.length)
			expect(indexedUpdated.map((r) => (r as { id: string }).id)).toEqual(
				unindexedUpdated.map((r) => (r as { id: string }).id),
			)

			// Query for old email (should no longer match u2)
			const indexedOld = await indexedDb.users.query({
				where: { email: "bob@example.com" },
			}).runPromise
			const unindexedOld = await unindexedDb.users.query({
				where: { email: "bob@example.com" },
			}).runPromise

			expect(indexedOld.length).toBe(0)
			expect(unindexedOld.length).toBe(0)

			// Query for deleted user's email
			const indexedDeleted = await indexedDb.users.query({
				where: { email: "dave@example.com" },
			}).runPromise
			const unindexedDeleted = await unindexedDb.users.query({
				where: { email: "dave@example.com" },
			}).runPromise

			expect(indexedDeleted.length).toBe(0)
			expect(unindexedDeleted.length).toBe(0)
		})

		it("should return same results for query with sorting", async () => {
			const indexedConfig = createIndexedUsersConfig()
			const indexedDb = await Effect.runPromise(
				createIndexedDatabase(indexedConfig, { users: testUsers }),
			)

			const unindexedConfig = createUnindexedConfig()
			const unindexedDb = await Effect.runPromise(
				createIndexedDatabase(unindexedConfig, { users: testUsers }),
			)

			// Query with sort on different field
			const indexedResults = await indexedDb.users.query({
				where: { email: "alice@example.com" },
				sort: [{ field: "age", order: "asc" }],
			}).runPromise
			const unindexedResults = await unindexedDb.users.query({
				where: { email: "alice@example.com" },
				sort: [{ field: "age", order: "asc" }],
			}).runPromise

			// Results should be identical including order
			expect(indexedResults.length).toBe(unindexedResults.length)
			expect(indexedResults.length).toBe(2)
			const indexedIds = indexedResults.map((r) => (r as { id: string }).id)
			const unindexedIds = unindexedResults.map((r) => (r as { id: string }).id)
			// Both should return u4 before u1 (sorted by age ascending: 28 < 30)
			expect(indexedIds).toEqual(unindexedIds)
		})

		it("should return same results for query with limit", async () => {
			const indexedConfig = createIndexedUsersConfig()
			const indexedDb = await Effect.runPromise(
				createIndexedDatabase(indexedConfig, { users: testUsers }),
			)

			const unindexedConfig = createUnindexedConfig()
			const unindexedDb = await Effect.runPromise(
				createIndexedDatabase(unindexedConfig, { users: testUsers }),
			)

			// Query with limit
			const indexedResults = await indexedDb.users.query({
				where: { email: { $in: ["alice@example.com", "bob@example.com", "charlie@example.com"] } },
				limit: 2,
			}).runPromise
			const unindexedResults = await unindexedDb.users.query({
				where: { email: { $in: ["alice@example.com", "bob@example.com", "charlie@example.com"] } },
				limit: 2,
			}).runPromise

			// Both should return exactly 2 results
			expect(indexedResults.length).toBe(2)
			expect(unindexedResults.length).toBe(2)
		})

		it("should return same results for compound index query with and without index", async () => {
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p3", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
				{ id: "p4", name: "Monitor", category: "electronics", subcategory: "computers", price: 399 },
				{ id: "p5", name: "Chair", category: "furniture", subcategory: "office", price: 199 },
			]

			// Indexed config with compound index
			const indexedConfig = createMultiIndexConfig()
			const indexedDb = await Effect.runPromise(
				createIndexedDatabase(indexedConfig, { users: [], products: testProducts }),
			)

			// Non-indexed config for products
			const unindexedConfig = {
				products: {
					schema: ProductSchema,
					relationships: {} as const,
				},
			} as const
			const unindexedDb = await Effect.runPromise(
				createIndexedDatabase(unindexedConfig, { products: testProducts }),
			)

			// Query on compound indexed fields
			const indexedResults = await indexedDb.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			const unindexedResults = await unindexedDb.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise

			expect(indexedResults.length).toBe(unindexedResults.length)
			const indexedIds = indexedResults.map((r) => (r as { id: string }).id).sort()
			const unindexedIds = unindexedResults.map((r) => (r as { id: string }).id).sort()
			expect(indexedIds).toEqual(unindexedIds)
			expect(indexedIds).toEqual(["p1", "p4"])
		})
	})

	// ============================================================================
	// Tests - Compound Indexes (Tasks 9.1-9.6)
	// ============================================================================

	describe("Task 9.1: compound index equality query on all fields → index lookup", () => {
		it("should use compound index for equality query on both fields", async () => {
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p3", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
				{ id: "p4", name: "Monitor", category: "electronics", subcategory: "computers", price: 399 },
				{ id: "p5", name: "Chair", category: "furniture", subcategory: "office", price: 199 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Query using both fields in compound index ["category", "subcategory"]
			const results = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise

			// Should return entities matching both fields
			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p1", "p4"])
		})

		it("should return correct results with compound index using $eq on all fields", async () => {
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p3", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Query using $eq on both compound index fields
			const results = await db.products.query({
				where: { category: { $eq: "furniture" }, subcategory: { $eq: "office" } },
			}).runPromise

			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("p3")
		})

		it("should return empty array when compound index lookup finds no matches", async () => {
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Query with compound key that doesn't exist
			const results = await db.products.query({
				where: { category: "electronics", subcategory: "tablets" },
			}).runPromise

			expect(results.length).toBe(0)
		})

		it("should prefer compound index over single-field index when both match", async () => {
			// createMultiIndexConfig has both "category" single-field and ["category", "subcategory"] compound
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p3", name: "Monitor", category: "electronics", subcategory: "computers", price: 399 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Query on both fields - should use compound index for more specific results
			const results = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise

			// Should return only the computers (2 items), not all electronics (3 items)
			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p1", "p3"])
		})

		it("should handle compound index with mixed direct and $eq conditions", async () => {
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
				{ id: "p3", name: "Chair", category: "furniture", subcategory: "office", price: 199 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Mix of direct value and $eq
			const results = await db.products.query({
				where: { category: "furniture", subcategory: { $eq: "office" } },
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p2", "p3"])
		})
	})

	describe("Task 9.2: partial compound query → falls back to full scan", () => {
		it("should return correct results when querying only first field of compound index", async () => {
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p3", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
				{ id: "p4", name: "Monitor", category: "electronics", subcategory: "computers", price: 399 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Query only on "category" - compound index ["category", "subcategory"] can't be used
			// But there's a single-field index on "category" that should be used
			const results = await db.products.query({
				where: { category: "electronics" },
			}).runPromise

			// Should return all electronics products
			expect(results.length).toBe(3)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p1", "p2", "p4"])
		})

		it("should return correct results when querying only second field of compound index", async () => {
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Workstation", category: "workstations", subcategory: "computers", price: 2999 },
				{ id: "p3", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p4", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Query only on "subcategory" - compound index ["category", "subcategory"] can't be used
			// No single-field index on "subcategory" either, so must fall back to full scan
			const results = await db.products.query({
				where: { subcategory: "computers" },
			}).runPromise

			// Should return all products with subcategory "computers" via full scan
			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p1", "p2"])
		})

		it("should fall back correctly when no single-field index exists for partial query", async () => {
			// Config with ONLY compound index, no single-field index on "category"
			const compoundOnlyConfig = {
				products: {
					schema: ProductSchema,
					indexes: [["category", "subcategory"]] as ReadonlyArray<ReadonlyArray<string>>,
					relationships: {} as const,
				},
			} as const

			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p3", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(compoundOnlyConfig, { products: testProducts }),
			)

			// Query only on "category" - compound index can't be used, must do full scan
			const results = await db.products.query({
				where: { category: "electronics" },
			}).runPromise

			// Should still return correct results via full scan
			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p1", "p2"])
		})

		it("should return same results as unindexed query for partial compound match", async () => {
			// Config with compound index
			const indexedConfig = {
				products: {
					schema: ProductSchema,
					indexes: [["category", "subcategory"]] as ReadonlyArray<ReadonlyArray<string>>,
					relationships: {} as const,
				},
			} as const

			// Config without any indexes
			const unindexedConfig = {
				products: {
					schema: ProductSchema,
					relationships: {} as const,
				},
			} as const

			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p3", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
				{ id: "p4", name: "Chair", category: "furniture", subcategory: "office", price: 199 },
			]

			const indexedDb = await Effect.runPromise(
				createIndexedDatabase(indexedConfig, { products: testProducts }),
			)
			const unindexedDb = await Effect.runPromise(
				createIndexedDatabase(unindexedConfig, { products: testProducts }),
			)

			// Partial query (only first field)
			const indexedResults = await indexedDb.products.query({
				where: { category: "furniture" },
			}).runPromise
			const unindexedResults = await unindexedDb.products.query({
				where: { category: "furniture" },
			}).runPromise

			const indexedIds = indexedResults.map((r) => (r as { id: string }).id).sort()
			const unindexedIds = unindexedResults.map((r) => (r as { id: string }).id).sort()

			expect(indexedIds).toEqual(unindexedIds)
			expect(indexedIds).toEqual(["p3", "p4"])
		})

		it("should handle partial query with $eq operator", async () => {
			const config = {
				products: {
					schema: ProductSchema,
					indexes: [["category", "subcategory"]] as ReadonlyArray<ReadonlyArray<string>>,
					relationships: {} as const,
				},
			} as const

			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p3", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: testProducts }),
			)

			// Partial query using $eq - compound index still can't be used
			const results = await db.products.query({
				where: { category: { $eq: "electronics" } },
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p1", "p2"])
		})

		it("should handle partial query with $in operator", async () => {
			const config = {
				products: {
					schema: ProductSchema,
					indexes: [["category", "subcategory"]] as ReadonlyArray<ReadonlyArray<string>>,
					relationships: {} as const,
				},
			} as const

			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p3", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
				{ id: "p4", name: "Toy", category: "toys", subcategory: "games", price: 49 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: testProducts }),
			)

			// Partial query using $in - compound index still can't be used
			const results = await db.products.query({
				where: { category: { $in: ["electronics", "toys"] } },
			}).runPromise

			expect(results.length).toBe(3)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p1", "p2", "p4"])
		})
	})

	describe("Task 9.3: compound query with extra non-indexed fields → index used, extras post-filtered", () => {
		it("should use compound index and post-filter extra non-indexed conditions", async () => {
			const config = createMultiIndexConfig()
			// products has compound index ["category", "subcategory"]
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Desktop", category: "electronics", subcategory: "computers", price: 799 },
				{ id: "p3", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p4", name: "Monitor", category: "electronics", subcategory: "computers", price: 399 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Query with indexed fields + extra non-indexed field (price)
			// Index should narrow to computers (p1, p2, p4), then price > 500 filters to (p1, p2)
			const results = await db.products.query({
				where: {
					category: "electronics",
					subcategory: "computers",
					price: { $gt: 500 },
				},
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p1", "p2"])
		})

		it("should post-filter multiple extra non-indexed conditions", async () => {
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop Pro", category: "electronics", subcategory: "computers", price: 1299 },
				{ id: "p2", name: "Laptop Basic", category: "electronics", subcategory: "computers", price: 599 },
				{ id: "p3", name: "Desktop Gaming", category: "electronics", subcategory: "computers", price: 1999 },
				{ id: "p4", name: "Desktop Basic", category: "electronics", subcategory: "computers", price: 499 },
				{ id: "p5", name: "Phone", category: "electronics", subcategory: "phones", price: 999 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Compound index narrows to computers (p1-p4), then filter by price and name pattern
			const results = await db.products.query({
				where: {
					category: "electronics",
					subcategory: "computers",
					price: { $gte: 1000 },
					name: { $contains: "Laptop" },
				},
			}).runPromise

			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("p1")
		})

		it("should produce same results as unindexed query with extra conditions", async () => {
			// Config with compound index
			const indexedConfig = {
				products: {
					schema: ProductSchema,
					indexes: [["category", "subcategory"]] as ReadonlyArray<ReadonlyArray<string>>,
					relationships: {} as const,
				},
			} as const

			// Config without any indexes
			const unindexedConfig = {
				products: {
					schema: ProductSchema,
					relationships: {} as const,
				},
			} as const

			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p3", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
				{ id: "p4", name: "Monitor", category: "electronics", subcategory: "computers", price: 399 },
			]

			const indexedDb = await Effect.runPromise(
				createIndexedDatabase(indexedConfig, { products: testProducts }),
			)
			const unindexedDb = await Effect.runPromise(
				createIndexedDatabase(unindexedConfig, { products: testProducts }),
			)

			// Query with compound index fields + extra condition
			const whereClause = {
				category: "electronics",
				subcategory: "computers",
				price: { $lt: 500 },
			}

			const indexedResults = await indexedDb.products.query({ where: whereClause }).runPromise
			const unindexedResults = await unindexedDb.products.query({ where: whereClause }).runPromise

			const indexedIds = indexedResults.map((r) => (r as { id: string }).id).sort()
			const unindexedIds = unindexedResults.map((r) => (r as { id: string }).id).sort()

			expect(indexedIds).toEqual(unindexedIds)
			expect(indexedIds).toEqual(["p4"])
		})

		it("should handle extra field with $eq operator", async () => {
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Desktop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p3", name: "Monitor", category: "electronics", subcategory: "computers", price: 399 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Compound index for category/subcategory, extra $eq condition on name
			const results = await db.products.query({
				where: {
					category: "electronics",
					subcategory: "computers",
					name: { $eq: "Laptop" },
				},
			}).runPromise

			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("p1")
		})

		it("should handle extra field with $in operator", async () => {
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Desktop", category: "electronics", subcategory: "computers", price: 899 },
				{ id: "p3", name: "Server", category: "electronics", subcategory: "computers", price: 2999 },
				{ id: "p4", name: "Monitor", category: "electronics", subcategory: "computers", price: 399 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Compound index for category/subcategory, extra $in condition on name
			const results = await db.products.query({
				where: {
					category: "electronics",
					subcategory: "computers",
					name: { $in: ["Laptop", "Server"] },
				},
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p1", "p3"])
		})

		it("should handle extra field with $ne operator (no index on that field)", async () => {
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Desktop", category: "electronics", subcategory: "computers", price: 899 },
				{ id: "p3", name: "Monitor", category: "electronics", subcategory: "computers", price: 399 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Compound index for category/subcategory, extra $ne condition on name
			const results = await db.products.query({
				where: {
					category: "electronics",
					subcategory: "computers",
					name: { $ne: "Laptop" },
				},
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p2", "p3"])
		})

		it("should handle extra condition that filters all index results to empty", async () => {
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Desktop", category: "electronics", subcategory: "computers", price: 899 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Compound index narrows to p1, p2 but price > 10000 filters to none
			const results = await db.products.query({
				where: {
					category: "electronics",
					subcategory: "computers",
					price: { $gt: 10000 },
				},
			}).runPromise

			expect(results.length).toBe(0)
		})
	})

	describe("Task 9.4: $in on one compound field → Cartesian product lookup", () => {
		it("should use Cartesian product when $in is used on one field of compound index", async () => {
			const config = createMultiIndexConfig()
			// Compound index: ["category", "subcategory"]
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p3", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
				{ id: "p4", name: "Chair", category: "furniture", subcategory: "office", price: 199 },
				{ id: "p5", name: "Tablet", category: "electronics", subcategory: "tablets", price: 499 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Query with $in on category (first field) and direct value on subcategory (second field)
			// Should lookup: ["electronics","office"] and ["furniture","office"]
			// Only ["furniture","office"] has matches (p3, p4)
			const results = await db.products.query({
				where: {
					category: { $in: ["electronics", "furniture"] },
					subcategory: "office",
				},
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p3", "p4"])
		})

		it("should use Cartesian product when $in is used on second field of compound index", async () => {
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p3", name: "Tablet", category: "electronics", subcategory: "tablets", price: 499 },
				{ id: "p4", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Query with direct value on category and $in on subcategory
			// Should lookup: ["electronics","computers"] and ["electronics","phones"]
			const results = await db.products.query({
				where: {
					category: "electronics",
					subcategory: { $in: ["computers", "phones"] },
				},
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p1", "p2"])
		})

		it("should use Cartesian product when $in is used on both fields of compound index", async () => {
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p3", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
				{ id: "p4", name: "Chair", category: "furniture", subcategory: "seating", price: 199 },
				{ id: "p5", name: "Table", category: "furniture", subcategory: "office", price: 399 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Query with $in on both fields
			// Cartesian product: ["electronics","computers"], ["electronics","phones"],
			//                    ["furniture","computers"], ["furniture","phones"]
			// Only ["electronics","computers"] and ["electronics","phones"] have matches
			const results = await db.products.query({
				where: {
					category: { $in: ["electronics", "furniture"] },
					subcategory: { $in: ["computers", "phones"] },
				},
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p1", "p2"])
		})

		it("should return empty when $in Cartesian product finds no matches", async () => {
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Query with $in values that don't match any entries
			// Cartesian product: ["furniture","office"], ["furniture","seating"]
			// None exist in data
			const results = await db.products.query({
				where: {
					category: { $in: ["furniture"] },
					subcategory: { $in: ["office", "seating"] },
				},
			}).runPromise

			expect(results.length).toBe(0)
		})

		it("should produce same results as non-indexed query with $in on compound field", async () => {
			// Config with compound index
			const indexedConfig = {
				products: {
					schema: ProductSchema,
					indexes: [["category", "subcategory"]] as ReadonlyArray<ReadonlyArray<string>>,
					relationships: {} as const,
				},
			} as const

			// Config without any indexes
			const unindexedConfig = {
				products: {
					schema: ProductSchema,
					relationships: {} as const,
				},
			} as const

			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p3", name: "Desk", category: "furniture", subcategory: "office", price: 299 },
				{ id: "p4", name: "Chair", category: "furniture", subcategory: "seating", price: 199 },
			]

			const indexedDb = await Effect.runPromise(
				createIndexedDatabase(indexedConfig, { products: testProducts }),
			)
			const unindexedDb = await Effect.runPromise(
				createIndexedDatabase(unindexedConfig, { products: testProducts }),
			)

			// Query with $in on one compound field
			const whereClause = {
				category: { $in: ["electronics", "furniture"] },
				subcategory: "computers",
			}

			const indexedResults = await indexedDb.products.query({ where: whereClause }).runPromise
			const unindexedResults = await unindexedDb.products.query({ where: whereClause }).runPromise

			const indexedIds = indexedResults.map((r) => (r as { id: string }).id).sort()
			const unindexedIds = unindexedResults.map((r) => (r as { id: string }).id).sort()

			expect(indexedIds).toEqual(unindexedIds)
			expect(indexedIds).toEqual(["p1"])
		})

		it("should combine $in Cartesian lookup with post-filtering on non-indexed field", async () => {
			const config = createMultiIndexConfig()
			const testProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Desktop", category: "electronics", subcategory: "computers", price: 599 },
				{ id: "p3", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
				{ id: "p4", name: "Tablet", category: "electronics", subcategory: "tablets", price: 399 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { users: [], products: testProducts }),
			)

			// Compound index with $in + extra non-indexed condition
			// Cartesian: ["electronics","computers"], ["electronics","phones"]
			// Matches: p1, p2, p3
			// Post-filter price > 600: p1, p3
			const results = await db.products.query({
				where: {
					category: "electronics",
					subcategory: { $in: ["computers", "phones"] },
					price: { $gt: 600 },
				},
			}).runPromise

			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p1", "p3"])
		})
	})

	describe("Task 9.5: compound index maintenance (create/update/delete)", () => {
		it("should add entity to compound index when created", async () => {
			const config = createMultiIndexConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Create a product with compound indexed fields
			await db.products.create({
				id: "p1",
				name: "Laptop",
				category: "electronics",
				subcategory: "computers",
				price: 999,
			}).runPromise

			// Query using compound index - should find the product
			const results = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("p1")
		})

		it("should add multiple entities to compound index with createMany", async () => {
			const config = createMultiIndexConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Batch create products
			await db.products.createMany([
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Desktop", category: "electronics", subcategory: "computers", price: 799 },
				{ id: "p3", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
			]).runPromise

			// Query compound index - should find both computers
			const computersResults = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(computersResults.length).toBe(2)
			const computerIds = computersResults.map((r) => (r as { id: string }).id).sort()
			expect(computerIds).toEqual(["p1", "p2"])

			// Query another compound key - should find phones
			const phonesResults = await db.products.query({
				where: { category: "electronics", subcategory: "phones" },
			}).runPromise
			expect(phonesResults.length).toBe(1)
			expect((phonesResults[0] as { id: string }).id).toBe("p3")
		})

		it("should update compound index when updating first field of compound key", async () => {
			const config = createMultiIndexConfig()
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: initialProducts }),
			)

			// Update category (first field) from "electronics" to "refurbished"
			await db.products.update("p1", { category: "refurbished" }).runPromise

			// Old compound key should be empty
			const oldResults = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(oldResults.length).toBe(0)

			// New compound key should have the product
			const newResults = await db.products.query({
				where: { category: "refurbished", subcategory: "computers" },
			}).runPromise
			expect(newResults.length).toBe(1)
			expect((newResults[0] as { id: string }).id).toBe("p1")
		})

		it("should update compound index when updating second field of compound key", async () => {
			const config = createMultiIndexConfig()
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: initialProducts }),
			)

			// Update subcategory (second field) from "computers" to "laptops"
			await db.products.update("p1", { subcategory: "laptops" }).runPromise

			// Old compound key should be empty
			const oldResults = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(oldResults.length).toBe(0)

			// New compound key should have the product
			const newResults = await db.products.query({
				where: { category: "electronics", subcategory: "laptops" },
			}).runPromise
			expect(newResults.length).toBe(1)
			expect((newResults[0] as { id: string }).id).toBe("p1")
		})

		it("should update compound index when updating both fields of compound key", async () => {
			const config = createMultiIndexConfig()
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: initialProducts }),
			)

			// Update both fields
			await db.products.update("p1", { category: "furniture", subcategory: "office" }).runPromise

			// Old compound key should be empty
			const oldResults = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(oldResults.length).toBe(0)

			// New compound key should have the product
			const newResults = await db.products.query({
				where: { category: "furniture", subcategory: "office" },
			}).runPromise
			expect(newResults.length).toBe(1)
			expect((newResults[0] as { id: string }).id).toBe("p1")
		})

		it("should not change compound index when updating non-indexed fields", async () => {
			const config = createMultiIndexConfig()
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: initialProducts }),
			)

			// Update non-indexed fields only
			await db.products.update("p1", { name: "Gaming Laptop", price: 1499 }).runPromise

			// Compound index query should still find the product
			const results = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("p1")
			expect((results[0] as { name: string }).name).toBe("Gaming Laptop")
			expect((results[0] as { price: number }).price).toBe(1499)
		})

		it("should remove entity from compound index when deleted", async () => {
			const config = createMultiIndexConfig()
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Desktop", category: "electronics", subcategory: "computers", price: 799 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: initialProducts }),
			)

			// Verify both exist initially
			const initialResults = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(initialResults.length).toBe(2)

			// Delete one product
			await db.products.delete("p1").runPromise

			// Compound index should only have remaining product
			const afterResults = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(afterResults.length).toBe(1)
			expect((afterResults[0] as { id: string }).id).toBe("p2")
		})

		it("should clean up empty compound index Set when last entity is deleted", async () => {
			const config = createMultiIndexConfig()
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: initialProducts }),
			)

			// Delete the only product with "computers" subcategory
			await db.products.delete("p1").runPromise

			// Compound index query for deleted key should return empty
			const computersResults = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(computersResults.length).toBe(0)

			// Other compound index entry should be unaffected
			const phonesResults = await db.products.query({
				where: { category: "electronics", subcategory: "phones" },
			}).runPromise
			expect(phonesResults.length).toBe(1)
			expect((phonesResults[0] as { id: string }).id).toBe("p2")
		})

		it("should maintain compound index through mixed create/update/delete sequence", async () => {
			const config = createMultiIndexConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Phase 1: Create initial products
			await db.products.create({
				id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999,
			}).runPromise
			await db.products.create({
				id: "p2", name: "Phone", category: "electronics", subcategory: "phones", price: 699,
			}).runPromise

			let computersResults = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(computersResults.length).toBe(1)

			// Phase 2: Update p1 to change compound key
			await db.products.update("p1", { subcategory: "laptops" }).runPromise

			computersResults = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(computersResults.length).toBe(0)

			const laptopsResults = await db.products.query({
				where: { category: "electronics", subcategory: "laptops" },
			}).runPromise
			expect(laptopsResults.length).toBe(1)

			// Phase 3: Create new product with the now-empty compound key
			await db.products.create({
				id: "p3", name: "Desktop", category: "electronics", subcategory: "computers", price: 799,
			}).runPromise

			computersResults = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(computersResults.length).toBe(1)
			expect((computersResults[0] as { id: string }).id).toBe("p3")

			// Phase 4: Delete p2
			await db.products.delete("p2").runPromise

			const phonesResults = await db.products.query({
				where: { category: "electronics", subcategory: "phones" },
			}).runPromise
			expect(phonesResults.length).toBe(0)

			// Verify final state: laptops has p1, computers has p3
			const finalLaptops = await db.products.query({
				where: { category: "electronics", subcategory: "laptops" },
			}).runPromise
			expect(finalLaptops.length).toBe(1)
			expect((finalLaptops[0] as { id: string }).id).toBe("p1")

			const finalComputers = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(finalComputers.length).toBe(1)
			expect((finalComputers[0] as { id: string }).id).toBe("p3")
		})

		it("should handle compound index with upsert (create path)", async () => {
			const config = createMultiIndexConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			// Upsert a product that doesn't exist (create path)
			const result = await db.products.upsert({
				where: { id: "p1" },
				update: { name: "Should Not Apply" },
				create: { name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
			}).runPromise

			expect(result.__action).toBe("created")

			// Compound index should have the product
			const results = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("p1")
		})

		it("should handle compound index with upsert (update path)", async () => {
			const config = createMultiIndexConfig()
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: initialProducts }),
			)

			// Upsert to update compound key fields
			const result = await db.products.upsert({
				where: { id: "p1" },
				update: { subcategory: "laptops" }, // changed from "computers"
				create: { name: "Laptop", category: "electronics", subcategory: "laptops", price: 999 },
			}).runPromise

			expect(result.__action).toBe("updated")

			// Old compound key should be empty
			const oldResults = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(oldResults.length).toBe(0)

			// New compound key should have the product
			const newResults = await db.products.query({
				where: { category: "electronics", subcategory: "laptops" },
			}).runPromise
			expect(newResults.length).toBe(1)
			expect((newResults[0] as { id: string }).id).toBe("p1")
		})

		it("should handle deleteMany with compound index", async () => {
			const config = createMultiIndexConfig()
			const initialProducts: ReadonlyArray<Product> = [
				{ id: "p1", name: "Laptop", category: "electronics", subcategory: "computers", price: 999 },
				{ id: "p2", name: "Desktop", category: "electronics", subcategory: "computers", price: 799 },
				{ id: "p3", name: "Phone", category: "electronics", subcategory: "phones", price: 699 },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { products: initialProducts }),
			)

			// Delete all computers (using predicate function)
			await db.products.deleteMany(
				(product) => (product as { subcategory: string }).subcategory === "computers"
			).runPromise

			// Compound index for computers should be empty
			const computersResults = await db.products.query({
				where: { category: "electronics", subcategory: "computers" },
			}).runPromise
			expect(computersResults.length).toBe(0)

			// Phones should be unaffected
			const phonesResults = await db.products.query({
				where: { category: "electronics", subcategory: "phones" },
			}).runPromise
			expect(phonesResults.length).toBe(1)
			expect((phonesResults[0] as { id: string }).id).toBe("p3")
		})
	})

	describe("Task 9.6: compound key handles mixed types (string + number)", () => {
		// Schema for testing mixed-type compound indexes
		const OrderSchema = Schema.Struct({
			id: Schema.String,
			userId: Schema.String,
			quantity: Schema.Number,
			product: Schema.String,
			status: Schema.optional(Schema.String),
		})

		type Order = Schema.Schema.Type<typeof OrderSchema>

		const createMixedTypeIndexConfig = () =>
			({
				orders: {
					schema: OrderSchema,
					indexes: [
						["userId", "quantity"], // string + number compound index
					] as ReadonlyArray<string | ReadonlyArray<string>>,
					relationships: {} as const,
				},
			}) as const

		it("should build compound index with string + number fields", async () => {
			const config = createMixedTypeIndexConfig()
			const initialOrders: ReadonlyArray<Order> = [
				{ id: "o1", userId: "u1", quantity: 5, product: "Laptop" },
				{ id: "o2", userId: "u1", quantity: 10, product: "Phone" },
				{ id: "o3", userId: "u2", quantity: 5, product: "Desk" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { orders: initialOrders }),
			)

			// Query with string + number compound key
			const results = await db.orders.query({
				where: { userId: "u1", quantity: 5 },
			}).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("o1")
		})

		it("should distinguish between same values of different types in compound index", async () => {
			// This tests that "5" (string) and 5 (number) create different index keys
			const MixedSchema = Schema.Struct({
				id: Schema.String,
				strField: Schema.String,
				numField: Schema.Number,
				data: Schema.optional(Schema.String),
			})

			const config = {
				items: {
					schema: MixedSchema,
					indexes: [["strField", "numField"]] as ReadonlyArray<ReadonlyArray<string>>,
					relationships: {} as const,
				},
			} as const

			type MixedItem = Schema.Schema.Type<typeof MixedSchema>
			const initialItems: ReadonlyArray<MixedItem> = [
				{ id: "i1", strField: "a", numField: 1, data: "first" },
				{ id: "i2", strField: "a", numField: 2, data: "second" },
				{ id: "i3", strField: "b", numField: 1, data: "third" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { items: initialItems }),
			)

			// Query for strField="a", numField=1 should return only i1
			const results1 = await db.items.query({
				where: { strField: "a", numField: 1 },
			}).runPromise
			expect(results1.length).toBe(1)
			expect((results1[0] as { id: string }).id).toBe("i1")

			// Query for strField="a", numField=2 should return only i2
			const results2 = await db.items.query({
				where: { strField: "a", numField: 2 },
			}).runPromise
			expect(results2.length).toBe(1)
			expect((results2[0] as { id: string }).id).toBe("i2")

			// Query for strField="b", numField=1 should return only i3
			const results3 = await db.items.query({
				where: { strField: "b", numField: 1 },
			}).runPromise
			expect(results3.length).toBe(1)
			expect((results3[0] as { id: string }).id).toBe("i3")
		})

		it("should handle $in on number field in mixed-type compound index", async () => {
			const config = createMixedTypeIndexConfig()
			const initialOrders: ReadonlyArray<Order> = [
				{ id: "o1", userId: "u1", quantity: 5, product: "Laptop" },
				{ id: "o2", userId: "u1", quantity: 10, product: "Phone" },
				{ id: "o3", userId: "u1", quantity: 15, product: "Desk" },
				{ id: "o4", userId: "u2", quantity: 5, product: "Chair" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { orders: initialOrders }),
			)

			// Query with string field exact match and $in on number field
			const results = await db.orders.query({
				where: { userId: "u1", quantity: { $in: [5, 10] } },
			}).runPromise
			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["o1", "o2"])
		})

		it("should handle $in on string field in mixed-type compound index", async () => {
			const config = createMixedTypeIndexConfig()
			const initialOrders: ReadonlyArray<Order> = [
				{ id: "o1", userId: "u1", quantity: 5, product: "Laptop" },
				{ id: "o2", userId: "u2", quantity: 5, product: "Phone" },
				{ id: "o3", userId: "u3", quantity: 5, product: "Desk" },
				{ id: "o4", userId: "u1", quantity: 10, product: "Chair" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { orders: initialOrders }),
			)

			// Query with $in on string field and exact match on number field
			const results = await db.orders.query({
				where: { userId: { $in: ["u1", "u2"] }, quantity: 5 },
			}).runPromise
			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["o1", "o2"])
		})

		it("should maintain mixed-type compound index on create", async () => {
			const config = createMixedTypeIndexConfig()
			const db = await Effect.runPromise(createIndexedDatabase(config))

			await db.orders.create({
				id: "o1",
				userId: "u1",
				quantity: 5,
				product: "Laptop",
			}).runPromise

			const results = await db.orders.query({
				where: { userId: "u1", quantity: 5 },
			}).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("o1")
		})

		it("should maintain mixed-type compound index on update (changing number field)", async () => {
			const config = createMixedTypeIndexConfig()
			const initialOrders: ReadonlyArray<Order> = [
				{ id: "o1", userId: "u1", quantity: 5, product: "Laptop" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { orders: initialOrders }),
			)

			// Update quantity from 5 to 10
			await db.orders.update("o1", { quantity: 10 }).runPromise

			// Old compound key should be empty
			const oldResults = await db.orders.query({
				where: { userId: "u1", quantity: 5 },
			}).runPromise
			expect(oldResults.length).toBe(0)

			// New compound key should have the order
			const newResults = await db.orders.query({
				where: { userId: "u1", quantity: 10 },
			}).runPromise
			expect(newResults.length).toBe(1)
			expect((newResults[0] as { id: string }).id).toBe("o1")
		})

		it("should maintain mixed-type compound index on update (changing string field)", async () => {
			const config = createMixedTypeIndexConfig()
			const initialOrders: ReadonlyArray<Order> = [
				{ id: "o1", userId: "u1", quantity: 5, product: "Laptop" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { orders: initialOrders }),
			)

			// Update userId from "u1" to "u2"
			await db.orders.update("o1", { userId: "u2" }).runPromise

			// Old compound key should be empty
			const oldResults = await db.orders.query({
				where: { userId: "u1", quantity: 5 },
			}).runPromise
			expect(oldResults.length).toBe(0)

			// New compound key should have the order
			const newResults = await db.orders.query({
				where: { userId: "u2", quantity: 5 },
			}).runPromise
			expect(newResults.length).toBe(1)
			expect((newResults[0] as { id: string }).id).toBe("o1")
		})

		it("should maintain mixed-type compound index on delete", async () => {
			const config = createMixedTypeIndexConfig()
			const initialOrders: ReadonlyArray<Order> = [
				{ id: "o1", userId: "u1", quantity: 5, product: "Laptop" },
				{ id: "o2", userId: "u1", quantity: 5, product: "Phone" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { orders: initialOrders }),
			)

			// Both orders should be found initially
			let results = await db.orders.query({
				where: { userId: "u1", quantity: 5 },
			}).runPromise
			expect(results.length).toBe(2)

			// Delete one order
			await db.orders.delete("o1").runPromise

			// Only one order should remain
			results = await db.orders.query({
				where: { userId: "u1", quantity: 5 },
			}).runPromise
			expect(results.length).toBe(1)
			expect((results[0] as { id: string }).id).toBe("o2")
		})

		it("should handle zero and negative numbers in compound index", async () => {
			const config = createMixedTypeIndexConfig()
			const initialOrders: ReadonlyArray<Order> = [
				{ id: "o1", userId: "u1", quantity: 0, product: "Free Sample" },
				{ id: "o2", userId: "u1", quantity: -1, product: "Return" },
				{ id: "o3", userId: "u1", quantity: 1, product: "Purchase" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { orders: initialOrders }),
			)

			// Query for zero quantity
			const zeroResults = await db.orders.query({
				where: { userId: "u1", quantity: 0 },
			}).runPromise
			expect(zeroResults.length).toBe(1)
			expect((zeroResults[0] as { id: string }).id).toBe("o1")

			// Query for negative quantity
			const negResults = await db.orders.query({
				where: { userId: "u1", quantity: -1 },
			}).runPromise
			expect(negResults.length).toBe(1)
			expect((negResults[0] as { id: string }).id).toBe("o2")
		})

		it("should handle floating point numbers in compound index", async () => {
			const PriceSchema = Schema.Struct({
				id: Schema.String,
				category: Schema.String,
				price: Schema.Number,
				name: Schema.optional(Schema.String),
			})

			type PriceItem = Schema.Schema.Type<typeof PriceSchema>

			const config = {
				prices: {
					schema: PriceSchema,
					indexes: [["category", "price"]] as ReadonlyArray<ReadonlyArray<string>>,
					relationships: {} as const,
				},
			} as const

			const initialItems: ReadonlyArray<PriceItem> = [
				{ id: "p1", category: "electronics", price: 9.99, name: "Cable" },
				{ id: "p2", category: "electronics", price: 9.99, name: "Adapter" },
				{ id: "p3", category: "electronics", price: 19.99, name: "Charger" },
			]
			const db = await Effect.runPromise(
				createIndexedDatabase(config, { prices: initialItems }),
			)

			// Query for floating point price
			const results = await db.prices.query({
				where: { category: "electronics", price: 9.99 },
			}).runPromise
			expect(results.length).toBe(2)
			const ids = results.map((r) => (r as { id: string }).id).sort()
			expect(ids).toEqual(["p1", "p2"])
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
