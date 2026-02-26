/**
 * Enhanced database configuration types that support persistence options.
 * Extends the existing configuration to include optional file paths for collections.
 */

import type { Schema } from "effect";
import type { Migration } from "../migrations/migration-types.js";
import type { ComputedFieldsConfig } from "./computed-types.js";
import type { HooksConfig } from "./hook-types.js";

/**
 * Configuration for a single collection, now with optional persistence support.
 */
export type CollectionConfig = {
	/**
	 * Effect Schema for validating and encoding/decoding entities in this collection
	 */
	readonly schema: Schema.Schema.All;

	/**
	 * Optional file path for persisting this collection.
	 * If not provided, the collection will be in-memory only.
	 * Multiple collections can share the same file path.
	 * Mutually exclusive with `directory`.
	 */
	readonly file?: string;

	/**
	 * Optional directory path for directory-per-collection persistence.
	 * Each entity is stored as a separate file: `<directory>/<id>.<format>`.
	 * Requires `format` to be specified (no file extension to infer from).
	 * Mutually exclusive with `file`, `path`, and `appendOnly`.
	 */
	readonly directory?: string;

	/**
	 * Explicit serialization format override.
	 * When provided, this format is used instead of inferring from file extension.
	 * Value should match a codec's extension (e.g., "prose", "yaml", "json").
	 */
	readonly format?: string;

	/**
	 * Dot-notation path into the file where this collection's data lives.
	 * When provided, ProseQL navigates into the parsed document structure
	 * before applying normal collection loading logic.
	 *
	 * The resolved value can be either a Record keyed by entity ID or an
	 * array of entity objects (each must have an `id` field).
	 *
	 * On save, the existing file is read first and the collection data is
	 * set at the specified path, preserving sibling data.
	 *
	 * @example
	 * ```ts
	 * // Read from { agents: { list: [{ id: "a1", ... }] } }
	 * projects: {
	 *   schema: ProjectSchema,
	 *   file: "~/.config/app.json",
	 *   path: "agents.list",
	 *   relationships: {},
	 * }
	 * ```
	 */
	readonly path?: string;

	/**
	 * Relationship definitions for this collection
	 */
	readonly relationships: Record<
		string,
		{
			readonly type: "ref" | "inverse";
			readonly target: string;
			readonly foreignKey?: string;
		}
	>;

	/**
	 * Index definitions for this collection.
	 * Each entry can be a single field name (string) or an array of field names (compound index).
	 * Indexes accelerate equality queries on the specified fields.
	 */
	readonly indexes?: ReadonlyArray<string | ReadonlyArray<string>>;

	/**
	 * Lifecycle hooks for this collection.
	 * Hooks intercept CRUD operations for transformation, validation, or side effects.
	 * Before-hooks can transform data or reject operations.
	 * After-hooks and onChange run fire-and-forget after mutation.
	 */
	readonly hooks?: HooksConfig<unknown>;

	/**
	 * Schema version for this collection.
	 * When defined, the collection participates in schema migrations.
	 * The version number is stored in the persisted file as `_version`.
	 */
	readonly version?: number;

	/**
	 * Migration chain for this collection.
	 * Each migration transforms data from one version to the next.
	 * The chain must be contiguous: migrations[i].to === migrations[i].from + 1
	 * and the last migration's `to` must match the config `version`.
	 */
	readonly migrations?: ReadonlyArray<Migration>;

	/**
	 * Unique field constraints for this collection.
	 * Each entry can be a single field name (string) or an array of field names (compound unique constraint).
	 * Single strings are normalized to single-element arrays internally.
	 * Example: ["email", ["userId", "settingKey"]] means:
	 *   - "email" must be unique across all entities
	 *   - The combination of "userId" + "settingKey" must be unique
	 */
	readonly uniqueFields?: ReadonlyArray<string | ReadonlyArray<string>>;

	/**
	 * Computed field definitions for this collection.
	 * Computed fields are derived at query time from stored entity data.
	 * They are never persisted to disk - only materialized in the query pipeline.
	 *
	 * Each entry maps a field name to a derivation function.
	 * The function receives the entity (with populated relationships if applicable) and returns the computed value.
	 *
	 * @example
	 * ```ts
	 * computed: {
	 *   displayName: (book) => `${book.title} (${book.year})`,
	 *   isClassic: (book) => book.year < 1980,
	 * }
	 * ```
	 */
	readonly computed?: ComputedFieldsConfig<unknown>;

	/**
	 * Fields to include in the full-text search index for this collection.
	 * When specified, an inverted index is built and maintained for fast text search.
	 * Each entry should be the name of a string-typed field on the entity.
	 *
	 * Queries using `$search` will leverage this index when available for the queried fields.
	 * If not specified, `$search` queries will scan all entities (slower but still functional).
	 *
	 * @example
	 * ```ts
	 * searchIndex: ["title", "author", "description"]
	 * ```
	 */
	readonly searchIndex?: ReadonlyArray<string>;

	/**
	 * Name of an ID generator provided by a plugin.
	 * When specified and no `id` is provided during entity creation,
	 * the named generator is used to produce the ID.
	 *
	 * The generator must be registered by a plugin in the database options.
	 * At init time, validation ensures the named generator exists in the plugin registry.
	 *
	 * @example
	 * ```ts
	 * idGenerator: "snowflake"  // uses generator from a plugin
	 * ```
	 */
	readonly idGenerator?: string;

	/**
	 * When true, the collection uses an append-only persistence strategy.
	 * Each `create()` appends a single JSONL line to the file instead of rewriting it.
	 *
	 * Restrictions when append-only:
	 * - `update()`, `updateMany()`, `delete()`, `deleteMany()` fail with OperationError
	 * - The file should use a `.jsonl` extension
	 * - `flush()` writes a clean canonical JSONL file
	 *
	 * Useful for event logs and audit trails where data is only ever inserted.
	 *
	 * @example
	 * ```ts
	 * events: {
	 *   schema: EventSchema,
	 *   file: "./data/events.jsonl",
	 *   appendOnly: true,
	 *   relationships: {},
	 * }
	 * ```
	 */
	readonly appendOnly?: boolean;

	/**
	 * Validation mode for loading persisted data.
	 *
	 * - `"strict"` (default): Abort on the first entity that fails schema validation.
	 * - `"lenient"`: Skip invalid entities with warnings and load remaining valid data.
	 *   For JSONL files, warnings include 1-based line numbers.
	 */
	readonly validation?: "strict" | "lenient";
};

/**
 * Complete database configuration type that preserves literal types
 */
export type DatabaseConfig = Record<string, CollectionConfig>;

/**
 * Reactive query configuration options for the database.
 * Controls behavior of watch() and watchById() subscriptions.
 */
export interface ReactiveConfig {
	/**
	 * Debounce interval in milliseconds for change event processing.
	 * When multiple mutations occur in rapid succession, they are coalesced
	 * into a single re-evaluation after the debounce interval settles.
	 * Default: 10ms (fast enough for interactive use, long enough to batch bursts).
	 */
	readonly debounceMs?: number;
}

/**
 * Database-level options that include reactive query configuration.
 * Used by database factory functions to configure database-wide behavior.
 */
export interface DatabaseReactiveOptions {
	/**
	 * Reactive query configuration.
	 * Controls debouncing and other behavior of watch() and watchById() methods.
	 */
	readonly reactive?: ReactiveConfig;
}

/**
 * Type guard to check if a collection configuration includes persistence
 */
export function isCollectionPersistent(
	config: CollectionConfig,
): config is CollectionConfig & ({ file: string } | { directory: string }) {
	return (
		(typeof config.file === "string" && config.file.length > 0) ||
		(typeof config.directory === "string" && config.directory.length > 0)
	);
}

/**
 * Type guard to check if a collection uses directory-per-collection mode
 */
export function isCollectionDirectoryMode(
	config: CollectionConfig,
): config is CollectionConfig & { directory: string; format: string } {
	return typeof config.directory === "string" && config.directory.length > 0;
}

/**
 * Extract only the persistent collections from a database configuration
 */
export type PersistentCollections<Config extends DatabaseConfig> = {
	readonly [K in keyof Config]: Config[K] extends
		| { file: string }
		| { directory: string }
		? Config[K]
		: never;
};

/**
 * Extract only the in-memory collections from a database configuration
 */
export type InMemoryCollections<Config extends DatabaseConfig> = {
	readonly [K in keyof Config]: Config[K] extends { file?: undefined }
		? Config[K]
		: never;
};

/**
 * Helper type to extract file paths from a database configuration
 */
export type ExtractFilePaths<Config extends DatabaseConfig> = {
	readonly [K in keyof Config]: Config[K] extends { file: infer F } ? F : never;
}[keyof Config];

/**
 * Type for mapping file paths to the collections that use them
 */
export type FileToCollectionsMap<Config extends DatabaseConfig> = Map<
	ExtractFilePaths<Config> & string,
	Array<keyof Config & string>
>;
