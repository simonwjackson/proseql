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

describe("Conditional Logic Operators", () => {
	const testData = [
		{
			id: 1,
			name: "John Doe",
			email: "john@company.com",
			age: 25,
			role: "admin",
			active: true,
		},
		{
			id: 2,
			name: "Jane Smith",
			email: "jane@example.com",
			age: 30,
			role: "user",
			active: false,
		},
		{
			id: 3,
			name: "John Smith",
			email: "johns@spam.com",
			age: 35,
			role: "admin",
			active: false,
		},
		{
			id: 4,
			name: "Bob Johnson",
			email: "bob@company.com",
			age: 17,
			role: "user",
			active: true,
		},
		{
			id: 5,
			name: "Alice Brown",
			email: "alice@test.com",
			age: 22,
			role: "moderator",
			active: true,
			superuser: true,
		},
	];

	describe("$or operator", () => {
		it("should return items matching any condition", async () => {
			const result = await collectFiltered(testData, {
				$or: [
					{ name: { $startsWith: "John" } },
					{ email: { $contains: "@company.com" } },
				],
			});

			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id)).toEqual([1, 3, 4]);
		});

		it("should return empty when no conditions match", async () => {
			const result = await collectFiltered(testData, {
				$or: [{ age: { $gt: 50 } }, { role: "nonexistent" }],
			});

			expect(result).toHaveLength(0);
		});

		it("should handle empty array as false", async () => {
			const result = await collectFiltered(testData, {
				$or: [],
			});

			expect(result).toHaveLength(0);
		});

		it("should handle nested conditions", async () => {
			const result = await collectFiltered(testData, {
				$or: [
					{ age: { $gte: 30 } },
					{ $and: [{ role: "user" }, { active: true }] },
				],
			});

			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id)).toEqual([2, 3, 4]);
		});
	});

	describe("$and operator", () => {
		it("should return items matching all conditions", async () => {
			const result = await collectFiltered(testData, {
				$and: [{ age: { $gte: 18 } }, { active: true }],
			});

			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual([1, 5]);
		});

		it("should return empty when any condition fails", async () => {
			const result = await collectFiltered(testData, {
				$and: [{ role: "admin" }, { active: true }, { age: { $gt: 30 } }],
			});

			expect(result).toHaveLength(0);
		});

		it("should handle empty array as true (vacuous truth)", async () => {
			const result = await collectFiltered(testData, {
				$and: [],
			});

			expect(result).toHaveLength(5);
		});

		it("should work with other field filters", async () => {
			const result = await collectFiltered(testData, {
				role: "admin",
				$and: [{ active: false }, { age: { $gt: 30 } }],
			});

			expect(result).toHaveLength(1);
			expect(result[0].id).toBe(3);
		});
	});

	describe("$not operator", () => {
		it("should return items not matching the condition", async () => {
			const result = await collectFiltered(testData, {
				$not: { email: { $endsWith: "@spam.com" } },
			});

			expect(result).toHaveLength(4);
			expect(result.map((r) => r.id)).toEqual([1, 2, 4, 5]);
		});

		it("should handle complex nested conditions", async () => {
			const result = await collectFiltered(testData, {
				$not: {
					$and: [{ role: "admin" }, { active: true }],
				},
			});

			expect(result).toHaveLength(4);
			expect(result.map((r) => r.id)).toEqual([2, 3, 4, 5]);
		});

		it("should work with direct equality", async () => {
			const result = await collectFiltered(testData, {
				$not: { role: "admin" },
			});

			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id)).toEqual([2, 4, 5]);
		});
	});

	describe("Complex nested combinations", () => {
		it("should handle OR with nested AND conditions", async () => {
			const result = await collectFiltered(testData, {
				$or: [
					{
						$and: [{ role: "admin" }, { active: true }],
					},
					{ superuser: true },
				],
			});

			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual([1, 5]);
		});

		it("should handle NOT with OR conditions", async () => {
			const result = await collectFiltered(testData, {
				$not: {
					$or: [{ age: { $lt: 20 } }, { role: "moderator" }],
				},
			});

			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id)).toEqual([1, 2, 3]);
		});

		it("should handle deeply nested conditions", async () => {
			const result = await collectFiltered(testData, {
				$and: [
					{
						$or: [{ age: { $gte: 30 } }, { role: "admin" }],
					},
					{
						$not: { active: true },
					},
				],
			});

			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual([2, 3]);
		});

		it("should combine logical operators with regular field filters", async () => {
			const result = await collectFiltered(testData, {
				email: { $contains: ".com" },
				$or: [
					{ role: "admin" },
					{
						$and: [{ age: { $lt: 25 } }, { active: true }],
					},
				],
			});

			expect(result).toHaveLength(4);
			expect(result.map((r) => r.id)).toEqual([1, 3, 4, 5]);
		});
	});

	describe("Additional complex scenarios", () => {
		it("should handle multiple levels of nesting", async () => {
			const result = await collectFiltered(testData, {
				$or: [
					{
						$not: {
							$or: [{ age: { $gt: 30 } }, { role: "moderator" }],
						},
					},
					{
						$and: [
							{ email: { $endsWith: ".com" } },
							{ $not: { active: false } },
						],
					},
				],
			});

			// Should get items that:
			// - Are NOT (age > 30 OR role='moderator')
			//   OR
			// - (email ends with .com AND NOT active=false)
			expect(result).toHaveLength(4);
			expect(result.map((r) => r.id).sort()).toEqual([1, 2, 4, 5]);
		});

		it("should handle field existence checks with operators", async () => {
			// Add an item without certain fields
			const dataWithMissing = [...testData, { id: 6, name: "Test User" }];

			const result = await collectFiltered(dataWithMissing as typeof testData, {
				$or: [
					{ email: { $eq: undefined } }, // Should match item 6
					{ role: "admin" },
				],
			});

			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id).sort()).toEqual([1, 3, 6]);
		});
	});

	describe("Edge cases", () => {
		it("should handle invalid where clause in $or", async () => {
			const result = await collectFiltered(testData, {
				$or: [null, { name: "John Doe" }, undefined] as unknown as Array<
					Record<string, unknown>
				>,
			});

			expect(result).toHaveLength(1);
			expect(result[0].id).toBe(1);
		});

		it("should handle non-array value for $or", async () => {
			const result = await collectFiltered(testData, {
				$or: { name: "John Doe" } as unknown as Array<Record<string, unknown>>,
			});

			expect(result).toHaveLength(0);
		});

		it("should handle non-object value for $not", async () => {
			const result = await collectFiltered(testData, {
				$not: "invalid" as unknown as Record<string, unknown>,
			});

			expect(result).toHaveLength(0);
		});
	});
});
