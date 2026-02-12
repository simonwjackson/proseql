import { describe, expect, it } from "vitest";
import {
	collectStringPaths,
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

	describe("collectStringPaths", () => {
		it("should return empty array for empty object", () => {
			expect(collectStringPaths({})).toEqual([]);
		});

		it("should collect top-level string fields", () => {
			const obj = { name: "John", age: 30 };
			const paths = collectStringPaths(obj);
			expect(paths).toContain("name");
			expect(paths).not.toContain("age");
		});

		it("should collect nested string fields", () => {
			const obj = { metadata: { description: "test", count: 5 } };
			const paths = collectStringPaths(obj);
			expect(paths).toContain("metadata.description");
			expect(paths).not.toContain("metadata.count");
		});

		it("should collect both top-level and nested string fields", () => {
			const obj = { name: "foo", metadata: { description: "bar", count: 5 } };
			const paths = collectStringPaths(obj);
			expect(paths).toEqual(["name", "metadata.description"]);
		});

		it("should handle deeply nested string fields", () => {
			const obj = { a: { b: { c: { d: "deep" } } } };
			const paths = collectStringPaths(obj);
			expect(paths).toEqual(["a.b.c.d"]);
		});

		it("should skip arrays (not recurse into them)", () => {
			const obj = { items: ["a", "b", "c"], name: "test" };
			const paths = collectStringPaths(obj);
			expect(paths).toEqual(["name"]);
			expect(paths).not.toContain("items.0");
		});

		it("should skip null values", () => {
			const obj = { name: "test", metadata: null };
			const paths = collectStringPaths(obj);
			expect(paths).toEqual(["name"]);
		});

		it("should handle mixed nested structure", () => {
			const obj = {
				title: "Book",
				metadata: {
					description: "A description",
					views: 100,
					tags: ["a", "b"],
				},
				author: {
					name: "Frank Herbert",
					country: "USA",
				},
			};
			const paths = collectStringPaths(obj);
			expect(paths).toContain("title");
			expect(paths).toContain("metadata.description");
			expect(paths).toContain("author.name");
			expect(paths).toContain("author.country");
			expect(paths).not.toContain("metadata.views");
			expect(paths).not.toContain("metadata.tags");
		});

		it("should return empty array when no strings exist", () => {
			const obj = { count: 1, active: true, items: [1, 2, 3] };
			expect(collectStringPaths(obj)).toEqual([]);
		});

		it("should handle object with only nested strings", () => {
			const obj = { data: { info: { label: "test" } } };
			const paths = collectStringPaths(obj);
			expect(paths).toEqual(["data.info.label"]);
		});
	});

	describe("setNestedValue", () => {
		describe("set leaf on existing object", () => {
			it("should set a leaf value on an existing nested object", () => {
				const obj = { metadata: { views: 100, rating: 5 } };
				const result = setNestedValue(obj, "metadata.views", 200);
				expect(result).toEqual({ metadata: { views: 200, rating: 5 } });
			});

			it("should set a new leaf value on existing nested object", () => {
				const obj = { metadata: { views: 100 } };
				const result = setNestedValue(obj, "metadata.rating", 5);
				expect(result).toEqual({ metadata: { views: 100, rating: 5 } });
			});

			it("should set a deeply nested leaf value", () => {
				const obj = { a: { b: { c: 1 } } };
				const result = setNestedValue(obj, "a.b.c", 42);
				expect(result).toEqual({ a: { b: { c: 42 } } });
			});

			it("should set a new leaf on existing deep path", () => {
				const obj = { a: { b: { c: 1 } } };
				const result = setNestedValue(obj, "a.b.d", 2);
				expect(result).toEqual({ a: { b: { c: 1, d: 2 } } });
			});

			it("should preserve sibling properties at all levels", () => {
				const obj = { a: { b: 1, c: 2 }, d: 3 };
				const result = setNestedValue(obj, "a.b", 10);
				expect(result).toEqual({ a: { b: 10, c: 2 }, d: 3 });
			});
		});

		describe("create intermediate objects", () => {
			it("should create intermediate objects for new path", () => {
				const obj = {};
				const result = setNestedValue(obj, "a.b.c", 1);
				expect(result).toEqual({ a: { b: { c: 1 } } });
			});

			it("should create missing intermediate object", () => {
				const obj = { a: 1 };
				const result = setNestedValue(obj, "b.c", 2);
				expect(result).toEqual({ a: 1, b: { c: 2 } });
			});

			it("should create multiple levels of intermediates", () => {
				const obj = { existing: "value" };
				const result = setNestedValue(obj, "a.b.c.d.e", "deep");
				expect(result).toEqual({
					existing: "value",
					a: { b: { c: { d: { e: "deep" } } } },
				});
			});

			it("should replace non-object intermediate with new object", () => {
				const obj = { a: "string" };
				const result = setNestedValue(obj, "a.b.c", 1);
				expect(result).toEqual({ a: { b: { c: 1 } } });
			});

			it("should replace null intermediate with new object", () => {
				const obj = { a: null };
				const result = setNestedValue(obj, "a.b", 1);
				expect(result).toEqual({ a: { b: 1 } });
			});
		});

		describe("single-segment path", () => {
			it("should set a direct property value", () => {
				const obj = { name: "old", age: 30 };
				const result = setNestedValue(obj, "name", "new");
				expect(result).toEqual({ name: "new", age: 30 });
			});

			it("should add a new direct property", () => {
				const obj = { name: "John" };
				const result = setNestedValue(obj, "age", 25);
				expect(result).toEqual({ name: "John", age: 25 });
			});

			it("should set a direct property to an object", () => {
				const obj = { name: "John" };
				const result = setNestedValue(obj, "metadata", { views: 100 });
				expect(result).toEqual({ name: "John", metadata: { views: 100 } });
			});

			it("should set a direct property to null", () => {
				const obj = { value: 1 };
				const result = setNestedValue(obj, "value", null);
				expect(result).toEqual({ value: null });
			});

			it("should set a direct property to undefined", () => {
				const obj = { value: 1 };
				const result = setNestedValue(obj, "value", undefined);
				expect(result).toEqual({ value: undefined });
			});
		});

		describe("verify immutability (original unchanged)", () => {
			it("should not modify the original object for nested path", () => {
				const original = { metadata: { views: 100, rating: 5 } };
				const originalCopy = JSON.parse(JSON.stringify(original));

				setNestedValue(original, "metadata.views", 200);

				expect(original).toEqual(originalCopy);
			});

			it("should not modify the original object for single-segment path", () => {
				const original = { name: "old", age: 30 };
				const originalCopy = JSON.parse(JSON.stringify(original));

				setNestedValue(original, "name", "new");

				expect(original).toEqual(originalCopy);
			});

			it("should not modify nested objects in original", () => {
				const original = { a: { b: { c: 1 } } };
				const originalA = original.a;
				const originalB = original.a.b;

				setNestedValue(original, "a.b.c", 42);

				// Original nested objects should be unchanged
				expect(original.a).toBe(originalA);
				expect(original.a.b).toBe(originalB);
				expect(original.a.b.c).toBe(1);
			});

			it("should create new object references along the path", () => {
				const original = { a: { b: { c: 1 } } };
				const result = setNestedValue(original, "a.b.c", 42);

				// Result should have new references along the path
				expect(result).not.toBe(original);
				expect(result.a).not.toBe(original.a);
				expect((result.a as Record<string, unknown>).b).not.toBe(original.a.b);
			});

			it("should preserve unchanged branches", () => {
				const sibling = { x: 1 };
				const original = { a: { b: 1 }, c: sibling };
				const result = setNestedValue(original, "a.b", 2);

				// The unchanged sibling branch should be the same reference
				expect(result.c).toBe(sibling);
			});
		});

		describe("edge cases", () => {
			it("should handle setting array values", () => {
				const obj = { data: {} };
				const result = setNestedValue(obj, "data.items", [1, 2, 3]);
				expect(result).toEqual({ data: { items: [1, 2, 3] } });
			});

			it("should handle setting boolean values", () => {
				const obj = { settings: {} };
				const result = setNestedValue(obj, "settings.enabled", true);
				expect(result).toEqual({ settings: { enabled: true } });
			});

			it("should handle empty string as value", () => {
				const obj = { data: { name: "test" } };
				const result = setNestedValue(obj, "data.name", "");
				expect(result).toEqual({ data: { name: "" } });
			});

			it("should handle numeric values", () => {
				const obj = {};
				const result = setNestedValue(obj, "stats.count", 0);
				expect(result).toEqual({ stats: { count: 0 } });
			});
		});
	});
});
