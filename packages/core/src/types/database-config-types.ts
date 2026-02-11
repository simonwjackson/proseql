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
	 */
	readonly file?: string;

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
};

/**
 * Complete database configuration type that preserves literal types
 */
export type DatabaseConfig = Record<string, CollectionConfig>;

/**
 * Type guard to check if a collection configuration includes persistence
 */
export function isCollectionPersistent(
	config: CollectionConfig,
): config is CollectionConfig & { file: string } {
	return typeof config.file === "string" && config.file.length > 0;
}

/**
 * Extract only the persistent collections from a database configuration
 */
export type PersistentCollections<Config extends DatabaseConfig> = {
	readonly [K in keyof Config]: Config[K] extends { file: string }
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
