import { describe, it, expect } from "vitest";
import {
	applyObjectSelection,
	applySelectionToArray,
	applySelectionSafe,
	shouldSelectField,
	hasSelectedFields,
	mergeObjectFieldSelections,
	createFieldSelector,
	createArrayFieldSelector,
} from "../core/operations/query/select";

describe("Field Selection", () => {
	describe("applyObjectSelection", () => {
		it("should select specified fields from an object", () => {
			const data = {
				id: "1",
				name: "John",
				email: "john@example.com",
				age: 30,
			};
			const result = applyObjectSelection(data, { name: true, email: true });

			expect(result).toEqual({
				name: "John",
				email: "john@example.com",
			});

			// Type check - these should be available
			expect(result.name).toBe("John");
			expect(result.email).toBe("john@example.com");

			// @ts-expect-error - age should not be available
			expect(result.age).toBeUndefined();
		});

		it("should handle empty field selection", () => {
			const data = { id: "1", name: "John" };
			const result = applyObjectSelection(data, {});

			expect(result).toEqual({});
		});

		it("should preserve populated relationships", () => {
			const dataWithCompany = {
				id: "1",
				name: "John",
				company: { id: "c1", name: "Acme Corp", revenue: 1000000 },
			};

			const result = applyObjectSelection(dataWithCompany, {
				name: true,
				company: true,
			});

			expect(result).toEqual({
				name: "John",
				company: { id: "c1", name: "Acme Corp", revenue: 1000000 },
			});

			// Type check - company should be fully typed
			expect(result.company.id).toBe("c1");
			expect(result.company.name).toBe("Acme Corp");
			expect(result.company.revenue).toBe(1000000);
		});

		it("should handle nested nulls and undefined", () => {
			const data = {
				id: "1",
				name: "John",
				company: null,
				department: undefined,
			};

			const result = applyObjectSelection(data, {
				name: true,
				company: true,
				department: true,
			});

			expect(result).toEqual({
				name: "John",
				company: null,
				department: undefined,
			});
		});
	});

	describe("applySelectionToArray", () => {
		it("should apply selection to all items in array", () => {
			const data = [
				{ id: "1", name: "John", age: 30 },
				{ id: "2", name: "Jane", age: 25 },
			];

			const result = applySelectionToArray(data, { id: true, name: true });

			expect(result).toEqual([
				{ id: "1", name: "John" },
				{ id: "2", name: "Jane" },
			]);
		});

		it("should handle empty arrays", () => {
			const result = applySelectionToArray([], { id: true, name: true });
			expect(result).toEqual([]);
		});

		it("should handle non-array input", () => {
			const result = applySelectionToArray(null as unknown as never[], {
				id: true,
			});
			expect(result).toEqual([]);
		});
	});

	describe("applySelectionSafe", () => {
		it("should handle null input", () => {
			const result = applySelectionSafe(null, { name: true });
			expect(result).toBe(null);
		});

		it("should handle undefined input", () => {
			const result = applySelectionSafe(undefined, { name: true });
			expect(result).toBe(undefined);
		});

		it("should apply selection to valid objects", () => {
			const data = { id: "1", name: "John" };
			const result = applySelectionSafe(data, { name: true });
			expect(result).toEqual({ name: "John" });
		});
	});

	describe("shouldSelectField", () => {
		it("should return true when field is in selection", () => {
			expect(shouldSelectField("name", { id: true, name: true })).toBe(true);
		});

		it("should return false when field is not in selection", () => {
			expect(shouldSelectField("age", { id: true, name: true })).toBe(false);
		});

		it("should return true when selection is undefined", () => {
			expect(shouldSelectField("anything", undefined)).toBe(true);
		});
	});

	describe("hasSelectedFields", () => {
		it("should return true when object has all selected fields", () => {
			const obj = { id: "1", name: "John", age: 30 };
			expect(hasSelectedFields(obj, { id: true, name: true })).toBe(true);
		});

		it("should return false when object is missing selected fields", () => {
			const obj = { id: "1" };
			expect(hasSelectedFields(obj, { id: true, name: true })).toBe(false);
		});

		it("should handle invalid values", () => {
			expect(hasSelectedFields(null, { id: true })).toBe(false);
			expect(hasSelectedFields(undefined, { id: true })).toBe(false);
			expect(hasSelectedFields("string", { id: true })).toBe(false);
		});
	});

	describe("mergeObjectFieldSelections", () => {
		it("should merge multiple selections", () => {
			const result = mergeObjectFieldSelections<{
				id: string;
				name: string;
				age: number;
			}>({ id: true, name: true }, { name: true, age: true });

			expect(result).toEqual({ id: true, name: true, age: true });
		});

		it("should handle undefined selections", () => {
			const result = mergeObjectFieldSelections<{ id: string; name: string }>(
				{ id: true },
				undefined,
				{ name: true },
			);

			expect(result).toEqual({ id: true, name: true });
		});

		it("should return undefined when all selections are undefined", () => {
			const result = mergeObjectFieldSelections(undefined, undefined);
			expect(result).toBeUndefined();
		});
	});

	describe("createFieldSelector", () => {
		it("should create a reusable selector function", () => {
			const selector = createFieldSelector({ id: true, name: true });

			const data1 = { id: "1", name: "John", age: 30 };
			const data2 = { id: "2", name: "Jane", age: 25 };

			expect(selector(data1)).toEqual({ id: "1", name: "John" });
			expect(selector(data2)).toEqual({ id: "2", name: "Jane" });
		});
	});

	describe("createArrayFieldSelector", () => {
		it("should create a reusable array selector function", () => {
			const selector = createArrayFieldSelector({ id: true, name: true });

			const data = [
				{ id: "1", name: "John", age: 30 },
				{ id: "2", name: "Jane", age: 25 },
			];

			expect(selector(data)).toEqual([
				{ id: "1", name: "John" },
				{ id: "2", name: "Jane" },
			]);
		});
	});

	describe("Type Safety", () => {
		it("should maintain type safety through selection", () => {
			type User = {
				id: string;
				name: string;
				email: string;
				age: number;
				isActive: boolean;
			};

			const user: User = {
				id: "1",
				name: "John",
				email: "john@example.com",
				age: 30,
				isActive: true,
			};

			const selected = applyObjectSelection(user, {
				name: true,
				email: true,
				isActive: true,
			});

			// These should compile
			const name: string = selected.name;
			const email: string = selected.email;
			const isActive: boolean = selected.isActive;

			// @ts-expect-error - id not selected
			const id: string = selected.id;

			// @ts-expect-error - age not selected
			const age: number = selected.age;

			expect(name).toBe("John");
			expect(email).toBe("john@example.com");
			expect(isActive).toBe(true);
		});
	});
});
