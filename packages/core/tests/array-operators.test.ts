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

describe("Array Operators (Stream-based)", () => {
	const products = [
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
			features: undefined as string[] | undefined,
		},
		{
			id: "4",
			name: "Product D",
			tags: [] as string[],
			ratings: [] as number[],
			features: [] as string[],
		},
	];

	describe("$contains operator", () => {
		it("should find items where array contains a specific value", async () => {
			const results = await collectFiltered(products, {
				tags: { $contains: "mobile" },
			});

			expect(results).toHaveLength(2);
			expect(results.map((p) => p.name).sort()).toEqual([
				"Product A",
				"Product B",
			]);
		});

		it("should return empty results when no arrays contain the value", async () => {
			const results = await collectFiltered(products, {
				tags: { $contains: "nonexistent" },
			});

			expect(results).toHaveLength(0);
		});

		it("should not match empty arrays", async () => {
			const results = await collectFiltered(products, {
				tags: { $contains: "electronics" },
			});

			expect(results).toHaveLength(3);
			expect(results.map((p) => p.id)).not.toContain("4");
		});

		it("should work with number arrays", async () => {
			const results = await collectFiltered(products, {
				ratings: { $contains: 5.0 },
			});

			expect(results).toHaveLength(2);
			expect(results.map((p) => p.name).sort()).toEqual([
				"Product A",
				"Product C",
			]);
		});
	});

	describe("$all operator", () => {
		it("should find items where array contains all specified values", async () => {
			const results = await collectFiltered(products, {
				tags: { $all: ["electronics", "mobile"] },
			});

			expect(results).toHaveLength(2);
			expect(results.map((p) => p.name).sort()).toEqual([
				"Product A",
				"Product B",
			]);
		});

		it("should return empty results when no arrays contain all values", async () => {
			const results = await collectFiltered(products, {
				tags: { $all: ["mobile", "computer"] },
			});

			expect(results).toHaveLength(0);
		});

		it("should match when querying with empty array", async () => {
			const results = await collectFiltered(products, {
				tags: { $all: [] },
			});

			// Empty $all should match all items (vacuous truth)
			expect(results).toHaveLength(4);
		});

		it("should work with single value in $all", async () => {
			const results = await collectFiltered(products, {
				features: { $all: ["fast-charging"] },
			});

			expect(results).toHaveLength(2);
			expect(results.map((p) => p.name).sort()).toEqual([
				"Product A",
				"Product B",
			]);
		});
	});

	describe("$size operator", () => {
		it("should find arrays with exact size", async () => {
			const results = await collectFiltered(products, {
				tags: { $size: 3 },
			});

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Product A");
		});

		it("should find empty arrays", async () => {
			const results = await collectFiltered(products, {
				tags: { $size: 0 },
			});

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Product D");
		});

		it("should work with different array sizes", async () => {
			const results = await collectFiltered(products, {
				ratings: { $size: 4 },
			});

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Product C");
		});
	});

	describe("Combining array operators", () => {
		it("should combine array operators with other operators", async () => {
			const results = await collectFiltered(products, {
				tags: { $contains: "electronics" },
				ratings: { $size: 3 },
			});

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Product A");
		});

		it("should combine multiple operators on same field", async () => {
			const results = await collectFiltered(products, {
				tags: {
					$contains: "electronics",
					$size: 3,
				},
			});

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Product A");
		});

		it("should work with standard operators alongside array operators", async () => {
			const results = await collectFiltered(products, {
				name: { $startsWith: "Product" },
				tags: { $contains: "mobile" },
				id: { $ne: "1" },
			});

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe("Product B");
		});
	});
});
