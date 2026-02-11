import { describe, it, expect } from "vitest";
import { Effect, Stream, Chunk } from "effect";
import { applyPagination } from "../src/operations/query/paginate-stream";
import { applyFilter } from "../src/operations/query/filter-stream";
import { applySort } from "../src/operations/query/sort-stream";

// Helper to run a stream through pagination and collect results
const collectPaginated = <T>(
	data: T[],
	offset: number | undefined,
	limit: number | undefined,
): Promise<readonly T[]> =>
	Effect.runPromise(
		Stream.fromIterable(data).pipe(
			applyPagination(offset, limit),
			Stream.runCollect,
			Effect.map(Chunk.toReadonlyArray),
		),
	);

// Helper to run filter → sort → paginate pipeline and collect results
const collectPipeline = <T extends Record<string, unknown>>(
	data: T[],
	options: {
		where?: Record<string, unknown>;
		sort?: Partial<Record<string, "asc" | "desc">>;
		offset?: number;
		limit?: number;
	},
): Promise<readonly T[]> =>
	Effect.runPromise(
		Stream.fromIterable(data).pipe(
			applyFilter<T>(options.where),
			applySort<T>(options.sort),
			applyPagination(options.offset, options.limit),
			Stream.runCollect,
			Effect.map(Chunk.toReadonlyArray),
		),
	);

describe("Database v2 - Pagination (Stream-based)", () => {
	// ============================================================================
	// Test Data Generators
	// ============================================================================

	interface Product {
		readonly id: string;
		readonly name: string;
		readonly price: number;
		readonly category: string;
		readonly inStock: boolean;
		readonly rating: number;
	}

	const generateProducts = (count: number): Product[] => {
		const products: Product[] = [];
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

	// ============================================================================
	// Basic Limit Functionality
	// ============================================================================

	describe("Basic Limit Functionality", () => {
		it("should limit results to specified number", async () => {
			const products = generateProducts(20);
			const limited = await collectPaginated(products, undefined, 5);
			expect(limited).toHaveLength(5);
			expect(limited.map((p) => p.id)).toEqual([
				"p1",
				"p2",
				"p3",
				"p4",
				"p5",
			]);
		});

		it("should return all items when limit exceeds total", async () => {
			const products = generateProducts(5);
			const limited = await collectPaginated(products, undefined, 10);
			expect(limited).toHaveLength(5);
		});

		it("should return empty array when limit is 0", async () => {
			const products = generateProducts(10);
			const limited = await collectPaginated(products, undefined, 0);
			expect(limited).toHaveLength(0);
		});

		it("should handle very large limits", async () => {
			const products = generateProducts(100);
			const limited = await collectPaginated(
				products,
				undefined,
				Number.MAX_SAFE_INTEGER,
			);
			expect(limited).toHaveLength(100);
		});
	});

	// ============================================================================
	// Basic Offset Functionality
	// ============================================================================

	describe("Basic Offset Functionality", () => {
		it("should skip specified number of items", async () => {
			const products = generateProducts(20);
			const offsetResults = await collectPaginated(products, 5, undefined);
			expect(offsetResults).toHaveLength(15);
			expect(offsetResults[0].id).toBe("p6");
			expect(offsetResults[14].id).toBe("p20");
		});

		it("should return empty when offset exceeds total", async () => {
			const products = generateProducts(10);
			const offsetResults = await collectPaginated(products, 20, undefined);
			expect(offsetResults).toHaveLength(0);
		});

		it("should handle offset of 0", async () => {
			const products = generateProducts(10);
			const offsetResults = await collectPaginated(products, 0, undefined);
			expect(offsetResults).toHaveLength(10);
			expect(offsetResults[0].id).toBe("p1");
		});
	});

	// ============================================================================
	// Combined Limit and Offset
	// ============================================================================

	describe("Combined Limit and Offset", () => {
		it("should apply offset before limit", async () => {
			const products = generateProducts(20);
			const paged = await collectPaginated(products, 5, 3);
			expect(paged).toHaveLength(3);
			expect(paged.map((p) => p.id)).toEqual(["p6", "p7", "p8"]);
		});

		it("should handle pagination through multiple pages", async () => {
			const products = generateProducts(25);

			// Page 1
			const page1 = await collectPaginated(products, 0, 10);
			expect(page1).toHaveLength(10);
			expect(page1[0].id).toBe("p1");
			expect(page1[9].id).toBe("p10");

			// Page 2
			const page2 = await collectPaginated(products, 10, 10);
			expect(page2).toHaveLength(10);
			expect(page2[0].id).toBe("p11");
			expect(page2[9].id).toBe("p20");

			// Page 3 (partial)
			const page3 = await collectPaginated(products, 20, 10);
			expect(page3).toHaveLength(5);
			expect(page3[0].id).toBe("p21");
			expect(page3[4].id).toBe("p25");
		});

		it("should return empty when offset + limit exceeds total", async () => {
			const products = generateProducts(10);
			const paged = await collectPaginated(products, 15, 5);
			expect(paged).toHaveLength(0);
		});
	});

	// ============================================================================
	// Pagination with Sorting
	// ============================================================================

	describe("Pagination with Sorting", () => {
		it("should paginate sorted results by price descending", async () => {
			const products = generateProducts(20);
			const sorted = await collectPipeline(products, {
				sort: { price: "desc" },
				offset: 5,
				limit: 5,
			});

			expect(sorted).toHaveLength(5);
			expect(sorted.map((p) => p.price)).toEqual([150, 140, 130, 120, 110]);
		});

		it("should paginate sorted results by name ascending", async () => {
			const products: Product[] = [
				{
					id: "p1",
					name: "Zebra",
					price: 10,
					category: "animals",
					inStock: true,
					rating: 3,
				},
				{
					id: "p2",
					name: "Apple",
					price: 20,
					category: "food",
					inStock: false,
					rating: 4,
				},
				{
					id: "p3",
					name: "Ball",
					price: 30,
					category: "toys",
					inStock: true,
					rating: 5,
				},
				{
					id: "p4",
					name: "Camera",
					price: 40,
					category: "electronics",
					inStock: false,
					rating: 3,
				},
				{
					id: "p5",
					name: "Dog",
					price: 50,
					category: "animals",
					inStock: true,
					rating: 4,
				},
			];

			const sorted = await collectPipeline(products, {
				sort: { name: "asc" },
				offset: 1,
				limit: 3,
			});

			expect(sorted).toHaveLength(3);
			expect(sorted.map((p) => p.name)).toEqual(["Ball", "Camera", "Dog"]);
		});

		it("should maintain consistent sort order across pages", async () => {
			const products = generateProducts(30);

			const page1 = await collectPipeline(products, {
				sort: { rating: "desc", name: "asc" },
				offset: 0,
				limit: 10,
			});

			const page2 = await collectPipeline(products, {
				sort: { rating: "desc", name: "asc" },
				offset: 10,
				limit: 10,
			});

			// Verify no overlap between pages
			const page1Ids = new Set(page1.map((p) => p.id));
			const page2Ids = new Set(page2.map((p) => p.id));
			const intersection = Array.from(page1Ids).filter((id) =>
				page2Ids.has(id),
			);
			expect(intersection).toHaveLength(0);
		});
	});

	// ============================================================================
	// Pagination with Filtering
	// ============================================================================

	describe("Pagination with Filtering", () => {
		it("should paginate filtered results", async () => {
			const products = generateProducts(30);
			const filtered = await collectPipeline(products, {
				where: { category: "electronics" },
				offset: 2,
				limit: 3,
			});

			expect(filtered).toHaveLength(3);
			filtered.forEach((p) => expect(p.category).toBe("electronics"));
		});

		it("should handle pagination when filter reduces result set", async () => {
			const products = generateProducts(20);
			// Filter for in-stock items (10 total: p2, p4, p6, p8, p10, p12, p14, p16, p18, p20)
			const filtered = await collectPipeline(products, {
				where: { inStock: true },
				offset: 5,
				limit: 10,
			});

			expect(filtered).toHaveLength(5); // Only 5 remaining after offset
		});

		it("should combine filtering, sorting, and pagination", async () => {
			const products = generateProducts(30);
			const results = await collectPipeline(products, {
				where: { category: { $in: ["electronics", "books"] } },
				sort: { price: "desc" },
				offset: 5,
				limit: 5,
			});

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

	// ============================================================================
	// Edge Cases
	// ============================================================================

	describe("Edge Cases", () => {
		it("should treat negative limit as 0", async () => {
			const products = generateProducts(10);
			const results = await collectPaginated(products, undefined, -5);
			expect(results).toHaveLength(0);
		});

		it("should treat negative offset as 0", async () => {
			const products = generateProducts(10);
			const results = await collectPaginated(products, -5, 3);
			expect(results).toHaveLength(3);
			expect(results[0].id).toBe("p1");
		});

		it("should handle fractional limit by flooring", async () => {
			const products = generateProducts(10);
			const results = await collectPaginated(products, undefined, 3.7);
			expect(results).toHaveLength(3);
		});

		it("should handle fractional offset by flooring", async () => {
			const products = generateProducts(10);
			const results = await collectPaginated(products, 2.9, 3);
			expect(results).toHaveLength(3);
			expect(results[0].id).toBe("p3"); // Offset floors to 2
		});

		it("should handle undefined limit (return all)", async () => {
			const products = generateProducts(15);
			const results = await collectPaginated(products, 5, undefined);
			expect(results).toHaveLength(10); // 15 - 5 offset
		});

		it("should handle undefined offset (start from beginning)", async () => {
			const products = generateProducts(15);
			const results = await collectPaginated(products, undefined, 5);
			expect(results).toHaveLength(5);
			expect(results[0].id).toBe("p1");
		});

		it("should handle empty collection", async () => {
			const results = await collectPaginated([], 5, 10);
			expect(results).toHaveLength(0);
		});
	});

	// ============================================================================
	// Pagination Consistency
	// ============================================================================

	describe("Pagination Consistency", () => {
		it("should return same results for same parameters", async () => {
			const products = generateProducts(50);

			const results1 = await collectPipeline(products, {
				offset: 10,
				limit: 15,
				sort: { price: "asc" },
			});
			const results2 = await collectPipeline(products, {
				offset: 10,
				limit: 15,
				sort: { price: "asc" },
			});
			const results3 = await collectPipeline(products, {
				offset: 10,
				limit: 15,
				sort: { price: "asc" },
			});

			expect(results1.map((p) => p.id)).toEqual(results2.map((p) => p.id));
			expect(results2.map((p) => p.id)).toEqual(results3.map((p) => p.id));
		});

		it("should maintain order stability with pagination", async () => {
			const products = generateProducts(20);

			// Get all items
			const all = await collectPaginated(products, undefined, undefined);

			// Get items in pages
			const pages: (typeof all)[number][] = [];
			for (let offset = 0; offset < 20; offset += 5) {
				const page = await collectPaginated(products, offset, 5);
				pages.push(...page);
			}

			// Should match
			expect(pages.map((p) => p.id)).toEqual(all.map((p) => p.id));
		});
	});

	// ============================================================================
	// Combined Query Features (filter + sort + paginate)
	// ============================================================================

	describe("Combined Query Features", () => {
		it("should combine all query features", async () => {
			const products = generateProducts(100);

			const results = await collectPipeline(products, {
				where: {
					$and: [
						{ category: { $in: ["electronics", "books"] } },
						{ price: { $gte: 50 } },
						{ inStock: true },
					],
				},
				sort: { rating: "desc", price: "asc" },
				offset: 5,
				limit: 10,
			});

			// Verify limit is respected
			expect(results.length).toBeLessThanOrEqual(10);

			// Verify all filters are applied
			results.forEach((product) => {
				expect(["electronics", "books"]).toContain(product.category);
				expect(product.price).toBeGreaterThanOrEqual(50);
				expect(product.inStock).toBe(true);
			});

			// Verify sort order
			if (results.length > 1) {
				for (let i = 1; i < results.length; i++) {
					const prev = results[i - 1];
					const curr = results[i];
					if (prev.rating === curr.rating) {
						expect(prev.price).toBeLessThanOrEqual(curr.price);
					} else {
						expect(prev.rating).toBeGreaterThanOrEqual(curr.rating);
					}
				}
			}
		});

		it("should combine pagination with simple filtering and sorting", async () => {
			const products: Product[] = [
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
			];

			const results = await collectPipeline(products, {
				where: { category: "electronics", inStock: true },
				sort: { price: "desc" },
				offset: 1,
				limit: 2,
			});

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
			const products = generateProducts(50);

			// First, get total count of matching items
			const allMatching = await collectPipeline(products, {
				where: {
					$or: [
						{ $and: [{ category: "electronics" }, { price: { $lt: 200 } }] },
						{ $and: [{ category: "books" }, { rating: { $gte: 4 } }] },
					],
				},
				sort: { id: "asc" },
			});
			const totalCount = allMatching.length;

			// Then paginate through results
			const pageSize = 7;
			const allPages: (typeof allMatching)[number][] = [];

			for (let offset = 0; offset < totalCount; offset += pageSize) {
				const page = await collectPipeline(products, {
					where: {
						$or: [
							{
								$and: [{ category: "electronics" }, { price: { $lt: 200 } }],
							},
							{ $and: [{ category: "books" }, { rating: { $gte: 4 } }] },
						],
					},
					sort: { id: "asc" },
					offset,
					limit: pageSize,
				});
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

	// ============================================================================
	// Performance Considerations
	// ============================================================================

	describe("Performance Considerations", () => {
		it("should handle large offset efficiently", async () => {
			const products = generateProducts(1000);

			const startTime = Date.now();
			const results = await collectPaginated(products, 900, 50);
			const endTime = Date.now();

			expect(results).toHaveLength(50);
			expect(results[0].id).toBe("p901");

			// Should complete reasonably quickly even with large offset
			expect(endTime - startTime).toBeLessThan(1000);
		});

		it("should handle large datasets with pagination", async () => {
			const products = generateProducts(10000);

			const results = await collectPaginated(products, 9990, 10);

			expect(results).toHaveLength(10);
			expect(results[0].id).toBe("p9991");
			expect(results[9].id).toBe("p10000");
		});
	});
});
