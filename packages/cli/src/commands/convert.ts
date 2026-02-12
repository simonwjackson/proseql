/**
 * ProseQL CLI - Convert Command
 *
 * Converts a collection's data file from one format to another.
 * Reads the current data file, serializes in the target format,
 * and writes the new file with the correct extension.
 */

import { Effect, Layer } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import {
	NodeStorageLayer,
	makeSerializerLayer,
	jsonCodec,
	yamlCodec,
	tomlCodec,
	json5Codec,
	jsoncCodec,
	hjsonCodec,
	toonCodec,
	StorageAdapterService,
	SerializerRegistryService,
	getFileExtension,
	type DatabaseConfig,
} from "@proseql/node"

/**
 * Supported target formats for conversion.
 */
export type TargetFormat = "json" | "yaml" | "toml" | "json5" | "jsonc" | "hjson" | "toon"

/**
 * Map of format names to their canonical file extensions.
 */
const FORMAT_EXTENSIONS: Record<TargetFormat, string> = {
	json: "json",
	yaml: "yaml",
	toml: "toml",
	json5: "json5",
	jsonc: "jsonc",
	hjson: "hjson",
	toon: "toon",
}

/**
 * Valid format names for validation.
 */
export const VALID_FORMATS = Object.keys(FORMAT_EXTENSIONS) as readonly TargetFormat[]

/**
 * Options for the convert command.
 */
export interface ConvertOptions {
	/** The collection to convert */
	readonly collection: string
	/** The database configuration */
	readonly config: DatabaseConfig
	/** The path to the config file (used for resolving relative file paths) */
	readonly configPath: string
	/** The target format to convert to */
	readonly targetFormat: TargetFormat
}

/**
 * Result of the convert command.
 */
export interface ConvertResult {
	readonly success: boolean
	readonly message?: string
	/** Details about the conversion */
	readonly data?: {
		readonly collection: string
		readonly oldFile: string
		readonly oldFormat: string
		readonly newFile: string
		readonly newFormat: string
		readonly configUpdated: boolean
	}
}

/**
 * Resolve relative file paths in the config to absolute paths
 * based on the config file's directory.
 */
function resolveFilePath(
	filePath: string | undefined,
	configPath: string,
): string | undefined {
	if (!filePath) {
		return undefined
	}
	if (path.isAbsolute(filePath)) {
		return filePath
	}
	const configDir = path.dirname(configPath)
	return path.resolve(configDir, filePath)
}

/**
 * Build the persistence layer for storage and serializer operations.
 * Includes all supported formats for maximum compatibility.
 */
function buildPersistenceLayer() {
	return Layer.merge(
		NodeStorageLayer,
		makeSerializerLayer([
			jsonCodec(),
			yamlCodec(),
			tomlCodec(),
			json5Codec(),
			jsoncCodec(),
			hjsonCodec(),
			toonCodec(),
		]),
	)
}

/**
 * Compute the new file path by replacing the extension.
 *
 * @param oldPath - The original file path
 * @param newFormat - The target format name
 * @returns The new file path with the correct extension
 */
function computeNewFilePath(oldPath: string, newFormat: TargetFormat): string {
	const dir = path.dirname(oldPath)
	const ext = path.extname(oldPath)
	const basename = path.basename(oldPath, ext)
	const newExt = FORMAT_EXTENSIONS[newFormat]
	return path.join(dir, `${basename}.${newExt}`)
}

/**
 * Validate that the target format is valid.
 *
 * @param format - The format string to validate
 * @returns true if valid
 */
export function isValidFormat(format: string): format is TargetFormat {
	return VALID_FORMATS.includes(format as TargetFormat)
}

/**
 * Update the config file to reference the new file path.
 *
 * For JSON config files, we parse and rewrite the entire file.
 * For TypeScript/JavaScript config files, we use text replacement
 * to preserve formatting, imports, and other code.
 *
 * @param configPath - Path to the config file
 * @param collectionName - Name of the collection to update
 * @param oldFilePath - The old file path (relative or absolute)
 * @param newFilePath - The new file path (relative)
 * @returns true if the config was updated successfully
 */
function updateConfigFile(
	configPath: string,
	collectionName: string,
	oldFilePath: string,
	newFilePath: string,
): boolean {
	try {
		const configContent = fs.readFileSync(configPath, "utf-8")
		const ext = path.extname(configPath).toLowerCase()

		if (ext === ".json") {
			// For JSON configs, parse and modify
			const config = JSON.parse(configContent) as Record<string, Record<string, unknown>>
			if (config[collectionName] && typeof config[collectionName].file === "string") {
				config[collectionName].file = newFilePath
				fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")
				return true
			}
			return false
		}

		// For TypeScript/JavaScript configs, use text replacement
		// We need to find the file property for the specific collection and update it

		// Normalize paths for comparison - handle both relative paths starting with "./"
		const normalizedOldPath = oldFilePath.startsWith("./") ? oldFilePath : `./${oldFilePath}`
		const normalizedNewPath = newFilePath.startsWith("./") ? newFilePath : `./${newFilePath}`

		// Also prepare versions without "./" prefix
		const oldPathNoPrefix = oldFilePath.replace(/^\.\//, "")
		const newPathNoPrefix = newFilePath.replace(/^\.\//, "")

		// Strategy: Replace the old file path with the new one
		// We look for patterns like:
		//   file: "./data/collection.json"
		//   file: './data/collection.json'
		//   file: "./data/collection.json",
		//   file: './data/collection.json',

		let updatedContent = configContent
		let replaced = false

		// Try multiple patterns for different quote styles and path formats
		const patterns = [
			// Double quotes with ./
			{ search: `file: "${normalizedOldPath}"`, replace: `file: "${normalizedNewPath}"` },
			// Single quotes with ./
			{ search: `file: '${normalizedOldPath}'`, replace: `file: '${normalizedNewPath}'` },
			// Double quotes without ./
			{ search: `file: "${oldPathNoPrefix}"`, replace: `file: "${newPathNoPrefix}"` },
			// Single quotes without ./
			{ search: `file: '${oldPathNoPrefix}'`, replace: `file: '${newPathNoPrefix}'` },
			// With trailing comma - double quotes with ./
			{ search: `file: "${normalizedOldPath}",`, replace: `file: "${normalizedNewPath}",` },
			// With trailing comma - single quotes with ./
			{ search: `file: '${normalizedOldPath}',`, replace: `file: '${normalizedNewPath}',` },
			// With trailing comma - double quotes without ./
			{ search: `file: "${oldPathNoPrefix}",`, replace: `file: "${newPathNoPrefix}",` },
			// With trailing comma - single quotes without ./
			{ search: `file: '${oldPathNoPrefix}',`, replace: `file: '${newPathNoPrefix}',` },
		]

		for (const { search, replace } of patterns) {
			if (updatedContent.includes(search)) {
				updatedContent = updatedContent.replace(search, replace)
				replaced = true
				break
			}
		}

		if (replaced) {
			fs.writeFileSync(configPath, updatedContent, "utf-8")
			return true
		}

		// If simple replacement didn't work, try regex for more flexible matching
		// Pattern matches: file: "path" or file: 'path' with optional whitespace
		const regexPatterns = [
			// Match with ./ prefix
			new RegExp(`(file:\\s*["'])${escapeRegex(normalizedOldPath)}(["'])`, "g"),
			// Match without ./ prefix
			new RegExp(`(file:\\s*["'])${escapeRegex(oldPathNoPrefix)}(["'])`, "g"),
		]

		for (const regex of regexPatterns) {
			if (regex.test(configContent)) {
				updatedContent = configContent.replace(regex, `$1${normalizedNewPath}$2`)
				fs.writeFileSync(configPath, updatedContent, "utf-8")
				return true
			}
		}

		return false
	} catch {
		return false
	}
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Execute the convert command.
 *
 * Reads the collection's current data file, deserializes it,
 * and re-serializes it in the target format.
 *
 * @param options - Convert command options
 * @returns Effect that resolves to the convert result
 */
export function runConvert(
	options: ConvertOptions,
): Effect.Effect<ConvertResult, never> {
	const { collection, config, configPath, targetFormat } = options

	const program = Effect.gen(function* () {
		// Look up the collection in the config
		const collectionConfig = config[collection]
		if (!collectionConfig) {
			return {
				success: false,
				message: `Collection '${collection}' not found in config`,
			}
		}

		// Check if the collection has a file configured
		const originalFilePath = collectionConfig.file
		if (!originalFilePath) {
			return {
				success: false,
				message: `Collection '${collection}' does not have a file configured (in-memory only)`,
			}
		}

		// Resolve the file path to absolute
		const absoluteFilePath = resolveFilePath(originalFilePath, configPath)!

		// Get the current format from the file extension
		const currentExt = getFileExtension(absoluteFilePath)
		if (!currentExt) {
			return {
				success: false,
				message: `Could not determine current format from file '${absoluteFilePath}'`,
			}
		}

		// Check if already in the target format
		const targetExt = FORMAT_EXTENSIONS[targetFormat]
		if (currentExt === targetExt) {
			return {
				success: false,
				message: `Collection '${collection}' is already in ${targetFormat} format`,
			}
		}

		// Get storage and serializer services
		const storage = yield* StorageAdapterService
		const serializer = yield* SerializerRegistryService

		// Check if the file exists
		const exists = yield* storage.exists(absoluteFilePath)
		if (!exists) {
			return {
				success: false,
				message: `Data file '${absoluteFilePath}' does not exist`,
			}
		}

		// Read the current file
		const rawContent = yield* storage.read(absoluteFilePath).pipe(
			Effect.catchAll((err) =>
				Effect.fail(new Error(`Failed to read file: ${err}`)),
			),
		)

		// Deserialize the current content
		const data = yield* serializer.deserialize(rawContent, currentExt).pipe(
			Effect.catchAll((err) =>
				Effect.fail(new Error(`Failed to parse ${currentExt} file: ${err}`)),
			),
		)

		// Serialize to the new format
		const newContent = yield* serializer.serialize(data, targetExt).pipe(
			Effect.catchAll((err) =>
				Effect.fail(new Error(`Failed to serialize to ${targetFormat}: ${err}`)),
			),
		)

		// Compute the new file path
		const newFilePath = computeNewFilePath(absoluteFilePath, targetFormat)

		// Write the new file
		yield* storage.write(newFilePath, newContent).pipe(
			Effect.catchAll((err) =>
				Effect.fail(new Error(`Failed to write new file '${newFilePath}': ${err}`)),
			),
		)

		// Remove the old file (only if different from new file path)
		if (newFilePath !== absoluteFilePath) {
			yield* storage.remove(absoluteFilePath).pipe(
				Effect.catchAll((err) =>
					Effect.fail(new Error(`Failed to remove old file '${absoluteFilePath}': ${err}`)),
				),
			)
		}

		// Compute relative paths for display and config update
		const configDir = path.dirname(configPath)
		const relativeOldPath = path.relative(configDir, absoluteFilePath) || absoluteFilePath
		const relativeNewPath = path.relative(configDir, newFilePath) || newFilePath

		// Update the config file to reference the new file path
		// We use the relative path with "./" prefix to match the typical config file style
		const configRelativeNewPath = relativeNewPath.startsWith("./") ? relativeNewPath : `./${relativeNewPath}`
		const configUpdated = updateConfigFile(
			configPath,
			collection,
			originalFilePath,
			configRelativeNewPath,
		)

		return {
			success: true,
			data: {
				collection,
				oldFile: relativeOldPath,
				oldFormat: currentExt,
				newFile: relativeNewPath,
				newFormat: targetFormat,
				configUpdated,
			},
		}
	})

	// Run with the persistence layer
	return program.pipe(
		Effect.provide(buildPersistenceLayer()),
		Effect.catchAll((error) => {
			const message = error instanceof Error ? error.message : String(error)
			return Effect.succeed({
				success: false as const,
				message: `Failed to convert: ${message}`,
			})
		}),
	)
}

/**
 * Handle the convert command from CLI main.ts.
 * This is the entry point called by the command dispatcher.
 *
 * @param options - Convert command options
 * @returns Promise that resolves to the convert result
 */
export async function handleConvert(options: ConvertOptions): Promise<ConvertResult> {
	return Effect.runPromise(runConvert(options))
}
