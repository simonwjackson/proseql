/**
 * ProseQL CLI - Init Command
 *
 * Scaffolds a new proseql project with config and data files.
 * Checks for existing config and aborts with warning if found.
 */

import * as fs from "node:fs"
import * as path from "node:path"

// Config file names in priority order (same as discovery.ts)
const CONFIG_FILE_NAMES = [
	"proseql.config.ts",
	"proseql.config.js",
	"proseql.config.json",
] as const

// Default config file name to create
const DEFAULT_CONFIG_FILE = "proseql.config.ts"

/**
 * Generate the content for proseql.config.ts with an example collection.
 * The generated config includes a "notes" collection as a simple starting point.
 *
 * @param format - The data file format (json, yaml, toml)
 */
function generateConfigContent(format: string): string {
	const extension = format === "yaml" ? "yaml" : format === "toml" ? "toml" : "json"

	return `import { Schema } from "effect"
import type { DatabaseConfig } from "@proseql/core"

/**
 * Example schema for a notes collection.
 * Customize this schema to match your data structure.
 */
const NoteSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  content: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})

/**
 * ProseQL database configuration.
 * Add your collections here. Each collection needs:
 * - schema: An Effect Schema for validation
 * - file: Path to the data file (optional for in-memory only)
 * - relationships: Related collections (empty object if none)
 */
const config = {
  notes: {
    schema: NoteSchema,
    file: "./data/notes.${extension}",
    relationships: {},
  },
} as const satisfies DatabaseConfig

export default config
`
}

/**
 * Check if a config file already exists in the current directory.
 * Returns the name of the found config file, or null if none found.
 */
function findExistingConfig(cwd: string): string | null {
	for (const configName of CONFIG_FILE_NAMES) {
		const configPath = path.join(cwd, configName)
		if (fs.existsSync(configPath)) {
			return configName
		}
	}
	return null
}

/**
 * Options for the init command.
 */
export interface InitOptions {
	readonly format?: string
	readonly cwd?: string
}

/**
 * Result of the init command.
 */
export interface InitResult {
	readonly success: boolean
	readonly message: string
	readonly createdFiles?: readonly string[]
}

/**
 * Execute the init command.
 *
 * Checks for existing config files and aborts if found.
 * Creates proseql.config.ts with an example collection definition.
 *
 * @param options - Init command options
 * @returns Result indicating success or failure
 */
export function runInit(options: InitOptions = {}): InitResult {
	const cwd = options.cwd ?? process.cwd()
	const format = options.format ?? "json"

	// Validate format
	const validFormats = ["json", "yaml", "toml"]
	if (!validFormats.includes(format)) {
		return {
			success: false,
			message: `Invalid format: ${format}. Valid formats are: ${validFormats.join(", ")}`,
		}
	}

	// Check for existing config file
	const existingConfig = findExistingConfig(cwd)

	if (existingConfig !== null) {
		return {
			success: false,
			message: `A proseql config file already exists: ${existingConfig}\nTo reinitialize, remove the existing config first.`,
		}
	}

	const createdFiles: string[] = []

	// Task 3.2: Scaffold proseql.config.ts with example collection
	const configPath = path.join(cwd, DEFAULT_CONFIG_FILE)
	const configContent = generateConfigContent(format)

	try {
		fs.writeFileSync(configPath, configContent, "utf-8")
		createdFiles.push(DEFAULT_CONFIG_FILE)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return {
			success: false,
			message: `Failed to create config file: ${message}`,
		}
	}

	// TODO: Subsequent tasks will implement:
	// - 3.3: Create data/ directory with example data file
	// - 3.4: Detect .git and update .gitignore
	// - 3.5: Print summary of created files

	return {
		success: true,
		message: `Created ${createdFiles.join(", ")}`,
		createdFiles,
	}
}

/**
 * Handle the init command from CLI main.ts
 * This is the entry point called by the command dispatcher.
 */
export async function handleInit(options: InitOptions = {}): Promise<void> {
	const result = runInit(options)

	if (!result.success) {
		console.error(`Error: ${result.message}`)
		process.exit(1)
	}

	console.log(result.message)
}
