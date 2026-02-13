import { describe, expect, it } from "vitest";
import {
	deserializeValue,
	serializeValue,
} from "../src/serializers/codecs/prose.js";

/**
 * Tests for prose value serialization and deserialization.
 * Task 2.4: Array element parsing — split on , respecting quoted elements
 * Task 2.5: Value round-trips
 */

describe("serializeValue", () => {
	describe("primitive types", () => {
		it("serializes numbers", () => {
			expect(serializeValue(42)).toBe("42");
			expect(serializeValue(-3.14)).toBe("-3.14");
			expect(serializeValue(0)).toBe("0");
			expect(serializeValue(-0)).toBe("0");
		});

		it("serializes booleans", () => {
			expect(serializeValue(true)).toBe("true");
			expect(serializeValue(false)).toBe("false");
		});

		it("serializes null and undefined", () => {
			expect(serializeValue(null)).toBe("~");
			expect(serializeValue(undefined)).toBe("~");
		});

		it("serializes strings as bare text", () => {
			expect(serializeValue("hello")).toBe("hello");
			expect(serializeValue("hello world")).toBe("hello world");
			expect(serializeValue("")).toBe("");
		});

		it("serializes negative numbers", () => {
			expect(serializeValue(-42)).toBe("-42");
			expect(serializeValue(-0.5)).toBe("-0.5");
		});

		it("serializes floats", () => {
			expect(serializeValue(3.14159)).toBe("3.14159");
			expect(serializeValue(0.001)).toBe("0.001");
		});
	});

	describe("array serialization", () => {
		it("serializes empty array", () => {
			expect(serializeValue([])).toBe("[]");
		});

		it("serializes simple arrays", () => {
			expect(serializeValue(["a", "b", "c"])).toBe("[a, b, c]");
			expect(serializeValue(["sci-fi", "classic"])).toBe("[sci-fi, classic]");
		});

		it("serializes array with single element", () => {
			expect(serializeValue(["only"])).toBe("[only]");
		});

		it("quotes elements containing commas", () => {
			expect(serializeValue(["one, two", "three"])).toBe('["one, two", three]');
		});

		it("quotes elements containing closing brackets", () => {
			expect(serializeValue(["a]b", "c"])).toBe('["a]b", c]');
		});

		it("escapes quotes in quoted elements", () => {
			expect(serializeValue(['say "hi"'])).toBe('["say \\"hi\\""]');
		});

		it("serializes mixed type arrays", () => {
			expect(serializeValue([1, "two", true, null])).toBe("[1, two, true, ~]");
		});

		it("handles nested arrays (inner arrays become quoted strings)", () => {
			// Nested arrays are serialized recursively - inner arrays become "[1, 2]" strings
			// which contain brackets, so they get quoted
			expect(
				serializeValue([
					[1, 2],
					[3, 4],
				]),
			).toBe('["[1, 2]", "[3, 4]"]');
		});
	});
});

describe("deserializeValue", () => {
	describe("primitive types", () => {
		it("deserializes numbers", () => {
			expect(deserializeValue("42")).toBe(42);
			expect(deserializeValue("-42")).toBe(-42);
			expect(deserializeValue("3.14")).toBe(3.14);
			expect(deserializeValue("-3.14")).toBe(-3.14);
			expect(deserializeValue("0")).toBe(0);
		});

		it("deserializes booleans", () => {
			expect(deserializeValue("true")).toBe(true);
			expect(deserializeValue("false")).toBe(false);
		});

		it("deserializes null", () => {
			expect(deserializeValue("~")).toBe(null);
		});

		it("deserializes strings (default)", () => {
			expect(deserializeValue("hello")).toBe("hello");
			expect(deserializeValue("hello world")).toBe("hello world");
			expect(deserializeValue("Frank Herbert")).toBe("Frank Herbert");
		});

		it("does not deserialize partial numbers", () => {
			expect(deserializeValue("42abc")).toBe("42abc");
			expect(deserializeValue("abc42")).toBe("abc42");
			expect(deserializeValue("3.14.15")).toBe("3.14.15");
		});
	});

	describe("array deserialization", () => {
		it("deserializes empty array", () => {
			expect(deserializeValue("[]")).toEqual([]);
		});

		it("deserializes simple arrays", () => {
			expect(deserializeValue("[a, b, c]")).toEqual(["a", "b", "c"]);
			expect(deserializeValue("[sci-fi, classic]")).toEqual([
				"sci-fi",
				"classic",
			]);
		});

		it("deserializes array with single element", () => {
			expect(deserializeValue("[only]")).toEqual(["only"]);
		});

		it("deserializes quoted elements containing commas", () => {
			expect(deserializeValue('["one, two", three]')).toEqual([
				"one, two",
				"three",
			]);
		});

		it("deserializes quoted elements containing brackets", () => {
			expect(deserializeValue('["a]b", c]')).toEqual(["a]b", "c"]);
		});

		it("deserializes escaped quotes in quoted elements", () => {
			expect(deserializeValue('["say \\"hi\\""]')).toEqual(['say "hi"']);
		});

		it("deserializes mixed type arrays", () => {
			expect(deserializeValue("[1, two, true, ~]")).toEqual([
				1,
				"two",
				true,
				null,
			]);
		});

		it("handles arrays with extra whitespace", () => {
			expect(deserializeValue("[  a  ,  b  ,  c  ]")).toEqual(["a", "b", "c"]);
		});

		it("handles arrays with no spaces", () => {
			expect(deserializeValue("[a,b,c]")).toEqual(["a", "b", "c"]);
		});
	});
});

describe("round-trip value serialization", () => {
	describe("primitive round-trips", () => {
		it("round-trips numbers", () => {
			expect(deserializeValue(serializeValue(42))).toBe(42);
			expect(deserializeValue(serializeValue(-3.14))).toBe(-3.14);
			expect(deserializeValue(serializeValue(0))).toBe(0);
		});

		it("round-trips booleans", () => {
			expect(deserializeValue(serializeValue(true))).toBe(true);
			expect(deserializeValue(serializeValue(false))).toBe(false);
		});

		it("round-trips null", () => {
			expect(deserializeValue(serializeValue(null))).toBe(null);
		});

		it("round-trips strings", () => {
			expect(deserializeValue(serializeValue("hello"))).toBe("hello");
			expect(deserializeValue(serializeValue("hello world"))).toBe(
				"hello world",
			);
		});

		// Note: empty string round-trips, but deserializes to empty string
		it("round-trips empty string", () => {
			expect(deserializeValue(serializeValue(""))).toBe("");
		});
	});

	describe("array round-trips", () => {
		it("round-trips empty array", () => {
			expect(deserializeValue(serializeValue([]))).toEqual([]);
		});

		it("round-trips simple arrays", () => {
			const arr = ["sci-fi", "classic"];
			expect(deserializeValue(serializeValue(arr))).toEqual(arr);
		});

		it("round-trips arrays with commas", () => {
			const arr = ["one, two", "three"];
			expect(deserializeValue(serializeValue(arr))).toEqual(arr);
		});

		it("round-trips arrays with brackets", () => {
			const arr = ["a]b", "c"];
			expect(deserializeValue(serializeValue(arr))).toEqual(arr);
		});

		it("round-trips arrays with quotes", () => {
			const arr = ['say "hi"', "world"];
			expect(deserializeValue(serializeValue(arr))).toEqual(arr);
		});

		it("round-trips mixed type arrays", () => {
			const arr = [1, "two", true, null];
			expect(deserializeValue(serializeValue(arr))).toEqual(arr);
		});

		it("round-trips arrays with negative numbers", () => {
			const arr = [-1, -3.14, 0];
			expect(deserializeValue(serializeValue(arr))).toEqual(arr);
		});
	});

	describe("edge cases", () => {
		it("string 'true' round-trips as boolean", () => {
			// This is expected behavior per spec: heuristic type detection
			expect(deserializeValue(serializeValue("true"))).toBe(true);
		});

		it("string '42' round-trips as number", () => {
			// This is expected behavior per spec: heuristic type detection
			expect(deserializeValue(serializeValue("42"))).toBe(42);
		});

		it("string '~' round-trips as null", () => {
			// This is expected behavior per spec: heuristic type detection
			expect(deserializeValue(serializeValue("~"))).toBe(null);
		});

		it("preserves array element with only commas", () => {
			const arr = [",,,"];
			expect(deserializeValue(serializeValue(arr))).toEqual(arr);
		});

		it("preserves array element with only brackets", () => {
			const arr = ["]]]"];
			expect(deserializeValue(serializeValue(arr))).toEqual(arr);
		});

		it("preserves array with complex quoted elements", () => {
			const arr = ['a, b, "c"', "d"];
			expect(deserializeValue(serializeValue(arr))).toEqual(arr);
		});
	});
});
