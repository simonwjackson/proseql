import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ConfigNotFoundError,
	discoverConfig,
	discoverConfigSync,
} from "../src/config/discovery";

/**
 * Tests for the config discovery module.
 *
 * Tests cover:
 * - Upward search finds config in parent directories
 * - Override path takes precedence
 * - Missing config error with helpful message
 * - Config file priority order (ts > js > json)
 */

describe("Config Discovery", () => {
	let tempRoot: string;
	const createdDirs: string[] = [];
	const createdFiles: string[] = [];

	/**
	 * Helper to create a temporary directory structure
	 */
	function createDir(relativePath: string): string {
		const fullPath = path.join(tempRoot, relativePath);
		fs.mkdirSync(fullPath, { recursive: true });
		createdDirs.push(fullPath);
		return fullPath;
	}

	/**
	 * Helper to create a temporary file
	 */
	function createFile(relativePath: string, content = ""): string {
		const fullPath = path.join(tempRoot, relativePath);
		const dir = path.dirname(fullPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
			createdDirs.push(dir);
		}
		fs.writeFileSync(fullPath, content);
		createdFiles.push(fullPath);
		return fullPath;
	}

	beforeEach(() => {
		// Create a unique temp directory for each test
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proseql-test-"));
		createdDirs.length = 0;
		createdFiles.length = 0;
	});

	afterEach(() => {
		// Clean up created files and directories
		for (const file of createdFiles) {
			if (fs.existsSync(file)) {
				fs.unlinkSync(file);
			}
		}
		// Remove directories in reverse order (deepest first)
		for (const dir of [...createdDirs].reverse()) {
			if (fs.existsSync(dir)) {
				try {
					fs.rmdirSync(dir);
				} catch {
					// Directory might not be empty, that's okay
				}
			}
		}
		// Clean up the temp root
		if (fs.existsSync(tempRoot)) {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	describe("discoverConfig (Effect-based)", () => {
		describe("upward search", () => {
			it("should find config in the current directory", async () => {
				const projectDir = createDir("project");
				createFile("project/proseql.config.ts", "export default {}");

				const result = await Effect.runPromise(discoverConfig(projectDir));

				expect(result).toBe(path.join(projectDir, "proseql.config.ts"));
			});

			it("should find config in a parent directory", async () => {
				const projectDir = createDir("project");
				const subDir = createDir("project/src/components");
				createFile("project/proseql.config.ts", "export default {}");

				const result = await Effect.runPromise(discoverConfig(subDir));

				expect(result).toBe(path.join(projectDir, "proseql.config.ts"));
			});

			it("should find config multiple levels up", async () => {
				const projectDir = createDir("project");
				const deepDir = createDir("project/src/features/auth/components");
				createFile("project/proseql.config.ts", "export default {}");

				const result = await Effect.runPromise(discoverConfig(deepDir));

				expect(result).toBe(path.join(projectDir, "proseql.config.ts"));
			});

			it("should prefer .ts config over .js config", async () => {
				const projectDir = createDir("project");
				createFile(
					"project/proseql.config.ts",
					"export default { format: 'ts' }",
				);
				createFile(
					"project/proseql.config.js",
					"export default { format: 'js' }",
				);

				const result = await Effect.runPromise(discoverConfig(projectDir));

				expect(result).toBe(path.join(projectDir, "proseql.config.ts"));
			});

			it("should prefer .js config over .json config", async () => {
				const projectDir = createDir("project");
				createFile(
					"project/proseql.config.js",
					"export default { format: 'js' }",
				);
				createFile("project/proseql.config.json", '{ "format": "json" }');

				const result = await Effect.runPromise(discoverConfig(projectDir));

				expect(result).toBe(path.join(projectDir, "proseql.config.js"));
			});

			it("should find .json config when no .ts or .js exists", async () => {
				const projectDir = createDir("project");
				createFile("project/proseql.config.json", '{ "format": "json" }');

				const result = await Effect.runPromise(discoverConfig(projectDir));

				expect(result).toBe(path.join(projectDir, "proseql.config.json"));
			});

			it("should find the nearest config when multiple exist in the hierarchy", async () => {
				const _rootDir = createDir("root");
				const projectDir = createDir("root/project");
				const srcDir = createDir("root/project/src");
				createFile("root/proseql.config.ts", "// root config");
				createFile("root/project/proseql.config.ts", "// project config");

				const result = await Effect.runPromise(discoverConfig(srcDir));

				// Should find the project config, not the root config
				expect(result).toBe(path.join(projectDir, "proseql.config.ts"));
			});
		});

		describe("override path", () => {
			it("should use absolute override path directly", async () => {
				const projectDir = createDir("project");
				const configPath = createFile(
					"project/custom.config.ts",
					"export default {}",
				);

				const result = await Effect.runPromise(
					discoverConfig(projectDir, configPath),
				);

				expect(result).toBe(configPath);
			});

			it("should resolve relative override path from cwd", async () => {
				const projectDir = createDir("project");
				createFile("project/config/proseql.config.ts", "export default {}");

				const result = await Effect.runPromise(
					discoverConfig(projectDir, "config/proseql.config.ts"),
				);

				expect(result).toBe(path.join(projectDir, "config/proseql.config.ts"));
			});

			it("should fail with ConfigNotFoundError for non-existent override path", async () => {
				const projectDir = createDir("project");

				const error = await Effect.runPromise(
					discoverConfig(projectDir, "nonexistent.config.ts").pipe(Effect.flip),
				);

				expect(error).toBeInstanceOf(ConfigNotFoundError);
				expect(error._tag).toBe("ConfigNotFoundError");
				expect(error.message).toContain("Config file not found");
				expect(error.searchedPaths).toHaveLength(1);
				expect(error.searchedPaths[0]).toContain("nonexistent.config.ts");
			});

			it("should ignore automatic discovery when override is provided", async () => {
				const projectDir = createDir("project");
				// Create a config that would be found by discovery
				createFile("project/proseql.config.ts", "export default {}");
				// But specify a different override that doesn't exist
				const customConfigPath = path.join(projectDir, "custom/my.config.ts");

				const error = await Effect.runPromise(
					discoverConfig(projectDir, customConfigPath).pipe(Effect.flip),
				);

				expect(error).toBeInstanceOf(ConfigNotFoundError);
				expect(error.message).toContain(customConfigPath);
			});
		});

		describe("missing config error", () => {
			it("should fail with ConfigNotFoundError when no config exists", async () => {
				const projectDir = createDir("project/src");

				const error = await Effect.runPromise(
					discoverConfig(projectDir).pipe(Effect.flip),
				);

				expect(error).toBeInstanceOf(ConfigNotFoundError);
				expect(error._tag).toBe("ConfigNotFoundError");
			});

			it("should include descriptive error message", async () => {
				const projectDir = createDir("project/src");

				const error = await Effect.runPromise(
					discoverConfig(projectDir).pipe(Effect.flip),
				);

				expect(error.message).toContain("No proseql config file found");
				expect(error.message).toContain(projectDir);
				expect(error.message).toContain("proseql.config.ts");
				expect(error.message).toContain("proseql.config.js");
				expect(error.message).toContain("proseql.config.json");
			});

			it("should include all searched paths in error", async () => {
				const projectDir = createDir("project");

				const error = await Effect.runPromise(
					discoverConfig(projectDir).pipe(Effect.flip),
				);

				// Should have searched for all config file names at each directory level
				expect(error.searchedPaths.length).toBeGreaterThan(0);

				// Should include the project directory searches
				const projectSearches = error.searchedPaths.filter((p) =>
					p.includes(projectDir),
				);
				expect(projectSearches).toContainEqual(
					path.join(projectDir, "proseql.config.ts"),
				);
				expect(projectSearches).toContainEqual(
					path.join(projectDir, "proseql.config.js"),
				);
				expect(projectSearches).toContainEqual(
					path.join(projectDir, "proseql.config.json"),
				);
			});

			it("should fail with error when starting directory does not exist", async () => {
				const nonExistentDir = path.join(tempRoot, "does-not-exist");

				const error = await Effect.runPromise(
					discoverConfig(nonExistentDir).pipe(Effect.flip),
				);

				expect(error).toBeInstanceOf(ConfigNotFoundError);
				expect(error.message).toContain("Starting directory does not exist");
				expect(error.message).toContain(nonExistentDir);
			});
		});

		describe("edge cases", () => {
			it("should handle config files that are actually directories", async () => {
				const projectDir = createDir("project");
				// Create a directory with the config file name (edge case)
				createDir("project/proseql.config.ts");

				const error = await Effect.runPromise(
					discoverConfig(projectDir).pipe(Effect.flip),
				);

				// Should not find the directory as a config file
				expect(error).toBeInstanceOf(ConfigNotFoundError);
			});

			it("should handle symlinks to config files", async () => {
				const projectDir = createDir("project");
				const realConfigPath = createFile(
					"project/configs/real.config.ts",
					"export default {}",
				);
				const symlinkPath = path.join(projectDir, "proseql.config.ts");

				// Create a symlink (skip test if symlinks aren't supported)
				try {
					fs.symlinkSync(realConfigPath, symlinkPath);
					createdFiles.push(symlinkPath);
				} catch {
					// Skip symlink test on systems that don't support it
					return;
				}

				const result = await Effect.runPromise(discoverConfig(projectDir));

				expect(result).toBe(symlinkPath);
			});
		});
	});

	describe("discoverConfigSync", () => {
		it("should find config in the current directory", () => {
			const projectDir = createDir("project");
			createFile("project/proseql.config.ts", "export default {}");

			const result = discoverConfigSync(projectDir);

			expect(result).toBe(path.join(projectDir, "proseql.config.ts"));
		});

		it("should find config in a parent directory", () => {
			const projectDir = createDir("project");
			const subDir = createDir("project/src");
			createFile("project/proseql.config.ts", "export default {}");

			const result = discoverConfigSync(subDir);

			expect(result).toBe(path.join(projectDir, "proseql.config.ts"));
		});

		it("should use override path when provided", () => {
			const projectDir = createDir("project");
			const configPath = createFile(
				"project/custom.config.ts",
				"export default {}",
			);

			const result = discoverConfigSync(projectDir, configPath);

			expect(result).toBe(configPath);
		});

		it("should throw error when config not found", () => {
			const projectDir = createDir("project");

			expect(() => discoverConfigSync(projectDir)).toThrow(
				"No proseql config file found",
			);
		});

		it("should throw error for non-existent override path", () => {
			const projectDir = createDir("project");

			expect(() =>
				discoverConfigSync(projectDir, "nonexistent.config.ts"),
			).toThrow("Config file not found");
		});

		it("should throw error when starting directory does not exist", () => {
			const nonExistentDir = path.join(tempRoot, "does-not-exist");

			expect(() => discoverConfigSync(nonExistentDir)).toThrow(
				"Starting directory does not exist",
			);
		});
	});
});
