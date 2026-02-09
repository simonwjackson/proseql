import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createDatabase } from "../core/factories/database";
import { collect, map, first, count } from "../core/utils/async-iterable.js";

describe("Database v2 - Comprehensive Filtering", () => {
	// Main test schema with all field types
	const ProductSchema = z.object({
		id: z.string(),
		name: z.string(),
		price: z.number(),
		inStock: z.boolean(),
		category: z.string(),
		tags: z.array(z.string()).optional(),
		description: z.string().optional(),
		rating: z.number().optional(),
	});

	const UserSchema = z.object({
		id: z.string(),
		name: z.string(),
		email: z.string(),
		age: z.number(),
		active: z.boolean(),
		role: z.string(),
		score: z.number().optional(),
	});

	const config = {
		products: {
			schema: ProductSchema,
			relationships: {},
		},
		users: {
			schema: UserSchema,
			relationships: {},
		},
	};

	const data = {
		products: [
			{
				id: "p1",
				name: "Laptop Pro",
				price: 1299.99,
				inStock: true,
				category: "electronics",
				tags: ["tech", "computer"],
				description: "High-end laptop",
				rating: 4.5,
			},
			{
				id: "p2",
				name: "Laptop Air",
				price: 899.99,
				inStock: false,
				category: "electronics",
				tags: ["tech", "computer", "portable"],
				description: "Lightweight laptop",
				rating: 4.2,
			},
			{
				id: "p3",
				name: "Gaming Mouse",
				price: 79.99,
				inStock: true,
				category: "accessories",
				tags: ["gaming", "peripheral"],
				description: "RGB gaming mouse",
				rating: 4.8,
			},
			{
				id: "p4",
				name: "Wireless Keyboard",
				price: 129.99,
				inStock: true,
				category: "accessories",
				tags: ["wireless", "peripheral"],
				description: "Mechanical keyboard",
				rating: 4.6,
			},
			{
				id: "p5",
				name: "Monitor 4K",
				price: 599.99,
				inStock: false,
				category: "electronics",
				tags: ["display", "4k"],
				description: "Ultra HD monitor",
				rating: 4.7,
			},
			{
				id: "p6",
				name: "USB Cable",
				price: 9.99,
				inStock: true,
				category: "accessories",
				tags: ["cable"],
				description: undefined,
				rating: undefined,
			},
			{
				id: "p7",
				name: "External SSD",
				price: 149.99,
				inStock: true,
				category: "storage",
				tags: [],
				description: "",
				rating: 4.3,
			},
		],
		users: [
			{
				id: "u1",
				name: "Alice Johnson",
				email: "alice@example.com",
				age: 28,
				active: true,
				role: "admin",
				score: 95,
			},
			{
				id: "u2",
				name: "Bob Smith",
				email: "bob@example.com",
				age: 35,
				active: true,
				role: "user",
				score: 82,
			},
			{
				id: "u3",
				name: "Charlie Brown",
				email: "charlie@example.com",
				age: 42,
				active: false,
				role: "user",
				score: undefined,
			},
			{
				id: "u4",
				name: "Diana Prince",
				email: "diana@example.com",
				age: 31,
				active: true,
				role: "moderator",
				score: 88,
			},
			{
				id: "u5",
				name: "Eve Wilson",
				email: "eve@example.com",
				age: 25,
				active: true,
				role: "user",
				score: 76,
			},
		],
	};

	describe("Basic Filtering", () => {
		it("should filter by exact match (implicit $eq)", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: { category: "electronics" },
				}),
			);

			expect(results).toHaveLength(3);
			expect(results.map((r) => r.name).sort()).toEqual([
				"Laptop Air",
				"Laptop Pro",
				"Monitor 4K",
			]);
		});

		it("should filter by boolean fields", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({ where: { active: true } }),
			);

			expect(results).toHaveLength(4);
			expect(results.every((r) => r.active === true)).toBe(true);
		});

		it("should filter by multiple fields (AND logic)", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: {
						category: "accessories",
						inStock: true,
					},
				}),
			);

			expect(results).toHaveLength(3);
			expect(results.map((r) => r.name).sort()).toEqual([
				"Gaming Mouse",
				"USB Cable",
				"Wireless Keyboard",
			]);
		});

		it("should handle empty where clause", async () => {
			const db = createDatabase(config, data);
			const results = await collect(db.products.query({ where: {} }));

			expect(results).toHaveLength(7);
		});

		it("should handle no config at all", async () => {
			const db = createDatabase(config, data);
			const results = await collect(db.products.query());

			expect(results).toHaveLength(7);
		});
	});

	describe("Equality Operators", () => {
		it("should filter with exact match (implicit $eq)", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: { category: "electronics" },
				}),
			);

			expect(results).toHaveLength(3);
			expect(results.map((r) => r.name).sort()).toEqual([
				"Laptop Air",
				"Laptop Pro",
				"Monitor 4K",
			]);
		});

		it("should filter with explicit $eq operator", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					where: { role: { $eq: "admin" } },
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ name: "Alice Johnson" });
		});

		it("should filter with $ne operator", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					where: { role: { $ne: "user" } },
				}),
			);

			expect(results).toHaveLength(2);
			expect(results.map((r) => r.role).sort()).toEqual(["admin", "moderator"]);
		});

		it("should handle $eq with undefined values", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					where: { score: { $eq: undefined } },
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ name: "Charlie Brown" });
		});

		it("should handle $ne with undefined values", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: { rating: { $ne: undefined } },
				}),
			);

			expect(results).toHaveLength(6);
			expect(results.every((r) => r.rating !== undefined)).toBe(true);
		});
	});

	describe("Comparison Operators", () => {
		it("should filter with $gt operator", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: { price: { $gt: 500 } },
				}),
			);

			expect(results).toHaveLength(3);
			expect(results.every((r) => r.price > 500)).toBe(true);
		});

		it("should filter with $gte operator", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					where: { age: { $gte: 35 } },
				}),
			);

			expect(results).toHaveLength(2);
			expect(results.every((r) => r.age >= 35)).toBe(true);
		});

		it("should filter with $lt operator", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					where: { age: { $lt: 30 } },
				}),
			);

			expect(results).toHaveLength(2);
			expect(results.every((r) => r.age < 30)).toBe(true);
		});

		it("should filter with $lte operator", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: { price: { $lte: 79.99 } },
				}),
			);

			expect(results).toHaveLength(2);
			expect(results.every((r) => r.price <= 79.99)).toBe(true);
		});

		it("should handle multiple comparison operators on same field", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: {
						price: {
							$gte: 100,
							$lt: 1000,
						},
					},
				}),
			);

			expect(results).toHaveLength(4);
			expect(results.every((r) => r.price >= 100 && r.price < 1000)).toBe(true);
		});

		it("should filter with comparison operators on rating field", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: {
						rating: {
							$gt: 4.5,
							$lte: 4.8,
						},
					},
				}),
			);

			expect(results).toHaveLength(3);
			const names = results.map((r) => r.name);
			expect(names).toContain("Gaming Mouse");
			expect(names).toContain("Monitor 4K");
			expect(names).toContain("Wireless Keyboard");
		});
	});

	describe("String Operators", () => {
		it("should filter with $startsWith operator", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: { name: { $startsWith: "Laptop" } },
				}),
			);

			expect(results).toHaveLength(2);
			expect(results.map((r) => r.name).sort()).toEqual([
				"Laptop Air",
				"Laptop Pro",
			]);
		});

		it("should filter with $endsWith operator", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					where: { email: { $endsWith: "@example.com" } },
				}),
			);

			expect(results).toHaveLength(5);
			expect(results.every((r) => r.email.endsWith("@example.com"))).toBe(true);
		});

		it("should filter with $contains operator", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: { description: { $contains: "laptop" } },
				}),
			);

			expect(results).toHaveLength(2);
			expect(results.every((r) => r.description?.includes("laptop"))).toBe(
				true,
			);
		});

		it("should handle case-sensitive string operations", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: { name: { $contains: "gaming" } },
				}),
			);

			expect(results).toHaveLength(0);
		});

		it("should handle empty string in string operators", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: { name: { $startsWith: "" } },
				}),
			);

			expect(results).toHaveLength(7);
		});
	});

	describe("Array Operators", () => {
		it("should filter with $in operator", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: {
						category: { $in: ["electronics", "storage"] },
					},
				}),
			);

			expect(results).toHaveLength(4);
			expect(
				results
					.map((r) => r.category)
					.every((c) => ["electronics", "storage"].includes(c)),
			).toBe(true);
		});

		it("should filter with $nin operator", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					where: {
						role: { $nin: ["admin", "moderator"] },
					},
				}),
			);

			expect(results).toHaveLength(3);
			expect(results.every((r) => r.role === "user")).toBe(true);
		});

		it("should handle empty arrays in $in operator", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: {
						category: { $in: [] },
					},
				}),
			);

			expect(results).toHaveLength(0);
		});

		it("should handle empty arrays in $nin operator", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: {
						category: { $nin: [] },
					},
				}),
			);

			expect(results).toHaveLength(7);
		});

		it("should work with $in on numeric fields", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: {
						price: { $in: [79.99, 599.99, 9.99] },
					},
				}),
			);

			expect(results).toHaveLength(3);
			expect(results.map((r) => r.name).sort()).toEqual([
				"Gaming Mouse",
				"Monitor 4K",
				"USB Cable",
			]);
		});
	});

	describe("Combined Operators", () => {
		it("should combine multiple operators on different fields", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: {
						category: "electronics",
						price: { $gt: 1000 },
						inStock: true,
					},
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ name: "Laptop Pro" });
		});

		it("should combine string and comparison operators", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: {
						name: { $startsWith: "L" },
						price: { $gte: 900 },
					},
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ name: "Laptop Pro" });
		});

		it("should handle complex queries with multiple operator types", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: {
						category: { $in: ["electronics", "accessories"] },
						price: { $gte: 50, $lte: 150 },
						inStock: { $eq: true },
						name: { $contains: "e" },
					},
				}),
			);

			expect(results).toHaveLength(2);
			expect(results.map((r) => r.name).sort()).toEqual([
				"Gaming Mouse",
				"Wireless Keyboard",
			]);
		});

		it("should handle all operators on a single field", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.users.query({
					where: {
						age: { $gte: 25, $lte: 35, $ne: 28 },
					},
				}),
			);

			expect(results).toHaveLength(3);
			expect(results.map((r) => r.age).sort()).toEqual([25, 31, 35]);
		});
	});

	describe("Edge Cases", () => {
		it("should handle undefined values in data", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: {
						rating: { $eq: undefined },
					},
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ name: "USB Cable" });
		});

		it("should handle queries with no matches", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: {
						price: { $gt: 10000 },
					},
				}),
			);

			expect(results).toHaveLength(0);
		});

		it("should handle queries with empty where clause", async () => {
			const db = createDatabase(config, data);
			const results = await collect(db.products.query({ where: {} }));

			expect(results).toHaveLength(7);
		});

		it("should handle queries with no config", async () => {
			const db = createDatabase(config, data);
			const results = await collect(db.products.query());

			expect(results).toHaveLength(7);
		});

		it("should handle fields that don't exist", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: {
						nonExistentField: "value",
					} as Record<string, unknown>,
				}),
			);

			expect(results).toHaveLength(0);
		});

		it("should handle empty strings", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: {
						description: { $eq: "" },
					},
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ name: "External SSD" });
		});

		it("should handle boolean field filtering with operators", async () => {
			const db = createDatabase(config, data);
			const results = await collect(
				db.products.query({
					where: {
						inStock: { $eq: false },
					},
				}),
			);

			expect(results).toHaveLength(2);
			expect(results.every((r) => r.inStock === false)).toBe(true);
		});

		it("should handle boolean field filtering correctly", async () => {
			const db = createDatabase(config, data);
			const resultsTrue = await collect(
				db.products.query({
					where: { inStock: true },
				}),
			);
			const resultsFalse = await collect(
				db.products.query({
					where: { inStock: false },
				}),
			);

			expect(resultsTrue).toHaveLength(5);
			expect(resultsFalse).toHaveLength(2);
			expect(resultsTrue.every((r) => r.inStock === true)).toBe(true);
			expect(resultsFalse.every((r) => r.inStock === false)).toBe(true);
		});
	});
});

describe("Database v2 - String Operators Deep Dive", () => {
	const UserSchema = z.object({
		id: z.string(),
		name: z.string(),
		email: z.string(),
		bio: z.string(),
		username: z.string(),
	});

	const ProductSchema = z.object({
		id: z.string(),
		name: z.string(),
		description: z.string(),
		sku: z.string(),
		category: z.string(),
	});

	const CompanySchema = z.object({
		id: z.string(),
		name: z.string(),
		website: z.string(),
		industry: z.string(),
	});

	const dbConfig = {
		users: {
			schema: UserSchema,
			relationships: {},
		},
		products: {
			schema: ProductSchema,
			relationships: {},
		},
		companies: {
			schema: CompanySchema,
			relationships: {},
		},
	} as const;

	const testData = {
		users: [
			{
				id: "u1",
				name: "Alice Johnson",
				email: "alice@example.com",
				bio: "Software developer from Seattle",
				username: "alice_dev",
			},
			{
				id: "u2",
				name: "Bob Smith",
				email: "bob@test.org",
				bio: "Product manager in San Francisco",
				username: "bob_pm",
			},
			{
				id: "u3",
				name: "Charlie Brown",
				email: "charlie@example.org",
				bio: "Designer based in New York",
				username: "charlie_design",
			},
			{
				id: "u4",
				name: "David Lee",
				email: "david@company.com",
				bio: "Marketing specialist from Chicago",
				username: "david_mkt",
			},
			{
				id: "u5",
				name: "Eve Adams",
				email: "eve@example.com",
				bio: "Data scientist in Seattle",
				username: "eve_data",
			},
		],
		products: [
			{
				id: "p1",
				name: "Professional Laptop",
				description: "High-performance laptop for professionals",
				sku: "LAP-PRO-001",
				category: "Electronics",
			},
			{
				id: "p2",
				name: "Wireless Mouse Pro",
				description: "Ergonomic wireless mouse with precision tracking",
				sku: "MOU-WIR-PRO",
				category: "Electronics",
			},
			{
				id: "p3",
				name: "Standing Desk Pro",
				description: "Adjustable standing desk for better posture",
				sku: "DSK-STD-PRO",
				category: "Furniture",
			},
			{
				id: "p4",
				name: "Office Chair Premium",
				description: "Premium ergonomic office chair",
				sku: "CHR-OFF-PRM",
				category: "Furniture",
			},
			{
				id: "p5",
				name: "Laptop Stand",
				description: "Portable laptop stand for better viewing",
				sku: "ACC-LAP-STD",
				category: "Accessories",
			},
		],
		companies: [
			{
				id: "c1",
				name: "TechCorp Inc.",
				website: "https://techcorp.com",
				industry: "Technology",
			},
			{
				id: "c2",
				name: "DesignStudio Pro",
				website: "https://designstudio.pro",
				industry: "Design",
			},
			{
				id: "c3",
				name: "DataTech Solutions",
				website: "https://datatech.io",
				industry: "Technology",
			},
			{
				id: "c4",
				name: "Creative Designs",
				website: "https://creative-designs.com",
				industry: "Design",
			},
			{
				id: "c5",
				name: "ProTech Industries",
				website: "https://protech.com",
				industry: "Manufacturing",
			},
		],
	};

	describe("$startsWith operator", () => {
		it("should filter strings that start with a value", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.users.query({
					where: {
						name: { $startsWith: "Alice" },
					},
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Alice Johnson");
		});

		it("should filter emails by domain", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.users.query({
					where: {
						email: { $startsWith: "alice@" },
					},
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0].email).toBe("alice@example.com");
		});

		it("should be case sensitive", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.users.query({
					where: {
						name: { $startsWith: "alice" },
					},
				}),
			);

			expect(results).toHaveLength(0);
		});

		it("should work with product SKUs", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.products.query({
					where: {
						sku: { $startsWith: "LAP" },
					},
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Professional Laptop");
		});
	});

	describe("$endsWith operator", () => {
		it("should filter strings that end with a value", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.users.query({
					where: {
						email: { $endsWith: ".com" },
					},
				}),
			);

			expect(results).toHaveLength(3);
			expect(results.map((u) => u.name).sort()).toEqual([
				"Alice Johnson",
				"David Lee",
				"Eve Adams",
			]);
		});

		it("should filter usernames by suffix", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.users.query({
					where: {
						username: { $endsWith: "_dev" },
					},
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Alice Johnson");
		});

		it("should work with product names", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.products.query({
					where: {
						name: { $endsWith: "Pro" },
					},
				}),
			);

			expect(results).toHaveLength(2);
			expect(results.map((p) => p.id).sort()).toEqual(["p2", "p3"]);
		});
	});

	describe("$contains operator", () => {
		it("should filter strings containing a value", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.users.query({
					where: {
						bio: { $contains: "Seattle" },
					},
				}),
			);

			expect(results).toHaveLength(2);
			expect(results.map((u) => u.name).sort()).toEqual([
				"Alice Johnson",
				"Eve Adams",
			]);
		});

		it("should find products by description content", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.products.query({
					where: {
						description: { $contains: "ergonomic" },
					},
				}),
			);

			expect(results).toHaveLength(1);
			expect(results.map((p) => p.id).sort()).toEqual(["p4"]);
		});

		it("should work with URLs", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.companies.query({
					where: {
						website: { $contains: ".pro" },
					},
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("DesignStudio Pro");
		});

		it("should handle special characters", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.users.query({
					where: {
						email: { $contains: "@example." },
					},
				}),
			);

			expect(results).toHaveLength(3);
		});
	});

	describe("Combined string operators", () => {
		it("should combine multiple string operators", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.products.query({
					where: {
						name: { $contains: "Pro", $endsWith: "Pro" },
					},
				}),
			);

			expect(results).toHaveLength(2);
		});

		it("should combine string operators with equality", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.products.query({
					where: {
						category: "Electronics",
						name: { $contains: "Pro" },
					},
				}),
			);

			expect(results).toHaveLength(2);
		});

		it("should combine different field operators", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.companies.query({
					where: {
						name: { $endsWith: "Pro" },
						industry: { $startsWith: "Design" },
					},
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("DesignStudio Pro");
		});
	});

	describe("String operator edge cases", () => {
		it("should handle empty search strings", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.users.query({
					where: {
						name: { $contains: "" },
					},
				}),
			);

			expect(results).toHaveLength(5);
		});

		it("should return no results for non-matching patterns", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.users.query({
					where: {
						email: { $startsWith: "xyz" },
					},
				}),
			);

			expect(results).toHaveLength(0);
		});

		it("should work with exact matches using string operators", async () => {
			const db = createDatabase(dbConfig, testData);

			const results = await collect(
				db.users.query({
					where: {
						username: { $startsWith: "alice_dev", $endsWith: "alice_dev" },
					},
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0].username).toBe("alice_dev");
		});
	});
});
