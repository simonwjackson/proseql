/**
 * ProseQL CLI - Update Command
 *
 * Updates an existing entity in a collection. Parses --set flag using set-parser,
 * calls update on the collection, and prints the updated entity.
 */

import {
	AllTextFormatsLayer,
	createPersistentEffectDatabase,
	type DatabaseConfig,
	NodeStorageLayer,
} from "@proseql/node";
import { Cause, Effect, Layer } from "effect";
import {
	getCliCollectionConfig,
	listCollectionNames,
	resolveConfigPaths,
} from "../config/paths.js";
import { parseSets, type SetParseError } from "../parsers/set-parser.js";

/**
 * Options for the update command.
 */
export interface UpdateOptions {
	/** Name of the collection containing the entity */
	readonly collection: string;
	/** ID of the entity to update */
	readonly id: string;
	/** The database configuration */
	readonly config: DatabaseConfig;
	/** The path to the config file (used for resolving relative file paths) */
	readonly configPath: string;
	/** Assignment string for --set flag (e.g., "year=2025,title=New Title") */
	readonly set: string;
}

/**
 * Result of the update command.
 */
export interface UpdateResult {
	readonly success: boolean;
	readonly message?: string;
	readonly data?: Record<string, unknown>;
}

function getErrorMessage(error: unknown): string {
	if (error && typeof error === "object") {
		const errorObj = error as Record<string, unknown>;
		if ("_tag" in errorObj && typeof errorObj.message === "string") {
			return errorObj.message;
		}
		if (error instanceof Error) {
			return error.message;
		}
	}
	return String(error);
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
		const { collection, id, config, configPath, set } = options;

		// Check if collection exists in config
		if (getCliCollectionConfig(config, collection) === undefined) {
			const availableCollections = listCollectionNames(config).join(", ");
			return {
				success: false,
				message: `Collection '${collection}' not found in config. Available collections: ${availableCollections || "(none)"}`,
			};
		}

		// Parse the --set assignments
		const parseResult = yield* parseSets(set).pipe(
			Effect.catchTag("SetParseError", (error: SetParseError) =>
				Effect.succeed({
					success: false as const,
					message: error.message,
				}),
			),
		);

		// Check if parsing failed
		if ("success" in parseResult && parseResult.success === false) {
			return parseResult as UpdateResult;
		}

		const updateData = parseResult as Record<string, string | number | boolean>;

		// Resolve relative file paths in the config
		const resolvedConfig = resolveConfigPaths(config, configPath);

		// Build the persistence layer for database operations
		const PersistenceLayer = Layer.merge(NodeStorageLayer, AllTextFormatsLayer);

		// Boot the database and execute the update
		const program = Effect.gen(function* () {
			const db = yield* createPersistentEffectDatabase(resolvedConfig, {});

			// Get the collection (type assertion needed since we check collection existence above)
			const coll = db[collection as keyof typeof db] as {
				readonly update: (
					id: string,
					data: Record<string, unknown>,
				) => Effect.Effect<Record<string, unknown>, unknown>;
			};

			// Execute the update operation and force durable persistence before exit
			const updated = yield* coll.update(id, updateData);
			yield* Effect.promise(() => db.flush());

			return updated as Record<string, unknown>;
		});

		// Run the program with the persistence layer
		const result = yield* program.pipe(
			Effect.provide(PersistenceLayer),
			Effect.scoped,
			Effect.catchCause((cause) => {
				const message = getErrorMessage(Cause.squash(cause));
				return Effect.succeed({
					success: false as const,
					message: `Update failed: ${message}`,
				});
			}),
		);

		// Check if we got an error result
		if ("success" in result && result.success === false) {
			return result as UpdateResult;
		}

		// We got the updated entity
		const entity = result as Record<string, unknown>;
		return {
			success: true,
			data: entity,
		};
	});
}

/**
 * Handle the update command from CLI main.ts.
 * This is the entry point called by the command dispatcher.
 *
 * @param options - Update command options
 * @returns Promise that resolves to the update result
 */
export async function handleUpdate(
	options: UpdateOptions,
): Promise<UpdateResult> {
	return Effect.runPromise(runUpdate(options));
}
