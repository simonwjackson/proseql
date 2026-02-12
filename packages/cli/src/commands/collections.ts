/**
 * ProseQL CLI - Collections Command
 *
 * Boots the database from config, lists all collection names with entity count,
 * file path, and serialization format.
 */

import { Chunk, Effect, Layer, Stream } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import {
	createPersistentEffectDatabase,
	NodeStorageLayer,
	makeSerializerLayer,
	jsonCodec,
	yamlCodec,
	tomlCodec,
	type DatabaseConfig,
} from "@proseql/node"

/**
 * Options for the collections command.
 */
export interface CollectionsOptions {
	/** The database configuration */
	readonly config: DatabaseConfig
	/** The path to the config file (used for resolving relative file paths) */
	readonly configPath: string
}

/**
 * Information about a single collection.
 */
export interface CollectionInfo {
	readonly name: string
	readonly count: number
	readonly file: string
	readonly format: string
}

/**
 * Result of the collections command.
 */
export interface CollectionsResult {
	readonly success: boolean
	readonly message?: string
	readonly data?: ReadonlyArray<CollectionInfo>
}

/**
 * Resolve relative file paths in the config to absolute paths
 * based on the config file's directory.
 */
function resolveConfigPaths(
	config: DatabaseConfig,
	configPath: string,
): DatabaseConfig {
	const configDir = path.dirname(configPath)
	const resolved: Record<string, (typeof config)[string]> = {}

	for (const [collectionName, collectionConfig] of Object.entries(config)) {
		if (collectionConfig.file && !path.isAbsolute(collectionConfig.file)) {
			resolved[collectionName] = {
				...collectionConfig,
				file: path.resolve(configDir, collectionConfig.file),
			}
		} else {
			resolved[collectionName] = collectionConfig
		}
	}

	return resolved as DatabaseConfig
}

/**
 * Determine the serialization format from a file path.
 * Returns the format based on the file extension.
 */
function getFormatFromFile(filePath: string | undefined): string {
	if (!filePath) {
		return "(in-memory)"
	}

	const ext = path.extname(filePath).toLowerCase()
	switch (ext) {
		case ".json":
			return "json"
		case ".jsonl":
			return "jsonl"
		case ".yaml":
		case ".yml":
			return "yaml"
		case ".toml":
			return "toml"
		case ".json5":
			return "json5"
		case ".jsonc":
			return "jsonc"
		case ".hjson":
			return "hjson"
		case ".toon":
			return "toon"
		default:
			return ext ? ext.slice(1) : "unknown"
	}
}

/**
 * Execute the collections command.
 *
 * Boots the database from the config, and lists all collections with
 * their entity counts, file paths, and serialization formats.
 *
 * @param options - Collections command options
 * @returns Result with collection information or error message
 */
export function runCollections(
	options: CollectionsOptions,
): Effect.Effect<CollectionsResult> {
	return Effect.gen(function* () {
		const { config, configPath } = options

		const collectionNames = Object.keys(config)

		if (collectionNames.length === 0) {
			return {
				success: true,
				data: [],
				message: "No collections configured",
			}
		}

		// Resolve relative file paths in the config
		const resolvedConfig = resolveConfigPaths(config, configPath)

		// Build the persistence layer for database operations
		const PersistenceLayer = Layer.merge(
			NodeStorageLayer,
			makeSerializerLayer([jsonCodec(), yamlCodec(), tomlCodec()]),
		)

		// Boot the database and gather collection info
		const program = Effect.gen(function* () {
			const db = yield* createPersistentEffectDatabase(resolvedConfig, {})

			const results: CollectionInfo[] = []

			for (const name of collectionNames) {
				const collectionConfig = resolvedConfig[name]
				const filePath = collectionConfig?.file

				// Get the collection (type assertion needed since we verify existence via config)
				const coll = db[name as keyof typeof db] as {
					readonly query: (options?: Record<string, unknown>) => Stream.Stream<Record<string, unknown>, unknown, never>
				}

				// Count entities by querying all and collecting
				const stream = coll.query()
				const chunk = yield* Stream.runCollect(stream)
				const count = Chunk.size(chunk)

				// Get format from file extension
				const format = getFormatFromFile(filePath)

				// Get relative file path for display (relative to config dir)
				const configDir = path.dirname(configPath)
				const displayPath = filePath
					? path.relative(configDir, filePath) || filePath
					: "(in-memory)"

				results.push({
					name,
					count,
					file: displayPath,
					format,
				})
			}

			return results
		})

		// Run the program with the persistence layer
		const result = yield* program.pipe(
			Effect.provide(PersistenceLayer),
			Effect.scoped,
			Effect.catchAll((error) => {
				const message =
					error instanceof Error ? error.message : String(error)
				return Effect.succeed({
					success: false as const,
					message: `Failed to list collections: ${message}`,
				})
			}),
		)

		// Check if we got an error result
		if ("success" in result && result.success === false) {
			return result as CollectionsResult
		}

		// We got data
		const data = result as ReadonlyArray<CollectionInfo>
		return {
			success: true,
			data,
		}
	})
}

/**
 * Handle the collections command from CLI main.ts.
 * This is the entry point called by the command dispatcher.
 *
 * @param options - Collections command options
 * @returns Promise that resolves to the collections info or rejects on error
 */
export async function handleCollections(
	options: CollectionsOptions,
): Promise<CollectionsResult> {
	const result = await Effect.runPromise(runCollections(options))
	return result
}
