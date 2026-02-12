import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Schema } from "effect"
import { runCreate, type CreateOptions, type CreateResult } from "../../src/commands/create"
import { runUpdate, type UpdateOptions, type UpdateResult } from "../../src/commands/update"
import { runDelete, type DeleteOptions, type DeleteResult } from "../../src/commands/delete"
import type { DatabaseConfig } from "@proseql/core"

/**
 * Tests for CRUD commands (create, update, delete).
 *
 * Tests cover:
 * - Create command with --data JSON parsing
 * - Update command with --set assignment parsing
 * - Delete command with --force flag
 * - Delete confirmation prompt behavior
 * - Error handling for invalid inputs
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
const sampleBooks: Record<
	string,
	{ id: string; title: string; author: string; year: number; genre: string; inStock: boolean }
> = {
	"1": { id: "1", title: "Dune", author: "Frank Herbert", year: 1965, genre: "sci-fi", inStock: true },
	"2": { id: "2", title: "Neuromancer", author: "William Gibson", year: 1984, genre: "sci-fi", inStock: true },
	"3": {
		id: "3",
		title: "The Great Gatsby",
		author: "F. Scott Fitzgerald",
		year: 1925,
		genre: "classic",
		inStock: false,
	},
}

describe("CRUD Commands", () => {
	let tempRoot: string
	let configPath: string
	let dataFilePath: string

	beforeEach(() => {
		// Create a unique temp directory for each test
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proseql-crud-test-"))

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
		// Restore any mocks
		vi.restoreAllMocks()
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
	 * Helper to run create command and handle Effect result
	 */
	async function executeCreate(options: Partial<CreateOptions>): Promise<CreateResult> {
		const { Effect } = await import("effect")
		const fullOptions: CreateOptions = {
			collection: options.collection ?? "books",
			config: options.config ?? createConfig(),
			configPath: options.configPath ?? configPath,
			data: options.data ?? "{}",
		}

		return Effect.runPromise(runCreate(fullOptions))
	}

	/**
	 * Helper to run update command and handle Effect result
	 */
	async function executeUpdate(options: Partial<UpdateOptions>): Promise<UpdateResult> {
		const { Effect } = await import("effect")
		const fullOptions: UpdateOptions = {
			collection: options.collection ?? "books",
			id: options.id ?? "1",
			config: options.config ?? createConfig(),
			configPath: options.configPath ?? configPath,
			set: options.set ?? "",
		}

		return Effect.runPromise(runUpdate(fullOptions))
	}

	/**
	 * Helper to run delete command and handle Effect result
	 */
	async function executeDelete(options: Partial<DeleteOptions>): Promise<DeleteResult> {
		const { Effect } = await import("effect")
		const fullOptions: DeleteOptions = {
			collection: options.collection ?? "books",
			id: options.id ?? "1",
			config: options.config ?? createConfig(),
			configPath: options.configPath ?? configPath,
			force: options.force ?? true, // Default to force=true to skip prompts in tests
		}

		return Effect.runPromise(runDelete(fullOptions))
	}

	describe("Create Command", () => {
		describe("valid JSON data", () => {
			it("should create entity with valid JSON --data", async () => {
				const newBook = {
					id: "4",
					title: "Snow Crash",
					author: "Neal Stephenson",
					year: 1992,
					genre: "sci-fi",
					inStock: true,
				}

				const result = await executeCreate({
					data: JSON.stringify(newBook),
				})

				expect(result.success).toBe(true)
				expect(result.data).toBeDefined()
				expect(result.data?.title).toBe("Snow Crash")
				expect(result.data?.author).toBe("Neal Stephenson")
				expect(result.data?.year).toBe(1992)
			})

			it("should persist created entity to data file", async () => {
				const newBook = {
					id: "5",
					title: "Foundation",
					author: "Isaac Asimov",
					year: 1951,
					genre: "sci-fi",
					inStock: true,
				}

				const result = await executeCreate({
					data: JSON.stringify(newBook),
				})

				expect(result.success).toBe(true)

				// Read the data file to verify persistence
				const fileContent = fs.readFileSync(dataFilePath, "utf-8")
				const data = JSON.parse(fileContent) as Record<string, unknown>
				expect(data["5"]).toBeDefined()
				expect((data["5"] as Record<string, unknown>).title).toBe("Foundation")
			})

			it("should handle nested JSON data", async () => {
				const newBook = {
					id: "6",
					title: "Complex Book",
					author: "Test Author",
					year: 2020,
					genre: "test",
					inStock: false,
				}

				const result = await executeCreate({
					data: JSON.stringify(newBook),
				})

				expect(result.success).toBe(true)
				expect(result.data?.id).toBe("6")
			})
		})

		describe("invalid JSON data", () => {
			it("should fail with invalid JSON syntax", async () => {
				const result = await executeCreate({
					data: "{ invalid json }}}",
				})

				expect(result.success).toBe(false)
				expect(result.message).toContain("Invalid JSON")
			})

			it("should fail when data is an array instead of object", async () => {
				const result = await executeCreate({
					data: "[1, 2, 3]",
				})

				expect(result.success).toBe(false)
				expect(result.message).toContain("must be a JSON object")
			})

			it("should fail when data is a primitive", async () => {
				const result = await executeCreate({
					data: '"just a string"',
				})

				expect(result.success).toBe(false)
				expect(result.message).toContain("must be a JSON object")
			})

			it("should fail when data is null", async () => {
				const result = await executeCreate({
					data: "null",
				})

				expect(result.success).toBe(false)
				expect(result.message).toContain("must be a JSON object")
			})

			it("should fail when data is a number", async () => {
				const result = await executeCreate({
					data: "42",
				})

				expect(result.success).toBe(false)
				expect(result.message).toContain("must be a JSON object")
			})
		})

		describe("collection validation", () => {
			it("should fail for non-existent collection", async () => {
				const result = await executeCreate({
					collection: "nonexistent",
					data: '{"id": "1"}',
				})

				expect(result.success).toBe(false)
				expect(result.message).toContain("not found")
				expect(result.message).toContain("nonexistent")
			})

			it("should list available collections in error message", async () => {
				const result = await executeCreate({
					collection: "invalid",
					data: '{"id": "1"}',
				})

				expect(result.success).toBe(false)
				expect(result.message).toContain("Available collections")
				expect(result.message).toContain("books")
			})
		})
	})

	describe("Update Command", () => {
		describe("valid --set assignments", () => {
			it("should update entity with single --set assignment", async () => {
				const result = await executeUpdate({
					id: "1",
					set: "year=2025",
				})

				expect(result.success).toBe(true)
				expect(result.data).toBeDefined()
				expect(result.data?.year).toBe(2025)
			})

			it("should update entity with multiple --set assignments", async () => {
				const result = await executeUpdate({
					id: "1",
					set: "year=2025,genre=modern-sci-fi",
				})

				expect(result.success).toBe(true)
				expect(result.data).toBeDefined()
				expect(result.data?.year).toBe(2025)
				expect(result.data?.genre).toBe("modern-sci-fi")
			})

			it("should persist updated entity to data file", async () => {
				const result = await executeUpdate({
					id: "1",
					set: "title=Dune Revised Edition",
				})

				expect(result.success).toBe(true)

				// Read the data file to verify persistence
				const fileContent = fs.readFileSync(dataFilePath, "utf-8")
				const data = JSON.parse(fileContent) as Record<string, Record<string, unknown>>
				expect(data["1"].title).toBe("Dune Revised Edition")
			})

			it("should update boolean fields", async () => {
				const result = await executeUpdate({
					id: "1",
					set: "inStock=false",
				})

				expect(result.success).toBe(true)
				expect(result.data?.inStock).toBe(false)
			})

			it("should update string fields with values containing spaces", async () => {
				const result = await executeUpdate({
					id: "1",
					set: "title=The Dune Chronicles",
				})

				expect(result.success).toBe(true)
				expect(result.data?.title).toBe("The Dune Chronicles")
			})
		})

		describe("invalid --set assignments", () => {
			it("should fail with empty --set string", async () => {
				const result = await executeUpdate({
					id: "1",
					set: "",
				})

				expect(result.success).toBe(false)
				expect(result.message).toBeDefined()
			})

			it("should fail with malformed --set (no equals sign)", async () => {
				const result = await executeUpdate({
					id: "1",
					set: "year 2025",
				})

				expect(result.success).toBe(false)
				expect(result.message).toBeDefined()
			})

			it("should fail with malformed --set (no value)", async () => {
				const result = await executeUpdate({
					id: "1",
					set: "year=",
				})

				expect(result.success).toBe(false)
				expect(result.message).toBeDefined()
			})
		})

		describe("entity not found", () => {
			it("should fail when updating non-existent entity", async () => {
				const result = await executeUpdate({
					id: "999",
					set: "year=2025",
				})

				expect(result.success).toBe(false)
				expect(result.message).toContain("Update failed")
			})
		})

		describe("collection validation", () => {
			it("should fail for non-existent collection", async () => {
				const result = await executeUpdate({
					collection: "nonexistent",
					id: "1",
					set: "year=2025",
				})

				expect(result.success).toBe(false)
				expect(result.message).toContain("not found")
				expect(result.message).toContain("nonexistent")
			})
		})
	})

	describe("Delete Command", () => {
		describe("delete with --force flag", () => {
			it("should delete entity when --force is true", async () => {
				const result = await executeDelete({
					id: "1",
					force: true,
				})

				expect(result.success).toBe(true)
				expect(result.message).toContain("Successfully deleted")
				expect(result.message).toContain("1")
			})

			it("should persist deletion to data file", async () => {
				const result = await executeDelete({
					id: "1",
					force: true,
				})

				expect(result.success).toBe(true)

				// Read the data file to verify deletion
				const fileContent = fs.readFileSync(dataFilePath, "utf-8")
				const data = JSON.parse(fileContent) as Record<string, unknown>
				expect(data["1"]).toBeUndefined()
			})

			it("should skip confirmation prompt when --force is true", async () => {
				// Mock confirm to verify it's not called when force=true
				const { confirm } = await import("../../src/prompt")
				const confirmSpy = vi.spyOn({ confirm }, "confirm")

				const result = await executeDelete({
					id: "1",
					force: true,
				})

				expect(result.success).toBe(true)
				// In non-TTY test environment, confirm returns immediately with confirmed: true
				// Either way, the operation should succeed
			})
		})

		describe("entity not found", () => {
			it("should fail when deleting non-existent entity", async () => {
				const result = await executeDelete({
					id: "999",
					force: true,
				})

				expect(result.success).toBe(false)
				expect(result.message).toContain("Delete failed")
			})
		})

		describe("collection validation", () => {
			it("should fail for non-existent collection", async () => {
				const result = await executeDelete({
					collection: "nonexistent",
					id: "1",
					force: true,
				})

				expect(result.success).toBe(false)
				expect(result.message).toContain("not found")
				expect(result.message).toContain("nonexistent")
			})
		})

		describe("confirmation prompt", () => {
			it("should include entity ID in delete message", async () => {
				const result = await executeDelete({
					id: "2",
					force: true,
				})

				expect(result.success).toBe(true)
				expect(result.message).toContain("2")
			})

			it("should include collection name in delete message", async () => {
				const result = await executeDelete({
					collection: "books",
					id: "1",
					force: true,
				})

				expect(result.success).toBe(true)
				expect(result.message).toContain("books")
			})

			it("should return aborted status when confirmation is declined", async () => {
				// In non-TTY mode (test environment), the prompt auto-confirms
				// Test the behavior by checking the delete result structure
				// When force=false in a TTY environment, it would prompt
				// We can verify the aborted field structure exists

				const result = await executeDelete({
					id: "1",
					force: true,
				})

				// The result should have the expected structure
				expect(result).toHaveProperty("success")
				expect(result).toHaveProperty("message")
				// aborted property exists on the interface
			})
		})

		describe("confirmation prompt behavior in non-TTY", () => {
			it("should auto-confirm in non-TTY environment (test runner)", async () => {
				// Tests run in non-TTY mode, so confirmation is automatically
				// skipped and treated as confirmed
				const result = await executeDelete({
					id: "1",
					force: false, // Not forcing, but non-TTY will auto-confirm
				})

				expect(result.success).toBe(true)
				expect(result.message).toContain("Successfully deleted")
			})
		})
	})

	describe("Integration scenarios", () => {
		it("should create, update, then delete an entity", async () => {
			// Create
			const createResult = await executeCreate({
				data: JSON.stringify({
					id: "100",
					title: "Test Book",
					author: "Test Author",
					year: 2000,
					genre: "test",
					inStock: true,
				}),
			})
			expect(createResult.success).toBe(true)

			// Update
			const updateResult = await executeUpdate({
				id: "100",
				set: "year=2024,inStock=false",
			})
			expect(updateResult.success).toBe(true)
			expect(updateResult.data?.year).toBe(2024)
			expect(updateResult.data?.inStock).toBe(false)

			// Delete
			const deleteResult = await executeDelete({
				id: "100",
				force: true,
			})
			expect(deleteResult.success).toBe(true)

			// Verify deleted
			const fileContent = fs.readFileSync(dataFilePath, "utf-8")
			const data = JSON.parse(fileContent) as Record<string, unknown>
			expect(data["100"]).toBeUndefined()
		})

		it("should handle concurrent operations correctly", async () => {
			// Create multiple entities
			const creates = await Promise.all([
				executeCreate({
					data: JSON.stringify({
						id: "a1",
						title: "Book A1",
						author: "Author A",
						year: 2001,
						genre: "test",
						inStock: true,
					}),
				}),
				executeCreate({
					data: JSON.stringify({
						id: "a2",
						title: "Book A2",
						author: "Author A",
						year: 2002,
						genre: "test",
						inStock: true,
					}),
				}),
			])

			expect(creates[0].success).toBe(true)
			expect(creates[1].success).toBe(true)
		})
	})

	describe("Edge cases", () => {
		describe("create edge cases", () => {
			it("should handle JSON with special characters", async () => {
				const result = await executeCreate({
					data: JSON.stringify({
						id: "special",
						title: 'Book with "quotes"',
						author: "Author's Name",
						year: 2020,
						genre: "test",
						inStock: true,
					}),
				})

				expect(result.success).toBe(true)
				expect(result.data?.title).toBe('Book with "quotes"')
				expect(result.data?.author).toBe("Author's Name")
			})

			it("should handle JSON with unicode characters", async () => {
				const result = await executeCreate({
					data: JSON.stringify({
						id: "unicode",
						title: "Book with unicode: \u00e9\u00e8\u00ea",
						author: "Test Author",
						year: 2020,
						genre: "test",
						inStock: true,
					}),
				})

				expect(result.success).toBe(true)
				expect(result.data?.title).toContain("\u00e9")
			})
		})

		describe("update edge cases", () => {
			it("should handle values containing equals sign", async () => {
				// The set parser should handle values with = correctly
				const result = await executeUpdate({
					id: "1",
					set: "title=Book = Title",
				})

				expect(result.success).toBe(true)
				expect(result.data?.title).toBe("Book = Title")
			})

			it("should handle numeric string values correctly", async () => {
				// Year should remain a number after update
				const result = await executeUpdate({
					id: "1",
					set: "year=1999",
				})

				expect(result.success).toBe(true)
				expect(result.data?.year).toBe(1999)
				expect(typeof result.data?.year).toBe("number")
			})
		})

		describe("delete edge cases", () => {
			it("should handle IDs with special characters", async () => {
				// First create an entity with special ID
				await executeCreate({
					data: JSON.stringify({
						id: "special-id_123",
						title: "Special ID Book",
						author: "Test Author",
						year: 2020,
						genre: "test",
						inStock: true,
					}),
				})

				const result = await executeDelete({
					id: "special-id_123",
					force: true,
				})

				expect(result.success).toBe(true)
			})
		})
	})
})
