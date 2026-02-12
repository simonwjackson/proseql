/**
 * ProseQL CLI - Query Command
 *
 * Boots the database from config, resolves collection by name, and executes
 * queries with parsed where, select, sort, and limit options.
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
import { Chunk, Effect, Layer, Stream } from "effect";
import {
	type FilterParseError,
	parseFilters,
} from "../parsers/filter-parser.js";

/**
 * Options for the query command.
 */
export interface QueryOptions {
	/** Name of the collection to query */
	readonly collection: string;
	/** The database configuration */
	readonly config: DatabaseConfig;
	/** The path to the config file (used for resolving relative file paths) */
	readonly configPath: string;
	/** Filter expressions from --where flags */
	readonly where?: readonly string[];
	/** Comma-separated field list from --select flag */
	readonly select?: string;
	/** Sort expression from --sort flag (e.g., "year:desc") */
	readonly sort?: string;
	/** Limit from --limit flag */
	readonly limit?: number;
}

/**
 * Result of the query command.
 */
export interface QueryResult {
	readonly success: boolean;
	readonly message?: string;
	readonly data?: ReadonlyArray<Record<string, unknown>>;
	readonly count?: number;
}

/**
 * Parse the select string into a field array.
 * Comma-separated list of field names, e.g., "id,title,author"
 */
function parseSelect(select: string): ReadonlyArray<string> {
	return select
		.split(",")
		.map((field) => field.trim())
		.filter((field) => field.length > 0);
}

/**
 * Parse the sort string into a sort config object.
 * Format: "field:direction" where direction is "asc" or "desc"
 * Examples: "year:desc", "title:asc"
 */
function parseSort(sort: string): Record<string, "asc" | "desc"> | undefined {
	const parts = sort.split(":");
	if (parts.length !== 2) {
		return undefined;
	}
	const [field, direction] = parts;
	const trimmedField = field.trim();
	const trimmedDirection = direction.trim().toLowerCase();

	if (!trimmedField) {
		return undefined;
	}
	if (trimmedDirection !== "asc" && trimmedDirection !== "desc") {
		return undefined;
	}

	return { [trimmedField]: trimmedDirection };
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
 * Execute the query command.
 *
 * Boots the database from the config, resolves the collection by name,
 * and executes a query with the provided options.
 *
 * @param options - Query command options
 * @returns Result with queried data or error message
 */
export function runQuery(
	options: QueryOptions,
): Effect.Effect<QueryResult, FilterParseError> {
	return Effect.gen(function* () {
		const { collection, config, configPath, where, select, sort, limit } =
			options;

		// Check if collection exists in config
		if (!(collection in config)) {
			const availableCollections = Object.keys(config).join(", ");
			return {
				success: false,
				message: `Collection '${collection}' not found in config. Available collections: ${availableCollections || "(none)"}`,
			};
		}

		// Parse filter expressions from --where flags
		const whereClause =
			where && where.length > 0 ? yield* parseFilters(where) : undefined;

		// Parse select fields
		const selectFields = select ? parseSelect(select) : undefined;

		// Parse sort
		const sortConfig = sort ? parseSort(sort) : undefined;

		if (sort && !sortConfig) {
			return {
				success: false,
				message: `Invalid sort format: '${sort}'. Expected format: 'field:asc' or 'field:desc'`,
			};
		}

		// Resolve relative file paths in the config
		const resolvedConfig = resolveConfigPaths(config, configPath);

		// Build the persistence layer for database operations
		const PersistenceLayer = Layer.merge(
			NodeStorageLayer,
			makeSerializerLayer([jsonCodec(), yamlCodec(), tomlCodec()]),
		);

		// Boot the database and execute the query
		const program = Effect.gen(function* () {
			const db = yield* createPersistentEffectDatabase(resolvedConfig, {});

			// Get the collection (type assertion needed since we check collection existence above)
			const coll = db[collection as keyof typeof db] as {
				readonly query: (options?: {
					readonly where?: Record<string, unknown>;
					readonly select?: ReadonlyArray<string>;
					readonly sort?: Record<string, "asc" | "desc">;
					readonly limit?: number;
				}) => Stream.Stream<Record<string, unknown>, unknown, never> & {
					readonly runPromise: Promise<ReadonlyArray<Record<string, unknown>>>;
				};
			};

			// Execute the query
			const queryOptions: {
				where?: Record<string, unknown>;
				select?: ReadonlyArray<string>;
				sort?: Record<string, "asc" | "desc">;
				limit?: number;
			} = {};

			if (whereClause && Object.keys(whereClause).length > 0) {
				queryOptions.where = whereClause;
			}
			if (selectFields && selectFields.length > 0) {
				queryOptions.select = selectFields;
			}
			if (sortConfig) {
				queryOptions.sort = sortConfig;
			}
			if (limit !== undefined && limit > 0) {
				queryOptions.limit = limit;
			}

			// Execute the query and collect results
			const stream = coll.query(
				Object.keys(queryOptions).length > 0 ? queryOptions : undefined,
			);

			// Collect the stream into an array
			const chunk = yield* Stream.runCollect(stream);
			const results = Chunk.toReadonlyArray(chunk) as ReadonlyArray<
				Record<string, unknown>
			>;

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
					message: `Query failed: ${message}`,
				});
			}),
		);

		// Check if we got an error result
		if ("success" in result && result.success === false) {
			return result as QueryResult;
		}

		// We got data
		const data = result as ReadonlyArray<Record<string, unknown>>;
		return {
			success: true,
			data,
			count: data.length,
		};
	});
}

/**
 * Handle the query command from CLI main.ts.
 * This is the entry point called by the command dispatcher.
 *
 * @param options - Query command options
 * @returns Promise that resolves to the query results or rejects on error
 */
export async function handleQuery(options: QueryOptions): Promise<QueryResult> {
	const result = await Effect.runPromise(
		runQuery(options).pipe(
			Effect.catchTag("FilterParseError", (error) =>
				Effect.succeed({
					success: false as const,
					message: error.message,
				}),
			),
		),
	);

	return result;
}
