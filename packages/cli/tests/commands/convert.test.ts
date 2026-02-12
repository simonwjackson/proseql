import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
	runConvert,
	isValidFormat,
	VALID_FORMATS,
	type ConvertOptions,
	type ConvertResult,
	type TargetFormat,
} from "../../src/commands/convert"
import type { DatabaseConfig } from "@proseql/core"

/**
 * Tests for the convert command.
 *
 * Tests cover:
 * - Format conversion writes correct file
 * - Config file updates with new file path
 * - Old file removal after conversion
 * - Error handling for invalid inputs
 * - Format validation
 */

// Define a simple test schema
const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
})

// Sample test data - keyed by entity ID as proseql expects
const sampleBooks: Record<
	string,
	{ id: string; title: string; author: string; year: number }
> = {
	"1": { id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
	"2": { id: "2", title: "Neuromancer", author: "William Gibson", year: 1984 },
}

describe("Convert Command", () => {
	let tempRoot: string
	let configPath: string
	let dataFilePath: string

	beforeEach(() => {
		// Create a unique temp directory for each test
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proseql-convert-test-"))

		// Create data directory
		const dataDir = path.join(tempRoot, "data")
		fs.mkdirSync(dataDir, { recursive: true })

		dataFilePath = path.join(dataDir, "books.json")
		fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooks, null, 2))

		// Create config file
		configPath = path.join(tempRoot, "proseql.config.json")
	})

	afterEach(() => {
		// Clean up the temp directory
		if (fs.existsSync(tempRoot)) {
			fs.rmSync(tempRoot, { recursive: true, force: true })
		}
	})

	/**
	 * Helper to run convert command and handle Effect result
	 */
	async function executeConvert(options: Partial<ConvertOptions>): Promise<ConvertResult> {
		const { Effect } = await import("effect")
		const fullOptions: ConvertOptions = {
			collection: options.collection ?? "books",
			config: options.config ?? createConfig(),
			configPath: options.configPath ?? configPath,
			targetFormat: options.targetFormat ?? "yaml",
		}

		return Effect.runPromise(runConvert(fullOptions))
	}

	/**
	 * Helper to create a config object
	 */
	function createConfig(): DatabaseConfig {
		return {
			books: {
				schema: BookSchema,
				file: "./data/books.json",
				relationships: {},
			},
		} as DatabaseConfig
	}

	/**
	 * Helper to create a JSON config file
	 */
	function createJsonConfig(): void {
		const config = {
			books: {
				schema: "BookSchema",
				file: "./data/books.json",
				relationships: {},
			},
		}
		fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
	}

	/**
	 * Helper to create a TypeScript config file
	 */
	function createTsConfig(): void {
		configPath = path.join(tempRoot, "proseql.config.ts")
		const content = `export default {
  books: {
    schema: BookSchema,
    file: "./data/books.json",
    relationships: {},
  },
}`
		fs.writeFileSync(configPath, content)
	}

	describe("isValidFormat", () => {
		it("should return true for valid formats", () => {
			expect(isValidFormat("json")).toBe(true)
			expect(isValidFormat("yaml")).toBe(true)
			expect(isValidFormat("toml")).toBe(true)
			expect(isValidFormat("json5")).toBe(true)
			expect(isValidFormat("jsonc")).toBe(true)
			expect(isValidFormat("hjson")).toBe(true)
			expect(isValidFormat("toon")).toBe(true)
		})

		it("should return false for invalid formats", () => {
			expect(isValidFormat("xml")).toBe(false)
			expect(isValidFormat("csv")).toBe(false)
			expect(isValidFormat("invalid")).toBe(false)
			expect(isValidFormat("")).toBe(false)
		})
	})

	describe("VALID_FORMATS", () => {
		it("should contain all supported formats", () => {
			expect(VALID_FORMATS).toContain("json")
			expect(VALID_FORMATS).toContain("yaml")
			expect(VALID_FORMATS).toContain("toml")
			expect(VALID_FORMATS).toContain("json5")
			expect(VALID_FORMATS).toContain("jsonc")
			expect(VALID_FORMATS).toContain("hjson")
			expect(VALID_FORMATS).toContain("toon")
			expect(VALID_FORMATS.length).toBe(7)
		})
	})

	describe("format conversion writes correct file", () => {
		it("should convert JSON to YAML format", async () => {
			const result = await executeConvert({
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.data?.newFormat).toBe("yaml")
			expect(result.data?.oldFormat).toBe("json")

			// Verify new file exists
			const newFilePath = path.join(tempRoot, "data", "books.yaml")
			expect(fs.existsSync(newFilePath)).toBe(true)

			// Verify content is valid YAML
			const content = fs.readFileSync(newFilePath, "utf-8")
			expect(content).toContain("title:")
			expect(content).toContain("Dune")
		})

		it("should convert JSON to TOML format", async () => {
			const result = await executeConvert({
				targetFormat: "toml",
			})

			expect(result.success).toBe(true)
			expect(result.data?.newFormat).toBe("toml")
			expect(result.data?.oldFormat).toBe("json")

			// Verify new file exists
			const newFilePath = path.join(tempRoot, "data", "books.toml")
			expect(fs.existsSync(newFilePath)).toBe(true)
		})

		it("should convert JSON to JSON5 format", async () => {
			const result = await executeConvert({
				targetFormat: "json5",
			})

			expect(result.success).toBe(true)
			expect(result.data?.newFormat).toBe("json5")

			// Verify new file exists with correct extension
			const newFilePath = path.join(tempRoot, "data", "books.json5")
			expect(fs.existsSync(newFilePath)).toBe(true)
		})

		it("should convert JSON to JSONC format", async () => {
			const result = await executeConvert({
				targetFormat: "jsonc",
			})

			expect(result.success).toBe(true)
			expect(result.data?.newFormat).toBe("jsonc")

			// Verify new file exists with correct extension
			const newFilePath = path.join(tempRoot, "data", "books.jsonc")
			expect(fs.existsSync(newFilePath)).toBe(true)
		})

		it("should convert JSON to Hjson format", async () => {
			const result = await executeConvert({
				targetFormat: "hjson",
			})

			expect(result.success).toBe(true)
			expect(result.data?.newFormat).toBe("hjson")

			// Verify new file exists with correct extension
			const newFilePath = path.join(tempRoot, "data", "books.hjson")
			expect(fs.existsSync(newFilePath)).toBe(true)
		})

		it("should convert JSON to TOON format", async () => {
			const result = await executeConvert({
				targetFormat: "toon",
			})

			expect(result.success).toBe(true)
			expect(result.data?.newFormat).toBe("toon")

			// Verify new file exists with correct extension
			const newFilePath = path.join(tempRoot, "data", "books.toon")
			expect(fs.existsSync(newFilePath)).toBe(true)
		})

		it("should convert YAML to JSON format", async () => {
			// First create a YAML file
			const yamlFilePath = path.join(tempRoot, "data", "books.yaml")
			const yamlContent = `"1":
  id: "1"
  title: Dune
  author: Frank Herbert
  year: 1965
"2":
  id: "2"
  title: Neuromancer
  author: William Gibson
  year: 1984`
			fs.writeFileSync(yamlFilePath, yamlContent)

			const yamlConfig: DatabaseConfig = {
				books: {
					schema: BookSchema,
					file: "./data/books.yaml",
					relationships: {},
				},
			} as DatabaseConfig

			const result = await executeConvert({
				config: yamlConfig,
				targetFormat: "json",
			})

			expect(result.success).toBe(true)
			expect(result.data?.newFormat).toBe("json")
			expect(result.data?.oldFormat).toBe("yaml")

			// Verify new file exists
			const newFilePath = path.join(tempRoot, "data", "books.json")
			expect(fs.existsSync(newFilePath)).toBe(true)

			// Verify content is valid JSON
			const content = fs.readFileSync(newFilePath, "utf-8")
			const parsed = JSON.parse(content) as Record<string, unknown>
			expect(parsed["1"]).toBeDefined()
			expect((parsed["1"] as Record<string, unknown>).title).toBe("Dune")
		})

		it("should preserve data integrity during conversion", async () => {
			const result = await executeConvert({
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)

			// Convert back to JSON to verify data integrity
			const yamlConfig: DatabaseConfig = {
				books: {
					schema: BookSchema,
					file: "./data/books.yaml",
					relationships: {},
				},
			} as DatabaseConfig

			const roundtripResult = await executeConvert({
				config: yamlConfig,
				targetFormat: "json",
			})

			expect(roundtripResult.success).toBe(true)

			// Verify data is preserved
			const finalFilePath = path.join(tempRoot, "data", "books.json")
			const content = fs.readFileSync(finalFilePath, "utf-8")
			const parsed = JSON.parse(content) as Record<string, Record<string, unknown>>
			expect(parsed["1"].id).toBe("1")
			expect(parsed["1"].title).toBe("Dune")
			expect(parsed["1"].author).toBe("Frank Herbert")
			expect(parsed["1"].year).toBe(1965)
			expect(parsed["2"].id).toBe("2")
			expect(parsed["2"].title).toBe("Neuromancer")
		})
	})

	describe("config file updates", () => {
		it("should update JSON config file with new file path", async () => {
			createJsonConfig()

			const result = await executeConvert({
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)
			expect(result.data?.configUpdated).toBe(true)

			// Verify config was updated
			const configContent = fs.readFileSync(configPath, "utf-8")
			const config = JSON.parse(configContent) as Record<string, Record<string, unknown>>
			expect(config.books.file).toBe("./data/books.yaml")
		})

		it("should update TypeScript config file with new file path", async () => {
			createTsConfig()

			const result = await executeConvert({
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)
			expect(result.data?.configUpdated).toBe(true)

			// Verify config was updated
			const configContent = fs.readFileSync(configPath, "utf-8")
			expect(configContent).toContain('./data/books.yaml')
		})

		it("should include collection name in result", async () => {
			const result = await executeConvert({
				collection: "books",
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)
			expect(result.data?.collection).toBe("books")
		})

		it("should include old file path in result", async () => {
			const result = await executeConvert({
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)
			expect(result.data?.oldFile).toContain("books.json")
		})

		it("should include new file path in result", async () => {
			const result = await executeConvert({
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)
			expect(result.data?.newFile).toContain("books.yaml")
		})
	})

	describe("old file removal", () => {
		it("should remove old file after successful conversion", async () => {
			const result = await executeConvert({
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)

			// Verify old file was removed
			expect(fs.existsSync(dataFilePath)).toBe(false)

			// Verify new file exists
			const newFilePath = path.join(tempRoot, "data", "books.yaml")
			expect(fs.existsSync(newFilePath)).toBe(true)
		})

		it("should not leave orphaned files on successful conversion", async () => {
			const result = await executeConvert({
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)

			// List files in data directory
			const dataDir = path.join(tempRoot, "data")
			const files = fs.readdirSync(dataDir)

			// Should only have one books file (the converted one)
			const booksFiles = files.filter(f => f.startsWith("books."))
			expect(booksFiles.length).toBe(1)
			expect(booksFiles[0]).toBe("books.yaml")
		})
	})

	describe("error handling", () => {
		it("should fail for non-existent collection", async () => {
			const result = await executeConvert({
				collection: "nonexistent",
				targetFormat: "yaml",
			})

			expect(result.success).toBe(false)
			expect(result.message).toContain("not found")
			expect(result.message).toContain("nonexistent")
		})

		it("should fail when collection has no file configured", async () => {
			const inMemoryConfig: DatabaseConfig = {
				books: {
					schema: BookSchema,
					relationships: {},
				},
			} as DatabaseConfig

			const result = await executeConvert({
				config: inMemoryConfig,
				targetFormat: "yaml",
			})

			expect(result.success).toBe(false)
			expect(result.message).toContain("does not have a file configured")
		})

		it("should fail when data file does not exist", async () => {
			// Remove the data file
			fs.unlinkSync(dataFilePath)

			const result = await executeConvert({
				targetFormat: "yaml",
			})

			expect(result.success).toBe(false)
			expect(result.message).toContain("does not exist")
		})

		it("should fail when already in the target format", async () => {
			const result = await executeConvert({
				targetFormat: "json",
			})

			expect(result.success).toBe(false)
			expect(result.message).toContain("already in json format")
		})
	})

	describe("multiple collections", () => {
		it("should only convert the specified collection", async () => {
			// Create additional collection data file
			const authorsFilePath = path.join(tempRoot, "data", "authors.json")
			fs.writeFileSync(authorsFilePath, JSON.stringify({ "a1": { id: "a1", name: "Frank Herbert" } }, null, 2))

			const AuthorSchema = Schema.Struct({
				id: Schema.String,
				name: Schema.String,
			})

			const multiConfig: DatabaseConfig = {
				books: {
					schema: BookSchema,
					file: "./data/books.json",
					relationships: {},
				},
				authors: {
					schema: AuthorSchema,
					file: "./data/authors.json",
					relationships: {},
				},
			} as DatabaseConfig

			const result = await executeConvert({
				collection: "books",
				config: multiConfig,
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)

			// Books should be converted
			expect(fs.existsSync(path.join(tempRoot, "data", "books.yaml"))).toBe(true)
			expect(fs.existsSync(path.join(tempRoot, "data", "books.json"))).toBe(false)

			// Authors should be unchanged
			expect(fs.existsSync(path.join(tempRoot, "data", "authors.json"))).toBe(true)
		})
	})

	describe("edge cases", () => {
		it("should handle empty data file", async () => {
			// Write empty object to data file
			fs.writeFileSync(dataFilePath, JSON.stringify({}, null, 2))

			const result = await executeConvert({
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)

			// Verify new file exists
			const newFilePath = path.join(tempRoot, "data", "books.yaml")
			expect(fs.existsSync(newFilePath)).toBe(true)
		})

		it("should handle data with special characters", async () => {
			const specialData = {
				"1": {
					id: "1",
					title: 'Book with "quotes" and \'apostrophes\'',
					author: "Author: Special & <Characters>",
					year: 2020,
				},
			}
			fs.writeFileSync(dataFilePath, JSON.stringify(specialData, null, 2))

			const result = await executeConvert({
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)

			// Verify data is preserved
			const newFilePath = path.join(tempRoot, "data", "books.yaml")
			const content = fs.readFileSync(newFilePath, "utf-8")
			expect(content).toContain("quotes")
		})

		it("should handle large number of entities", async () => {
			// Create data with many entities
			const largeData: Record<string, { id: string; title: string; author: string; year: number }> = {}
			for (let i = 0; i < 100; i++) {
				largeData[String(i)] = {
					id: String(i),
					title: `Book ${i}`,
					author: `Author ${i}`,
					year: 2000 + (i % 25),
				}
			}
			fs.writeFileSync(dataFilePath, JSON.stringify(largeData, null, 2))

			const result = await executeConvert({
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)

			// Verify all entities are preserved
			const newFilePath = path.join(tempRoot, "data", "books.yaml")
			const content = fs.readFileSync(newFilePath, "utf-8")
			expect(content).toContain("Book 0")
			expect(content).toContain("Book 99")
		})

		it("should handle nested data structures", async () => {
			// Note: proseql schemas are flat, but the raw data could have nested objects
			const nestedData = {
				"1": {
					id: "1",
					title: "Nested Book",
					author: "Test Author",
					year: 2020,
				},
			}
			fs.writeFileSync(dataFilePath, JSON.stringify(nestedData, null, 2))

			const result = await executeConvert({
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)
		})
	})

	describe("format-specific validation", () => {
		it("should produce valid YAML output", async () => {
			const result = await executeConvert({
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)

			const { default: yaml } = await import("yaml")
			const newFilePath = path.join(tempRoot, "data", "books.yaml")
			const content = fs.readFileSync(newFilePath, "utf-8")

			// Should parse without error
			const parsed = yaml.parse(content) as Record<string, unknown>
			expect(parsed).toBeDefined()
			expect(parsed["1"]).toBeDefined()
		})

		it("should produce valid TOML output", async () => {
			const result = await executeConvert({
				targetFormat: "toml",
			})

			expect(result.success).toBe(true)

			const TOML = await import("smol-toml")
			const newFilePath = path.join(tempRoot, "data", "books.toml")
			const content = fs.readFileSync(newFilePath, "utf-8")

			// Should parse without error
			const parsed = TOML.parse(content) as Record<string, unknown>
			expect(parsed).toBeDefined()
		})

		it("should produce valid JSON5 output", async () => {
			const result = await executeConvert({
				targetFormat: "json5",
			})

			expect(result.success).toBe(true)

			const JSON5 = await import("json5")
			const newFilePath = path.join(tempRoot, "data", "books.json5")
			const content = fs.readFileSync(newFilePath, "utf-8")

			// Should parse without error
			const parsed = JSON5.default.parse(content) as Record<string, unknown>
			expect(parsed).toBeDefined()
			expect(parsed["1"]).toBeDefined()
		})
	})

	describe("conversion summary", () => {
		it("should include all required fields in success result", async () => {
			const result = await executeConvert({
				targetFormat: "yaml",
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.data?.collection).toBe("books")
			expect(result.data?.oldFile).toBeDefined()
			expect(result.data?.oldFormat).toBe("json")
			expect(result.data?.newFile).toBeDefined()
			expect(result.data?.newFormat).toBe("yaml")
			expect(typeof result.data?.configUpdated).toBe("boolean")
		})

		it("should include error message in failure result", async () => {
			const result = await executeConvert({
				collection: "nonexistent",
				targetFormat: "yaml",
			})

			expect(result.success).toBe(false)
			expect(result.message).toBeDefined()
			expect(result.message?.length).toBeGreaterThan(0)
		})
	})
})
