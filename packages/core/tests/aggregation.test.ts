import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createEffectDatabase } from "../src/factories/database-effect.js";

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
});

type Product = Schema.Schema.Type<typeof ProductSchema>;

// ============================================================================
// Config
// ============================================================================

const config = {
	products: {
		schema: ProductSchema,
		relationships: {},
	},
} as const;

// ============================================================================
// Test Data
// ============================================================================

const testProducts: ReadonlyArray<Omit<Product, "createdAt" | "updatedAt">> = [
	{
		id: "p1",
		name: "Widget A",
		price: 10.0,
		category: "electronics",
		stock: 100,
	},
	{
		id: "p2",
		name: "Widget B",
		price: 25.5,
		category: "electronics",
		stock: 50,
	},
	{ id: "p3", name: "Gadget X", price: 15.75, category: "gadgets", stock: 75 },
	{ id: "p4", name: "Gadget Y", price: 35.0, category: "gadgets", stock: 25 },
	{ id: "p5", name: "Tool Z", price: 5.25, category: "tools", stock: 200 },
];

// ============================================================================
// Test Helper
// ============================================================================

/**
 * Create a fresh database instance with test products.
 */
const createTestDb = () =>
	Effect.runPromise(createEffectDatabase(config, { products: testProducts }));

/**
 * Create an empty database instance.
 */
const createEmptyDb = () =>
	Effect.runPromise(createEffectDatabase(config, { products: [] }));

// ============================================================================
// Tests — Scalar Aggregates
// ============================================================================

describe("Aggregation", () => {
	describe("count", () => {
		it("5.2 count with no where → total collection size", async () => {
			const db = await createTestDb();
			const result = await db.products.aggregate({ count: true }).runPromise;
			expect(result.count).toBe(5);
		});

		it("5.3 count with where → filtered count", async () => {
			const db = await createTestDb();
			const result = await db.products.aggregate({
				count: true,
				where: { category: "electronics" },
			}).runPromise;
			expect(result.count).toBe(2);
		});

		it("5.4 count on empty collection → 0", async () => {
			const db = await createEmptyDb();
			const result = await db.products.aggregate({ count: true }).runPromise;
			expect(result.count).toBe(0);
		});
	});

	describe("sum", () => {
		it("5.5 sum on numeric field → correct total", async () => {
			const db = await createTestDb();
			const result = await db.products.aggregate({ sum: "price" }).runPromise;
			// 10.00 + 25.50 + 15.75 + 35.00 + 5.25 = 91.50
			expect(result.sum?.price).toBeCloseTo(91.5);
		});

		it("5.6 sum with non-numeric/null values → skipped", async () => {
			// Create a database with some products having non-numeric or null values
			const productsWithNulls = [
				{ id: "p1", name: "A", price: 10, category: "cat", stock: 100 },
				{
					id: "p2",
					name: "B",
					price: null as unknown as number,
					category: "cat",
					stock: 50,
				},
				{ id: "p3", name: "C", price: 20, category: "cat", stock: 75 },
			];
			const db = await Effect.runPromise(
				createEffectDatabase(config, { products: productsWithNulls }),
			);
			const result = await db.products.aggregate({ sum: "price" }).runPromise;
			// Only 10 + 20 = 30 (null is skipped)
			expect(result.sum?.price).toBe(30);
		});

		it("5.7 sum on empty result set → 0", async () => {
			const db = await createEmptyDb();
			const result = await db.products.aggregate({ sum: "price" }).runPromise;
			expect(result.sum?.price).toBe(0);
		});
	});

	describe("avg", () => {
		it("5.8 avg on numeric field → correct mean", async () => {
			const db = await createTestDb();
			const result = await db.products.aggregate({ avg: "price" }).runPromise;
			// (10.00 + 25.50 + 15.75 + 35.00 + 5.25) / 5 = 91.50 / 5 = 18.30
			expect(result.avg?.price).toBeCloseTo(18.3);
		});

		it("5.9 avg with all non-numeric → null", async () => {
			// All prices are null/undefined/strings
			const productsAllNonNumeric = [
				{
					id: "p1",
					name: "A",
					price: null as unknown as number,
					category: "cat",
					stock: 100,
				},
				{
					id: "p2",
					name: "B",
					price: undefined as unknown as number,
					category: "cat",
					stock: 50,
				},
				{
					id: "p3",
					name: "C",
					price: "not a number" as unknown as number,
					category: "cat",
					stock: 75,
				},
			];
			const db = await Effect.runPromise(
				createEffectDatabase(config, { products: productsAllNonNumeric }),
			);
			const result = await db.products.aggregate({ avg: "price" }).runPromise;
			expect(result.avg?.price).toBeNull();
		});

		it("5.10 avg on empty result set → null", async () => {
			const db = await createEmptyDb();
			const result = await db.products.aggregate({ avg: "price" }).runPromise;
			expect(result.avg?.price).toBeNull();
		});
	});

	describe("min/max", () => {
		it("5.11 min/max on numeric field → correct extremes", async () => {
			const db = await createTestDb();
			const result = await db.products.aggregate({
				min: "price",
				max: "price",
			}).runPromise;
			expect(result.min?.price).toBe(5.25);
			expect(result.max?.price).toBe(35.0);
		});

		it("5.12 min/max on string field → lexicographic comparison", async () => {
			const db = await createTestDb();
			const result = await db.products.aggregate({
				min: "name",
				max: "name",
			}).runPromise;
			expect(result.min?.name).toBe("Gadget X"); // G < T < W
			expect(result.max?.name).toBe("Widget B");
		});

		it("5.13 min/max on empty result set → undefined", async () => {
			const db = await createEmptyDb();
			const result = await db.products.aggregate({
				min: "price",
				max: "price",
			}).runPromise;
			expect(result.min?.price).toBeUndefined();
			expect(result.max?.price).toBeUndefined();
		});
	});

	describe("multiple aggregations", () => {
		it("5.14 multiple aggregations in one call → all present in result", async () => {
			const db = await createTestDb();
			const result = await db.products.aggregate({
				count: true,
				sum: "price",
				avg: "price",
				min: "price",
				max: "price",
			}).runPromise;

			expect(result.count).toBe(5);
			expect(result.sum?.price).toBeCloseTo(91.5);
			expect(result.avg?.price).toBeCloseTo(18.3);
			expect(result.min?.price).toBe(5.25);
			expect(result.max?.price).toBe(35.0);
		});

		it("5.15 multiple fields per aggregation → all fields computed", async () => {
			const db = await createTestDb();
			const result = await db.products.aggregate({
				sum: ["price", "stock"],
				avg: ["price", "stock"],
			}).runPromise;

			// Sum of prices: 91.50
			expect(result.sum?.price).toBeCloseTo(91.5);
			// Sum of stock: 100 + 50 + 75 + 25 + 200 = 450
			expect(result.sum?.stock).toBe(450);

			// Avg of prices: 18.30
			expect(result.avg?.price).toBeCloseTo(18.3);
			// Avg of stock: 450 / 5 = 90
			expect(result.avg?.stock).toBe(90);
		});
	});

	describe("groupBy", () => {
		it("6.1 single-field groupBy with count → correct group counts", async () => {
			const db = await createTestDb();
			const result = await db.products.aggregate({
				groupBy: "category",
				count: true,
			}).runPromise;

			// Test data has: electronics (2), gadgets (2), tools (1)
			expect(result).toHaveLength(3);

			// Find each group and verify count
			const electronics = result.find(
				(g) => g.group.category === "electronics",
			);
			const gadgets = result.find((g) => g.group.category === "gadgets");
			const tools = result.find((g) => g.group.category === "tools");

			expect(electronics?.count).toBe(2);
			expect(gadgets?.count).toBe(2);
			expect(tools?.count).toBe(1);
		});

		it("6.2 single-field groupBy with sum → correct group sums", async () => {
			const db = await createTestDb();
			const result = await db.products.aggregate({
				groupBy: "category",
				sum: "price",
			}).runPromise;

			// Test data:
			// electronics: p1 (10.00) + p2 (25.50) = 35.50
			// gadgets: p3 (15.75) + p4 (35.00) = 50.75
			// tools: p5 (5.25) = 5.25
			expect(result).toHaveLength(3);

			const electronics = result.find(
				(g) => g.group.category === "electronics",
			);
			const gadgets = result.find((g) => g.group.category === "gadgets");
			const tools = result.find((g) => g.group.category === "tools");

			expect(electronics?.sum?.price).toBeCloseTo(35.5);
			expect(gadgets?.sum?.price).toBeCloseTo(50.75);
			expect(tools?.sum?.price).toBeCloseTo(5.25);
		});

		it("6.3 multi-field groupBy → correct group partitioning", async () => {
			// Create data with multiple grouping dimensions
			// category + stock level (high: >50, low: <=50)
			// We'll use a "tier" field to create meaningful multi-field groups
			const multiGroupProducts = [
				{
					id: "p1",
					name: "Widget A",
					price: 10.0,
					category: "electronics",
					stock: 100,
				},
				{
					id: "p2",
					name: "Widget B",
					price: 25.5,
					category: "electronics",
					stock: 50,
				},
				{
					id: "p3",
					name: "Gadget X",
					price: 15.75,
					category: "electronics",
					stock: 100,
				},
				{
					id: "p4",
					name: "Gadget Y",
					price: 35.0,
					category: "gadgets",
					stock: 50,
				},
				{
					id: "p5",
					name: "Tool Z",
					price: 5.25,
					category: "gadgets",
					stock: 100,
				},
			];
			const db = await Effect.runPromise(
				createEffectDatabase(config, { products: multiGroupProducts }),
			);

			const result = await db.products.aggregate({
				groupBy: ["category", "stock"],
				count: true,
			}).runPromise;

			// Expected groups:
			// (electronics, 100): p1, p3 → count: 2
			// (electronics, 50): p2 → count: 1
			// (gadgets, 50): p4 → count: 1
			// (gadgets, 100): p5 → count: 1
			expect(result).toHaveLength(4);

			const elec100 = result.find(
				(g) => g.group.category === "electronics" && g.group.stock === 100,
			);
			const elec50 = result.find(
				(g) => g.group.category === "electronics" && g.group.stock === 50,
			);
			const gadget50 = result.find(
				(g) => g.group.category === "gadgets" && g.group.stock === 50,
			);
			const gadget100 = result.find(
				(g) => g.group.category === "gadgets" && g.group.stock === 100,
			);

			expect(elec100?.count).toBe(2);
			expect(elec50?.count).toBe(1);
			expect(gadget50?.count).toBe(1);
			expect(gadget100?.count).toBe(1);
		});

		it("6.4 groupBy with where → groups from filtered subset only", async () => {
			const db = await createTestDb();
			const result = await db.products.aggregate({
				groupBy: "category",
				count: true,
				sum: "price",
				where: { price: { $gt: 20 } },
			}).runPromise;

			// Test data with price > 20:
			// p2 (electronics, 25.50)
			// p4 (gadgets, 35.00)
			// tools category (p5, 5.25) is EXCLUDED — no group should exist

			expect(result).toHaveLength(2);

			const electronics = result.find(
				(g) => g.group.category === "electronics",
			);
			const gadgets = result.find((g) => g.group.category === "gadgets");
			const tools = result.find((g) => g.group.category === "tools");

			// electronics: 1 item (p2), sum = 25.50
			expect(electronics?.count).toBe(1);
			expect(electronics?.sum?.price).toBeCloseTo(25.5);

			// gadgets: 1 item (p4), sum = 35.00
			expect(gadgets?.count).toBe(1);
			expect(gadgets?.sum?.price).toBeCloseTo(35.0);

			// tools: should NOT exist as a group
			expect(tools).toBeUndefined();
		});

		it("6.5 null grouping field value → forms own group", async () => {
			// Create products with null/undefined category values
			const productsWithNulls = [
				{
					id: "p1",
					name: "Widget A",
					price: 10.0,
					category: "electronics",
					stock: 100,
				},
				{
					id: "p2",
					name: "Widget B",
					price: 25.5,
					category: null as unknown as string,
					stock: 50,
				},
				{
					id: "p3",
					name: "Gadget X",
					price: 15.75,
					category: "electronics",
					stock: 75,
				},
				{
					id: "p4",
					name: "Gadget Y",
					price: 35.0,
					category: null as unknown as string,
					stock: 25,
				},
				{
					id: "p5",
					name: "Tool Z",
					price: 5.25,
					category: "tools",
					stock: 200,
				},
			];
			const db = await Effect.runPromise(
				createEffectDatabase(config, { products: productsWithNulls }),
			);

			const result = await db.products.aggregate({
				groupBy: "category",
				count: true,
				sum: "price",
			}).runPromise;

			// Expected groups:
			// electronics: p1, p3 → count: 2, sum: 10.00 + 15.75 = 25.75
			// null: p2, p4 → count: 2, sum: 25.50 + 35.00 = 60.50
			// tools: p5 → count: 1, sum: 5.25
			expect(result).toHaveLength(3);

			const electronics = result.find(
				(g) => g.group.category === "electronics",
			);
			const nullGroup = result.find((g) => g.group.category === null);
			const tools = result.find((g) => g.group.category === "tools");

			expect(electronics?.count).toBe(2);
			expect(electronics?.sum?.price).toBeCloseTo(25.75);

			expect(nullGroup?.count).toBe(2);
			expect(nullGroup?.sum?.price).toBeCloseTo(60.5);

			expect(tools?.count).toBe(1);
			expect(tools?.sum?.price).toBeCloseTo(5.25);
		});

		it("6.6 empty result (no matches) → empty array", async () => {
			const db = await createTestDb();
			// Use a where clause that matches nothing
			const result = await db.products.aggregate({
				groupBy: "category",
				count: true,
				where: { price: { $gt: 1000 } }, // No products have price > 1000
			}).runPromise;

			expect(result).toEqual([]);
		});

		it("6.7 groupBy with all aggregate types → all present per group", async () => {
			const db = await createTestDb();
			const result = await db.products.aggregate({
				groupBy: "category",
				count: true,
				sum: "price",
				avg: "price",
				min: "price",
				max: "price",
			}).runPromise;

			// Test data by category:
			// electronics: p1 (10.00), p2 (25.50) → count: 2, sum: 35.50, avg: 17.75, min: 10.00, max: 25.50
			// gadgets: p3 (15.75), p4 (35.00) → count: 2, sum: 50.75, avg: 25.375, min: 15.75, max: 35.00
			// tools: p5 (5.25) → count: 1, sum: 5.25, avg: 5.25, min: 5.25, max: 5.25

			expect(result).toHaveLength(3);

			const electronics = result.find(
				(g) => g.group.category === "electronics",
			);
			const gadgets = result.find((g) => g.group.category === "gadgets");
			const tools = result.find((g) => g.group.category === "tools");

			// Verify all aggregate types are present for electronics
			expect(electronics?.count).toBe(2);
			expect(electronics?.sum?.price).toBeCloseTo(35.5);
			expect(electronics?.avg?.price).toBeCloseTo(17.75);
			expect(electronics?.min?.price).toBe(10.0);
			expect(electronics?.max?.price).toBe(25.5);

			// Verify all aggregate types are present for gadgets
			expect(gadgets?.count).toBe(2);
			expect(gadgets?.sum?.price).toBeCloseTo(50.75);
			expect(gadgets?.avg?.price).toBeCloseTo(25.375);
			expect(gadgets?.min?.price).toBe(15.75);
			expect(gadgets?.max?.price).toBe(35.0);

			// Verify all aggregate types are present for tools
			expect(tools?.count).toBe(1);
			expect(tools?.sum?.price).toBeCloseTo(5.25);
			expect(tools?.avg?.price).toBeCloseTo(5.25);
			expect(tools?.min?.price).toBe(5.25);
			expect(tools?.max?.price).toBe(5.25);
		});

		it("6.8 group ordering → matches first-encounter order", async () => {
			// Create products in a specific order that differs from alphabetical
			// First encounter order should be: tools, gadgets, electronics
			const orderedProducts = [
				{ id: "p1", name: "Tool A", price: 5.0, category: "tools", stock: 100 },
				{
					id: "p2",
					name: "Gadget A",
					price: 15.0,
					category: "gadgets",
					stock: 50,
				},
				{
					id: "p3",
					name: "Gadget B",
					price: 25.0,
					category: "gadgets",
					stock: 75,
				},
				{
					id: "p4",
					name: "Widget A",
					price: 10.0,
					category: "electronics",
					stock: 25,
				},
				{ id: "p5", name: "Tool B", price: 8.0, category: "tools", stock: 200 },
				{
					id: "p6",
					name: "Widget B",
					price: 20.0,
					category: "electronics",
					stock: 150,
				},
			];
			const db = await Effect.runPromise(
				createEffectDatabase(config, { products: orderedProducts }),
			);

			const result = await db.products.aggregate({
				groupBy: "category",
				count: true,
			}).runPromise;

			// Verify the order matches first-encounter: tools, gadgets, electronics
			// NOT alphabetical (electronics, gadgets, tools)
			expect(result).toHaveLength(3);
			expect(result[0].group.category).toBe("tools");
			expect(result[1].group.category).toBe("gadgets");
			expect(result[2].group.category).toBe("electronics");

			// Also verify counts are correct
			expect(result[0].count).toBe(2); // tools: p1, p5
			expect(result[1].count).toBe(2); // gadgets: p2, p3
			expect(result[2].count).toBe(2); // electronics: p4, p6
		});
	});
});
