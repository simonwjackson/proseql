/**
 * ProseQL CLI - Create Command
 *
 * Creates a new entity in a collection. Parses JSON data from --data flag,
 * calls create on the collection, and prints the created entity.
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

/**
 * Options for the create command.
 */
export interface CreateOptions {
	/** Name of the collection to create the entity in */
	readonly collection: string;
	/** The database configuration */
	readonly config: DatabaseConfig;
	/** The path to the config file (used for resolving relative file paths) */
	readonly configPath: string;
	/** JSON string containing the entity data */
	readonly data: string;
}

/**
 * Result of the create command.
 */
export interface CreateResult {
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
 * Parse JSON data string into an object.
 * Returns an error message if parsing fails.
 */
function parseJsonData(
	data: string,
):
	| { success: true; parsed: Record<string, unknown> }
	| { success: false; error: string } {
	try {
		const parsed = JSON.parse(data) as unknown;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return {
				success: false,
				error: "Data must be a JSON object, not an array or primitive",
			};
		}
		return { success: true, parsed: parsed as Record<string, unknown> };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { success: false, error: `Invalid JSON: ${message}` };
	}
}

/**
 * Execute the create command.
 *
 * Boots the database from the config, parses the JSON data,
 * and creates a new entity in the specified collection.
 *
 * @param options - Create command options
 * @returns Effect that resolves to the create result
 */
export function runCreate(
	options: CreateOptions,
): Effect.Effect<CreateResult, never> {
	return Effect.gen(function* () {
		const { collection, config, configPath, data } = options;

		// Check if collection exists in config
		if (getCliCollectionConfig(config, collection) === undefined) {
			const availableCollections = listCollectionNames(config).join(", ");
			return {
				success: false,
				message: `Collection '${collection}' not found in config. Available collections: ${availableCollections || "(none)"}`,
			};
		}

		// Parse the JSON data
		const parseResult = parseJsonData(data);
		if (!parseResult.success) {
			return {
				success: false,
				message: parseResult.error,
			};
		}
		const entityData = parseResult.parsed;

		// Resolve relative file paths in the config
		const resolvedConfig = resolveConfigPaths(config, configPath);

		// Build the persistence layer for database operations
		const PersistenceLayer = Layer.merge(NodeStorageLayer, AllTextFormatsLayer);

		// Boot the database and execute the create
		const program = Effect.gen(function* () {
			const db = yield* createPersistentEffectDatabase(resolvedConfig, {});

			// Get the collection (type assertion needed since we check collection existence above)
			const coll = db[collection as keyof typeof db] as {
				readonly create: (
					data: Record<string, unknown>,
				) => Effect.Effect<Record<string, unknown>, unknown>;
			};

			// Execute the create operation and force durable persistence before exit
			const created = yield* coll.create(entityData);
			yield* Effect.promise(() => db.flush());

			return created as Record<string, unknown>;
		});

		// Run the program with the persistence layer
		const result = yield* program.pipe(
			Effect.provide(PersistenceLayer),
			Effect.scoped,
			Effect.catchCause((cause) => {
				const message = getErrorMessage(Cause.squash(cause));
				return Effect.succeed({
					success: false as const,
					message: `Create failed: ${message}`,
				});
			}),
		);

		// Check if we got an error result
		if ("success" in result && result.success === false) {
			return result as CreateResult;
		}

		// We got the created entity
		const entity = result as Record<string, unknown>;
		return {
			success: true,
			data: entity,
		};
	});
}

/**
 * Handle the create command from CLI main.ts.
 * This is the entry point called by the command dispatcher.
 *
 * @param options - Create command options
 * @returns Promise that resolves to the create result
 */
export async function handleCreate(
	options: CreateOptions,
): Promise<CreateResult> {
	return Effect.runPromise(runCreate(options));
}
