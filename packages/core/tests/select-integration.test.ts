import { Chunk, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { applyFilter } from "../src/operations/query/filter-stream";
import {
	applyObjectSelection,
	applySelectionToArray,
	createFieldSelector,
} from "../src/operations/query/select";
import { applySelect } from "../src/operations/query/select-stream";
import { applySort } from "../src/operations/query/sort-stream";

// Helper to collect stream-based pipeline results
const collectPipeline = <T extends Record<string, unknown>>(
	data: ReadonlyArray<T>,
	options: {
		where?: Record<string, unknown>;
		sort?: Record<string, "asc" | "desc">;
		select?: Record<string, unknown> | ReadonlyArray<string>;
	},
): Promise<ReadonlyArray<T>> =>
	Effect.runPromise(
		Stream.fromIterable(data).pipe(
			applyFilter<T>(options.where),
			applySort<T>(options.sort),
			applySelect<T>(options.select),
			Stream.runCollect,
			Effect.map(Chunk.toReadonlyArray),
		),
	);

describe("Field Selection Integration (Stream-based)", () => {
	// Sample data
	const users = [
		{
			id: "user-1",
			name: "Alice Johnson",
			email: "alice@example.com",
			age: 28,
			role: "admin",
			salary: 95000,
			department: {
				id: "dept-1",
				name: "Engineering",
				budget: 500000,
			},
			projects: ["proj-1", "proj-2"],
		},
		{
			id: "user-2",
			name: "Bob Smith",
			email: "bob@example.com",
			age: 35,
			role: "developer",
			salary: 85000,
			department: {
				id: "dept-1",
				name: "Engineering",
				budget: 500000,
			},
			projects: ["proj-2", "proj-3"],
		},
		{
			id: "user-3",
			name: "Charlie Davis",
			email: "charlie@example.com",
			age: 42,
			role: "manager",
			salary: 105000,
			department: {
				id: "dept-2",
				name: "Marketing",
				budget: 300000,
			},
			projects: ["proj-4"],
		},
	];

	describe("Query Pipeline Integration (Stream)", () => {
		it("should work with filter -> select pipeline", async () => {
			// Filter for engineering employees, then select public fields
			const engineeringUsers = users.filter(
				(user) => user.department.name === "Engineering",
			);

			const result = await collectPipeline(engineeringUsers, {
				select: {
					id: true,
					name: true,
					email: true,
					role: true,
					department: true,
				},
			});

			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({
				id: "user-1",
				name: "Alice Johnson",
				email: "alice@example.com",
				role: "admin",
				department: {
					id: "dept-1",
					name: "Engineering",
					budget: 500000,
				},
			});

			// Verify salary is not included
			expect(result[0]).not.toHaveProperty("salary");
			expect(result[1]).not.toHaveProperty("salary");
		});

		it("should work with filter -> sort -> select pipeline", async () => {
			const result = await collectPipeline(users, {
				where: { salary: { $gte: 90000 } },
				sort: { age: "desc" },
				select: { id: true, name: true, age: true, role: true },
			});

			expect(result).toEqual([
				{ id: "user-3", name: "Charlie Davis", age: 42, role: "manager" },
				{ id: "user-1", name: "Alice Johnson", age: 28, role: "admin" },
			]);
		});

		it("should handle complex field selection with nested objects", async () => {
			const complexUser = {
				id: "user-4",
				name: "Diana Evans",
				contact: {
					email: "diana@example.com",
					phone: "555-0123",
					address: {
						street: "123 Main St",
						city: "Anytown",
						country: "USA",
					},
				},
				employment: {
					role: "senior developer",
					department: {
						id: "dept-1",
						name: "Engineering",
						manager: {
							id: "user-3",
							name: "Charlie Davis",
						},
					},
					startDate: "2020-01-15",
				},
				permissions: ["read", "write", "admin"],
			};

			// Select specific fields including nested ones
			const selected = applyObjectSelection(complexUser, {
				id: true,
				name: true,
				contact: true,
				employment: true,
			});

			// All nested structures are preserved
			expect(selected.contact.email).toBe("diana@example.com");
			expect(selected.contact.address.city).toBe("Anytown");
			expect(selected.employment.department.manager.name).toBe("Charlie Davis");

			// But top-level permissions are not included
			expect(selected).not.toHaveProperty("permissions");
		});
	});

	describe("Performance Considerations", () => {
		it("should efficiently handle large datasets via Stream", async () => {
			// Generate large dataset
			const largeDataset = Array.from({ length: 10000 }, (_, i) => ({
				id: `user-${i}`,
				name: `User ${i}`,
				email: `user${i}@example.com`,
				age: 20 + (i % 50),
				salary: 50000 + i * 100,
				department: `dept-${i % 10}`,
				metadata: {
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					tags: [`tag-${i % 5}`, `tag-${i % 7}`],
					preferences: {
						theme: i % 2 === 0 ? "dark" : "light",
						notifications: i % 3 === 0,
					},
				},
			}));

			const start = performance.now();

			const selected = await Effect.runPromise(
				Stream.fromIterable(largeDataset).pipe(
					applySelect({ id: true, name: true, department: true }),
					Stream.runCollect,
					Effect.map(Chunk.toArray),
				),
			);

			const end = performance.now();

			expect(selected).toHaveLength(10000);
			expect(selected[0]).toEqual({
				id: "user-0",
				name: "User 0",
				department: "dept-0",
			});

			// Should complete in reasonable time (less than 200ms)
			expect(end - start).toBeLessThan(200);
		});

		it("should also efficiently handle large datasets via sync utility", () => {
			const largeDataset = Array.from({ length: 10000 }, (_, i) => ({
				id: `user-${i}`,
				name: `User ${i}`,
				email: `user${i}@example.com`,
				age: 20 + (i % 50),
				salary: 50000 + i * 100,
				department: `dept-${i % 10}`,
			}));

			const start = performance.now();

			const selected = applySelectionToArray(largeDataset, {
				id: true,
				name: true,
				department: true,
			});

			const end = performance.now();

			expect(selected).toHaveLength(10000);
			expect(selected[0]).toEqual({
				id: "user-0",
				name: "User 0",
				department: "dept-0",
			});

			expect(end - start).toBeLessThan(100);
		});
	});

	describe("Type Safety in Pipelines", () => {
		it("should maintain type safety through selection pipeline", () => {
			type Product = {
				id: string;
				name: string;
				price: number;
				category: string;
				inStock: boolean;
				supplier: {
					id: string;
					name: string;
					country: string;
				};
			};

			const products: Product[] = [
				{
					id: "prod-1",
					name: "Laptop",
					price: 999,
					category: "Electronics",
					inStock: true,
					supplier: {
						id: "sup-1",
						name: "TechCorp",
						country: "USA",
					},
				},
			];

			const catalogSelector = createFieldSelector({
				id: true,
				name: true,
				price: true,
				inStock: true,
			});

			const selected = catalogSelector(products[0]);

			const typedSelected = selected as {
				id: string;
				name: string;
				price: number;
				inStock: boolean;
			};
			const id: string = typedSelected.id;
			const _name: string = typedSelected.name;
			const price: number = typedSelected.price;
			const _inStock: boolean = typedSelected.inStock;

			// @ts-expect-error - supplier not selected
			const _supplier = selected.supplier;

			expect(id).toBe("prod-1");
			expect(price).toBe(999);
		});
	});

	describe("Edge Cases", () => {
		it("should handle selection on empty stream", async () => {
			const result = await collectPipeline([], {
				select: { id: true, name: true },
			});
			expect(result).toEqual([]);
		});

		it("should handle selection with no fields (sync utility)", () => {
			const data = { id: "1", name: "Test", value: 42 };
			const result = applyObjectSelection(data, {});
			expect(result).toEqual({});
		});

		it("should handle selection of non-existent fields gracefully", () => {
			const data = { id: "1", name: "Test" };
			const result = applyObjectSelection(data, {
				id: true,
				name: true,
				nonExistent: true,
			} as Record<string, boolean>);
			expect(result).toEqual({ id: "1", name: "Test" });
		});

		it("should preserve undefined and null values when selected", () => {
			const data = {
				id: "1",
				name: "Test",
				optional: undefined as string | undefined,
				nullable: null as string | null,
			};

			const result = applyObjectSelection(data, {
				id: true,
				optional: true,
				nullable: true,
			});
			expect(result).toEqual({
				id: "1",
				optional: undefined,
				nullable: null,
			});
		});

		it("should preserve Stream error channel through full pipeline", async () => {
			const failingStream = Stream.concat(
				Stream.fromIterable([
					{ id: "1", name: "A", age: 30 } as Record<string, unknown>,
				]),
				Stream.fail("pipeline-error"),
			);

			const selected = failingStream.pipe(
				applySort({ name: "asc" }),
				applySelect({ name: true }),
			);

			const result = await Effect.runPromise(
				Effect.either(Stream.runCollect(selected)),
			);

			expect(result._tag).toBe("Left");
		});
	});
});
