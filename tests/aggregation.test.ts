import { describe, it, expect, beforeEach } from "vitest"
import { Effect, Schema } from "effect"
import {
	createEffectDatabase,
	type EffectDatabase,
} from "../core/factories/database-effect.js"

// ============================================================================
// Test Schema: Products
// ============================================================================

const ProductSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	price: Schema.Number,
	category: Schema.String,
	stock: Schema.Number,
	createdAt: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.String),
})

type Product = Schema.Schema.Type<typeof ProductSchema>

// ============================================================================
// Config
// ============================================================================

const config = {
	products: {
		schema: ProductSchema,
		relationships: {},
	},
} as const

// ============================================================================
// Test Data
// ============================================================================

const testProducts: ReadonlyArray<Omit<Product, "createdAt" | "updatedAt">> = [
	{ id: "p1", name: "Widget A", price: 10.00, category: "electronics", stock: 100 },
	{ id: "p2", name: "Widget B", price: 25.50, category: "electronics", stock: 50 },
	{ id: "p3", name: "Gadget X", price: 15.75, category: "gadgets", stock: 75 },
	{ id: "p4", name: "Gadget Y", price: 35.00, category: "gadgets", stock: 25 },
	{ id: "p5", name: "Tool Z", price: 5.25, category: "tools", stock: 200 },
]

// ============================================================================
// Test Helper
// ============================================================================

/**
 * Create a fresh database instance with test products.
 */
const createTestDb = () =>
	Effect.runPromise(
		createEffectDatabase(config, { products: testProducts }),
	)

/**
 * Create an empty database instance.
 */
const createEmptyDb = () =>
	Effect.runPromise(
		createEffectDatabase(config, { products: [] }),
	)

// ============================================================================
// Tests — Scalar Aggregates
// ============================================================================

describe("Aggregation", () => {
	describe("count", () => {
		it("5.2 count with no where → total collection size", async () => {
			const db = await createTestDb()
			const result = await db.products.aggregate({ count: true }).runPromise
			expect(result.count).toBe(5)
		})

		it("5.3 count with where → filtered count", async () => {
			const db = await createTestDb()
			const result = await db.products.aggregate({
				count: true,
				where: { category: "electronics" },
			}).runPromise
			expect(result.count).toBe(2)
		})

		it("5.4 count on empty collection → 0", async () => {
			const db = await createEmptyDb()
			const result = await db.products.aggregate({ count: true }).runPromise
			expect(result.count).toBe(0)
		})
	})

	describe("sum", () => {
		it("5.5 sum on numeric field → correct total", async () => {
			const db = await createTestDb()
			const result = await db.products.aggregate({ sum: "price" }).runPromise
			// 10.00 + 25.50 + 15.75 + 35.00 + 5.25 = 91.50
			expect(result.sum?.price).toBeCloseTo(91.50)
		})

		it("5.6 sum with non-numeric/null values → skipped", async () => {
			// Create a database with some products having non-numeric or null values
			const productsWithNulls = [
				{ id: "p1", name: "A", price: 10, category: "cat", stock: 100 },
				{ id: "p2", name: "B", price: null as unknown as number, category: "cat", stock: 50 },
				{ id: "p3", name: "C", price: 20, category: "cat", stock: 75 },
			]
			const db = await Effect.runPromise(
				createEffectDatabase(config, { products: productsWithNulls }),
			)
			const result = await db.products.aggregate({ sum: "price" }).runPromise
			// Only 10 + 20 = 30 (null is skipped)
			expect(result.sum?.price).toBe(30)
		})

		it("5.7 sum on empty result set → 0", async () => {
			const db = await createEmptyDb()
			const result = await db.products.aggregate({ sum: "price" }).runPromise
			expect(result.sum?.price).toBe(0)
		})
	})

	describe("avg", () => {
		it("5.8 avg on numeric field → correct mean", async () => {
			const db = await createTestDb()
			const result = await db.products.aggregate({ avg: "price" }).runPromise
			// (10.00 + 25.50 + 15.75 + 35.00 + 5.25) / 5 = 91.50 / 5 = 18.30
			expect(result.avg?.price).toBeCloseTo(18.30)
		})

		it("5.9 avg with all non-numeric → null", async () => {
			// All prices are null/undefined/strings
			const productsAllNonNumeric = [
				{ id: "p1", name: "A", price: null as unknown as number, category: "cat", stock: 100 },
				{ id: "p2", name: "B", price: undefined as unknown as number, category: "cat", stock: 50 },
				{ id: "p3", name: "C", price: "not a number" as unknown as number, category: "cat", stock: 75 },
			]
			const db = await Effect.runPromise(
				createEffectDatabase(config, { products: productsAllNonNumeric }),
			)
			const result = await db.products.aggregate({ avg: "price" }).runPromise
			expect(result.avg?.price).toBeNull()
		})

		it("5.10 avg on empty result set → null", async () => {
			const db = await createEmptyDb()
			const result = await db.products.aggregate({ avg: "price" }).runPromise
			expect(result.avg?.price).toBeNull()
		})
	})

	describe("min/max", () => {
		it("5.11 min/max on numeric field → correct extremes", async () => {
			const db = await createTestDb()
			const result = await db.products.aggregate({
				min: "price",
				max: "price",
			}).runPromise
			expect(result.min?.price).toBe(5.25)
			expect(result.max?.price).toBe(35.00)
		})

		it("5.12 min/max on string field → lexicographic comparison", async () => {
			const db = await createTestDb()
			const result = await db.products.aggregate({
				min: "name",
				max: "name",
			}).runPromise
			expect(result.min?.name).toBe("Gadget X") // G < T < W
			expect(result.max?.name).toBe("Widget B")
		})

		it("5.13 min/max on empty result set → undefined", async () => {
			const db = await createEmptyDb()
			const result = await db.products.aggregate({
				min: "price",
				max: "price",
			}).runPromise
			expect(result.min?.price).toBeUndefined()
			expect(result.max?.price).toBeUndefined()
		})
	})

	describe("multiple aggregations", () => {
		it("5.14 multiple aggregations in one call → all present in result", async () => {
			const db = await createTestDb()
			const result = await db.products.aggregate({
				count: true,
				sum: "price",
				avg: "price",
				min: "price",
				max: "price",
			}).runPromise

			expect(result.count).toBe(5)
			expect(result.sum?.price).toBeCloseTo(91.50)
			expect(result.avg?.price).toBeCloseTo(18.30)
			expect(result.min?.price).toBe(5.25)
			expect(result.max?.price).toBe(35.00)
		})

		it("5.15 multiple fields per aggregation → all fields computed", async () => {
			const db = await createTestDb()
			const result = await db.products.aggregate({
				sum: ["price", "stock"],
				avg: ["price", "stock"],
			}).runPromise

			// Sum of prices: 91.50
			expect(result.sum?.price).toBeCloseTo(91.50)
			// Sum of stock: 100 + 50 + 75 + 25 + 200 = 450
			expect(result.sum?.stock).toBe(450)

			// Avg of prices: 18.30
			expect(result.avg?.price).toBeCloseTo(18.30)
			// Avg of stock: 450 / 5 = 90
			expect(result.avg?.stock).toBe(90)
		})
	})

	describe("groupBy", () => {
		it("6.1 single-field groupBy with count → correct group counts", async () => {
			const db = await createTestDb()
			const result = await db.products.aggregate({
				groupBy: "category",
				count: true,
			}).runPromise

			// Test data has: electronics (2), gadgets (2), tools (1)
			expect(result).toHaveLength(3)

			// Find each group and verify count
			const electronics = result.find(g => g.group.category === "electronics")
			const gadgets = result.find(g => g.group.category === "gadgets")
			const tools = result.find(g => g.group.category === "tools")

			expect(electronics?.count).toBe(2)
			expect(gadgets?.count).toBe(2)
			expect(tools?.count).toBe(1)
		})
	})
})
