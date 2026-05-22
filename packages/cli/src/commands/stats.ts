/**
 * ProseQL CLI - Stats Command
 *
 * Boots the database from config, reports per-collection entity count,
 * file size on disk, and serialization format.
 */

import * as fs from "node:fs";
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
 * Options for the stats command.
 */
export interface StatsOptions {
	/** The database configuration */
	readonly config: DatabaseConfig;
	/** The path to the config file (used for resolving relative file paths) */
	readonly configPath: string;
}

/**
 * Statistics for a single collection.
 */
export interface CollectionStats {
	readonly name: string;
	readonly count: number;
	readonly file: string;
	readonly format: string;
	readonly size: string;
	readonly sizeBytes: number;
}

/**
 * Result of the stats command.
 */
export interface StatsResult {
	readonly success: boolean;
	readonly message?: string;
	readonly data?: ReadonlyArray<CollectionStats>;
}

/**
 * Get the file size on disk.
 * Returns the size in bytes, or 0 if the file doesn't exist or path is undefined.
 */
function getFileSize(filePath: string | undefined): number {
	if (!filePath) {
		return 0;
	}

	try {
		const stat = fs.statSync(filePath);
		return stat.size;
	} catch {
		// File doesn't exist or can't be read
		return 0;
	}
}

/**
 * Execute the stats command.
 *
 * Boots the database from the config, and reports statistics for all collections
 * including entity counts, file sizes, and serialization formats.
 *
 * @param options - Stats command options
 * @returns Result with collection statistics or error message
 */
export function runStats(options: StatsOptions): Effect.Effect<StatsResult> {
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

		// Boot the database and gather collection stats
		const program = Effect.gen(function* () {
			const db = yield* createPersistentEffectDatabase(resolvedConfig, {});

			const results: CollectionStats[] = [];

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
					getFileSize,
				);

				results.push({
					name,
					count,
					file: persistence.file,
					format: persistence.format,
					size: persistence.sizeLabel,
					sizeBytes: persistence.sizeBytes,
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
					message: `Failed to get collection stats: ${message}`,
				});
			}),
		);

		// Check if we got an error result
		if ("success" in result && result.success === false) {
			return result as StatsResult;
		}

		// We got data
		const data = result as ReadonlyArray<CollectionStats>;
		return {
			success: true,
			data,
		};
	});
}

/**
 * Handle the stats command from CLI main.ts.
 * This is the entry point called by the command dispatcher.
 *
 * @param options - Stats command options
 * @returns Promise that resolves to the stats result or rejects on error
 */
export async function handleStats(options: StatsOptions): Promise<StatsResult> {
	const result = await Effect.runPromise(runStats(options));
	return result;
}
