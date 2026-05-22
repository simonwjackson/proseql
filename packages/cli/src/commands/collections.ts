/**
 * ProseQL CLI - Collections Command
 *
 * Boots the database from config, lists all collection names with entity count,
 * file path, and serialization format.
 */

import {
	AllTextFormatsLayer,
	createPersistentEffectDatabase,
	type DatabaseConfig,
	NodeStorageLayer,
} from "@proseql/node";
import { Effect, Layer, Stream } from "effect";
import {
	getCollectionPersistenceInfo,
	listCollectionNames,
	resolveConfigPaths,
} from "../config/paths.js";

/**
 * Options for the collections command.
 */
export interface CollectionsOptions {
	/** The database configuration */
	readonly config: DatabaseConfig;
	/** The path to the config file (used for resolving relative file paths) */
	readonly configPath: string;
}

/**
 * Information about a single collection.
 */
export interface CollectionInfo {
	readonly name: string;
	readonly count: number;
	readonly file: string;
	readonly format: string;
}

/**
 * Result of the collections command.
 */
export interface CollectionsResult {
	readonly success: boolean;
	readonly message?: string;
	readonly data?: ReadonlyArray<CollectionInfo>;
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
		const { config, configPath } = options;

		const collectionNames = listCollectionNames(config);

		if (collectionNames.length === 0) {
			return {
				success: true,
				data: [],
				message: "No collections configured",
			};
		}

		// Resolve relative file paths in the config
		const resolvedConfig = resolveConfigPaths(config, configPath);

		// Build the persistence layer for database operations
		const PersistenceLayer = Layer.merge(NodeStorageLayer, AllTextFormatsLayer);

		// Boot the database and gather collection info
		const program = Effect.gen(function* () {
			const db = yield* createPersistentEffectDatabase(resolvedConfig, {});

			const results: CollectionInfo[] = [];

			for (const name of collectionNames) {
				// Get the collection (type assertion needed since we verify existence via config)
				const coll = db[name as keyof typeof db] as {
					readonly query: (
						options?: Record<string, unknown>,
					) => Stream.Stream<Record<string, unknown>, unknown, never>;
				};

				// Count entities by querying all and collecting
				const stream = coll.query();
				const records = yield* Stream.runCollect(stream);
				const count = records.length;

				const persistence = getCollectionPersistenceInfo(
					resolvedConfig,
					name,
					configPath,
					() => 0,
				);

				results.push({
					name,
					count,
					file: persistence.file,
					format: persistence.format,
				});
			}

			return results;
		});

		// Run the program with the persistence layer
		const result = yield* program.pipe(
			Effect.provide(PersistenceLayer),
			Effect.scoped,
			Effect.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				return Effect.succeed({
					success: false as const,
					message: `Failed to list collections: ${message}`,
				});
			}),
		);

		// Check if we got an error result
		if ("success" in result && result.success === false) {
			return result as CollectionsResult;
		}

		// We got data
		const data = result as ReadonlyArray<CollectionInfo>;
		return {
			success: true,
			data,
		};
	});
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
	const result = await Effect.runPromise(runCollections(options));
	return result;
}
