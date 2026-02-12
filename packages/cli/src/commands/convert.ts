/**
 * ProseQL CLI - Convert Command
 *
 * Converts a collection's data file from one format to another.
 * Reads the current data file, serializes in the target format,
 * and writes the new file with the correct extension.
 */

import { Effect, Layer } from "effect"
import * as path from "node:path"
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

		// Store conversion details (actual file write will be done in task 8.2)
		// For now, this task only does the read and serialization
		const configDir = path.dirname(configPath)
		const relativeOldPath = path.relative(configDir, absoluteFilePath) || absoluteFilePath
		const relativeNewPath = path.relative(configDir, newFilePath) || newFilePath

		return {
			success: true,
			data: {
				collection,
				oldFile: relativeOldPath,
				oldFormat: currentExt,
				newFile: relativeNewPath,
				newFormat: targetFormat,
			},
			// Store the serialized content internally for the next task
			_serializedContent: newContent,
			_absoluteNewPath: newFilePath,
			_absoluteOldPath: absoluteFilePath,
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
		// Strip internal fields before returning
		Effect.map((result) => {
			if ("_serializedContent" in result) {
				const { _serializedContent, _absoluteNewPath, _absoluteOldPath, ...publicResult } = result
				return publicResult as ConvertResult
			}
			return result as ConvertResult
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
