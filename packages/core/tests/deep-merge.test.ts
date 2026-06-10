import { describe, expect, it } from "vitest";
import { deepMerge, deepMergeAll } from "../src/utils/deep-merge";

describe("deepMerge overlay utility", () => {
	describe("deepMerge (pairwise)", () => {
		it("unions disjoint keys", () => {
			const base = { a: 1 };
			const overlay = { b: 2 };
			expect(deepMerge(base, overlay)).toEqual({ a: 1, b: 2 });
		});

		it("merges nested objects recursively with later scalar winning", () => {
			const base = { macros: { cal: 10, fat: 1 } };
			const overlay = { macros: { fat: 2, protein: 3 } };
			expect(deepMerge(base, overlay)).toEqual({
				macros: { cal: 10, fat: 2, protein: 3 },
			});
		});

		it("replaces arrays wholesale rather than merging or concatenating", () => {
			const base = { tags: ["a", "b"] };
			const overlay = { tags: ["c"] };
			expect(deepMerge(base, overlay)).toEqual({ tags: ["c"] });
		});

		it("lets an object overwrite a scalar and a scalar overwrite an object", () => {
			expect(deepMerge({ x: 1 }, { x: { y: 2 } })).toEqual({ x: { y: 2 } });
			expect(deepMerge({ x: { y: 2 } }, { x: 1 })).toEqual({ x: 1 });
		});

		it("lets null replace a prior object value", () => {
			expect(deepMerge({ x: { y: 1 } }, { x: null })).toEqual({ x: null });
		});

		it("does not mutate either input", () => {
			const base = { macros: { cal: 10 } };
			const overlay = { macros: { fat: 2 } };
			const merged = deepMerge(base, overlay);
			expect(base).toEqual({ macros: { cal: 10 } });
			expect(overlay).toEqual({ macros: { fat: 2 } });
			expect(merged).not.toBe(base);
			expect(merged.macros).not.toBe(base.macros);
		});
	});

	describe("deepMergeAll (ordered list)", () => {
		it("returns an empty object for an empty list", () => {
			expect(deepMergeAll([])).toEqual({});
		});

		it("returns an equivalent (but new) object for a single fragment", () => {
			const only = { a: { b: 1 } };
			const merged = deepMergeAll([only]);
			expect(merged).toEqual({ a: { b: 1 } });
			expect(merged).not.toBe(only);
			expect(merged.a).not.toBe(only.a);
		});

		it("applies fragments in order so the last fragment wins on a conflicting leaf", () => {
			const fragments = [
				{ macros: { cal: 1 } },
				{ macros: { cal: 2 } },
				{ macros: { cal: 3 } },
			];
			expect(deepMergeAll(fragments)).toEqual({ macros: { cal: 3 } });
		});

		it("deep-merges across three fragments preserving disjoint nested keys", () => {
			const fragments = [
				{ food: { name: "x", macros: { cal: 1 } } },
				{ food: { macros: { fat: 2 } } },
				{ food: { macros: { cal: 9 }, serving: { grams: 15 } } },
			];
			expect(deepMergeAll(fragments)).toEqual({
				food: { name: "x", macros: { cal: 9, fat: 2 }, serving: { grams: 15 } },
			});
		});

		it("does not mutate any input fragment", () => {
			const a = { m: { cal: 1 } };
			const b = { m: { fat: 2 } };
			deepMergeAll([a, b]);
			expect(a).toEqual({ m: { cal: 1 } });
			expect(b).toEqual({ m: { fat: 2 } });
		});
	});
});
