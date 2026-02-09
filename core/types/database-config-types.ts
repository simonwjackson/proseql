/**
 * Enhanced database configuration types that support persistence options.
 * Extends the existing configuration to include optional file paths for collections.
 */

import type { z } from "zod";
import type { StorageAdapter } from "../storage/types.js";
import type { SerializerRegistry } from "../serializers/types.js";

/**
 * Configuration for a single collection, now with optional persistence support.
 */
export type CollectionConfig = {
	/**
	 * Zod schema for validating entities in this collection
	 */
	readonly schema: z.ZodType<unknown>;

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
};

/**
 * Complete database configuration type that preserves literal types
 */
export type DatabaseConfig = Record<string, CollectionConfig>;

/**
 * Options for database persistence functionality
 */
export type PersistenceOptions = {
	/**
	 * Storage adapter for file operations
	 */
	readonly adapter: StorageAdapter;

	/**
	 * Registry of serializers for different file formats
	 */
	readonly serializerRegistry: SerializerRegistry;

	/**
	 * Debounce delay for write operations in milliseconds (default: 100)
	 */
	readonly writeDebounce?: number;

	/**
	 * Whether to watch files for external changes and reload data
	 */
	readonly watchFiles?: boolean;

	/**
	 * Callback for handling file change events
	 */
	readonly onFileChange?: (filePath: string) => void;
};

/**
 * Complete options for creating a database with optional persistence
 */
export type DatabaseOptions = {
	/**
	 * Persistence configuration. If not provided, database will be in-memory only.
	 */
	readonly persistence?: PersistenceOptions;

	/**
	 * Whether to validate all data against schemas on startup (default: false)
	 */
	readonly validateOnStartup?: boolean;

	/**
	 * Custom ID generator function (default: uses built-in generator)
	 */
	readonly generateId?: () => string;
};

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
