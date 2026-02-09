import { describe, it, expect } from "vitest";
import {
	applyObjectSelection,
	applySelectionToArray,
	createFieldSelector,
} from "../core/operations/query/select";
import { filterData } from "../core/operations/query/filter";
import { sortData } from "../core/operations/query/sort";
import type { UnknownRecord } from "../core/types/types";

describe("Field Selection Integration", () => {
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

	describe("Query Pipeline Integration", () => {
		it("should work with filter -> select pipeline", () => {
			// Filter for engineering employees
			// Since the filter doesn't support dot notation, we need to filter manually
			const engineeringUsers = users.filter(
				(user) => user.department.name === "Engineering",
			);

			// Select only public fields
			const publicFieldSelector = createFieldSelector({
				id: true,
				name: true,
				email: true,
				role: true,
				department: true,
			});

			// Apply pipeline
			const result = engineeringUsers.map(publicFieldSelector);

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

		it("should work with filter -> sort -> select pipeline", () => {
			// Filter for high earners using the correct filter syntax
			const highEarners = users.filter((user) => user.salary >= 90000);

			// Sort by age descending
			const sorted = sortData(highEarners, { age: "desc" });

			// Select summary fields
			const summarySelector = createFieldSelector({
				id: true,
				name: true,
				age: true,
				role: true,
			});

			// Apply full pipeline
			const result = sorted.map(summarySelector);

			expect(result).toEqual([
				{ id: "user-3", name: "Charlie Davis", age: 42, role: "manager" },
				{ id: "user-1", name: "Alice Johnson", age: 28, role: "admin" },
			]);
		});

		it("should handle complex field selection with nested objects", () => {
			// Create a user with more complex nested structure
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
		it("should efficiently handle large datasets", () => {
			// Generate large dataset
			const largeDataset = Array.from({ length: 10000 }, (_, i) => ({
				id: `user-${i}`,
				name: `User ${i}`,
				email: `user${i}@example.com`,
				age: 20 + (i % 50),
				salary: 50000 + i * 100,
				department: `dept-${i % 10}`,
				metadata: {
					createdAt: new Date(),
					updatedAt: new Date(),
					tags: [`tag-${i % 5}`, `tag-${i % 7}`],
					preferences: {
						theme: i % 2 === 0 ? "dark" : "light",
						notifications: i % 3 === 0,
					},
				},
			}));

			const start = performance.now();

			// Apply selection to reduce data size
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

			// Should complete in reasonable time (less than 100ms)
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

			// Create typed selector
			const catalogSelector = createFieldSelector({
				id: true,
				name: true,
				price: true,
				inStock: true,
			});

			const selected = catalogSelector(products[0]);

			// Type checks - these should compile
			// Using type assertion because selector creates unknown type
			const typedSelected = selected as {
				id: string;
				name: string;
				price: number;
				inStock: boolean;
			};
			const id: string = typedSelected.id;
			const name: string = typedSelected.name;
			const price: number = typedSelected.price;
			const inStock: boolean = typedSelected.inStock;

			// These should not compile - category not selected
			const category: string = (selected as unknown as { category: string })
				.category;

			// @ts-expect-error - supplier not selected
			const supplier = selected.supplier;

			expect(id).toBe("prod-1");
			expect(price).toBe(999);
		});
	});

	describe("Edge Cases", () => {
		it("should handle selection on empty arrays", () => {
			const emptyArray: UnknownRecord[] = [];
			const result = applySelectionToArray(emptyArray, {
				id: true,
				name: true,
			});
			expect(result).toEqual([]);
		});

		it("should handle selection with no fields", () => {
			const data = { id: "1", name: "Test", value: 42 };
			const result = applyObjectSelection(data, {});
			expect(result).toEqual({});
		});

		it("should handle selection of non-existent fields gracefully", () => {
			const data = { id: "1", name: "Test" };
			// intentionally selecting non-existent field for edge case test
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
	});
});
