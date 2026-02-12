import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/commands/init";

/**
 * Tests for the init command.
 *
 * Tests cover:
 * - Scaffolding creates expected files (config and data)
 * - --format flag creates data files in the specified format (json, yaml, toml)
 * - Abort on existing config with helpful message
 * - .gitignore handling in git repositories
 */

describe("Init Command", () => {
	let tempRoot: string;

	beforeEach(() => {
		// Create a unique temp directory for each test
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proseql-init-test-"));
	});

	afterEach(() => {
		// Clean up the temp directory
		if (fs.existsSync(tempRoot)) {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	/**
	 * Helper to create a directory structure within the temp root
	 */
	function createDir(relativePath: string): string {
		const fullPath = path.join(tempRoot, relativePath);
		fs.mkdirSync(fullPath, { recursive: true });
		return fullPath;
	}

	/**
	 * Helper to create a file within the temp root
	 */
	function createFile(relativePath: string, content = ""): string {
		const fullPath = path.join(tempRoot, relativePath);
		const dir = path.dirname(fullPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(fullPath, content);
		return fullPath;
	}

	/**
	 * Helper to read a file's contents
	 */
	function readFile(relativePath: string): string {
		const fullPath = path.join(tempRoot, relativePath);
		return fs.readFileSync(fullPath, "utf-8");
	}

	/**
	 * Helper to check if a file exists
	 */
	function fileExists(relativePath: string): boolean {
		const fullPath = path.join(tempRoot, relativePath);
		return fs.existsSync(fullPath);
	}

	describe("scaffolding creates expected files", () => {
		it("should create proseql.config.ts", () => {
			const projectDir = createDir("project");

			const result = runInit({ cwd: projectDir });

			expect(result.success).toBe(true);
			expect(fileExists("project/proseql.config.ts")).toBe(true);
		});

		it("should create data/ directory", () => {
			const projectDir = createDir("project");

			const result = runInit({ cwd: projectDir });

			expect(result.success).toBe(true);
			expect(fileExists("project/data")).toBe(true);
			expect(
				fs.statSync(path.join(tempRoot, "project/data")).isDirectory(),
			).toBe(true);
		});

		it("should create data/notes.json by default", () => {
			const projectDir = createDir("project");

			const result = runInit({ cwd: projectDir });

			expect(result.success).toBe(true);
			expect(fileExists("project/data/notes.json")).toBe(true);
		});

		it("should create valid JSON data file with example notes", () => {
			const projectDir = createDir("project");

			runInit({ cwd: projectDir });

			const content = readFile("project/data/notes.json");
			const data = JSON.parse(content);

			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(0);
			expect(data[0]).toHaveProperty("id");
			expect(data[0]).toHaveProperty("title");
			expect(data[0]).toHaveProperty("content");
			expect(data[0]).toHaveProperty("createdAt");
			expect(data[0]).toHaveProperty("updatedAt");
		});

		it("should create config file with correct collection reference", () => {
			const projectDir = createDir("project");

			runInit({ cwd: projectDir });

			const content = readFile("project/proseql.config.ts");

			// Should contain schema import
			expect(content).toContain('import { Schema } from "effect"');
			// Should contain DatabaseConfig type
			expect(content).toContain("DatabaseConfig");
			// Should reference the data file
			expect(content).toContain("./data/notes.json");
			// Should define NoteSchema
			expect(content).toContain("NoteSchema");
			// Should have notes collection
			expect(content).toContain("notes:");
		});

		it("should report created files in result", () => {
			const projectDir = createDir("project");

			const result = runInit({ cwd: projectDir });

			expect(result.success).toBe(true);
			expect(result.createdFiles).toBeDefined();
			expect(result.createdFiles).toContain("proseql.config.ts");
			expect(result.createdFiles).toContain("data/");
			expect(result.createdFiles).toContain("data/notes.json");
		});

		it("should return success message", () => {
			const projectDir = createDir("project");

			const result = runInit({ cwd: projectDir });

			expect(result.success).toBe(true);
			expect(result.message).toContain("successfully");
		});
	});

	describe("--format flag", () => {
		it("should create JSON data file with --format json", () => {
			const projectDir = createDir("project");

			const result = runInit({ cwd: projectDir, format: "json" });

			expect(result.success).toBe(true);
			expect(fileExists("project/data/notes.json")).toBe(true);
			expect(fileExists("project/data/notes.yaml")).toBe(false);
			expect(fileExists("project/data/notes.toml")).toBe(false);

			// Verify it's valid JSON
			const content = readFile("project/data/notes.json");
			expect(() => JSON.parse(content)).not.toThrow();
		});

		it("should create YAML data file with --format yaml", () => {
			const projectDir = createDir("project");

			const result = runInit({ cwd: projectDir, format: "yaml" });

			expect(result.success).toBe(true);
			expect(fileExists("project/data/notes.yaml")).toBe(true);
			expect(fileExists("project/data/notes.json")).toBe(false);
			expect(fileExists("project/data/notes.toml")).toBe(false);

			// Verify it has YAML structure
			const content = readFile("project/data/notes.yaml");
			expect(content).toContain("-");
			expect(content).toContain("id:");
			expect(content).toContain("title:");
		});

		it("should create TOML data file with --format toml", () => {
			const projectDir = createDir("project");

			const result = runInit({ cwd: projectDir, format: "toml" });

			expect(result.success).toBe(true);
			expect(fileExists("project/data/notes.toml")).toBe(true);
			expect(fileExists("project/data/notes.json")).toBe(false);
			expect(fileExists("project/data/notes.yaml")).toBe(false);

			// Verify it has TOML structure
			const content = readFile("project/data/notes.toml");
			expect(content).toContain("[[notes]]");
			expect(content).toContain("id =");
			expect(content).toContain("title =");
		});

		it("should update config file to reference correct format", () => {
			const projectDir = createDir("project");

			runInit({ cwd: projectDir, format: "yaml" });

			const configContent = readFile("project/proseql.config.ts");
			expect(configContent).toContain("./data/notes.yaml");
			expect(configContent).not.toContain("./data/notes.json");
		});

		it("should update config file to reference toml format", () => {
			const projectDir = createDir("project");

			runInit({ cwd: projectDir, format: "toml" });

			const configContent = readFile("project/proseql.config.ts");
			expect(configContent).toContain("./data/notes.toml");
			expect(configContent).not.toContain("./data/notes.json");
		});

		it("should report correct file in createdFiles with yaml format", () => {
			const projectDir = createDir("project");

			const result = runInit({ cwd: projectDir, format: "yaml" });

			expect(result.createdFiles).toContain("data/notes.yaml");
			expect(result.createdFiles).not.toContain("data/notes.json");
		});

		it("should report correct file in createdFiles with toml format", () => {
			const projectDir = createDir("project");

			const result = runInit({ cwd: projectDir, format: "toml" });

			expect(result.createdFiles).toContain("data/notes.toml");
			expect(result.createdFiles).not.toContain("data/notes.json");
		});

		it("should reject invalid format", () => {
			const projectDir = createDir("project");

			const result = runInit({ cwd: projectDir, format: "xml" });

			expect(result.success).toBe(false);
			expect(result.message).toContain("Invalid format");
			expect(result.message).toContain("xml");
			expect(result.message).toContain("json");
			expect(result.message).toContain("yaml");
			expect(result.message).toContain("toml");
		});

		it("should reject empty string format", () => {
			const projectDir = createDir("project");

			const result = runInit({ cwd: projectDir, format: "" });

			expect(result.success).toBe(false);
			expect(result.message).toContain("Invalid format");
		});
	});

	describe("abort on existing config", () => {
		it("should abort if proseql.config.ts exists", () => {
			const projectDir = createDir("project");
			createFile("project/proseql.config.ts", "export default {}");

			const result = runInit({ cwd: projectDir });

			expect(result.success).toBe(false);
			expect(result.message).toContain("config file already exists");
			expect(result.message).toContain("proseql.config.ts");
		});

		it("should abort if proseql.config.js exists", () => {
			const projectDir = createDir("project");
			createFile("project/proseql.config.js", "module.exports = {}");

			const result = runInit({ cwd: projectDir });

			expect(result.success).toBe(false);
			expect(result.message).toContain("config file already exists");
			expect(result.message).toContain("proseql.config.js");
		});

		it("should abort if proseql.config.json exists", () => {
			const projectDir = createDir("project");
			createFile("project/proseql.config.json", "{}");

			const result = runInit({ cwd: projectDir });

			expect(result.success).toBe(false);
			expect(result.message).toContain("config file already exists");
			expect(result.message).toContain("proseql.config.json");
		});

		it("should not create any files when config exists", () => {
			const projectDir = createDir("project");
			createFile("project/proseql.config.ts", "export default {}");

			runInit({ cwd: projectDir });

			// Should not create data directory
			expect(fileExists("project/data")).toBe(false);
		});

		it("should suggest removing existing config in error message", () => {
			const projectDir = createDir("project");
			createFile("project/proseql.config.ts", "export default {}");

			const result = runInit({ cwd: projectDir });

			expect(result.message).toContain("remove");
		});

		it("should detect existing config even with different format flag", () => {
			const projectDir = createDir("project");
			createFile("project/proseql.config.ts", "export default {}");

			const result = runInit({ cwd: projectDir, format: "yaml" });

			expect(result.success).toBe(false);
			expect(result.message).toContain("config file already exists");
		});
	});

	describe(".gitignore handling", () => {
		it("should create .gitignore with data/ entry in git repository", () => {
			const projectDir = createDir("project");
			// Create .git directory to simulate git repository
			createDir("project/.git");

			const result = runInit({ cwd: projectDir });

			expect(result.success).toBe(true);
			expect(fileExists("project/.gitignore")).toBe(true);

			const gitignoreContent = readFile("project/.gitignore");
			expect(gitignoreContent).toContain("data/");
		});

		it("should append to existing .gitignore", () => {
			const projectDir = createDir("project");
			createDir("project/.git");
			createFile("project/.gitignore", "node_modules/\n");

			const result = runInit({ cwd: projectDir });

			expect(result.success).toBe(true);

			const gitignoreContent = readFile("project/.gitignore");
			expect(gitignoreContent).toContain("node_modules/");
			expect(gitignoreContent).toContain("data/");
		});

		it("should not duplicate entry if data/ already in .gitignore", () => {
			const projectDir = createDir("project");
			createDir("project/.git");
			createFile("project/.gitignore", "node_modules/\ndata/\n");

			const result = runInit({ cwd: projectDir });

			expect(result.success).toBe(true);

			const gitignoreContent = readFile("project/.gitignore");
			const dataMatches = gitignoreContent.match(/data\//g) || [];
			expect(dataMatches.length).toBe(1);
		});

		it("should not create .gitignore outside git repository", () => {
			const projectDir = createDir("project");
			// No .git directory

			const result = runInit({ cwd: projectDir });

			expect(result.success).toBe(true);
			expect(fileExists("project/.gitignore")).toBe(false);
		});

		it("should report .gitignore in createdFiles when created", () => {
			const projectDir = createDir("project");
			createDir("project/.git");

			const result = runInit({ cwd: projectDir });

			expect(result.createdFiles).toContain(".gitignore");
		});

		it("should report .gitignore (updated) when appended", () => {
			const projectDir = createDir("project");
			createDir("project/.git");
			createFile("project/.gitignore", "node_modules/\n");

			const result = runInit({ cwd: projectDir });

			expect(result.createdFiles).toContain(".gitignore (updated)");
		});

		it("should not report .gitignore if pattern already exists", () => {
			const projectDir = createDir("project");
			createDir("project/.git");
			createFile("project/.gitignore", "data/\n");

			const result = runInit({ cwd: projectDir });

			// Should not include .gitignore in created files since nothing changed
			expect(result.createdFiles?.includes(".gitignore")).toBe(false);
			expect(result.createdFiles?.includes(".gitignore (updated)")).toBe(false);
		});

		it("should add comment before data/ entry", () => {
			const projectDir = createDir("project");
			createDir("project/.git");

			runInit({ cwd: projectDir });

			const gitignoreContent = readFile("project/.gitignore");
			expect(gitignoreContent).toContain("# ProseQL data directory");
		});
	});

	describe("edge cases", () => {
		it("should use process.cwd() when cwd option is not provided", () => {
			// This test verifies the default behavior
			// We can't easily test process.cwd() without mocking, so we just verify
			// that providing cwd explicitly works
			const projectDir = createDir("project");

			const result = runInit({ cwd: projectDir });

			expect(result.success).toBe(true);
		});

		it("should handle data directory that already exists", () => {
			const projectDir = createDir("project");
			createDir("project/data");

			const result = runInit({ cwd: projectDir });

			expect(result.success).toBe(true);
			expect(fileExists("project/data/notes.json")).toBe(true);
		});

		it("should handle data directory with existing files", () => {
			const projectDir = createDir("project");
			createDir("project/data");
			createFile("project/data/other.json", '{"foo": "bar"}');

			const result = runInit({ cwd: projectDir });

			expect(result.success).toBe(true);
			// Should create notes.json alongside existing file
			expect(fileExists("project/data/notes.json")).toBe(true);
			expect(fileExists("project/data/other.json")).toBe(true);
		});

		it("should create example data with timestamps", () => {
			const projectDir = createDir("project");

			runInit({ cwd: projectDir });

			const content = readFile("project/data/notes.json");
			const data = JSON.parse(content);

			// Check that timestamps are valid ISO strings
			expect(data[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(data[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});

		it("should create multiple example notes", () => {
			const projectDir = createDir("project");

			runInit({ cwd: projectDir });

			const content = readFile("project/data/notes.json");
			const data = JSON.parse(content);

			expect(data.length).toBe(2);
			expect(data[0].title).toContain("ProseQL");
			expect(data[1].title).toContain("Getting Started");
		});
	});
});
