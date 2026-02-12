import { describe, expect, it } from "vitest";
import {
	getNestedValue,
	setNestedValue,
	isDotPath,
} from "../src/utils/nested-path";

describe("nested-path utilities", () => {
	describe("isDotPath", () => {
		it("should return false for single-segment paths", () => {
			expect(isDotPath("name")).toBe(false);
			expect(isDotPath("id")).toBe(false);
			expect(isDotPath("")).toBe(false);
		});

		it("should return true for dot-notation paths", () => {
			expect(isDotPath("a.b")).toBe(true);
			expect(isDotPath("metadata.views")).toBe(true);
			expect(isDotPath("a.b.c")).toBe(true);
			expect(isDotPath(".")).toBe(true);
			expect(isDotPath("a.")).toBe(true);
			expect(isDotPath(".b")).toBe(true);
		});
	});

	describe("getNestedValue", () => {
		describe("flat path (single-segment)", () => {
			it("should return direct property value for single-segment path", () => {
				const obj = { name: "John", age: 30 };
				expect(getNestedValue(obj, "name")).toBe("John");
				expect(getNestedValue(obj, "age")).toBe(30);
			});

			it("should return undefined for missing property", () => {
				const obj = { name: "John" };
				expect(getNestedValue(obj, "missing")).toBeUndefined();
			});

			it("should return the object itself for nested object property", () => {
				const obj = { metadata: { views: 100, rating: 5 } };
				expect(getNestedValue(obj, "metadata")).toEqual({
					views: 100,
					rating: 5,
				});
			});
		});

		describe("2-level path", () => {
			it("should return nested value for 2-level path", () => {
				const obj = { metadata: { views: 100 } };
				expect(getNestedValue(obj, "metadata.views")).toBe(100);
			});

			it("should return nested object for 2-level path pointing to object", () => {
				const obj = { a: { b: { c: 1 } } };
				expect(getNestedValue(obj, "a.b")).toEqual({ c: 1 });
			});

			it("should return string at nested level", () => {
				const obj = { author: { name: "Frank Herbert" } };
				expect(getNestedValue(obj, "author.name")).toBe("Frank Herbert");
			});
		});

		describe("3-level path", () => {
			it("should return deeply nested value for 3-level path", () => {
				const obj = { a: { b: { c: "deep" } } };
				expect(getNestedValue(obj, "a.b.c")).toBe("deep");
			});

			it("should return nested number at 3 levels", () => {
				const obj = { level1: { level2: { level3: 42 } } };
				expect(getNestedValue(obj, "level1.level2.level3")).toBe(42);
			});

			it("should return nested array at 3 levels", () => {
				const obj = { data: { nested: { items: [1, 2, 3] } } };
				expect(getNestedValue(obj, "data.nested.items")).toEqual([1, 2, 3]);
			});
		});

		describe("missing intermediate", () => {
			it("should return undefined when intermediate object is missing", () => {
				const obj = { name: "John" };
				expect(getNestedValue(obj, "metadata.views")).toBeUndefined();
			});

			it("should return undefined for deeply missing intermediate", () => {
				const obj = { a: { b: 1 } };
				expect(getNestedValue(obj, "a.x.y.z")).toBeUndefined();
			});

			it("should return undefined when first segment is missing", () => {
				const obj = { name: "John" };
				expect(getNestedValue(obj, "missing.path")).toBeUndefined();
			});
		});

		describe("null intermediate", () => {
			it("should return undefined when intermediate is null", () => {
				const obj = { metadata: null };
				expect(getNestedValue(obj, "metadata.views")).toBeUndefined();
			});

			it("should return undefined when deeply nested intermediate is null", () => {
				const obj = { a: { b: null } };
				expect(getNestedValue(obj, "a.b.c")).toBeUndefined();
			});

			it("should return null when null is the final value", () => {
				const obj = { value: null };
				expect(getNestedValue(obj, "value")).toBeNull();
			});

			it("should return null when nested null is the final value", () => {
				const obj = { metadata: { value: null } };
				expect(getNestedValue(obj, "metadata.value")).toBeNull();
			});
		});

		describe("empty string path", () => {
			it("should return undefined for empty string path", () => {
				const obj = { "": "empty key", name: "John" };
				// Empty string is a valid property access in JS
				expect(getNestedValue(obj, "")).toBe("empty key");
			});

			it("should return undefined for object without empty string key", () => {
				const obj = { name: "John" };
				expect(getNestedValue(obj, "")).toBeUndefined();
			});
		});

		describe("single-segment path (optimized path)", () => {
			it("should use fast path for single-segment (no dot)", () => {
				const obj = { name: "test", value: 123 };
				expect(getNestedValue(obj, "name")).toBe("test");
				expect(getNestedValue(obj, "value")).toBe(123);
			});

			it("should handle boolean values", () => {
				const obj = { active: true, disabled: false };
				expect(getNestedValue(obj, "active")).toBe(true);
				expect(getNestedValue(obj, "disabled")).toBe(false);
			});

			it("should handle undefined values", () => {
				const obj = { value: undefined };
				expect(getNestedValue(obj, "value")).toBeUndefined();
			});
		});

		describe("edge cases", () => {
			it("should handle primitive intermediate (non-object)", () => {
				const obj = { value: "string" };
				expect(getNestedValue(obj, "value.length")).toBeUndefined();
			});

			it("should handle number intermediate", () => {
				const obj = { value: 42 };
				expect(getNestedValue(obj, "value.nested")).toBeUndefined();
			});

			it("should handle array intermediate", () => {
				const obj = { items: [1, 2, 3] };
				// Arrays are objects, so numeric string keys work
				expect(getNestedValue(obj, "items.0")).toBe(1);
				expect(getNestedValue(obj, "items.length")).toBe(3);
			});

			it("should handle empty object", () => {
				const obj = {};
				expect(getNestedValue(obj, "any.path")).toBeUndefined();
			});
		});
	});
});
