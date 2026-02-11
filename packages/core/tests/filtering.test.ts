import { Chunk, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { applyFilter } from "../src/operations/query/filter-stream";

const collectFiltered = <T extends Record<string, unknown>>(
	data: T[],
	where: Record<string, unknown> | undefined,
): Promise<readonly T[]> =>
	Effect.runPromise(
		Stream.fromIterable(data).pipe(
			applyFilter<T>(where),
			Stream.runCollect,
			Effect.map(Chunk.toReadonlyArray),
		),
	);

describe("Comprehensive Filtering (Stream-based)", () => {
	const products = [
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
			description: undefined as string | undefined,
			rating: undefined as number | undefined,
		},
		{
			id: "p7",
			name: "External SSD",
			price: 149.99,
			inStock: true,
			category: "storage",
			tags: [] as string[],
			description: "",
			rating: 4.3,
		},
	];

	const users = [
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
			score: undefined as number | undefined,
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
	];

	describe("Basic Filtering", () => {
		it("should filter by exact match (implicit $eq)", async () => {
			const results = await collectFiltered(products, {
				category: "electronics",
			});

			expect(results).toHaveLength(3);
			expect(results.map((r) => r.name).sort()).toEqual([
				"Laptop Air",
				"Laptop Pro",
				"Monitor 4K",
			]);
		});

		it("should filter by boolean fields", async () => {
			const results = await collectFiltered(users, { active: true });

			expect(results).toHaveLength(4);
			expect(results.every((r) => r.active === true)).toBe(true);
		});

		it("should filter by multiple fields (AND logic)", async () => {
			const results = await collectFiltered(products, {
				category: "accessories",
				inStock: true,
			});

			expect(results).toHaveLength(3);
			expect(results.map((r) => r.name).sort()).toEqual([
				"Gaming Mouse",
				"USB Cable",
				"Wireless Keyboard",
			]);
		});

		it("should handle empty where clause", async () => {
			const results = await collectFiltered(products, {});

			expect(results).toHaveLength(7);
		});

		it("should handle undefined where clause", async () => {
			const results = await collectFiltered(products, undefined);

			expect(results).toHaveLength(7);
		});
	});

	describe("Equality Operators", () => {
		it("should filter with exact match (implicit $eq)", async () => {
			const results = await collectFiltered(products, {
				category: "electronics",
			});

			expect(results).toHaveLength(3);
			expect(results.map((r) => r.name).sort()).toEqual([
				"Laptop Air",
				"Laptop Pro",
				"Monitor 4K",
			]);
		});

		it("should filter with explicit $eq operator", async () => {
			const results = await collectFiltered(users, {
				role: { $eq: "admin" },
			});

			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ name: "Alice Johnson" });
		});

		it("should filter with $ne operator", async () => {
			const results = await collectFiltered(users, {
				role: { $ne: "user" },
			});

			expect(results).toHaveLength(2);
			expect(results.map((r) => r.role).sort()).toEqual(["admin", "moderator"]);
		});

		it("should handle $eq with undefined values", async () => {
			const results = await collectFiltered(users, {
				score: { $eq: undefined },
			});

			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ name: "Charlie Brown" });
		});

		it("should handle $ne with undefined values", async () => {
			const results = await collectFiltered(products, {
				rating: { $ne: undefined },
			});

			expect(results).toHaveLength(6);
			expect(results.every((r) => r.rating !== undefined)).toBe(true);
		});
	});

	describe("Comparison Operators", () => {
		it("should filter with $gt operator", async () => {
			const results = await collectFiltered(products, {
				price: { $gt: 500 },
			});

			expect(results).toHaveLength(3);
			expect(results.every((r) => (r.price as number) > 500)).toBe(true);
		});

		it("should filter with $gte operator", async () => {
			const results = await collectFiltered(users, {
				age: { $gte: 35 },
			});

			expect(results).toHaveLength(2);
			expect(results.every((r) => (r.age as number) >= 35)).toBe(true);
		});

		it("should filter with $lt operator", async () => {
			const results = await collectFiltered(users, {
				age: { $lt: 30 },
			});

			expect(results).toHaveLength(2);
			expect(results.every((r) => (r.age as number) < 30)).toBe(true);
		});

		it("should filter with $lte operator", async () => {
			const results = await collectFiltered(products, {
				price: { $lte: 79.99 },
			});

			expect(results).toHaveLength(2);
			expect(results.every((r) => (r.price as number) <= 79.99)).toBe(true);
		});

		it("should handle multiple comparison operators on same field", async () => {
			const results = await collectFiltered(products, {
				price: {
					$gte: 100,
					$lt: 1000,
				},
			});

			expect(results).toHaveLength(4);
			expect(
				results.every(
					(r) => (r.price as number) >= 100 && (r.price as number) < 1000,
				),
			).toBe(true);
		});

		it("should filter with comparison operators on rating field", async () => {
			const results = await collectFiltered(products, {
				rating: {
					$gt: 4.5,
					$lte: 4.8,
				},
			});

			expect(results).toHaveLength(3);
			const names = results.map((r) => r.name);
			expect(names).toContain("Gaming Mouse");
			expect(names).toContain("Monitor 4K");
			expect(names).toContain("Wireless Keyboard");
		});
	});

	describe("String Operators", () => {
		it("should filter with $startsWith operator", async () => {
			const results = await collectFiltered(products, {
				name: { $startsWith: "Laptop" },
			});

			expect(results).toHaveLength(2);
			expect(results.map((r) => r.name).sort()).toEqual([
				"Laptop Air",
				"Laptop Pro",
			]);
		});

		it("should filter with $endsWith operator", async () => {
			const results = await collectFiltered(users, {
				email: { $endsWith: "@example.com" },
			});

			expect(results).toHaveLength(5);
			expect(
				results.every((r) => (r.email as string).endsWith("@example.com")),
			).toBe(true);
		});

		it("should filter with $contains operator", async () => {
			const results = await collectFiltered(products, {
				description: { $contains: "laptop" },
			});

			expect(results).toHaveLength(2);
			expect(
				results.every((r) => (r.description as string)?.includes("laptop")),
			).toBe(true);
		});

		it("should handle case-sensitive string operations", async () => {
			const results = await collectFiltered(products, {
				name: { $contains: "gaming" },
			});

			expect(results).toHaveLength(0);
		});

		it("should handle empty string in string operators", async () => {
			const results = await collectFiltered(products, {
				name: { $startsWith: "" },
			});

			expect(results).toHaveLength(7);
		});
	});

	describe("Array Operators", () => {
		it("should filter with $in operator", async () => {
			const results = await collectFiltered(products, {
				category: { $in: ["electronics", "storage"] },
			});

			expect(results).toHaveLength(4);
			expect(
				results
					.map((r) => r.category)
					.every((c) => ["electronics", "storage"].includes(c as string)),
			).toBe(true);
		});

		it("should filter with $nin operator", async () => {
			const results = await collectFiltered(users, {
				role: { $nin: ["admin", "moderator"] },
			});

			expect(results).toHaveLength(3);
			expect(results.every((r) => r.role === "user")).toBe(true);
		});

		it("should handle empty arrays in $in operator", async () => {
			const results = await collectFiltered(products, {
				category: { $in: [] },
			});

			expect(results).toHaveLength(0);
		});

		it("should handle empty arrays in $nin operator", async () => {
			const results = await collectFiltered(products, {
				category: { $nin: [] },
			});

			expect(results).toHaveLength(7);
		});

		it("should work with $in on numeric fields", async () => {
			const results = await collectFiltered(products, {
				price: { $in: [79.99, 599.99, 9.99] },
			});

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
			const results = await collectFiltered(products, {
				category: "electronics",
				price: { $gt: 1000 },
				inStock: true,
			});

			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ name: "Laptop Pro" });
		});

		it("should combine string and comparison operators", async () => {
			const results = await collectFiltered(products, {
				name: { $startsWith: "L" },
				price: { $gte: 900 },
			});

			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ name: "Laptop Pro" });
		});

		it("should handle complex queries with multiple operator types", async () => {
			const results = await collectFiltered(products, {
				category: { $in: ["electronics", "accessories"] },
				price: { $gte: 50, $lte: 150 },
				inStock: { $eq: true },
				name: { $contains: "e" },
			});

			expect(results).toHaveLength(2);
			expect(results.map((r) => r.name).sort()).toEqual([
				"Gaming Mouse",
				"Wireless Keyboard",
			]);
		});

		it("should handle all operators on a single field", async () => {
			const results = await collectFiltered(users, {
				age: { $gte: 25, $lte: 35, $ne: 28 },
			});

			expect(results).toHaveLength(3);
			expect(results.map((r) => r.age).sort()).toEqual([25, 31, 35]);
		});
	});

	describe("Edge Cases", () => {
		it("should handle undefined values in data", async () => {
			const results = await collectFiltered(products, {
				rating: { $eq: undefined },
			});

			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ name: "USB Cable" });
		});

		it("should handle queries with no matches", async () => {
			const results = await collectFiltered(products, {
				price: { $gt: 10000 },
			});

			expect(results).toHaveLength(0);
		});

		it("should handle queries with empty where clause", async () => {
			const results = await collectFiltered(products, {});

			expect(results).toHaveLength(7);
		});

		it("should handle queries with undefined where clause", async () => {
			const results = await collectFiltered(products, undefined);

			expect(results).toHaveLength(7);
		});

		it("should handle fields that don't exist", async () => {
			const results = await collectFiltered(products, {
				nonExistentField: "value",
			});

			expect(results).toHaveLength(0);
		});

		it("should handle empty strings", async () => {
			const results = await collectFiltered(products, {
				description: { $eq: "" },
			});

			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ name: "External SSD" });
		});

		it("should handle boolean field filtering with operators", async () => {
			const results = await collectFiltered(products, {
				inStock: { $eq: false },
			});

			expect(results).toHaveLength(2);
			expect(results.every((r) => r.inStock === false)).toBe(true);
		});

		it("should handle boolean field filtering correctly", async () => {
			const resultsTrue = await collectFiltered(products, {
				inStock: true,
			});
			const resultsFalse = await collectFiltered(products, {
				inStock: false,
			});

			expect(resultsTrue).toHaveLength(5);
			expect(resultsFalse).toHaveLength(2);
			expect(resultsTrue.every((r) => r.inStock === true)).toBe(true);
			expect(resultsFalse.every((r) => r.inStock === false)).toBe(true);
		});
	});
});

describe("String Operators Deep Dive (Stream-based)", () => {
	const users = [
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
	];

	const stringProducts = [
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
	];

	const companies = [
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
	];

	describe("$startsWith operator", () => {
		it("should filter strings that start with a value", async () => {
			const results = await collectFiltered(users, {
				name: { $startsWith: "Alice" },
			});

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Alice Johnson");
		});

		it("should filter emails by domain", async () => {
			const results = await collectFiltered(users, {
				email: { $startsWith: "alice@" },
			});

			expect(results).toHaveLength(1);
			expect(results[0].email).toBe("alice@example.com");
		});

		it("should be case sensitive", async () => {
			const results = await collectFiltered(users, {
				name: { $startsWith: "alice" },
			});

			expect(results).toHaveLength(0);
		});

		it("should work with product SKUs", async () => {
			const results = await collectFiltered(stringProducts, {
				sku: { $startsWith: "LAP" },
			});

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Professional Laptop");
		});
	});

	describe("$endsWith operator", () => {
		it("should filter strings that end with a value", async () => {
			const results = await collectFiltered(users, {
				email: { $endsWith: ".com" },
			});

			expect(results).toHaveLength(3);
			expect(results.map((u) => u.name).sort()).toEqual([
				"Alice Johnson",
				"David Lee",
				"Eve Adams",
			]);
		});

		it("should filter usernames by suffix", async () => {
			const results = await collectFiltered(users, {
				username: { $endsWith: "_dev" },
			});

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Alice Johnson");
		});

		it("should work with product names", async () => {
			const results = await collectFiltered(stringProducts, {
				name: { $endsWith: "Pro" },
			});

			expect(results).toHaveLength(2);
			expect(results.map((p) => p.id).sort()).toEqual(["p2", "p3"]);
		});
	});

	describe("$contains operator", () => {
		it("should filter strings containing a value", async () => {
			const results = await collectFiltered(users, {
				bio: { $contains: "Seattle" },
			});

			expect(results).toHaveLength(2);
			expect(results.map((u) => u.name).sort()).toEqual([
				"Alice Johnson",
				"Eve Adams",
			]);
		});

		it("should find products by description content", async () => {
			const results = await collectFiltered(stringProducts, {
				description: { $contains: "ergonomic" },
			});

			expect(results).toHaveLength(1);
			expect(results.map((p) => p.id).sort()).toEqual(["p4"]);
		});

		it("should work with URLs", async () => {
			const results = await collectFiltered(companies, {
				website: { $contains: ".pro" },
			});

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("DesignStudio Pro");
		});

		it("should handle special characters", async () => {
			const results = await collectFiltered(users, {
				email: { $contains: "@example." },
			});

			expect(results).toHaveLength(3);
		});
	});

	describe("Combined string operators", () => {
		it("should combine multiple string operators", async () => {
			const results = await collectFiltered(stringProducts, {
				name: { $contains: "Pro", $endsWith: "Pro" },
			});

			expect(results).toHaveLength(2);
		});

		it("should combine string operators with equality", async () => {
			const results = await collectFiltered(stringProducts, {
				category: "Electronics",
				name: { $contains: "Pro" },
			});

			expect(results).toHaveLength(2);
		});

		it("should combine different field operators", async () => {
			const results = await collectFiltered(companies, {
				name: { $endsWith: "Pro" },
				industry: { $startsWith: "Design" },
			});

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("DesignStudio Pro");
		});
	});

	describe("String operator edge cases", () => {
		it("should handle empty search strings", async () => {
			const results = await collectFiltered(users, {
				name: { $contains: "" },
			});

			expect(results).toHaveLength(5);
		});

		it("should return no results for non-matching patterns", async () => {
			const results = await collectFiltered(users, {
				email: { $startsWith: "xyz" },
			});

			expect(results).toHaveLength(0);
		});

		it("should work with exact matches using string operators", async () => {
			const results = await collectFiltered(users, {
				username: {
					$startsWith: "alice_dev",
					$endsWith: "alice_dev",
				},
			});

			expect(results).toHaveLength(1);
			expect(results[0].username).toBe("alice_dev");
		});
	});
});
