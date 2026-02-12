import { describe, expect, it } from "vitest";
import { DEFAULT_STORAGE_KEY_PREFIX, pathToKey } from "../src/path-to-key.js";

// ============================================================================
// pathToKey - Basic functionality
// ============================================================================

describe("pathToKey", () => {
	describe("default prefix", () => {
		it("converts ./data/books.yaml to proseql:data/books.yaml", () => {
			expect(pathToKey("./data/books.yaml")).toBe("proseql:data/books.yaml");
		});

		it("uses proseql: as the default prefix", () => {
			expect(DEFAULT_STORAGE_KEY_PREFIX).toBe("proseql:");
		});
	});

	describe("custom prefix", () => {
		it("converts ./data/books.yaml with prefix myapp: to myapp:data/books.yaml", () => {
			expect(pathToKey("./data/books.yaml", "myapp:")).toBe(
				"myapp:data/books.yaml",
			);
		});

		it("supports empty prefix", () => {
			expect(pathToKey("./data/books.yaml", "")).toBe("data/books.yaml");
		});

		it("supports prefix without colon", () => {
			expect(pathToKey("./data/books.yaml", "app_")).toBe(
				"app_data/books.yaml",
			);
		});
	});

	describe("backslash normalization", () => {
		it("converts Windows-style backslashes to forward slashes", () => {
			expect(pathToKey(".\\data\\books.yaml")).toBe("proseql:data/books.yaml");
		});

		it("handles mixed slashes", () => {
			expect(pathToKey(".\\data/books\\file.yaml")).toBe(
				"proseql:data/books/file.yaml",
			);
		});

		it("normalizes deeply nested Windows paths", () => {
			expect(pathToKey(".\\a\\b\\c\\d.json")).toBe("proseql:a/b/c/d.json");
		});
	});

	describe("paths without leading ./", () => {
		it("converts data/books.yaml to proseql:data/books.yaml", () => {
			expect(pathToKey("data/books.yaml")).toBe("proseql:data/books.yaml");
		});

		it("handles simple filename", () => {
			expect(pathToKey("books.yaml")).toBe("proseql:books.yaml");
		});
	});

	describe("empty string", () => {
		it("maps empty string to proseql:", () => {
			expect(pathToKey("")).toBe("proseql:");
		});

		it("maps empty string with custom prefix to just the prefix", () => {
			expect(pathToKey("", "custom:")).toBe("custom:");
		});
	});

	describe("nested paths", () => {
		it("converts ./a/b/c/d.json to proseql:a/b/c/d.json", () => {
			expect(pathToKey("./a/b/c/d.json")).toBe("proseql:a/b/c/d.json");
		});

		it("handles deeply nested paths without leading ./", () => {
			expect(pathToKey("one/two/three/four/five/file.txt")).toBe(
				"proseql:one/two/three/four/five/file.txt",
			);
		});
	});

	describe("edge cases", () => {
		it("handles multiple leading ./", () => {
			expect(pathToKey("./././data/books.yaml")).toBe(
				"proseql:data/books.yaml",
			);
		});

		it("handles standalone dot", () => {
			expect(pathToKey(".")).toBe("proseql:");
		});

		it("handles absolute paths by stripping leading /", () => {
			expect(pathToKey("/absolute/path.yaml")).toBe(
				"proseql:absolute/path.yaml",
			);
		});

		it("handles trailing slashes", () => {
			expect(pathToKey("./data/")).toBe("proseql:data");
		});

		it("handles multiple consecutive slashes", () => {
			expect(pathToKey("./data//books.yaml")).toBe("proseql:data/books.yaml");
		});

		it("handles only slashes", () => {
			expect(pathToKey("///")).toBe("proseql:");
		});

		it("preserves parent directory references", () => {
			expect(pathToKey("../data/books.yaml")).toBe(
				"proseql:../data/books.yaml",
			);
		});

		it("handles complex parent references", () => {
			expect(pathToKey("./../data/../other/file.json")).toBe(
				"proseql:../data/../other/file.json",
			);
		});
	});
});
