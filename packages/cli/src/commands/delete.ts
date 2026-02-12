/**
 * ProseQL CLI - Delete Command
 *
 * Deletes an entity from a collection. Prompts for confirmation (unless --force),
 * calls delete on the collection, and prints a confirmation message.
 */

import * as path from "node:path";
import {
	createPersistentEffectDatabase,
	type DatabaseConfig,
	jsonCodec,
	makeSerializerLayer,
	NodeStorageLayer,
	tomlCodec,
	yamlCodec,
} from "@proseql/node";
import { Effect, Layer } from "effect";
import { confirm } from "../prompt.js";

/**
 * Options for the delete command.
 */
export interface DeleteOptions {
	/** Name of the collection containing the entity */
	readonly collection: string;
	/** ID of the entity to delete */
	readonly id: string;
	/** The database configuration */
	readonly config: DatabaseConfig;
	/** The path to the config file (used for resolving relative file paths) */
	readonly configPath: string;
	/** Skip confirmation prompt if true */
	readonly force?: boolean;
}

/**
 * Result of the delete command.
 */
export interface DeleteResult {
	readonly success: boolean;
	readonly message?: string;
	/** Whether the operation was aborted by the user */
	readonly aborted?: boolean;
}

/**
 * Resolve relative file paths in the config to absolute paths
 * based on the config file's directory.
 */
function resolveConfigPaths(
	config: DatabaseConfig,
	configPath: string,
): DatabaseConfig {
	const configDir = path.dirname(configPath);
	const resolved: Record<string, (typeof config)[string]> = {};

	for (const [collectionName, collectionConfig] of Object.entries(config)) {
		if (collectionConfig.file && !path.isAbsolute(collectionConfig.file)) {
			resolved[collectionName] = {
				...collectionConfig,
				file: path.resolve(configDir, collectionConfig.file),
			};
		} else {
			resolved[collectionName] = collectionConfig;
		}
	}

	return resolved as DatabaseConfig;
}

/**
 * Execute the delete command.
 *
 * Boots the database from the config, prompts for confirmation (unless --force),
 * and deletes the entity from the specified collection.
 *
 * @param options - Delete command options
 * @returns Effect that resolves to the delete result
 */
export function runDelete(
	options: DeleteOptions,
): Effect.Effect<DeleteResult, never> {
	return Effect.gen(function* () {
		const { collection, id, config, configPath, force = false } = options;

		// Check if collection exists in config
		if (!(collection in config)) {
			const availableCollections = Object.keys(config).join(", ");
			return {
				success: false,
				message: `Collection '${collection}' not found in config. Available collections: ${availableCollections || "(none)"}`,
			};
		}

		// Prompt for confirmation
		const confirmResult = yield* Effect.promise(() =>
			confirm({
				message: `Delete entity '${id}' from collection '${collection}'?`,
				force,
			}),
		);

		if (!confirmResult.confirmed) {
			return {
				success: false,
				message: "Delete operation cancelled.",
				aborted: true,
			};
		}

		// Resolve relative file paths in the config
		const resolvedConfig = resolveConfigPaths(config, configPath);

		// Build the persistence layer for database operations
		const PersistenceLayer = Layer.merge(
			NodeStorageLayer,
			makeSerializerLayer([jsonCodec(), yamlCodec(), tomlCodec()]),
		);

		// Boot the database and execute the delete
		const program = Effect.gen(function* () {
			const db = yield* createPersistentEffectDatabase(resolvedConfig, {});

			// Get the collection (type assertion needed since we check collection existence above)
			const coll = db[collection as keyof typeof db] as {
				readonly delete: (id: string) => Effect.Effect<void, unknown>;
			};

			// Execute the delete operation
			yield* coll.delete(id);

			return { deleted: true };
		});

		// Run the program with the persistence layer
		const result = yield* program.pipe(
			Effect.provide(PersistenceLayer),
			Effect.scoped,
			Effect.catchAll((error) => {
				// Extract error message based on error type
				let message: string;
				if (error && typeof error === "object") {
					const errorObj = error as Record<string, unknown>;
					if ("_tag" in errorObj && typeof errorObj.message === "string") {
						// Tagged error with message field
						message = errorObj.message;
					} else if (error instanceof Error) {
						message = error.message;
					} else {
						message = String(error);
					}
				} else {
					message = String(error);
				}
				return Effect.succeed({
					success: false as const,
					message: `Delete failed: ${message}`,
				});
			}),
		);

		// Check if we got an error result
		if ("success" in result && result.success === false) {
			return result as DeleteResult;
		}

		// Success - entity was deleted
		return {
			success: true,
			message: `Successfully deleted entity '${id}' from collection '${collection}'.`,
		};
	});
}

/**
 * Handle the delete command from CLI main.ts.
 * This is the entry point called by the command dispatcher.
 *
 * @param options - Delete command options
 * @returns Promise that resolves to the delete result
 */
export async function handleDelete(
	options: DeleteOptions,
): Promise<DeleteResult> {
	return Effect.runPromise(runDelete(options));
}
