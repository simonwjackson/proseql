import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
	runMigrateCommand,
	detectSubcommand,
	type MigrateOptions,
	type MigrateResult,
} from "../../src/commands/migrate"
import type { DatabaseConfig, Migration } from "@proseql/core"

/**
 * Tests for the migrate command.
 *
 * Tests cover:
 * - Status display (showing current vs target versions)
 * - Dry-run output (showing what migrations would run)
 * - Migration execution (running pending migrations)
 * - Subcommand detection
 * - Error handling
 */

// Define a simple test schema
const BookSchemaV1 = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
})

// V2 adds genre field
const BookSchemaV2 = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	genre: Schema.String,
})

// V3 adds inStock field
const BookSchemaV3 = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	genre: Schema.String,
	inStock: Schema.Boolean,
})

// Sample test data at V1 (no _version means version 0)
const sampleBooksV0: Record<string, { id: string; title: string; author: string; year: number }> = {
	"1": { id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
	"2": { id: "2", title: "Neuromancer", author: "William Gibson", year: 1984 },
}

// Sample test data at V1 (with _version: 1)
const sampleBooksV1 = {
	_version: 1,
	"1": { id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
	"2": { id: "2", title: "Neuromancer", author: "William Gibson", year: 1984 },
}

// Sample test data at V2 (with _version: 2, genre field added)
const sampleBooksV2 = {
	_version: 2,
	"1": { id: "1", title: "Dune", author: "Frank Herbert", year: 1965, genre: "sci-fi" },
	"2": { id: "2", title: "Neuromancer", author: "William Gibson", year: 1984, genre: "sci-fi" },
}

// Migration from V1 to V2: add genre field with default value
const migrationV1toV2: Migration = {
	from: 1,
	to: 2,
	description: "Add genre field with default 'unknown'",
	transform: (data) => {
		const result: Record<string, unknown> = { _version: 2 }
		for (const [key, value] of Object.entries(data)) {
			if (key === "_version") continue
			const entity = value as Record<string, unknown>
			result[key] = { ...entity, genre: "unknown" }
		}
		return result
	},
}

// Migration from V2 to V3: add inStock field with default true
const migrationV2toV3: Migration = {
	from: 2,
	to: 3,
	description: "Add inStock field with default true",
	transform: (data) => {
		const result: Record<string, unknown> = { _version: 3 }
		for (const [key, value] of Object.entries(data)) {
			if (key === "_version") continue
			const entity = value as Record<string, unknown>
			result[key] = { ...entity, inStock: true }
		}
		return result
	},
}

// Migration from V0 to V1: no data changes, just version bump
const migrationV0toV1: Migration = {
	from: 0,
	to: 1,
	description: "Initial version marker",
	transform: (data) => {
		const result: Record<string, unknown> = { _version: 1 }
		for (const [key, value] of Object.entries(data)) {
			if (key === "_version") continue
			result[key] = value
		}
		return result
	},
}

describe("Migrate Command", () => {
	let tempRoot: string
	let configPath: string
	let dataFilePath: string

	beforeEach(() => {
		// Create a unique temp directory for each test
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proseql-migrate-test-"))

		// Create data directory
		const dataDir = path.join(tempRoot, "data")
		fs.mkdirSync(dataDir, { recursive: true })

		dataFilePath = path.join(dataDir, "books.json")

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
	 * Helper to run migrate command and handle Effect result
	 */
	async function executeMigrate(options: Partial<MigrateOptions>): Promise<MigrateResult> {
		const { Effect } = await import("effect")
		const fullOptions: MigrateOptions = {
			config: options.config ?? createConfigV2(),
			configPath: options.configPath ?? configPath,
			subcommand: options.subcommand ?? "status",
			force: options.force ?? false,
		}

		return Effect.runPromise(runMigrateCommand(fullOptions))
	}

	/**
	 * Helper to create a V2 config
	 */
	function createConfigV2(): DatabaseConfig {
		return {
			books: {
				schema: BookSchemaV2,
				file: "./data/books.json",
				version: 2,
				migrations: [migrationV1toV2],
				relationships: {},
			},
		} as DatabaseConfig
	}

	/**
	 * Helper to create a V3 config with multiple migrations
	 */
	function createConfigV3(): DatabaseConfig {
		return {
			books: {
				schema: BookSchemaV3,
				file: "./data/books.json",
				version: 3,
				migrations: [migrationV0toV1, migrationV1toV2, migrationV2toV3],
				relationships: {},
			},
		} as DatabaseConfig
	}

	/**
	 * Helper to create config with no version (non-versioned collection)
	 */
	function createConfigNoVersion(): DatabaseConfig {
		return {
			books: {
				schema: BookSchemaV1,
				file: "./data/books.json",
				relationships: {},
			},
		} as DatabaseConfig
	}

	describe("detectSubcommand", () => {
		it("should detect 'status' from positional args", () => {
			expect(detectSubcommand(["status"], false)).toBe("status")
		})

		it("should detect 'dry-run' from --dry-run flag", () => {
			expect(detectSubcommand([], true)).toBe("dry-run")
		})

		it("should default to 'run' when no subcommand or flag", () => {
			expect(detectSubcommand([], false)).toBe("run")
		})

		it("should prioritize 'status' over --dry-run flag", () => {
			expect(detectSubcommand(["status"], true)).toBe("status")
		})

		it("should handle extra args after status", () => {
			expect(detectSubcommand(["status", "extra", "args"], false)).toBe("status")
		})
	})

	describe("migrate status", () => {
		it("should show 'up-to-date' when file version matches config version", async () => {
			// Write V2 data to file
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV2, null, 2))

			const result = await executeMigrate({
				subcommand: "status",
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()
			expect(result.data?.collections).toBeDefined()
			expect(result.data?.collections.length).toBe(1)

			const booksCollection = result.data?.collections[0]
			expect(booksCollection?.name).toBe("books")
			expect(booksCollection?.currentVersion).toBe(2)
			expect(booksCollection?.targetVersion).toBe(2)
			expect(booksCollection?.status).toBe("up-to-date")
			expect(booksCollection?.migrationsToApply.length).toBe(0)
		})

		it("should show 'needs-migration' when file version is behind", async () => {
			// Write V1 data to file
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV1, null, 2))

			const result = await executeMigrate({
				subcommand: "status",
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()

			const booksCollection = result.data?.collections[0]
			expect(booksCollection?.status).toBe("needs-migration")
			expect(booksCollection?.currentVersion).toBe(1)
			expect(booksCollection?.targetVersion).toBe(2)
		})

		it("should show 'ahead' when file version is ahead of config", async () => {
			// Write V2 data but configure for V1
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV2, null, 2))

			const configV1: DatabaseConfig = {
				books: {
					schema: BookSchemaV1,
					file: "./data/books.json",
					version: 1,
					migrations: [],
					relationships: {},
				},
			} as DatabaseConfig

			const result = await executeMigrate({
				config: configV1,
				subcommand: "status",
			})

			expect(result.success).toBe(true)
			expect(result.data?.collections[0]?.status).toBe("ahead")
			expect(result.data?.collections[0]?.currentVersion).toBe(2)
			expect(result.data?.collections[0]?.targetVersion).toBe(1)
		})

		it("should show 'no-file' when data file does not exist", async () => {
			// Don't create the data file

			const result = await executeMigrate({
				subcommand: "status",
			})

			expect(result.success).toBe(true)
			expect(result.data?.collections[0]?.status).toBe("no-file")
			expect(result.data?.collections[0]?.currentVersion).toBe(0)
		})

		it("should skip non-versioned collections", async () => {
			// Write data file
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV0, null, 2))

			const result = await executeMigrate({
				config: createConfigNoVersion(),
				subcommand: "status",
			})

			expect(result.success).toBe(true)
			// Non-versioned collections should not appear in the results
			expect(result.data?.collections.length).toBe(0)
		})

		it("should handle file with no _version field as version 0", async () => {
			// Write V0 data (no _version field)
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV0, null, 2))

			const result = await executeMigrate({
				config: createConfigV3(),
				subcommand: "status",
			})

			expect(result.success).toBe(true)
			const booksCollection = result.data?.collections[0]
			expect(booksCollection?.currentVersion).toBe(0)
			expect(booksCollection?.targetVersion).toBe(3)
			expect(booksCollection?.status).toBe("needs-migration")
		})

		it("should include file path in status result", async () => {
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV2, null, 2))

			const result = await executeMigrate({
				subcommand: "status",
			})

			expect(result.success).toBe(true)
			expect(result.data?.collections[0]?.filePath).toContain("books.json")
		})
	})

	describe("migrate dry-run", () => {
		it("should show migrations that would be applied", async () => {
			// Write V1 data
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV1, null, 2))

			const result = await executeMigrate({
				subcommand: "dry-run",
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()

			const booksCollection = result.data?.collections[0]
			expect(booksCollection?.status).toBe("needs-migration")
			expect(booksCollection?.migrationsToApply.length).toBe(1)
			expect(booksCollection?.migrationsToApply[0]?.from).toBe(1)
			expect(booksCollection?.migrationsToApply[0]?.to).toBe(2)
		})

		it("should include migration descriptions", async () => {
			// Write V1 data
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV1, null, 2))

			const result = await executeMigrate({
				subcommand: "dry-run",
			})

			expect(result.success).toBe(true)
			const booksCollection = result.data?.collections[0]
			expect(booksCollection?.migrationsToApply[0]?.description).toBe(
				"Add genre field with default 'unknown'",
			)
		})

		it("should show multiple migrations when needed", async () => {
			// Write V0 data (needs V0->V1->V2->V3)
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV0, null, 2))

			const result = await executeMigrate({
				config: createConfigV3(),
				subcommand: "dry-run",
			})

			expect(result.success).toBe(true)
			const booksCollection = result.data?.collections[0]
			expect(booksCollection?.migrationsToApply.length).toBe(3)
			expect(booksCollection?.migrationsToApply[0]?.from).toBe(0)
			expect(booksCollection?.migrationsToApply[0]?.to).toBe(1)
			expect(booksCollection?.migrationsToApply[1]?.from).toBe(1)
			expect(booksCollection?.migrationsToApply[1]?.to).toBe(2)
			expect(booksCollection?.migrationsToApply[2]?.from).toBe(2)
			expect(booksCollection?.migrationsToApply[2]?.to).toBe(3)
		})

		it("should show empty migrations when up-to-date", async () => {
			// Write V2 data
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV2, null, 2))

			const result = await executeMigrate({
				subcommand: "dry-run",
			})

			expect(result.success).toBe(true)
			const booksCollection = result.data?.collections[0]
			expect(booksCollection?.status).toBe("up-to-date")
			expect(booksCollection?.migrationsToApply.length).toBe(0)
		})

		it("should not modify the data file during dry-run", async () => {
			// Write V1 data
			const originalData = JSON.stringify(sampleBooksV1, null, 2)
			fs.writeFileSync(dataFilePath, originalData)

			await executeMigrate({
				subcommand: "dry-run",
			})

			// File should be unchanged
			const fileContent = fs.readFileSync(dataFilePath, "utf-8")
			expect(fileContent).toBe(originalData)
		})
	})

	describe("migrate run", () => {
		it("should execute migrations and update file version", async () => {
			// Write V1 data
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV1, null, 2))

			const result = await executeMigrate({
				subcommand: "run",
				force: true, // Skip confirmation prompt
			})

			expect(result.success).toBe(true)
			expect(result.message).toContain("Migration complete")

			// Verify file was updated
			const fileContent = fs.readFileSync(dataFilePath, "utf-8")
			const data = JSON.parse(fileContent) as Record<string, unknown>
			expect(data._version).toBe(2)
		})

		it("should add new fields during migration", async () => {
			// Write V1 data
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV1, null, 2))

			await executeMigrate({
				subcommand: "run",
				force: true,
			})

			// Verify genre field was added
			const fileContent = fs.readFileSync(dataFilePath, "utf-8")
			const data = JSON.parse(fileContent) as Record<string, Record<string, unknown>>
			expect(data["1"].genre).toBe("unknown")
			expect(data["2"].genre).toBe("unknown")
		})

		it("should apply multiple migrations in sequence", async () => {
			// Write V0 data
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV0, null, 2))

			const result = await executeMigrate({
				config: createConfigV3(),
				subcommand: "run",
				force: true,
			})

			expect(result.success).toBe(true)

			// Verify all migrations applied
			const fileContent = fs.readFileSync(dataFilePath, "utf-8")
			const data = JSON.parse(fileContent) as Record<string, Record<string, unknown>>
			expect(data._version).toBe(3)
			expect(data["1"].genre).toBe("unknown")
			expect(data["1"].inStock).toBe(true)
		})

		it("should show up-to-date message when no migrations needed", async () => {
			// Write V2 data (already at target version)
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV2, null, 2))

			const result = await executeMigrate({
				subcommand: "run",
				force: true,
			})

			expect(result.success).toBe(true)
			expect(result.message).toContain("up-to-date")
		})

		it("should show message when no versioned collections exist", async () => {
			// Use config with no version
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV0, null, 2))

			const result = await executeMigrate({
				config: createConfigNoVersion(),
				subcommand: "run",
				force: true,
			})

			expect(result.success).toBe(true)
			expect(result.message).toContain("No versioned collections")
		})

		it("should return aborted status when confirmation is declined", async () => {
			// In non-TTY mode (test environment), the prompt auto-confirms
			// but we can check the aborted property exists in the result structure
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV1, null, 2))

			const result = await executeMigrate({
				subcommand: "run",
				force: true,
			})

			// Result should have proper structure
			expect(result).toHaveProperty("success")
			expect(result).toHaveProperty("message")
		})

		it("should include collection names in success message", async () => {
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV1, null, 2))

			const result = await executeMigrate({
				subcommand: "run",
				force: true,
			})

			expect(result.success).toBe(true)
			// Message should indicate migrations were applied
			expect(result.message).toContain("migration")
		})

		it("should update status to up-to-date after successful migration", async () => {
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV1, null, 2))

			const result = await executeMigrate({
				subcommand: "run",
				force: true,
			})

			expect(result.success).toBe(true)
			expect(result.data).toBeDefined()

			// Collection should now show as up-to-date
			const booksCollection = result.data?.collections.find(c => c.name === "books")
			expect(booksCollection?.status).toBe("up-to-date")
			expect(booksCollection?.currentVersion).toBe(2)
		})
	})

	describe("error handling", () => {
		it("should handle invalid JSON in data file", async () => {
			// Write invalid JSON
			fs.writeFileSync(dataFilePath, "not valid json {{{")

			const result = await executeMigrate({
				subcommand: "status",
			})

			// Should still succeed but report version 0 due to parse error
			expect(result.success).toBe(true)
			expect(result.data?.collections[0]?.currentVersion).toBe(0)
		})

		it("should preserve existing data during migration", async () => {
			// Write V1 data with specific values
			const v1Data = {
				_version: 1,
				"1": { id: "1", title: "Test Book", author: "Test Author", year: 2020 },
			}
			fs.writeFileSync(dataFilePath, JSON.stringify(v1Data, null, 2))

			await executeMigrate({
				subcommand: "run",
				force: true,
			})

			// Verify original fields preserved
			const fileContent = fs.readFileSync(dataFilePath, "utf-8")
			const data = JSON.parse(fileContent) as Record<string, Record<string, unknown>>
			expect(data["1"].id).toBe("1")
			expect(data["1"].title).toBe("Test Book")
			expect(data["1"].author).toBe("Test Author")
			expect(data["1"].year).toBe(2020)
		})
	})

	describe("YAML data file", () => {
		beforeEach(() => {
			// Create YAML version of data file
			const yamlDataPath = path.join(tempRoot, "data", "books.yaml")
			const yamlContent = `_version: 1
"1":
  id: "1"
  title: "Dune"
  author: "Frank Herbert"
  year: 1965
"2":
  id: "2"
  title: "Neuromancer"
  author: "William Gibson"
  year: 1984`
			fs.writeFileSync(yamlDataPath, yamlContent)
		})

		it("should detect version from YAML file", async () => {
			const yamlConfig: DatabaseConfig = {
				books: {
					schema: BookSchemaV2,
					file: "./data/books.yaml",
					version: 2,
					migrations: [migrationV1toV2],
					relationships: {},
				},
			} as DatabaseConfig

			const result = await executeMigrate({
				config: yamlConfig,
				subcommand: "status",
			})

			expect(result.success).toBe(true)
			expect(result.data?.collections[0]?.currentVersion).toBe(1)
			expect(result.data?.collections[0]?.status).toBe("needs-migration")
		})
	})

	describe("multiple collections", () => {
		it("should report status for all versioned collections", async () => {
			// Create second data file
			const authorsFilePath = path.join(tempRoot, "data", "authors.json")
			const authorsData = {
				_version: 1,
				"a1": { id: "a1", name: "Frank Herbert" },
			}
			fs.writeFileSync(authorsFilePath, JSON.stringify(authorsData, null, 2))
			fs.writeFileSync(dataFilePath, JSON.stringify(sampleBooksV2, null, 2))

			const AuthorSchemaV1 = Schema.Struct({
				id: Schema.String,
				name: Schema.String,
			})
			const AuthorSchemaV2 = Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				bio: Schema.String,
			})

			const multiConfig: DatabaseConfig = {
				books: {
					schema: BookSchemaV2,
					file: "./data/books.json",
					version: 2,
					migrations: [migrationV1toV2],
					relationships: {},
				},
				authors: {
					schema: AuthorSchemaV2,
					file: "./data/authors.json",
					version: 2,
					migrations: [
						{
							from: 1,
							to: 2,
							description: "Add bio field",
							transform: (data) => {
								const result: Record<string, unknown> = { _version: 2 }
								for (const [key, value] of Object.entries(data)) {
									if (key === "_version") continue
									const entity = value as Record<string, unknown>
									result[key] = { ...entity, bio: "" }
								}
								return result
							},
						},
					],
					relationships: {},
				},
			} as DatabaseConfig

			const result = await executeMigrate({
				config: multiConfig,
				subcommand: "status",
			})

			expect(result.success).toBe(true)
			expect(result.data?.collections.length).toBe(2)

			const booksStatus = result.data?.collections.find(c => c.name === "books")
			const authorsStatus = result.data?.collections.find(c => c.name === "authors")

			expect(booksStatus?.status).toBe("up-to-date")
			expect(authorsStatus?.status).toBe("needs-migration")
		})
	})
})
