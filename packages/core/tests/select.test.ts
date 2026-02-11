import { describe, it, expect } from "vitest";
import { Effect, Stream, Chunk } from "effect";
import { applySelect } from "../src/operations/query/select-stream";
import {
	applyObjectSelection,
	applySelectionToArray,
	applySelectionSafe,
	shouldSelectField,
	hasSelectedFields,
	mergeObjectFieldSelections,
	createFieldSelector,
	createArrayFieldSelector,
} from "../src/operations/query/select";

// Helper to run a stream-based select and collect results
const collectSelected = <T extends Record<string, unknown>>(
	items: ReadonlyArray<T>,
	select: Record<string, unknown> | ReadonlyArray<string> | undefined,
) =>
	Effect.runPromise(
		Stream.runCollect(Stream.fromIterable(items).pipe(applySelect<T>(select))),
	).then(Chunk.toArray);

describe("Field Selection (Stream-based + utility functions)", () => {
	// ============================================================================
	// Stream-based applySelect tests
	// ============================================================================

	describe("applySelect Stream combinator", () => {
		const users = [
			{ id: "1", name: "John", email: "john@example.com", age: 30 },
			{ id: "2", name: "Jane", email: "jane@example.com", age: 25 },
		];

		it("should select specified fields from stream items", async () => {
			const result = await collectSelected(users, { name: true, email: true });
			expect(result).toEqual([
				{ name: "John", email: "john@example.com" },
				{ name: "Jane", email: "jane@example.com" },
			]);
		});

		it("should handle empty field selection object (pass-through)", async () => {
			const result = await collectSelected(users, {});
			// Empty object = pass-through in stream combinator
			expect(result).toEqual(users);
		});

		it("should pass-through when select is undefined", async () => {
			const result = await collectSelected(users, undefined);
			expect(result).toEqual(users);
		});

		it("should preserve populated relationships when selected as true", async () => {
			const dataWithCompany = [
				{
					id: "1",
					name: "John",
					company: { id: "c1", name: "Acme Corp", revenue: 1000000 },
				},
			];

			const result = await collectSelected(dataWithCompany, {
				name: true,
				company: true,
			});

			expect(result).toEqual([
				{
					name: "John",
					company: { id: "c1", name: "Acme Corp", revenue: 1000000 },
				},
			]);
		});

		it("should apply nested selection to populated objects", async () => {
			const dataWithCompany = [
				{
					id: "1",
					name: "John",
					company: { id: "c1", name: "Acme Corp", revenue: 1000000 },
				},
			];

			const result = await collectSelected(dataWithCompany, {
				name: true,
				company: { name: true },
			});

			expect(result).toEqual([
				{ name: "John", company: { name: "Acme Corp" } },
			]);
		});

		it("should handle items with null and undefined field values", async () => {
			const data = [
				{ id: "1", name: "John", company: null as string | null },
				{ id: "2", name: "Jane", company: undefined as string | undefined },
			];

			const result = await collectSelected(data, { name: true, company: true });
			expect(result).toEqual([
				{ name: "John", company: null },
				{ name: "Jane", company: undefined },
			]);
		});

		it("should select via array-based selection", async () => {
			const result = await collectSelected(users, ["name", "email"]);
			expect(result).toEqual([
				{ name: "John", email: "john@example.com" },
				{ name: "Jane", email: "jane@example.com" },
			]);
		});
	});

	// ============================================================================
	// Synchronous utility: applyObjectSelection
	// ============================================================================

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

	// ============================================================================
	// Synchronous utility: applySelectionToArray
	// ============================================================================

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

	// ============================================================================
	// Synchronous utility: applySelectionSafe
	// ============================================================================

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

	// ============================================================================
	// Synchronous utility: shouldSelectField
	// ============================================================================

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

	// ============================================================================
	// Synchronous utility: hasSelectedFields
	// ============================================================================

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

	// ============================================================================
	// Synchronous utility: mergeObjectFieldSelections
	// ============================================================================

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

	// ============================================================================
	// Synchronous utility: createFieldSelector / createArrayFieldSelector
	// ============================================================================

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

	// ============================================================================
	// Type Safety
	// ============================================================================

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

		it("should preserve Stream error channel through selection", async () => {
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
	});
});
