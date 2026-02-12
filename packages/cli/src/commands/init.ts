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
 * This task (3.1) only implements the detection and abort logic.
 * Subsequent tasks will add scaffolding functionality.
 *
 * @param options - Init command options
 * @returns Result indicating success or failure
 */
export function runInit(options: InitOptions = {}): InitResult {
	const cwd = options.cwd ?? process.cwd()

	// Check for existing config file
	const existingConfig = findExistingConfig(cwd)

	if (existingConfig !== null) {
		return {
			success: false,
			message: `A proseql config file already exists: ${existingConfig}\nTo reinitialize, remove the existing config first.`,
		}
	}

	// TODO: Subsequent tasks will implement:
	// - 3.2: Scaffold proseql.config.ts with example collection
	// - 3.3: Create data/ directory with example data file
	// - 3.4: Detect .git and update .gitignore
	// - 3.5: Print summary of created files

	// Placeholder return for now - the config check passed
	return {
		success: true,
		message: "init command scaffolding not yet implemented",
		createdFiles: [],
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
