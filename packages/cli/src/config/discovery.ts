import { Data, Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"

// ============================================================================
// Config Discovery Error
// ============================================================================

/**
 * Error thrown when no config file can be found.
 */
export class ConfigNotFoundError extends Data.TaggedError("ConfigNotFoundError")<{
	readonly searchedPaths: readonly string[]
	readonly message: string
}> {}

// ============================================================================
// Config File Names (in priority order)
// ============================================================================

const CONFIG_FILE_NAMES = [
	"proseql.config.ts",
	"proseql.config.js",
	"proseql.config.json",
] as const

// ============================================================================
// Discovery Functions
// ============================================================================

/**
 * Check if a file exists at the given path.
 */
function fileExists(filePath: string): boolean {
	try {
		return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
	} catch {
		return false
	}
}

/**
 * Check if a directory exists at the given path.
 */
function directoryExists(dirPath: string): boolean {
	try {
		return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()
	} catch {
		return false
	}
}

/**
 * Get the parent directory of a path.
 * Returns null if at filesystem root.
 */
function getParentDirectory(dirPath: string): string | null {
	const parent = path.dirname(dirPath)
	// If dirname returns the same path, we're at the root
	return parent === dirPath ? null : parent
}

/**
 * Search for a config file in a single directory.
 * Returns the first matching config file path, or null if none found.
 */
function findConfigInDirectory(dirPath: string): string | null {
	for (const configName of CONFIG_FILE_NAMES) {
		const configPath = path.join(dirPath, configName)
		if (fileExists(configPath)) {
			return configPath
		}
	}
	return null
}

/**
 * Walk from the start directory upward to the filesystem root,
 * collecting all directories searched.
 */
function* walkUpward(startDir: string): Generator<string> {
	let currentDir: string | null = startDir
	while (currentDir !== null) {
		yield currentDir
		currentDir = getParentDirectory(currentDir)
	}
}

/**
 * Discover a proseql config file.
 *
 * If `overridePath` is provided, it is validated and returned directly.
 * Otherwise, the function walks from `cwd` upward, checking for:
 * - `proseql.config.ts`
 * - `proseql.config.js`
 * - `proseql.config.json`
 *
 * Returns the absolute path to the config file.
 * Fails with ConfigNotFoundError if no config file is found.
 *
 * @param cwd - The directory to start searching from
 * @param overridePath - Optional explicit path to a config file
 */
export function discoverConfig(
	cwd: string,
	overridePath?: string,
): Effect.Effect<string, ConfigNotFoundError> {
	return Effect.gen(function* () {
		// If an override path is provided, validate and return it
		if (overridePath !== undefined) {
			const absoluteOverridePath = path.isAbsolute(overridePath)
				? overridePath
				: path.resolve(cwd, overridePath)

			if (fileExists(absoluteOverridePath)) {
				return absoluteOverridePath
			}

			// Override path was specified but doesn't exist
			return yield* Effect.fail(
				new ConfigNotFoundError({
					searchedPaths: [absoluteOverridePath],
					message: `Config file not found: ${absoluteOverridePath}`,
				}),
			)
		}

		// Normalize and resolve the starting directory
		const startDir = path.resolve(cwd)

		// Validate that the starting directory exists
		if (!directoryExists(startDir)) {
			return yield* Effect.fail(
				new ConfigNotFoundError({
					searchedPaths: [],
					message: `Starting directory does not exist: ${startDir}`,
				}),
			)
		}

		// Track all directories searched for error reporting
		const searchedPaths: string[] = []

		// Walk upward from cwd to filesystem root
		for (const dir of walkUpward(startDir)) {
			const configPath = findConfigInDirectory(dir)
			if (configPath !== null) {
				return configPath
			}
			// Track all config file paths that were checked in this directory
			for (const configName of CONFIG_FILE_NAMES) {
				searchedPaths.push(path.join(dir, configName))
			}
		}

		// No config file found anywhere
		return yield* Effect.fail(
			new ConfigNotFoundError({
				searchedPaths,
				message: `No proseql config file found. Searched from ${startDir} to filesystem root.\nLooking for: ${CONFIG_FILE_NAMES.join(", ")}`,
			}),
		)
	})
}

/**
 * Synchronous version of discoverConfig for use in contexts
 * where Effect is not available.
 *
 * @throws Error if no config file is found
 */
export function discoverConfigSync(
	cwd: string,
	overridePath?: string,
): string {
	// If an override path is provided, validate and return it
	if (overridePath !== undefined) {
		const absoluteOverridePath = path.isAbsolute(overridePath)
			? overridePath
			: path.resolve(cwd, overridePath)

		if (fileExists(absoluteOverridePath)) {
			return absoluteOverridePath
		}

		throw new Error(`Config file not found: ${absoluteOverridePath}`)
	}

	// Normalize and resolve the starting directory
	const startDir = path.resolve(cwd)

	// Validate that the starting directory exists
	if (!directoryExists(startDir)) {
		throw new Error(`Starting directory does not exist: ${startDir}`)
	}

	// Walk upward from cwd to filesystem root
	for (const dir of walkUpward(startDir)) {
		const configPath = findConfigInDirectory(dir)
		if (configPath !== null) {
			return configPath
		}
	}

	// No config file found anywhere
	throw new Error(
		`No proseql config file found. Searched from ${startDir} to filesystem root.\nLooking for: ${CONFIG_FILE_NAMES.join(", ")}`,
	)
}
