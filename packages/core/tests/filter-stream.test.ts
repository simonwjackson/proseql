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

const testData = [
	{
		id: "1",
		name: "John Doe",
		email: "john@company.com",
		age: 25,
		role: "admin",
		active: true,
		tags: ["a", "b"],
	},
	{
		id: "2",
		name: "Jane Smith",
		email: "jane@example.com",
		age: 30,
		role: "user",
		active: false,
		tags: ["b", "c"],
	},
	{
		id: "3",
		name: "John Smith",
		email: "johns@spam.com",
		age: 35,
		role: "admin",
		active: false,
		tags: ["a", "c", "d"],
	},
	{
		id: "4",
		name: "Bob Johnson",
		email: "bob@company.com",
		age: 17,
		role: "user",
		active: true,
		tags: ["a"],
	},
	{
		id: "5",
		name: "Alice Brown",
		email: "alice@test.com",
		age: 22,
		role: "moderator",
		active: true,
		tags: [],
	},
];

describe("applyFilter Stream combinator", () => {
	describe("passthrough", () => {
		it("should return all items when where is undefined", async () => {
			const result = await collectFiltered(testData, undefined);
			expect(result).toHaveLength(5);
		});

		it("should return all items when where is empty object", async () => {
			const result = await collectFiltered(testData, {});
			expect(result).toHaveLength(5);
		});
	});

	describe("direct equality", () => {
		it("should filter by direct value equality", async () => {
			const result = await collectFiltered(testData, { role: "admin" });
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["1", "3"]);
		});
	});

	describe("$eq operator", () => {
		it("should match equal values", async () => {
			const result = await collectFiltered(testData, { age: { $eq: 30 } });
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("2");
		});
	});

	describe("$ne operator", () => {
		it("should exclude matching values", async () => {
			const result = await collectFiltered(testData, {
				role: { $ne: "admin" },
			});
			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id)).toEqual(["2", "4", "5"]);
		});
	});

	describe("$gt operator", () => {
		it("should match values greater than", async () => {
			const result = await collectFiltered(testData, { age: { $gt: 25 } });
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["2", "3"]);
		});

		it("should work on strings (lexicographic)", async () => {
			const result = await collectFiltered(testData, { name: { $gt: "John" } });
			expect(result.every((r) => (r.name as string) > "John")).toBe(true);
		});
	});

	describe("$gte operator", () => {
		it("should match values greater than or equal", async () => {
			const result = await collectFiltered(testData, { age: { $gte: 30 } });
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["2", "3"]);
		});
	});

	describe("$lt operator", () => {
		it("should match values less than", async () => {
			const result = await collectFiltered(testData, { age: { $lt: 25 } });
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["4", "5"]);
		});
	});

	describe("$lte operator", () => {
		it("should match values less than or equal", async () => {
			const result = await collectFiltered(testData, { age: { $lte: 25 } });
			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id)).toEqual(["1", "4", "5"]);
		});
	});

	describe("$in operator", () => {
		it("should match values in array", async () => {
			const result = await collectFiltered(testData, {
				role: { $in: ["admin", "moderator"] },
			});
			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id)).toEqual(["1", "3", "5"]);
		});
	});

	describe("$nin operator", () => {
		it("should exclude values in array", async () => {
			const result = await collectFiltered(testData, {
				role: { $nin: ["admin", "moderator"] },
			});
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["2", "4"]);
		});
	});

	describe("$startsWith operator", () => {
		it("should match strings starting with prefix", async () => {
			const result = await collectFiltered(testData, {
				name: { $startsWith: "John" },
			});
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["1", "3"]);
		});
	});

	describe("$endsWith operator", () => {
		it("should match strings ending with suffix", async () => {
			const result = await collectFiltered(testData, {
				name: { $endsWith: "Smith" },
			});
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["2", "3"]);
		});
	});

	describe("$contains operator", () => {
		it("should match strings containing substring", async () => {
			const result = await collectFiltered(testData, {
				email: { $contains: "@company.com" },
			});
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["1", "4"]);
		});

		it("should match arrays containing element", async () => {
			const result = await collectFiltered(testData, {
				tags: { $contains: "a" },
			});
			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id)).toEqual(["1", "3", "4"]);
		});
	});

	describe("$all operator", () => {
		it("should match arrays containing all elements", async () => {
			const result = await collectFiltered(testData, {
				tags: { $all: ["a", "b"] },
			});
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("1");
		});
	});

	describe("$size operator", () => {
		it("should match arrays with exact size", async () => {
			const result = await collectFiltered(testData, { tags: { $size: 2 } });
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["1", "2"]);
		});

		it("should match empty arrays", async () => {
			const result = await collectFiltered(testData, { tags: { $size: 0 } });
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("5");
		});
	});

	describe("$or operator", () => {
		it("should match items satisfying any condition", async () => {
			const result = await collectFiltered(testData, {
				$or: [
					{ name: { $startsWith: "John" } },
					{ email: { $contains: "@company.com" } },
				],
			});
			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id)).toEqual(["1", "3", "4"]);
		});

		it("should return nothing for empty $or array", async () => {
			const result = await collectFiltered(testData, { $or: [] });
			expect(result).toHaveLength(0);
		});
	});

	describe("$and operator", () => {
		it("should match items satisfying all conditions", async () => {
			const result = await collectFiltered(testData, {
				$and: [{ role: "admin" }, { age: { $gte: 30 } }],
			});
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("3");
		});

		it("should return all for empty $and array (vacuous truth)", async () => {
			const result = await collectFiltered(testData, { $and: [] });
			expect(result).toHaveLength(5);
		});
	});

	describe("$not operator", () => {
		it("should exclude items matching the condition", async () => {
			const result = await collectFiltered(testData, {
				$not: { role: "admin" },
			});
			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id)).toEqual(["2", "4", "5"]);
		});
	});

	describe("combined operators", () => {
		it("should combine multiple field filters with AND semantics", async () => {
			const result = await collectFiltered(testData, {
				role: "admin",
				active: true,
			});
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("1");
		});

		it("should combine operator filters on the same field", async () => {
			const result = await collectFiltered(testData, {
				age: { $gte: 20, $lte: 30 },
			});
			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id)).toEqual(["1", "2", "5"]);
		});
	});

	describe("non-existent fields", () => {
		it("should not match when filtering on non-existent field with a value", async () => {
			const result = await collectFiltered(testData, { nonexistent: "value" });
			expect(result).toHaveLength(0);
		});

		it("should not match operators on non-existent fields", async () => {
			const result = await collectFiltered(testData, {
				nonexistent: { $gt: 10 },
			});
			expect(result).toHaveLength(0);
		});
	});

	describe("Stream composition", () => {
		it("should compose with other Stream operations", async () => {
			const result = await Effect.runPromise(
				Stream.fromIterable(testData).pipe(
					applyFilter({ role: "admin" }),
					Stream.map((item) => item.name),
					Stream.runCollect,
					Effect.map(Chunk.toReadonlyArray),
				),
			);
			expect(result).toEqual(["John Doe", "John Smith"]);
		});

		it("should chain multiple filters", async () => {
			const result = await Effect.runPromise(
				Stream.fromIterable(testData).pipe(
					applyFilter({ role: "admin" }),
					applyFilter({ age: { $gte: 30 } }),
					Stream.runCollect,
					Effect.map(Chunk.toReadonlyArray),
				),
			);
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("3");
		});
	});

	describe("nested filtering (shape-mirroring)", () => {
		const nestedData = [
			{
				id: "1",
				title: "Dune",
				genre: "sci-fi",
				metadata: { views: 150, rating: 5, tags: ["classic"] },
				author: { name: "Frank Herbert", country: "USA" },
			},
			{
				id: "2",
				title: "Neuromancer",
				genre: "sci-fi",
				metadata: { views: 80, rating: 4, tags: ["cyberpunk"] },
				author: { name: "William Gibson", country: "USA" },
			},
			{
				id: "3",
				title: "Foundation",
				genre: "sci-fi",
				metadata: { views: 200, rating: 5, tags: ["epic", "classic"] },
				author: { name: "Isaac Asimov", country: "Russia" },
			},
			{
				id: "4",
				title: "1984",
				genre: "dystopian",
				metadata: { views: 50, rating: 3, tags: ["political"] },
				author: { name: "George Orwell", country: "UK" },
			},
		];

		it("should filter by nested field with $gt operator (shape-mirroring)", async () => {
			const result = await collectFiltered(nestedData, {
				metadata: { views: { $gt: 100 } },
			});
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["1", "3"]);
		});

		it("should filter by nested field with $gte operator", async () => {
			const result = await collectFiltered(nestedData, {
				metadata: { views: { $gte: 150 } },
			});
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["1", "3"]);
		});

		it("should filter by nested field with $lt operator", async () => {
			const result = await collectFiltered(nestedData, {
				metadata: { views: { $lt: 100 } },
			});
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["2", "4"]);
		});

		it("should filter by nested field with $lte operator", async () => {
			const result = await collectFiltered(nestedData, {
				metadata: { views: { $lte: 80 } },
			});
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["2", "4"]);
		});

		it("should filter by nested field with $eq operator", async () => {
			const result = await collectFiltered(nestedData, {
				metadata: { rating: { $eq: 5 } },
			});
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["1", "3"]);
		});

		it("should filter by nested field with $ne operator", async () => {
			const result = await collectFiltered(nestedData, {
				metadata: { rating: { $ne: 5 } },
			});
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["2", "4"]);
		});

		it("should filter by nested field with $in operator", async () => {
			const result = await collectFiltered(nestedData, {
				metadata: { rating: { $in: [4, 5] } },
			});
			expect(result).toHaveLength(3);
			expect(result.map((r) => r.id)).toEqual(["1", "2", "3"]);
		});

		it("should filter by multiple nested fields", async () => {
			const result = await collectFiltered(nestedData, {
				metadata: { views: { $gt: 100 }, rating: 5 },
			});
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["1", "3"]);
		});

		it("should filter by different nested objects", async () => {
			const result = await collectFiltered(nestedData, {
				metadata: { rating: 5 },
				author: { country: "USA" },
			});
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("1");
		});

		it("should combine nested and flat filters", async () => {
			const result = await collectFiltered(nestedData, {
				genre: "sci-fi",
				metadata: { views: { $gt: 100 } },
			});
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["1", "3"]);
		});

		it("should handle nested array operators ($contains)", async () => {
			const result = await collectFiltered(nestedData, {
				metadata: { tags: { $contains: "classic" } },
			});
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(["1", "3"]);
		});

		it("should handle nested array operators ($all)", async () => {
			const result = await collectFiltered(nestedData, {
				metadata: { tags: { $all: ["epic", "classic"] } },
			});
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("3");
		});
	});
});
