import { Data, Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import type { DatabaseConfig } from "@proseql/core"

// ============================================================================
// Config Loading Errors
// ============================================================================

/**
 * Error thrown when a config file cannot be loaded.
 */
export class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{
	readonly configPath: string
	readonly reason: string
	readonly message: string
}> {}

/**
 * Error thrown when a config file has an invalid structure.
 */
export class ConfigValidationError extends Data.TaggedError(
	"ConfigValidationError",
)<{
	readonly configPath: string
	readonly reason: string
	readonly message: string
}> {}

// ============================================================================
// Supported Extensions
// ============================================================================

const SUPPORTED_EXTENSIONS = [".ts", ".js", ".json"] as const
type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number]

/**
 * Check if a file extension is supported.
 */
function isSupportedExtension(ext: string): ext is SupportedExtension {
	return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)
}

// ============================================================================
// Config Loading Functions
// ============================================================================

/**
 * Load a JSON config file.
 */
function loadJsonConfig(
	configPath: string,
): Effect.Effect<unknown, ConfigLoadError> {
	return Effect.gen(function* () {
		try {
			const content = fs.readFileSync(configPath, "utf-8")
			return JSON.parse(content) as unknown
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error)
			return yield* Effect.fail(
				new ConfigLoadError({
					configPath,
					reason: `Failed to parse JSON config: ${errorMessage}`,
					message: `Failed to load config from ${configPath}: ${errorMessage}`,
				}),
			)
		}
	})
}

/**
 * Load a TypeScript or JavaScript config file using dynamic import.
 * Bun handles TypeScript natively, so this works for both .ts and .js.
 */
function loadModuleConfig(
	configPath: string,
): Effect.Effect<unknown, ConfigLoadError> {
	// Use file:// URL for dynamic import to work correctly
	const fileUrl = `file://${configPath}`

	return Effect.tryPromise({
		try: async () => {
			const module = (await import(fileUrl)) as Record<string, unknown>

			// Config should be the default export
			if ("default" in module) {
				return module.default
			}

			// If no default export, try to use the module itself
			// (in case the config is exported as module.exports = {...})
			return module
		},
		catch: (error) => {
			const errorMessage =
				error instanceof Error ? error.message : String(error)
			return new ConfigLoadError({
				configPath,
				reason: `Failed to import config module: ${errorMessage}`,
				message: `Failed to load config from ${configPath}: ${errorMessage}`,
			})
		},
	})
}

/**
 * Validate that a loaded config object has the correct structure.
 * A valid DatabaseConfig is a Record<string, CollectionConfig> where
 * each CollectionConfig has at least a `schema` and `relationships` field.
 */
function validateConfigStructure(
	config: unknown,
	configPath: string,
): Effect.Effect<DatabaseConfig, ConfigValidationError> {
	return Effect.gen(function* () {
		// Must be a non-null object
		if (config === null || typeof config !== "object") {
			return yield* Effect.fail(
				new ConfigValidationError({
					configPath,
					reason: "Config must be an object",
					message: `Invalid config in ${configPath}: Config must be an object, got ${typeof config}`,
				}),
			)
		}

		// Must be a plain object (not an array)
		if (Array.isArray(config)) {
			return yield* Effect.fail(
				new ConfigValidationError({
					configPath,
					reason: "Config must be an object, not an array",
					message: `Invalid config in ${configPath}: Config must be an object, got array`,
				}),
			)
		}

		const configObj = config as Record<string, unknown>

		// Check each collection
		for (const [collectionName, collectionConfig] of Object.entries(
			configObj,
		)) {
			// Each collection config must be an object
			if (
				collectionConfig === null ||
				typeof collectionConfig !== "object" ||
				Array.isArray(collectionConfig)
			) {
				return yield* Effect.fail(
					new ConfigValidationError({
						configPath,
						reason: `Collection '${collectionName}' must be an object`,
						message: `Invalid config in ${configPath}: Collection '${collectionName}' must be an object`,
					}),
				)
			}

			const collection = collectionConfig as Record<string, unknown>

			// Must have a schema field
			if (!("schema" in collection)) {
				return yield* Effect.fail(
					new ConfigValidationError({
						configPath,
						reason: `Collection '${collectionName}' is missing required field 'schema'`,
						message: `Invalid config in ${configPath}: Collection '${collectionName}' is missing required field 'schema'`,
					}),
				)
			}

			// Must have a relationships field
			if (!("relationships" in collection)) {
				return yield* Effect.fail(
					new ConfigValidationError({
						configPath,
						reason: `Collection '${collectionName}' is missing required field 'relationships'`,
						message: `Invalid config in ${configPath}: Collection '${collectionName}' is missing required field 'relationships'`,
					}),
				)
			}

			// Relationships must be an object
			if (
				collection.relationships === null ||
				typeof collection.relationships !== "object" ||
				Array.isArray(collection.relationships)
			) {
				return yield* Effect.fail(
					new ConfigValidationError({
						configPath,
						reason: `Collection '${collectionName}' field 'relationships' must be an object`,
						message: `Invalid config in ${configPath}: Collection '${collectionName}' field 'relationships' must be an object`,
					}),
				)
			}
		}

		// Config is valid
		return configObj as DatabaseConfig
	})
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Load a proseql configuration file.
 *
 * Supports three file formats:
 * - `.ts` - TypeScript (imported via Bun)
 * - `.js` - JavaScript (dynamic import)
 * - `.json` - JSON (parsed with JSON.parse)
 *
 * The config file should export a DatabaseConfig object as its default export.
 *
 * @param configPath - Absolute path to the config file
 * @returns The validated DatabaseConfig
 */
export function loadConfig(
	configPath: string,
): Effect.Effect<DatabaseConfig, ConfigLoadError | ConfigValidationError> {
	return Effect.gen(function* () {
		// Ensure the path is absolute
		const absolutePath = path.isAbsolute(configPath)
			? configPath
			: path.resolve(process.cwd(), configPath)

		// Get file extension
		const ext = path.extname(absolutePath).toLowerCase()

		// Validate extension
		if (!isSupportedExtension(ext)) {
			return yield* Effect.fail(
				new ConfigLoadError({
					configPath: absolutePath,
					reason: `Unsupported config file extension: ${ext}`,
					message: `Cannot load config from ${absolutePath}: Unsupported extension '${ext}'. Use .ts, .js, or .json`,
				}),
			)
		}

		// Load the raw config based on extension
		const rawConfig: unknown =
			ext === ".json"
				? yield* loadJsonConfig(absolutePath)
				: yield* loadModuleConfig(absolutePath)

		// Validate the config structure
		const validatedConfig = yield* validateConfigStructure(
			rawConfig,
			absolutePath,
		)

		return validatedConfig
	})
}

/**
 * Synchronous version of loadConfig for use in contexts
 * where Effect is not available.
 *
 * @throws Error if config cannot be loaded or is invalid
 */
export async function loadConfigAsync(configPath: string): Promise<DatabaseConfig> {
	return Effect.runPromise(loadConfig(configPath))
}
