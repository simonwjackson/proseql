import { Chunk, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { applySelect } from "../src/operations/query/select-stream.js";

describe("applySelect Stream combinator", () => {
	// Test data
	const users = [
		{
			id: "u1",
			name: "Alice",
			email: "alice@example.com",
			age: 30,
			active: true,
		},
		{ id: "u2", name: "Bob", email: "bob@example.com", age: 25, active: false },
		{
			id: "u3",
			name: "Charlie",
			email: "charlie@example.com",
			age: 35,
			active: true,
		},
	];

	const toStream = <T>(items: ReadonlyArray<T>) => Stream.fromIterable(items);

	const collectSelected = <T extends Record<string, unknown>>(
		items: ReadonlyArray<T>,
		select: Record<string, unknown> | ReadonlyArray<string> | undefined,
	) =>
		Effect.runPromise(
			Stream.runCollect(toStream(items).pipe(applySelect<T>(select))),
		).then(Chunk.toArray);

	// ============================================================================
	// Pass-through behavior
	// ============================================================================

	describe("pass-through when no select config", () => {
		it("should return stream unchanged when select is undefined", async () => {
			const result = await collectSelected(users, undefined);
			expect(result).toEqual(users);
		});

		it("should return stream unchanged when select is empty object", async () => {
			const result = await collectSelected(users, {});
			expect(result).toEqual(users);
		});

		it("should return stream unchanged when select is empty array", async () => {
			const result = await collectSelected(users, []);
			expect(result).toEqual(users);
		});
	});

	// ============================================================================
	// Object-based selection
	// ============================================================================

	describe("object-based selection", () => {
		it("should select a single field", async () => {
			const result = await collectSelected(users, { name: true });
			expect(result).toEqual([
				{ name: "Alice" },
				{ name: "Bob" },
				{ name: "Charlie" },
			]);
		});

		it("should select multiple fields", async () => {
			const result = await collectSelected(users, { name: true, email: true });
			expect(result).toEqual([
				{ name: "Alice", email: "alice@example.com" },
				{ name: "Bob", email: "bob@example.com" },
				{ name: "Charlie", email: "charlie@example.com" },
			]);
		});

		it("should select all fields when all are true", async () => {
			const result = await collectSelected(users, {
				id: true,
				name: true,
				email: true,
				age: true,
				active: true,
			});
			expect(result).toEqual(users);
		});

		it("should ignore fields not present in the item", async () => {
			const result = await collectSelected(users, {
				name: true,
				nonExistent: true,
			});
			expect(result).toEqual([
				{ name: "Alice" },
				{ name: "Bob" },
				{ name: "Charlie" },
			]);
		});
	});

	// ============================================================================
	// Array-based selection
	// ============================================================================

	describe("array-based selection", () => {
		it("should select a single field via array", async () => {
			const result = await collectSelected(users, ["name"]);
			expect(result).toEqual([
				{ name: "Alice" },
				{ name: "Bob" },
				{ name: "Charlie" },
			]);
		});

		it("should select multiple fields via array", async () => {
			const result = await collectSelected(users, ["id", "name"]);
			expect(result).toEqual([
				{ id: "u1", name: "Alice" },
				{ id: "u2", name: "Bob" },
				{ id: "u3", name: "Charlie" },
			]);
		});

		it("should ignore fields not present in the item", async () => {
			const result = await collectSelected(users, ["name", "nonExistent"]);
			expect(result).toEqual([
				{ name: "Alice" },
				{ name: "Bob" },
				{ name: "Charlie" },
			]);
		});
	});

	// ============================================================================
	// Nested selection (populated relationships)
	// ============================================================================

	describe("nested selection on populated relationships", () => {
		const usersWithCompany = [
			{
				id: "u1",
				name: "Alice",
				email: "alice@example.com",
				company: { id: "c1", name: "Acme Corp", revenue: 1000000 },
			},
			{
				id: "u2",
				name: "Bob",
				email: "bob@example.com",
				company: { id: "c2", name: "Beta Inc", revenue: 500000 },
			},
		];

		it("should apply nested selection to populated object", async () => {
			const result = await collectSelected(usersWithCompany, {
				name: true,
				company: { name: true },
			});
			expect(result).toEqual([
				{ name: "Alice", company: { name: "Acme Corp" } },
				{ name: "Bob", company: { name: "Beta Inc" } },
			]);
		});

		it("should include full populated object when selection is true", async () => {
			const result = await collectSelected(usersWithCompany, {
				name: true,
				company: true,
			});
			expect(result).toEqual([
				{
					name: "Alice",
					company: { id: "c1", name: "Acme Corp", revenue: 1000000 },
				},
				{
					name: "Bob",
					company: { id: "c2", name: "Beta Inc", revenue: 500000 },
				},
			]);
		});

		const usersWithOrders = [
			{
				id: "u1",
				name: "Alice",
				orders: [
					{ id: "o1", total: 100, status: "shipped" },
					{ id: "o2", total: 200, status: "pending" },
				],
			},
			{
				id: "u2",
				name: "Bob",
				orders: [{ id: "o3", total: 50, status: "delivered" }],
			},
		];

		it("should apply nested selection to populated array", async () => {
			const result = await collectSelected(usersWithOrders, {
				name: true,
				orders: { id: true, total: true },
			});
			expect(result).toEqual([
				{
					name: "Alice",
					orders: [
						{ id: "o1", total: 100 },
						{ id: "o2", total: 200 },
					],
				},
				{ name: "Bob", orders: [{ id: "o3", total: 50 }] },
			]);
		});

		it("should include full populated array when selection is true", async () => {
			const result = await collectSelected(usersWithOrders, {
				name: true,
				orders: true,
			});
			expect(result).toEqual([
				{
					name: "Alice",
					orders: [
						{ id: "o1", total: 100, status: "shipped" },
						{ id: "o2", total: 200, status: "pending" },
					],
				},
				{
					name: "Bob",
					orders: [{ id: "o3", total: 50, status: "delivered" }],
				},
			]);
		});
	});

	// ============================================================================
	// Edge cases
	// ============================================================================

	describe("edge cases", () => {
		it("should handle empty stream", async () => {
			const result = await collectSelected([], { name: true });
			expect(result).toEqual([]);
		});

		it("should handle single item stream", async () => {
			const result = await collectSelected([users[0]], { name: true });
			expect(result).toEqual([{ name: "Alice" }]);
		});

		it("should handle items with null/undefined field values", async () => {
			const items = [
				{ id: "1", name: "Alice", company: null as string | null },
				{ id: "2", name: "Bob", company: undefined as string | undefined },
			];
			const result = await collectSelected(items, {
				name: true,
				company: true,
			});
			expect(result).toEqual([
				{ name: "Alice", company: null },
				{ name: "Bob", company: undefined },
			]);
		});

		it("should preserve Stream error channel", async () => {
			const failingStream = Stream.concat(
				Stream.fromIterable([{ id: "1", name: "A" }]),
				Stream.fail("test-error"),
			);

			const selected = failingStream.pipe(applySelect({ name: true }));
			const result = await Effect.runPromise(
				Effect.either(Stream.runCollect(selected)),
			);

			expect(result._tag).toBe("Left");
		});

		it("should preserve Stream context (R) type", async () => {
			const stream: Stream.Stream<{ id: string; name: string }, never, never> =
				Stream.fromIterable([{ id: "1", name: "A" }]);
			const selected = stream.pipe(applySelect({ name: true }));

			const result = await Effect.runPromise(Stream.runCollect(selected));
			expect(Chunk.toArray(result)).toEqual([{ name: "A" }]);
		});
	});
});
