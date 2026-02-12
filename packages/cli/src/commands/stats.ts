/**
 * ProseQL CLI - Stats Command
 *
 * Boots the database from config, reports per-collection entity count,
 * file size on disk, and serialization format.
 */

import * as fs from "node:fs";
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
import { Chunk, Effect, Layer, Stream } from "effect";

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
 * Determine the serialization format from a file path.
 * Returns the format based on the file extension.
 */
function getFormatFromFile(filePath: string | undefined): string {
	if (!filePath) {
		return "(in-memory)";
	}

	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case ".json":
			return "json";
		case ".jsonl":
			return "jsonl";
		case ".yaml":
		case ".yml":
			return "yaml";
		case ".toml":
			return "toml";
		case ".json5":
			return "json5";
		case ".jsonc":
			return "jsonc";
		case ".hjson":
			return "hjson";
		case ".toon":
			return "toon";
		default:
			return ext ? ext.slice(1) : "unknown";
	}
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
 * Format bytes into a human-readable string.
 */
function formatBytes(bytes: number): string {
	if (bytes === 0) {
		return "(in-memory)";
	}

	const units = ["B", "KB", "MB", "GB"];
	let unitIndex = 0;
	let size = bytes;

	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}

	// Use fixed precision for KB and above, no decimals for bytes
	if (unitIndex === 0) {
		return `${size} ${units[unitIndex]}`;
	}
	return `${size.toFixed(2)} ${units[unitIndex]}`;
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

		const collectionNames = Object.keys(config);

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
		const PersistenceLayer = Layer.merge(
			NodeStorageLayer,
			makeSerializerLayer([jsonCodec(), yamlCodec(), tomlCodec()]),
		);

		// Boot the database and gather collection stats
		const program = Effect.gen(function* () {
			const db = yield* createPersistentEffectDatabase(resolvedConfig, {});

			const results: CollectionStats[] = [];

			for (const name of collectionNames) {
				const collectionConfig = resolvedConfig[name];
				const filePath = collectionConfig?.file;

				// Get the collection (type assertion needed since we verify existence via config)
				const coll = db[name as keyof typeof db] as {
					readonly query: (
						options?: Record<string, unknown>,
					) => Stream.Stream<Record<string, unknown>, unknown, never>;
				};

				// Count entities by querying all and collecting
				const stream = coll.query();
				const chunk = yield* Stream.runCollect(stream);
				const count = Chunk.size(chunk);

				// Get format from file extension
				const format = getFormatFromFile(filePath);

				// Get file size on disk
				const sizeBytes = getFileSize(filePath);
				const size = formatBytes(sizeBytes);

				// Get relative file path for display (relative to config dir)
				const configDir = path.dirname(configPath);
				const displayPath = filePath
					? path.relative(configDir, filePath) || filePath
					: "(in-memory)";

				results.push({
					name,
					count,
					file: displayPath,
					format,
					size,
					sizeBytes,
				});
			}

			return results;
		});

		// Run the program with the persistence layer
		const result = yield* program.pipe(
			Effect.provide(PersistenceLayer),
			Effect.scoped,
			Effect.catchAll((error) => {
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
