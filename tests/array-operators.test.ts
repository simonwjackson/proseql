import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createDatabase } from "../core/factories/database";
import { collect } from "../core/utils/async-iterable.js";
import type { DatasetFor } from "../core/types/types";

describe("Array Operators", () => {
	const ProductSchema = z.object({
		id: z.string(),
		name: z.string(),
		tags: z.array(z.string()),
		ratings: z.array(z.number()),
		features: z.array(z.string()).optional(),
	});

	const dbConfig = {
		products: {
			schema: ProductSchema,
			relationships: {},
		},
	} as const;

	const data: DatasetFor<typeof dbConfig> = {
		products: [
			{
				id: "1",
				name: "Product A",
				tags: ["electronics", "mobile", "smartphone"],
				ratings: [4.5, 4.0, 5.0],
				features: ["waterproof", "fast-charging", "5G"],
			},
			{
				id: "2",
				name: "Product B",
				tags: ["electronics", "mobile"],
				ratings: [3.5, 4.0],
				features: ["stylus", "fast-charging"],
			},
			{
				id: "3",
				name: "Product C",
				tags: ["electronics", "computer", "laptop", "professional"],
				ratings: [5.0, 4.5, 4.8, 4.9],
				features: undefined,
			},
			{
				id: "4",
				name: "Product D",
				tags: [],
				ratings: [],
				features: [],
			},
		],
	};

	const db = createDatabase(dbConfig, data);

	describe("$contains operator", () => {
		it("should find items where array contains a specific value", async () => {
			const results = await collect(
				db.products.query({
					where: { tags: { $contains: "mobile" } },
				}),
			);

			expect(results).toHaveLength(2);
			expect(results.map((p) => p.name).sort()).toEqual([
				"Product A",
				"Product B",
			]);
		});

		it("should return empty results when no arrays contain the value", async () => {
			const results = await collect(
				db.products.query({
					where: { tags: { $contains: "nonexistent" } },
				}),
			);

			expect(results).toHaveLength(0);
		});

		it("should not match empty arrays", async () => {
			const results = await collect(
				db.products.query({
					where: { tags: { $contains: "electronics" } },
				}),
			);

			expect(results).toHaveLength(3);
			expect(results.map((p) => p.id)).not.toContain("4");
		});

		it("should work with number arrays", async () => {
			const results = await collect(
				db.products.query({
					where: { ratings: { $contains: 5.0 } },
				}),
			);

			expect(results).toHaveLength(2);
			expect(results.map((p) => p.name).sort()).toEqual([
				"Product A",
				"Product C",
			]);
		});
	});

	describe("$all operator", () => {
		it("should find items where array contains all specified values", async () => {
			const results = await collect(
				db.products.query({
					where: { tags: { $all: ["electronics", "mobile"] } },
				}),
			);

			expect(results).toHaveLength(2);
			expect(results.map((p) => p.name).sort()).toEqual([
				"Product A",
				"Product B",
			]);
		});

		it("should return empty results when no arrays contain all values", async () => {
			const results = await collect(
				db.products.query({
					where: { tags: { $all: ["mobile", "computer"] } },
				}),
			);

			expect(results).toHaveLength(0);
		});

		it("should match when querying with empty array", async () => {
			const results = await collect(
				db.products.query({
					where: { tags: { $all: [] } },
				}),
			);

			// Empty $all should match all items (vacuous truth)
			expect(results).toHaveLength(4);
		});

		it("should work with single value in $all", async () => {
			const results = await collect(
				db.products.query({
					where: { features: { $all: ["fast-charging"] } },
				}),
			);

			expect(results).toHaveLength(2);
			expect(results.map((p) => p.name).sort()).toEqual([
				"Product A",
				"Product B",
			]);
		});
	});

	describe("$size operator", () => {
		it("should find arrays with exact size", async () => {
			const results = await collect(
				db.products.query({
					where: { tags: { $size: 3 } },
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Product A");
		});

		it("should find empty arrays", async () => {
			const results = await collect(
				db.products.query({
					where: { tags: { $size: 0 } },
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Product D");
		});

		it("should work with different array sizes", async () => {
			const results = await collect(
				db.products.query({
					where: { ratings: { $size: 4 } },
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Product C");
		});
	});

	describe("Combining array operators", () => {
		it("should combine array operators with other operators", async () => {
			const results = await collect(
				db.products.query({
					where: {
						tags: { $contains: "electronics" },
						ratings: { $size: 3 },
					},
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Product A");
		});

		it("should combine multiple operators on same field", async () => {
			const results = await collect(
				db.products.query({
					where: {
						tags: {
							$contains: "electronics",
							$size: 3,
						},
					},
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Product A");
		});

		it("should work with standard operators alongside array operators", async () => {
			const results = await collect(
				db.products.query({
					where: {
						name: { $startsWith: "Product" },
						tags: { $contains: "mobile" },
						id: { $ne: "1" },
					},
				}),
			);

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Product B");
		});
	});

	describe("Type safety", () => {
		it("should provide proper TypeScript inference", () => {
			// This test just verifies that TypeScript compilation succeeds
			// The actual type checking happens at compile time

			// These should compile without errors:
			db.products.query({ where: { tags: { $contains: "test" } } });
			db.products.query({ where: { tags: { $all: ["a", "b"] } } });
			db.products.query({ where: { tags: { $size: 5 } } });
			db.products.query({ where: { ratings: { $contains: 4.5 } } });

			// The following would cause TypeScript errors (commented out):
			// db.products.query({ where: { tags: { $contains: 123 } } }); // Error: number not string
			// db.products.query({ where: { name: { $all: ["test"] } } }); // Error: $all not available for string
			// db.products.query({ where: { tags: { $gt: 5 } } }); // Error: $gt not available for arrays

			expect(true).toBe(true); // Dummy assertion
		});
	});
});
