import { describe, expect, it } from "vitest";
import { isMatch, matchesAny } from "../src/utils/glob-match";

describe("glob-match (picomatch wrapper)", () => {
	describe("isMatch", () => {
		it("matches a recursive **/*.yaml against a nested path", () => {
			expect(isMatch("a/b/c.yaml", "**/*.yaml")).toBe(true);
			expect(isMatch("a/b/c.json", "**/*.yaml")).toBe(false);
		});

		it("matches a brace group across each listed extension", () => {
			const pattern = "**/*.config.{json,yaml,toml}";
			expect(isMatch("x/app.config.json", pattern)).toBe(true);
			expect(isMatch("x/app.config.yaml", pattern)).toBe(true);
			expect(isMatch("x/app.config.toml", pattern)).toBe(true);
			expect(isMatch("x/app.config.ini", pattern)).toBe(false);
		});

		it("matches recursive ** at depth 0 and depth N", () => {
			expect(isMatch("c.yaml", "**/*.yaml")).toBe(true);
			expect(isMatch("a/b/c/d/e.yaml", "**/*.yaml")).toBe(true);
		});

		it("matches dotfiles per the pinned dot policy", () => {
			expect(isMatch(".config.yaml", "**/*.yaml")).toBe(true);
			expect(isMatch(".hidden/x.yaml", "**/*.yaml")).toBe(true);
		});

		it("never matches a path escaping the root", () => {
			expect(isMatch("../x.yaml", "**/*.yaml")).toBe(false);
		});
	});

	describe("matchesAny", () => {
		it("returns true when any pattern matches", () => {
			expect(matchesAny("a/b.yaml", ["**/*.json", "**/*.yaml"])).toBe(true);
		});

		it("returns false for an empty pattern list", () => {
			expect(matchesAny("a/b.yaml", [])).toBe(false);
		});

		it("returns false when no pattern matches", () => {
			expect(matchesAny("a/b.txt", ["**/*.json", "**/*.yaml"])).toBe(false);
		});
	});
});
