import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Schema } from "effect"
import { runQuery, type QueryOptions, type QueryResult } from "../../src/commands/query"
import { format, type OutputFormat } from "../../src/output/formatter"
import type { DatabaseConfig } from "@proseql/core"

/**
 * Tests for the query command.
 *
 * Tests cover:
 * - Basic query (retrieves all records from a collection)
 * - Filtered query (with --where expressions)
 * - Select specific fields (--select)
 * - Sort results (--sort)
 * - Limit results (--limit)
 * - Output format flags (--json, --yaml, --csv)
 * - Error handling (invalid collection, invalid filters)
 */

// Define a simple test schema
const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	genre: Schema.String,
	inStock: Schema.Boolean,
})

// Sample test data - keyed by entity ID as proseql expects
const sampleBooks: Record<string, { id: string; title: string; author: string; year: number; genre: string; inStock: boolean }> = {
	"1": { id: "1", title: "Dune", author: "Frank Herbert", year: 1965, genre: "sci-fi", inStock: true },
	"2": { id: "2", title: "Neuromancer", author: "William Gibson", year: 1984, genre: "sci-fi", inStock: true },
	"3": { id: "3", title: "The Great Gatsby", author: "F. Scott Fitzgerald", year: 1925, genre: "classic", inStock: false },
	"4": { id: "4", title: "1984", author: "George Orwell", year: 1949, genre: "dystopia", inStock: true },
	"5": { id: "5", title: "Snow Crash", author: "Neal Stephenson", year: 1992, genre: "sci-fi", inStock: false },
}

describe("Query Command", () => {
	let tempRoot: string
	let configPath: string
	let dataFilePath: string

	beforeEach(() => {
		// Create a unique temp directory for each test
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proseql-query-test-"))

		// Create data directory and file
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
	 * Helper to run query and handle Effect result
	 */
	async function executeQuery(options: Partial<QueryOptions>): Promise<QueryResult> {
		const { Effect } = await import("effect")
		const fullOptions: QueryOptions = {
			collection: options.collection ?? "books",
			config: options.config ?? createConfig(),
			configPath: options.configPath ?? configPath,
			where: options.where,
			select: options.select,
			sort: options.sort,
			limit: options.limit,
		}

		return Effect.runPromise(
			runQuery(fullOptions).pipe(
				Effect.catchTag("FilterParseError", (error) =>
					Effect.succeed({
						success: false as const,
						message: error.message,
					}),
				),
			),
		)
	}

	describe("basic query", () => {
		it("should retrieve all records from a collection", async () => {
			const result = await executeQuery({})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.data?.length).toBe(5)
			expect(result.count).toBe(5)
		})

		it("should include all fields in each record", async () => {
			const result = await executeQuery({})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			const firstBook = result.data?.[0]
			expect(firstBook).toHaveProperty("id")
			expect(firstBook).toHaveProperty("title")
			expect(firstBook).toHaveProperty("author")
			expect(firstBook).toHaveProperty("year")
			expect(firstBook).toHaveProperty("genre")
			expect(firstBook).toHaveProperty("inStock")
		})

		it("should fail for non-existent collection", async () => {
			const result = await executeQuery({
				collection: "nonexistent",
			})

			expect(result.success).toBe(false)
			expect(result.message).toContain("not found")
			expect(result.message).toContain("nonexistent")
			expect(result.message).toContain("Available collections")
		})

		it("should list available collections in error message", async () => {
			const result = await executeQuery({
				collection: "invalid",
			})

			expect(result.success).toBe(false)
			expect(result.message).toContain("books")
		})
	})

	describe("filtered query", () => {
		it("should filter by equality", async () => {
			const result = await executeQuery({
				where: ["genre = sci-fi"],
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.count).toBe(3)
			// All results should have genre "sci-fi"
			for (const book of result.data ?? []) {
				expect(book.genre).toBe("sci-fi")
			}
		})

		it("should filter by numeric comparison (>)", async () => {
			const result = await executeQuery({
				where: ["year > 1970"],
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			// Neuromancer (1984) and Snow Crash (1992) are after 1970
			expect(result.count).toBe(2)
			for (const book of result.data ?? []) {
				expect(book.year).toBeGreaterThan(1970)
			}
		})

		it("should filter by numeric comparison (<)", async () => {
			const result = await executeQuery({
				where: ["year < 1960"],
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			// The Great Gatsby (1925) and 1984 (1949) are before 1960
			expect(result.count).toBe(2)
			for (const book of result.data ?? []) {
				expect(book.year).toBeLessThan(1960)
			}
		})

		it("should filter by boolean value", async () => {
			const result = await executeQuery({
				where: ["inStock = true"],
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			// Dune, Neuromancer, and 1984 are in stock
			expect(result.count).toBe(3)
			for (const book of result.data ?? []) {
				expect(book.inStock).toBe(true)
			}
		})

		it("should filter by not equals (!=)", async () => {
			const result = await executeQuery({
				where: ["genre != sci-fi"],
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			// The Great Gatsby (classic) and 1984 (dystopia)
			expect(result.count).toBe(2)
			for (const book of result.data ?? []) {
				expect(book.genre).not.toBe("sci-fi")
			}
		})

		it("should combine multiple filters with AND logic", async () => {
			const result = await executeQuery({
				where: ["genre = sci-fi", "inStock = true"],
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			// Dune and Neuromancer are sci-fi AND in stock
			expect(result.count).toBe(2)
			for (const book of result.data ?? []) {
				expect(book.genre).toBe("sci-fi")
				expect(book.inStock).toBe(true)
			}
		})

		it("should filter with range conditions on same field", async () => {
			const result = await executeQuery({
				where: ["year >= 1940", "year <= 1970"],
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			// 1984 (1949) and Dune (1965) are in range
			expect(result.count).toBe(2)
			for (const book of result.data ?? []) {
				expect(book.year).toBeGreaterThanOrEqual(1940)
				expect(book.year).toBeLessThanOrEqual(1970)
			}
		})

		it("should handle invalid filter expressions", async () => {
			const result = await executeQuery({
				where: ["invalid filter expression"],
			})

			expect(result.success).toBe(false)
			expect(result.message).toContain("Failed to parse filter")
		})
	})

	describe("select fields", () => {
		it("should select specific fields", async () => {
			const result = await executeQuery({
				select: "id,title",
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.count).toBe(5)

			// Each record should only have selected fields
			for (const book of result.data ?? []) {
				expect(book).toHaveProperty("id")
				expect(book).toHaveProperty("title")
				expect(book).not.toHaveProperty("author")
				expect(book).not.toHaveProperty("year")
				expect(book).not.toHaveProperty("genre")
			}
		})

		it("should select single field", async () => {
			const result = await executeQuery({
				select: "title",
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()

			for (const book of result.data ?? []) {
				expect(book).toHaveProperty("title")
				expect(Object.keys(book).length).toBe(1)
			}
		})

		it("should handle select with whitespace", async () => {
			const result = await executeQuery({
				select: " id , title , author ",
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()

			for (const book of result.data ?? []) {
				expect(book).toHaveProperty("id")
				expect(book).toHaveProperty("title")
				expect(book).toHaveProperty("author")
				expect(book).not.toHaveProperty("year")
			}
		})
	})

	describe("sort results", () => {
		it("should sort by field ascending", async () => {
			const result = await executeQuery({
				sort: "year:asc",
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.count).toBe(5)

			// Verify ascending order
			const years = result.data?.map(book => book.year as number) ?? []
			expect(years).toEqual([1925, 1949, 1965, 1984, 1992])
		})

		it("should sort by field descending", async () => {
			const result = await executeQuery({
				sort: "year:desc",
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.count).toBe(5)

			// Verify descending order
			const years = result.data?.map(book => book.year as number) ?? []
			expect(years).toEqual([1992, 1984, 1965, 1949, 1925])
		})

		it("should sort by string field", async () => {
			const result = await executeQuery({
				sort: "title:asc",
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()

			// Verify alphabetical order
			const titles = result.data?.map(book => book.title as string) ?? []
			const sortedTitles = [...titles].sort()
			expect(titles).toEqual(sortedTitles)
		})

		it("should fail on invalid sort format", async () => {
			const result = await executeQuery({
				sort: "year-asc", // wrong separator
			})

			expect(result.success).toBe(false)
			expect(result.message).toContain("Invalid sort format")
		})

		it("should fail on invalid sort direction", async () => {
			const result = await executeQuery({
				sort: "year:up", // invalid direction
			})

			expect(result.success).toBe(false)
			expect(result.message).toContain("Invalid sort format")
		})
	})

	describe("limit results", () => {
		it("should limit number of results", async () => {
			const result = await executeQuery({
				limit: 2,
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.count).toBe(2)
		})

		it("should return all results when limit exceeds total", async () => {
			const result = await executeQuery({
				limit: 100,
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.count).toBe(5)
		})

		it("should combine limit with sort", async () => {
			const result = await executeQuery({
				sort: "year:desc",
				limit: 3,
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.count).toBe(3)

			// Should get the 3 newest books
			const years = result.data?.map(book => book.year as number) ?? []
			expect(years).toEqual([1992, 1984, 1965])
		})

		it("should combine limit with filter", async () => {
			const result = await executeQuery({
				where: ["genre = sci-fi"],
				limit: 2,
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.count).toBe(2)

			for (const book of result.data ?? []) {
				expect(book.genre).toBe("sci-fi")
			}
		})

		it("should ignore zero limit", async () => {
			const result = await executeQuery({
				limit: 0,
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.count).toBe(5) // All results
		})
	})

	describe("combined options", () => {
		it("should apply filter, sort, and limit together", async () => {
			const result = await executeQuery({
				where: ["inStock = true"],
				sort: "year:desc",
				limit: 2,
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.count).toBe(2)

			// Should be the 2 newest in-stock books: Neuromancer (1984), Dune (1965)
			const years = result.data?.map(book => book.year as number) ?? []
			expect(years).toEqual([1984, 1965])
		})

		it("should apply filter, sort, limit, and select together", async () => {
			const result = await executeQuery({
				where: ["genre = sci-fi"],
				sort: "year:asc",
				limit: 2,
				select: "title,year",
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.count).toBe(2)

			// Should be the 2 oldest sci-fi books with only title and year
			const firstBook = result.data?.[0]
			expect(firstBook).toHaveProperty("title")
			expect(firstBook).toHaveProperty("year")
			expect(firstBook).not.toHaveProperty("author")
			expect(firstBook).not.toHaveProperty("genre")
		})
	})

	describe("output format flags", () => {
		it("should format results as JSON", async () => {
			const result = await executeQuery({
				limit: 2,
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()

			const output = format("json", result.data ?? [])
			const parsed = JSON.parse(output)

			expect(Array.isArray(parsed)).toBe(true)
			expect(parsed.length).toBe(2)
		})

		it("should format results as YAML", async () => {
			const result = await executeQuery({
				limit: 2,
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()

			const output = format("yaml", result.data ?? [])

			// YAML output should have list indicators
			expect(output).toContain("-")
			expect(output).toContain("id:")
			expect(output).toContain("title:")
		})

		it("should format results as CSV", async () => {
			const result = await executeQuery({
				limit: 2,
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()

			const output = format("csv", result.data ?? [])
			const lines = output.split("\n")

			// Should have header and 2 data rows
			expect(lines.length).toBe(3)

			// Header should contain field names
			const header = lines[0]
			expect(header).toContain("id")
			expect(header).toContain("title")
		})

		it("should format results as table", async () => {
			const result = await executeQuery({
				limit: 2,
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()

			const output = format("table", result.data ?? [])

			// Table output should have field names and values
			expect(output).toContain("id")
			expect(output).toContain("title")
		})

		it("should handle empty results in all formats", async () => {
			const result = await executeQuery({
				where: ["year > 3000"], // No books match this
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.count).toBe(0)

			// All formats should handle empty arrays
			const jsonOutput = format("json", result.data ?? [])
			expect(JSON.parse(jsonOutput)).toEqual([])

			const csvOutput = format("csv", result.data ?? [])
			expect(csvOutput).toBe("")

			const yamlOutput = format("yaml", result.data ?? [])
			expect(yamlOutput.trim()).toBe("[]")

			const tableOutput = format("table", result.data ?? [])
			expect(tableOutput).toBe("(no results)") // Table formatter returns this for empty results
		})
	})

	describe("error handling", () => {
		it("should handle missing data file gracefully", async () => {
			// Delete the data file
			fs.unlinkSync(dataFilePath)

			const result = await executeQuery({})

			// The database should still work but with empty data
			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.count).toBe(0)
		})

		it("should handle invalid JSON data file", async () => {
			// Write invalid JSON
			fs.writeFileSync(dataFilePath, "not valid json {{{")

			const result = await executeQuery({})

			expect(result.success).toBe(false)
			expect(result.message).toBeDefined()
		})

		it("should handle empty config", async () => {
			const result = await executeQuery({
				config: {} as DatabaseConfig,
				collection: "books",
			})

			expect(result.success).toBe(false)
			expect(result.message).toContain("not found")
		})
	})

	describe("YAML data file", () => {
		beforeEach(() => {
			// Create a YAML data file for additional testing - using keyed format
			const yamlDataPath = path.join(tempRoot, "data", "books.yaml")
			const yamlContent = Object.entries(sampleBooks).map(([key, book]) =>
				`"${key}":\n  id: "${book.id}"\n  title: "${book.title}"\n  author: "${book.author}"\n  year: ${book.year}\n  genre: "${book.genre}"\n  inStock: ${book.inStock}`
			).join("\n")
			fs.writeFileSync(yamlDataPath, yamlContent)
		})

		it("should query YAML data files", async () => {
			const yamlConfig: DatabaseConfig = {
				books: {
					schema: BookSchema,
					file: "./data/books.yaml",
					relationships: {},
				},
			} as DatabaseConfig

			const result = await executeQuery({
				config: yamlConfig,
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.count).toBe(5)
		})
	})
})
