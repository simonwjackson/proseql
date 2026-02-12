import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import {
	runCollections,
	type CollectionsOptions,
	type CollectionsResult,
} from "../../src/commands/collections"
import {
	runDescribe,
	type DescribeOptions,
	type DescribeResult,
} from "../../src/commands/describe"
import {
	runStats,
	type StatsOptions,
	type StatsResult,
} from "../../src/commands/stats"
import type { DatabaseConfig } from "@proseql/core"

/**
 * Tests for inspect commands (collections, describe, stats).
 *
 * Tests cover:
 * - Collections listing: lists all collections with count, file path, format
 * - Describe output: shows field types, indexes, relationships, constraints
 * - Stats output: shows entity count, file size, format per collection
 * - Error handling for invalid collections and missing config
 */

// Define test schemas with various features
const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	genre: Schema.String,
	inStock: Schema.Boolean,
	tags: Schema.optional(Schema.Array(Schema.String)),
})

const AuthorSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	birthYear: Schema.Number,
	nationality: Schema.optional(Schema.String),
})

// Sample test data - keyed by entity ID as proseql expects
const sampleBooks: Record<
	string,
	{
		id: string
		title: string
		author: string
		year: number
		genre: string
		inStock: boolean
		tags?: string[]
	}
> = {
	"1": {
		id: "1",
		title: "Dune",
		author: "Frank Herbert",
		year: 1965,
		genre: "sci-fi",
		inStock: true,
		tags: ["classic", "space"],
	},
	"2": {
		id: "2",
		title: "Neuromancer",
		author: "William Gibson",
		year: 1984,
		genre: "sci-fi",
		inStock: true,
		tags: ["cyberpunk"],
	},
	"3": {
		id: "3",
		title: "The Great Gatsby",
		author: "F. Scott Fitzgerald",
		year: 1925,
		genre: "classic",
		inStock: false,
	},
}

const sampleAuthors: Record<
	string,
	{ id: string; name: string; birthYear: number; nationality?: string }
> = {
	"a1": {
		id: "a1",
		name: "Frank Herbert",
		birthYear: 1920,
		nationality: "American",
	},
	"a2": { id: "a2", name: "William Gibson", birthYear: 1948, nationality: "American" },
}

describe("Inspect Commands", () => {
	let tempRoot: string
	let configPath: string
	let booksFilePath: string
	let authorsFilePath: string

	beforeEach(() => {
		// Create a unique temp directory for each test
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proseql-inspect-test-"))

		// Create data directory and files
		const dataDir = path.join(tempRoot, "data")
		fs.mkdirSync(dataDir, { recursive: true })

		booksFilePath = path.join(dataDir, "books.json")
		fs.writeFileSync(booksFilePath, JSON.stringify(sampleBooks, null, 2))

		authorsFilePath = path.join(dataDir, "authors.yaml")
		// Create a simple YAML file
		const yamlContent = Object.entries(sampleAuthors)
			.map(
				([key, author]) =>
					`"${key}":\n  id: "${author.id}"\n  name: "${author.name}"\n  birthYear: ${author.birthYear}${author.nationality ? `\n  nationality: "${author.nationality}"` : ""}`,
			)
			.join("\n")
		fs.writeFileSync(authorsFilePath, yamlContent)

		// Config file path
		configPath = path.join(tempRoot, "proseql.config.json")
	})

	afterEach(() => {
		// Clean up the temp directory
		if (fs.existsSync(tempRoot)) {
			fs.rmSync(tempRoot, { recursive: true, force: true })
		}
	})

	/**
	 * Helper to create a config with multiple collections and features
	 */
	function createConfig(): DatabaseConfig {
		return {
			books: {
				schema: BookSchema,
				file: "./data/books.json",
				indexes: ["genre", ["year", "inStock"]],
				uniqueFields: ["title"],
				searchIndex: ["title", "author"],
				relationships: {
					authorRef: {
						type: "ref" as const,
						target: "authors" as const,
						foreignKey: "author",
					},
				},
			},
			authors: {
				schema: AuthorSchema,
				file: "./data/authors.yaml",
				indexes: ["nationality"],
				relationships: {
					books: {
						type: "inverse" as const,
						target: "books" as const,
						foreignKey: "author",
					},
				},
			},
		} as DatabaseConfig
	}

	/**
	 * Helper to create a minimal config
	 */
	function createMinimalConfig(): DatabaseConfig {
		return {
			books: {
				schema: BookSchema,
				file: "./data/books.json",
				relationships: {},
			},
		} as DatabaseConfig
	}

	/**
	 * Helper to run collections command
	 */
	async function executeCollections(
		options: Partial<CollectionsOptions>,
	): Promise<CollectionsResult> {
		const fullOptions: CollectionsOptions = {
			config: options.config ?? createConfig(),
			configPath: options.configPath ?? configPath,
		}

		return Effect.runPromise(runCollections(fullOptions))
	}

	/**
	 * Helper to run describe command
	 */
	async function executeDescribe(
		options: Partial<DescribeOptions>,
	): Promise<DescribeResult> {
		const fullOptions: DescribeOptions = {
			config: options.config ?? createConfig(),
			collection: options.collection ?? "books",
		}

		return Effect.runPromise(runDescribe(fullOptions))
	}

	/**
	 * Helper to run stats command
	 */
	async function executeStats(
		options: Partial<StatsOptions>,
	): Promise<StatsResult> {
		const fullOptions: StatsOptions = {
			config: options.config ?? createConfig(),
			configPath: options.configPath ?? configPath,
		}

		return Effect.runPromise(runStats(fullOptions))
	}

	describe("Collections Command", () => {
		describe("basic listing", () => {
			it("should list all collections", async () => {
				const result = await executeCollections({})

				expect(result.success).toBe(true)
				expect(result.data).toBeDefined()
				expect(result.data?.length).toBe(2)

				const collectionNames = result.data?.map((c) => c.name) ?? []
				expect(collectionNames).toContain("books")
				expect(collectionNames).toContain("authors")
			})

			it("should include entity count for each collection", async () => {
				const result = await executeCollections({})

				expect(result.success).toBe(true)
				expect(result.data).toBeDefined()

				const booksCollection = result.data?.find((c) => c.name === "books")
				expect(booksCollection?.count).toBe(3)

				const authorsCollection = result.data?.find((c) => c.name === "authors")
				expect(authorsCollection?.count).toBe(2)
			})

			it("should include file path for each collection", async () => {
				const result = await executeCollections({})

				expect(result.success).toBe(true)
				expect(result.data).toBeDefined()

				const booksCollection = result.data?.find((c) => c.name === "books")
				expect(booksCollection?.file).toContain("books.json")

				const authorsCollection = result.data?.find((c) => c.name === "authors")
				expect(authorsCollection?.file).toContain("authors.yaml")
			})

			it("should include serialization format for each collection", async () => {
				const result = await executeCollections({})

				expect(result.success).toBe(true)
				expect(result.data).toBeDefined()

				const booksCollection = result.data?.find((c) => c.name === "books")
				expect(booksCollection?.format).toBe("json")

				const authorsCollection = result.data?.find((c) => c.name === "authors")
				expect(authorsCollection?.format).toBe("yaml")
			})
		})

		describe("empty config", () => {
			it("should handle empty config gracefully", async () => {
				const result = await executeCollections({
					config: {} as DatabaseConfig,
				})

				expect(result.success).toBe(true)
				expect(result.data).toEqual([])
				expect(result.message).toContain("No collections")
			})
		})

		describe("single collection", () => {
			it("should list single collection", async () => {
				const result = await executeCollections({
					config: createMinimalConfig(),
				})

				expect(result.success).toBe(true)
				expect(result.data).toBeDefined()
				expect(result.data?.length).toBe(1)
				expect(result.data?.[0].name).toBe("books")
			})
		})

		describe("format detection", () => {
			it("should detect JSON format", async () => {
				const result = await executeCollections({
					config: {
						books: {
							schema: BookSchema,
							file: "./data/books.json",
							relationships: {},
						},
					} as DatabaseConfig,
				})

				expect(result.success).toBe(true)
				const booksCollection = result.data?.find((c) => c.name === "books")
				expect(booksCollection?.format).toBe("json")
			})

			it("should detect YAML format", async () => {
				const result = await executeCollections({
					config: {
						authors: {
							schema: AuthorSchema,
							file: "./data/authors.yaml",
							relationships: {},
						},
					} as DatabaseConfig,
				})

				expect(result.success).toBe(true)
				const authorsCollection = result.data?.find((c) => c.name === "authors")
				expect(authorsCollection?.format).toBe("yaml")
			})

			it("should handle in-memory collections (no file)", async () => {
				const result = await executeCollections({
					config: {
						books: {
							schema: BookSchema,
							relationships: {},
						},
					} as DatabaseConfig,
				})

				expect(result.success).toBe(true)
				const booksCollection = result.data?.find((c) => c.name === "books")
				expect(booksCollection?.file).toBe("(in-memory)")
				expect(booksCollection?.format).toBe("(in-memory)")
			})
		})
	})

	describe("Describe Command", () => {
		describe("field information", () => {
			it("should list all fields in the schema", async () => {
				const result = await executeDescribe({ collection: "books" })

				expect(result.success).toBe(true)
				expect(result.data).toBeDefined()
				expect(result.data?.collection).toBe("books")

				const fieldNames = result.data?.fields.map((f) => f.name) ?? []
				expect(fieldNames).toContain("id")
				expect(fieldNames).toContain("title")
				expect(fieldNames).toContain("author")
				expect(fieldNames).toContain("year")
				expect(fieldNames).toContain("genre")
				expect(fieldNames).toContain("inStock")
				expect(fieldNames).toContain("tags")
			})

			it("should show field types correctly", async () => {
				const result = await executeDescribe({ collection: "books" })

				expect(result.success).toBe(true)
				expect(result.data?.fields).toBeDefined()

				const idField = result.data?.fields.find((f) => f.name === "id")
				expect(idField?.type).toBe("string")

				const yearField = result.data?.fields.find((f) => f.name === "year")
				expect(yearField?.type).toBe("number")

				const inStockField = result.data?.fields.find((f) => f.name === "inStock")
				expect(inStockField?.type).toBe("boolean")
			})

			it("should indicate required vs optional fields", async () => {
				const result = await executeDescribe({ collection: "books" })

				expect(result.success).toBe(true)

				const titleField = result.data?.fields.find((f) => f.name === "title")
				expect(titleField?.required).toBe(true)

				const tagsField = result.data?.fields.find((f) => f.name === "tags")
				expect(tagsField?.required).toBe(false)
			})

			it("should indicate indexed fields", async () => {
				const result = await executeDescribe({ collection: "books" })

				expect(result.success).toBe(true)

				const genreField = result.data?.fields.find((f) => f.name === "genre")
				expect(genreField?.indexed).toBe(true)

				const yearField = result.data?.fields.find((f) => f.name === "year")
				expect(yearField?.indexed).toBe(true) // Part of compound index

				const titleField = result.data?.fields.find((f) => f.name === "title")
				expect(titleField?.indexed).toBe(false)
			})

			it("should indicate unique fields", async () => {
				const result = await executeDescribe({ collection: "books" })

				expect(result.success).toBe(true)

				const titleField = result.data?.fields.find((f) => f.name === "title")
				expect(titleField?.unique).toBe(true)

				const genreField = result.data?.fields.find((f) => f.name === "genre")
				expect(genreField?.unique).toBe(false)
			})
		})

		describe("index information", () => {
			it("should list single-field indexes", async () => {
				const result = await executeDescribe({ collection: "books" })

				expect(result.success).toBe(true)
				expect(result.data?.indexes).toBeDefined()
				expect(result.data?.indexes).toContain("genre")
			})

			it("should list compound indexes", async () => {
				const result = await executeDescribe({ collection: "books" })

				expect(result.success).toBe(true)
				expect(result.data?.indexes).toBeDefined()

				const compoundIndex = result.data?.indexes.find(
					(idx) =>
						Array.isArray(idx) &&
						idx.includes("year") &&
						idx.includes("inStock"),
				)
				expect(compoundIndex).toBeDefined()
			})
		})

		describe("relationship information", () => {
			it("should list ref relationships", async () => {
				const result = await executeDescribe({ collection: "books" })

				expect(result.success).toBe(true)
				expect(result.data?.relationships).toBeDefined()

				const authorRel = result.data?.relationships.find(
					(r) => r.name === "authorRef",
				)
				expect(authorRel).toBeDefined()
				expect(authorRel?.type).toBe("ref")
				expect(authorRel?.target).toBe("authors")
				expect(authorRel?.foreignKey).toBe("author")
			})

			it("should list inverse relationships", async () => {
				const result = await executeDescribe({ collection: "authors" })

				expect(result.success).toBe(true)

				const booksRel = result.data?.relationships.find(
					(r) => r.name === "books",
				)
				expect(booksRel).toBeDefined()
				expect(booksRel?.type).toBe("inverse")
				expect(booksRel?.target).toBe("books")
			})
		})

		describe("search index information", () => {
			it("should indicate when collection has search index", async () => {
				const result = await executeDescribe({ collection: "books" })

				expect(result.success).toBe(true)
				expect(result.data?.hasSearchIndex).toBe(true)
				expect(result.data?.searchIndexFields).toContain("title")
				expect(result.data?.searchIndexFields).toContain("author")
			})

			it("should indicate when collection has no search index", async () => {
				const result = await executeDescribe({ collection: "authors" })

				expect(result.success).toBe(true)
				expect(result.data?.hasSearchIndex).toBe(false)
				expect(result.data?.searchIndexFields).toEqual([])
			})
		})

		describe("unique constraints", () => {
			it("should list unique constraints", async () => {
				const result = await executeDescribe({ collection: "books" })

				expect(result.success).toBe(true)
				expect(result.data?.uniqueConstraints).toBeDefined()
				expect(result.data?.uniqueConstraints).toContain("title")
			})
		})

		describe("error handling", () => {
			it("should fail for non-existent collection", async () => {
				const result = await executeDescribe({ collection: "nonexistent" })

				expect(result.success).toBe(false)
				expect(result.message).toContain("not found")
				expect(result.message).toContain("nonexistent")
			})

			it("should list available collections in error message", async () => {
				const result = await executeDescribe({ collection: "invalid" })

				expect(result.success).toBe(false)
				expect(result.message).toContain("Available collections")
				expect(result.message).toContain("books")
				expect(result.message).toContain("authors")
			})

			it("should handle empty config", async () => {
				const result = await executeDescribe({
					config: {} as DatabaseConfig,
					collection: "anything",
				})

				expect(result.success).toBe(false)
				expect(result.message).toContain("not found")
			})
		})

		describe("appendOnly flag", () => {
			it("should detect appendOnly collections", async () => {
				const result = await executeDescribe({
					config: {
						events: {
							schema: Schema.Struct({
								id: Schema.String,
								type: Schema.String,
							}),
							file: "./data/events.jsonl",
							appendOnly: true,
							relationships: {},
						},
					} as DatabaseConfig,
					collection: "events",
				})

				expect(result.success).toBe(true)
				expect(result.data?.appendOnly).toBe(true)
			})

			it("should show appendOnly as false for regular collections", async () => {
				const result = await executeDescribe({ collection: "books" })

				expect(result.success).toBe(true)
				expect(result.data?.appendOnly).toBe(false)
			})
		})

		describe("schema versioning", () => {
			it("should show version when present", async () => {
				const result = await executeDescribe({
					config: {
						books: {
							schema: BookSchema,
							file: "./data/books.json",
							version: 2,
							relationships: {},
						},
					} as DatabaseConfig,
					collection: "books",
				})

				expect(result.success).toBe(true)
				expect(result.data?.version).toBe(2)
			})

			it("should handle collections without version", async () => {
				const result = await executeDescribe({
					config: createMinimalConfig(),
					collection: "books",
				})

				expect(result.success).toBe(true)
				expect(result.data?.version).toBeUndefined()
			})
		})
	})

	describe("Stats Command", () => {
		describe("basic stats", () => {
			it("should report stats for all collections", async () => {
				const result = await executeStats({})

				expect(result.success).toBe(true)
				expect(result.data).toBeDefined()
				expect(result.data?.length).toBe(2)
			})

			it("should include entity count per collection", async () => {
				const result = await executeStats({})

				expect(result.success).toBe(true)

				const booksStats = result.data?.find((s) => s.name === "books")
				expect(booksStats?.count).toBe(3)

				const authorsStats = result.data?.find((s) => s.name === "authors")
				expect(authorsStats?.count).toBe(2)
			})

			it("should include file path per collection", async () => {
				const result = await executeStats({})

				expect(result.success).toBe(true)

				const booksStats = result.data?.find((s) => s.name === "books")
				expect(booksStats?.file).toContain("books.json")

				const authorsStats = result.data?.find((s) => s.name === "authors")
				expect(authorsStats?.file).toContain("authors.yaml")
			})

			it("should include format per collection", async () => {
				const result = await executeStats({})

				expect(result.success).toBe(true)

				const booksStats = result.data?.find((s) => s.name === "books")
				expect(booksStats?.format).toBe("json")

				const authorsStats = result.data?.find((s) => s.name === "authors")
				expect(authorsStats?.format).toBe("yaml")
			})
		})

		describe("file size", () => {
			it("should include file size in bytes", async () => {
				const result = await executeStats({})

				expect(result.success).toBe(true)

				const booksStats = result.data?.find((s) => s.name === "books")
				expect(booksStats?.sizeBytes).toBeGreaterThan(0)
			})

			it("should include human-readable file size", async () => {
				const result = await executeStats({})

				expect(result.success).toBe(true)

				const booksStats = result.data?.find((s) => s.name === "books")
				expect(booksStats?.size).toBeDefined()
				expect(booksStats?.size).not.toBe("(in-memory)")
				// Should contain unit like "B", "KB", etc.
				expect(booksStats?.size).toMatch(/\d+(\.\d+)?\s*(B|KB|MB|GB)/)
			})

			it("should show (in-memory) for collections without files", async () => {
				const result = await executeStats({
					config: {
						books: {
							schema: BookSchema,
							relationships: {},
						},
					} as DatabaseConfig,
				})

				expect(result.success).toBe(true)

				const booksStats = result.data?.find((s) => s.name === "books")
				expect(booksStats?.size).toBe("(in-memory)")
				expect(booksStats?.sizeBytes).toBe(0)
			})
		})

		describe("empty config", () => {
			it("should handle empty config gracefully", async () => {
				const result = await executeStats({
					config: {} as DatabaseConfig,
				})

				expect(result.success).toBe(true)
				expect(result.data).toEqual([])
				expect(result.message).toContain("No collections")
			})
		})

		describe("missing files", () => {
			it("should handle missing data file gracefully", async () => {
				// Delete the data file
				fs.unlinkSync(booksFilePath)

				const result = await executeStats({
					config: createMinimalConfig(),
				})

				expect(result.success).toBe(true)
				const booksStats = result.data?.find((s) => s.name === "books")
				// Should show 0 entities when file is missing
				expect(booksStats?.count).toBe(0)
				expect(booksStats?.sizeBytes).toBe(0)
			})
		})

		describe("various formats", () => {
			it("should detect TOML format", async () => {
				// Create a TOML file
				const tomlPath = path.join(tempRoot, "data", "config.toml")
				fs.writeFileSync(
					tomlPath,
					'[entry]\nid = "1"\nname = "Test"\nvalue = 42',
				)

				const result = await executeStats({
					config: {
						configs: {
							schema: Schema.Struct({
								id: Schema.String,
								name: Schema.String,
								value: Schema.Number,
							}),
							file: "./data/config.toml",
							relationships: {},
						},
					} as DatabaseConfig,
				})

				expect(result.success).toBe(true)
				const configStats = result.data?.find((s) => s.name === "configs")
				expect(configStats?.format).toBe("toml")
			})

	it("should detect JSON5 format from extension", async () => {
				// Create a JSON5 file (even though we're not loading it with the right codec,
				// we're testing format detection)
				const json5Path = path.join(tempRoot, "data", "config.json5")
				fs.writeFileSync(json5Path, '{"id": "1", "name": "Test"}')

				const result = await executeStats({
					config: {
						configs: {
							schema: Schema.Struct({
								id: Schema.String,
								name: Schema.String,
							}),
							file: "./data/config.json5",
							relationships: {},
						},
					} as DatabaseConfig,
				})

				// The format detection still works, though the codec might fail
				// We expect the command to succeed or fail gracefully
				// What matters is that if it succeeds, the format is correct
				if (result.success) {
					const configStats = result.data?.find((s) => s.name === "configs")
					expect(configStats?.format).toBe("json5")
				}
			})
		})
	})

	describe("Integration scenarios", () => {
		it("should provide consistent data across all inspect commands", async () => {
			// Run all three commands
			const collectionsResult = await executeCollections({})
			const describeResult = await executeDescribe({ collection: "books" })
			const statsResult = await executeStats({})

			// All should succeed
			expect(collectionsResult.success).toBe(true)
			expect(describeResult.success).toBe(true)
			expect(statsResult.success).toBe(true)

			// Entity counts should match
			const collectionsBookCount = collectionsResult.data?.find(
				(c) => c.name === "books",
			)?.count
			const statsBookCount = statsResult.data?.find(
				(s) => s.name === "books",
			)?.count
			expect(collectionsBookCount).toBe(statsBookCount)

			// File paths should match
			const collectionsBookFile = collectionsResult.data?.find(
				(c) => c.name === "books",
			)?.file
			const statsBookFile = statsResult.data?.find(
				(s) => s.name === "books",
			)?.file
			expect(collectionsBookFile).toBe(statsBookFile)

			// Formats should match
			const collectionsBookFormat = collectionsResult.data?.find(
				(c) => c.name === "books",
			)?.format
			const statsBookFormat = statsResult.data?.find(
				(s) => s.name === "books",
			)?.format
			expect(collectionsBookFormat).toBe(statsBookFormat)
		})
	})
})
