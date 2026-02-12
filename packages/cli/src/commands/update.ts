/**
 * ProseQL CLI - Update Command
 *
 * Updates an existing entity in a collection. Parses --set flag using set-parser,
 * calls update on the collection, and prints the updated entity.
 */

import { Effect, Layer } from "effect"
import * as path from "node:path"
import {
	createPersistentEffectDatabase,
	NodeStorageLayer,
	makeSerializerLayer,
	jsonCodec,
	yamlCodec,
	tomlCodec,
	type DatabaseConfig,
} from "@proseql/node"
import { parseSets, SetParseError } from "../parsers/set-parser.js"

/**
 * Options for the update command.
 */
export interface UpdateOptions {
	/** Name of the collection containing the entity */
	readonly collection: string
	/** ID of the entity to update */
	readonly id: string
	/** The database configuration */
	readonly config: DatabaseConfig
	/** The path to the config file (used for resolving relative file paths) */
	readonly configPath: string
	/** Assignment string for --set flag (e.g., "year=2025,title=New Title") */
	readonly set: string
}

/**
 * Result of the update command.
 */
export interface UpdateResult {
	readonly success: boolean
	readonly message?: string
	readonly data?: Record<string, unknown>
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
 * Execute the update command.
 *
 * Boots the database from the config, parses the --set assignments,
 * and updates the entity in the specified collection.
 *
 * @param options - Update command options
 * @returns Effect that resolves to the update result
 */
export function runUpdate(
	options: UpdateOptions,
): Effect.Effect<UpdateResult, never> {
	return Effect.gen(function* () {
		const { collection, id, config, configPath, set } = options

		// Check if collection exists in config
		if (!(collection in config)) {
			const availableCollections = Object.keys(config).join(", ")
			return {
				success: false,
				message: `Collection '${collection}' not found in config. Available collections: ${availableCollections || "(none)"}`,
			}
		}

		// Parse the --set assignments
		const parseResult = yield* parseSets(set).pipe(
			Effect.catchTag("SetParseError", (error: SetParseError) =>
				Effect.succeed({
					success: false as const,
					message: error.message,
				}),
			),
		)

		// Check if parsing failed
		if ("success" in parseResult && parseResult.success === false) {
			return parseResult as UpdateResult
		}

		const updateData = parseResult as Record<string, string | number | boolean>

		// Resolve relative file paths in the config
		const resolvedConfig = resolveConfigPaths(config, configPath)

		// Build the persistence layer for database operations
		const PersistenceLayer = Layer.merge(
			NodeStorageLayer,
			makeSerializerLayer([jsonCodec(), yamlCodec(), tomlCodec()]),
		)

		// Boot the database and execute the update
		const program = Effect.gen(function* () {
			const db = yield* createPersistentEffectDatabase(resolvedConfig, {})

			// Get the collection (type assertion needed since we check collection existence above)
			const coll = db[collection as keyof typeof db] as {
				readonly update: (
					id: string,
					data: Record<string, unknown>,
				) => Effect.Effect<Record<string, unknown>, unknown>
			}

			// Execute the update operation
			const updated = yield* coll.update(id, updateData)

			return updated as Record<string, unknown>
		})

		// Run the program with the persistence layer
		const result = yield* program.pipe(
			Effect.provide(PersistenceLayer),
			Effect.scoped,
			Effect.catchAll((error) => {
				// Extract error message based on error type
				let message: string
				if (error && typeof error === "object") {
					const errorObj = error as Record<string, unknown>
					if ("_tag" in errorObj && typeof errorObj.message === "string") {
						// Tagged error with message field
						message = errorObj.message
					} else if (error instanceof Error) {
						message = error.message
					} else {
						message = String(error)
					}
				} else {
					message = String(error)
				}
				return Effect.succeed({
					success: false as const,
					message: `Update failed: ${message}`,
				})
			}),
		)

		// Check if we got an error result
		if ("success" in result && result.success === false) {
			return result as UpdateResult
		}

		// We got the updated entity
		const entity = result as Record<string, unknown>
		return {
			success: true,
			data: entity,
		}
	})
}

/**
 * Handle the update command from CLI main.ts.
 * This is the entry point called by the command dispatcher.
 *
 * @param options - Update command options
 * @returns Promise that resolves to the update result
 */
export async function handleUpdate(options: UpdateOptions): Promise<UpdateResult> {
	return Effect.runPromise(runUpdate(options))
}
