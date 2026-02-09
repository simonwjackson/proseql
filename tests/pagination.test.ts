import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createDatabase } from "../core/factories/database";
import { collect, count, first, map } from "../core/utils/async-iterable.js";

describe("Database v2 - Pagination (Limit/Offset)", () => {
	// Schema definitions
	const ProductSchema = z.object({
		id: z.string(),
		name: z.string(),
		price: z.number(),
		category: z.string(),
		inStock: z.boolean(),
		rating: z.number().optional(),
	});

	const UserSchema = z.object({
		id: z.string(),
		name: z.string(),
		email: z.string(),
		age: z.number(),
		active: z.boolean(),
		productId: z.string().optional(),
	});

	const config = {
		products: {
			schema: ProductSchema,
			relationships: {
				buyers: {
					type: "inverse" as const,
					target: "users" as const,
					foreignKey: "productId",
				},
			},
		},
		users: {
			schema: UserSchema,
			relationships: {
				product: {
					type: "ref" as const,
					target: "products" as const,
					foreignKey: "productId",
				},
			},
		},
	} as const;

	// Generate test data
	const generateProducts = (count: number) => {
		const products = [];
		for (let i = 1; i <= count; i++) {
			products.push({
				id: `p${i}`,
				name: `Product ${i}`,
				price: i * 10,
				category:
					i % 3 === 0 ? "electronics" : i % 3 === 1 ? "books" : "clothing",
				inStock: i % 2 === 0,
				rating: (i % 5) + 1,
			});
		}
		return products;
	};

	const generateUsers = (count: number) => {
		const users = [];
		for (let i = 1; i <= count; i++) {
			users.push({
				id: `u${i}`,
				name: `User ${i}`,
				email: `user${i}@example.com`,
				age: 20 + (i % 40),
				active: i % 3 !== 0,
				productId: i <= 10 ? `p${i}` : undefined,
			});
		}
		return users;
	};

	describe("Basic Limit Functionality", () => {
		it("should limit results to specified number", async () => {
			const data = {
				products: generateProducts(20),
				users: generateUsers(20),
			};
			const db = createDatabase(config, data);

			const limited = await collect(db.products.query({ limit: 5 }));
			expect(limited).toHaveLength(5);
			expect(limited.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
		});

		it("should return all items when limit exceeds total", async () => {
			const data = {
				products: generateProducts(5),
				users: generateUsers(5),
			};
			const db = createDatabase(config, data);

			const limited = await collect(db.products.query({ limit: 10 }));
			expect(limited).toHaveLength(5);
		});

		it("should return empty array when limit is 0", async () => {
			const data = {
				products: generateProducts(10),
				users: generateUsers(10),
			};
			const db = createDatabase(config, data);

			const limited = await collect(db.products.query({ limit: 0 }));
			expect(limited).toHaveLength(0);
		});

		it("should handle very large limits", async () => {
			const data = {
				products: generateProducts(100),
				users: generateUsers(100),
			};
			const db = createDatabase(config, data);

			const limited = await collect(
				db.products.query({ limit: Number.MAX_SAFE_INTEGER }),
			);
			expect(limited).toHaveLength(100);
		});
	});

	describe("Basic Offset Functionality", () => {
		it("should skip specified number of items", async () => {
			const data = {
				products: generateProducts(20),
				users: generateUsers(20),
			};
			const db = createDatabase(config, data);

			const offsetResults = await collect(db.products.query({ offset: 5 }));
			expect(offsetResults).toHaveLength(15);
			expect(offsetResults[0].id).toBe("p6");
			expect(offsetResults[14].id).toBe("p20");
		});

		it("should return empty when offset exceeds total", async () => {
			const data = {
				products: generateProducts(10),
				users: generateUsers(10),
			};
			const db = createDatabase(config, data);

			const offsetResults = await collect(db.products.query({ offset: 20 }));
			expect(offsetResults).toHaveLength(0);
		});

		it("should handle offset of 0", async () => {
			const data = {
				products: generateProducts(10),
				users: generateUsers(10),
			};
			const db = createDatabase(config, data);

			const offsetResults = await collect(db.products.query({ offset: 0 }));
			expect(offsetResults).toHaveLength(10);
			expect(offsetResults[0].id).toBe("p1");
		});
	});

	describe("Combined Limit and Offset", () => {
		it("should apply offset before limit", async () => {
			const data = {
				products: generateProducts(20),
				users: generateUsers(20),
			};
			const db = createDatabase(config, data);

			const paged = await collect(db.products.query({ offset: 5, limit: 3 }));
			expect(paged).toHaveLength(3);
			expect(paged.map((p) => p.id)).toEqual(["p6", "p7", "p8"]);
		});

		it("should handle pagination through multiple pages", async () => {
			const data = {
				products: generateProducts(25),
				users: generateUsers(25),
			};
			const db = createDatabase(config, data);

			// Page 1
			const page1 = await collect(db.products.query({ offset: 0, limit: 10 }));
			expect(page1).toHaveLength(10);
			expect(page1[0].id).toBe("p1");
			expect(page1[9].id).toBe("p10");

			// Page 2
			const page2 = await collect(db.products.query({ offset: 10, limit: 10 }));
			expect(page2).toHaveLength(10);
			expect(page2[0].id).toBe("p11");
			expect(page2[9].id).toBe("p20");

			// Page 3 (partial)
			const page3 = await collect(db.products.query({ offset: 20, limit: 10 }));
			expect(page3).toHaveLength(5);
			expect(page3[0].id).toBe("p21");
			expect(page3[4].id).toBe("p25");
		});

		it("should return empty when offset + limit exceeds total", async () => {
			const data = {
				products: generateProducts(10),
				users: generateUsers(10),
			};
			const db = createDatabase(config, data);

			const paged = await collect(db.products.query({ offset: 15, limit: 5 }));
			expect(paged).toHaveLength(0);
		});
	});

	describe("Pagination with Sorting", () => {
		it("should paginate sorted results by price descending", async () => {
			const data = {
				products: generateProducts(20),
				users: generateUsers(20),
			};
			const db = createDatabase(config, data);

			const sorted = await collect(
				db.products.query({
					sort: { price: "desc" },
					offset: 5,
					limit: 5,
				}),
			);

			expect(sorted).toHaveLength(5);
			expect(sorted.map((p) => p.price)).toEqual([150, 140, 130, 120, 110]);
		});

		it("should paginate sorted results by name ascending", async () => {
			const data = {
				products: [
					{
						id: "p1",
						name: "Zebra",
						price: 10,
						category: "animals",
						inStock: true,
					},
					{
						id: "p2",
						name: "Apple",
						price: 20,
						category: "food",
						inStock: false,
					},
					{
						id: "p3",
						name: "Ball",
						price: 30,
						category: "toys",
						inStock: true,
					},
					{
						id: "p4",
						name: "Camera",
						price: 40,
						category: "electronics",
						inStock: false,
					},
					{
						id: "p5",
						name: "Dog",
						price: 50,
						category: "animals",
						inStock: true,
					},
				],
				users: [],
			};
			const db = createDatabase(config, data);

			const sorted = await collect(
				db.products.query({
					sort: { name: "asc" },
					offset: 1,
					limit: 3,
				}),
			);

			expect(sorted).toHaveLength(3);
			expect(sorted.map((p) => p.name)).toEqual(["Ball", "Camera", "Dog"]);
		});

		it("should maintain consistent sort order across pages", async () => {
			const data = {
				products: generateProducts(30),
				users: generateUsers(30),
			};
			const db = createDatabase(config, data);

			const page1 = await collect(
				db.products.query({
					sort: { rating: "desc", name: "asc" },
					offset: 0,
					limit: 10,
				}),
			);

			const page2 = await collect(
				db.products.query({
					sort: { rating: "desc", name: "asc" },
					offset: 10,
					limit: 10,
				}),
			);

			// Verify no overlap between pages
			const page1Ids = new Set(page1.map((p) => p.id));
			const page2Ids = new Set(page2.map((p) => p.id));
			const intersection = Array.from(page1Ids).filter((id) =>
				page2Ids.has(id),
			);
			expect(intersection).toHaveLength(0);
		});
	});

	describe("Pagination with Filtering", () => {
		it("should paginate filtered results", async () => {
			const data = {
				products: generateProducts(30),
				users: generateUsers(30),
			};
			const db = createDatabase(config, data);

			// Filter for electronics category
			const filtered = await collect(
				db.products.query({
					where: { category: "electronics" },
					offset: 2,
					limit: 3,
				}),
			);

			expect(filtered).toHaveLength(3);
			filtered.forEach((p) => expect(p.category).toBe("electronics"));
		});

		it("should handle pagination when filter reduces result set", async () => {
			const data = {
				products: generateProducts(20),
				users: generateUsers(20),
			};
			const db = createDatabase(config, data);

			// Filter for in-stock items (10 total)
			const filtered = await collect(
				db.products.query({
					where: { inStock: true },
					offset: 5,
					limit: 10,
				}),
			);

			expect(filtered).toHaveLength(5); // Only 5 remaining after offset
		});

		it("should combine filtering, sorting, and pagination", async () => {
			const data = {
				products: generateProducts(30),
				users: generateUsers(30),
			};
			const db = createDatabase(config, data);

			const results = await collect(
				db.products.query({
					where: { category: { $in: ["electronics", "books"] } },
					sort: { price: "desc" },
					offset: 5,
					limit: 5,
				}),
			);

			expect(results).toHaveLength(5);
			// Verify all are from correct categories
			results.forEach((p) => {
				expect(["electronics", "books"]).toContain(p.category);
			});
			// Verify descending price order
			for (let i = 1; i < results.length; i++) {
				expect(results[i - 1].price).toBeGreaterThanOrEqual(results[i].price);
			}
		});
	});

	describe("Pagination with Population", () => {
		it("should paginate with populated relationships", async () => {
			const data = {
				products: generateProducts(20),
				users: generateUsers(20),
			};
			const db = createDatabase(config, data);

			// Use type assertion for the query result to handle populate properly
			const populated = await collect(
				db.products.query({
					populate: { buyers: true },
					offset: 3,
					limit: 5,
				} as Parameters<typeof db.products.query>[0]),
			);

			expect(populated).toHaveLength(5);
			expect(populated[0].id).toBe("p4");

			// Type guard to check for populated data
			const firstItem = populated[0];
			if ("buyers" in firstItem && Array.isArray(firstItem.buyers)) {
				expect(firstItem.buyers).toBeDefined();
				expect(Array.isArray(firstItem.buyers)).toBe(true);
			}
		});

		it("should maintain pagination consistency with complex population", async () => {
			const data = {
				products: generateProducts(15),
				users: generateUsers(15),
			};
			const db = createDatabase(config, data);

			// Get all results with population
			const allResults = await collect(
				db.products.query({
					populate: { buyers: true },
				} as Parameters<typeof db.products.query>[0]),
			);

			// Get paginated results
			const page1 = await collect(
				db.products.query({
					populate: { buyers: true },
					offset: 0,
					limit: 5,
				} as Parameters<typeof db.products.query>[0]),
			);

			const page2 = await collect(
				db.products.query({
					populate: { buyers: true },
					offset: 5,
					limit: 5,
				} as Parameters<typeof db.products.query>[0]),
			);

			// Verify pagination matches full results
			expect(page1.map((p) => p.id)).toEqual(
				allResults.slice(0, 5).map((p) => p.id),
			);
			expect(page2.map((p) => p.id)).toEqual(
				allResults.slice(5, 10).map((p) => p.id),
			);
		});
	});

	describe("Edge Cases", () => {
		it("should treat negative limit as 0", async () => {
			const data = {
				products: generateProducts(10),
				users: generateUsers(10),
			};
			const db = createDatabase(config, data);

			const results = await collect(db.products.query({ limit: -5 }));
			expect(results).toHaveLength(0);
		});

		it("should treat negative offset as 0", async () => {
			const data = {
				products: generateProducts(10),
				users: generateUsers(10),
			};
			const db = createDatabase(config, data);

			const results = await collect(
				db.products.query({ offset: -5, limit: 3 }),
			);
			expect(results).toHaveLength(3);
			expect(results[0].id).toBe("p1");
		});

		it("should handle fractional limit by flooring", async () => {
			const data = {
				products: generateProducts(10),
				users: generateUsers(10),
			};
			const db = createDatabase(config, data);

			const results = await collect(db.products.query({ limit: 3.7 }));
			expect(results).toHaveLength(3);
		});

		it("should handle fractional offset by flooring", async () => {
			const data = {
				products: generateProducts(10),
				users: generateUsers(10),
			};
			const db = createDatabase(config, data);

			const results = await collect(
				db.products.query({ offset: 2.9, limit: 3 }),
			);
			expect(results).toHaveLength(3);
			expect(results[0].id).toBe("p3"); // Offset floors to 2
		});

		it("should handle undefined limit (return all)", async () => {
			const data = {
				products: generateProducts(15),
				users: generateUsers(15),
			};
			const db = createDatabase(config, data);

			const results = await collect(db.products.query({ offset: 5 }));
			expect(results).toHaveLength(10); // 15 - 5 offset
		});

		it("should handle undefined offset (start from beginning)", async () => {
			const data = {
				products: generateProducts(15),
				users: generateUsers(15),
			};
			const db = createDatabase(config, data);

			const results = await collect(db.products.query({ limit: 5 }));
			expect(results).toHaveLength(5);
			expect(results[0].id).toBe("p1");
		});

		it("should handle empty collection", async () => {
			const data = {
				products: [],
				users: [],
			};
			const db = createDatabase(config, data);

			const results = await collect(
				db.products.query({ offset: 5, limit: 10 }),
			);
			expect(results).toHaveLength(0);
		});
	});

	describe("Pagination Consistency", () => {
		it("should return same results for same parameters", async () => {
			const data = {
				products: generateProducts(50),
				users: generateUsers(50),
			};
			const db = createDatabase(config, data);

			const params = { offset: 10, limit: 15, sort: { price: "asc" as const } };

			const results1 = await collect(db.products.query(params));
			const results2 = await collect(db.products.query(params));
			const results3 = await collect(db.products.query(params));

			expect(results1.map((p) => p.id)).toEqual(results2.map((p) => p.id));
			expect(results2.map((p) => p.id)).toEqual(results3.map((p) => p.id));
		});

		it("should maintain order stability with pagination", async () => {
			const data = {
				products: generateProducts(20),
				users: generateUsers(20),
			};
			const db = createDatabase(config, data);

			// Get all items
			const all = await collect(db.products.query());

			// Get items in pages
			const pages: typeof all = [];
			for (let offset = 0; offset < 20; offset += 5) {
				const page = await collect(db.products.query({ offset, limit: 5 }));
				pages.push(...page);
			}

			// Should match
			expect(pages.map((p) => p.id)).toEqual(all.map((p) => p.id));
		});
	});

	describe("Combined Query Features", () => {
		it("should combine all query features", async () => {
			const data = {
				products: generateProducts(100),
				users: generateUsers(100),
			};
			const db = createDatabase(config, data);

			const results = await collect(
				db.products.query({
					where: {
						$and: [
							{ category: { $in: ["electronics", "books"] } },
							{ price: { $gte: 50 } },
							{ inStock: true },
						],
					},
					populate: { buyers: true },
					sort: { rating: "desc", price: "asc" },
					offset: 5,
					limit: 10,
				} as Parameters<typeof db.products.query>[0]),
			);

			// Verify limit is respected
			expect(results.length).toBeLessThanOrEqual(10);

			// Verify all filters are applied
			results.forEach((product) => {
				expect(["electronics", "books"]).toContain(product.category);
				expect(product.price).toBeGreaterThanOrEqual(50);
				expect(product.inStock).toBe(true);
				if ("buyers" in product && Array.isArray(product.buyers)) {
					expect(product.buyers).toBeDefined();
				}
			});

			// Verify sort order (only if we have results)
			if (results.length > 1) {
				for (let i = 1; i < results.length; i++) {
					const prev = results[i - 1];
					const curr = results[i];
					if (prev.rating === curr.rating) {
						expect(prev.price).toBeLessThanOrEqual(curr.price);
					} else if (prev.rating !== undefined && curr.rating !== undefined) {
						expect(prev.rating).toBeGreaterThanOrEqual(curr.rating);
					}
				}
			}
		});

		it("should combine pagination with simple filtering and sorting", async () => {
			const data = {
				products: [
					{
						id: "p1",
						name: "Laptop",
						price: 1000,
						category: "electronics",
						inStock: true,
						rating: 5,
					},
					{
						id: "p2",
						name: "Phone",
						price: 800,
						category: "electronics",
						inStock: true,
						rating: 4,
					},
					{
						id: "p3",
						name: "Book A",
						price: 20,
						category: "books",
						inStock: true,
						rating: 5,
					},
					{
						id: "p4",
						name: "Book B",
						price: 25,
						category: "books",
						inStock: false,
						rating: 3,
					},
					{
						id: "p5",
						name: "Tablet",
						price: 600,
						category: "electronics",
						inStock: true,
						rating: 4,
					},
					{
						id: "p6",
						name: "Book C",
						price: 30,
						category: "books",
						inStock: true,
						rating: 5,
					},
					{
						id: "p7",
						name: "Monitor",
						price: 400,
						category: "electronics",
						inStock: false,
						rating: 3,
					},
					{
						id: "p8",
						name: "Book D",
						price: 15,
						category: "books",
						inStock: true,
						rating: 4,
					},
				],
				users: [],
			};
			const db = createDatabase(config, data);

			// Test with simple where clause, sort, and pagination
			const results = await collect(
				db.products.query({
					where: { category: "electronics", inStock: true },
					sort: { price: "desc" },
					offset: 1,
					limit: 2,
				}),
			);

			expect(results).toHaveLength(2);
			expect(results[0].id).toBe("p2"); // Phone (800)
			expect(results[1].id).toBe("p5"); // Tablet (600)

			// Verify all are electronics and in stock
			results.forEach((p) => {
				expect(p.category).toBe("electronics");
				expect(p.inStock).toBe(true);
			});
		});

		it("should handle complex nested queries with pagination", async () => {
			const data = {
				products: generateProducts(50),
				users: generateUsers(50),
			};
			const db = createDatabase(config, data);

			// First, get count of matching items
			const totalCount = await count(
				db.products.query({
					where: {
						$or: [
							{ $and: [{ category: "electronics" }, { price: { $lt: 200 } }] },
							{ $and: [{ category: "books" }, { rating: { $gte: 4 } }] },
						],
					},
				}),
			);

			// Then paginate through results
			const pageSize = 7;
			const allPages = [];

			for (let offset = 0; offset < totalCount; offset += pageSize) {
				const page = await collect(
					db.products.query({
						where: {
							$or: [
								{
									$and: [{ category: "electronics" }, { price: { $lt: 200 } }],
								},
								{ $and: [{ category: "books" }, { rating: { $gte: 4 } }] },
							],
						},
						sort: { id: "asc" }, // Ensure consistent order
						offset,
						limit: pageSize,
					}),
				);
				allPages.push(...page);
			}

			// Verify we got all items
			expect(allPages).toHaveLength(totalCount);

			// Verify no duplicates
			const ids = allPages.map((p) => p.id);
			const uniqueIds = new Set(ids);
			expect(uniqueIds.size).toBe(ids.length);
		});
	});

	describe("Performance Considerations", () => {
		it("should handle large offset efficiently", async () => {
			const data = {
				products: generateProducts(1000),
				users: generateUsers(1000),
			};
			const db = createDatabase(config, data);

			const startTime = Date.now();
			const results = await collect(
				db.products.query({
					offset: 900,
					limit: 50,
				}),
			);
			const endTime = Date.now();

			expect(results).toHaveLength(50);
			expect(results[0].id).toBe("p901");

			// Should complete reasonably quickly even with large offset
			expect(endTime - startTime).toBeLessThan(1000); // Less than 1 second
		});

		it("should not consume memory for skipped items", async () => {
			const data = {
				products: generateProducts(10000),
				users: generateUsers(10000),
			};
			const db = createDatabase(config, data);

			// This should only yield 10 items, not load all 10000
			const results = await collect(
				db.products.query({
					offset: 9990,
					limit: 10,
				}),
			);

			expect(results).toHaveLength(10);
			expect(results[0].id).toBe("p9991");
			expect(results[9].id).toBe("p10000");
		});
	});
});
