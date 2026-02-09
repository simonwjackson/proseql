/**
 * Data transformation utilities for converting between internal formats
 * (ReadonlyMap and array) and storage object format, plus collection
 * file grouping utilities.
 */

/**
 * Convert an array of entities with id fields to an object keyed by id.
 * This provides O(1) lookups in storage files.
 *
 * @param items - Array of entities, each must have an 'id' field
 * @returns Object keyed by entity id
 *
 * @example
 * arrayToObject([
 *   { id: 'user-1', name: 'Alice' },
 *   { id: 'user-2', name: 'Bob' }
 * ])
 * // Returns: {
 * //   'user-1': { id: 'user-1', name: 'Alice' },
 * //   'user-2': { id: 'user-2', name: 'Bob' }
 * // }
 */
export function arrayToObject<T extends { id: string }>(
	items: readonly T[],
): Record<string, T> {
	const result: Record<string, T> = {};

	for (const item of items) {
		if (typeof item.id !== "string") {
			throw new Error(
				`Invalid entity: id must be a string, got ${typeof item.id}`,
			);
		}
		result[item.id] = item;
	}

	return result;
}

/**
 * Convert an object keyed by id back to an array of entities.
 *
 * @param obj - Object keyed by entity id
 * @returns Array of entities
 *
 * @example
 * objectToArray({
 *   'user-1': { id: 'user-1', name: 'Alice' },
 *   'user-2': { id: 'user-2', name: 'Bob' }
 * })
 * // Returns: [
 * //   { id: 'user-1', name: 'Alice' },
 * //   { id: 'user-2', name: 'Bob' }
 * // ]
 */
export function objectToArray<T>(obj: Record<string, T>): T[] {
	return Object.values(obj);
}

/**
 * Collection configuration that may include a file path for persistence
 */
type CollectionConfig = {
	readonly file?: string;
	readonly [key: string]: unknown;
};

/**
 * Group collections by their configured file paths.
 * Collections without a file path are not included in the result.
 *
 * @param config - Database configuration with collection definitions
 * @returns Map from file path to array of collection names that use that file
 *
 * @example
 * groupByFile({
 *   users: { schema: UserSchema, file: '/data/users.json' },
 *   products: { schema: ProductSchema, file: '/data/db.json' },
 *   categories: { schema: CategorySchema, file: '/data/db.json' },
 *   sessions: { schema: SessionSchema } // no file = in-memory only
 * })
 * // Returns: Map {
 * //   '/data/users.json' => ['users'],
 * //   '/data/db.json' => ['products', 'categories']
 * // }
 */
export function groupByFile<Config extends Record<string, CollectionConfig>>(
	config: Config,
): Map<string, string[]> {
	const fileGroups = new Map<string, string[]>();

	for (const [collectionName, collectionConfig] of Object.entries(config)) {
		const filePath = collectionConfig.file;

		if (filePath && typeof filePath === "string") {
			const existingCollections = fileGroups.get(filePath) ?? [];
			existingCollections.push(collectionName);
			fileGroups.set(filePath, existingCollections);
		}
	}

	return fileGroups;
}

/**
 * Get all unique file paths from a database configuration.
 *
 * @param config - Database configuration with collection definitions
 * @returns Array of unique file paths used by collections
 */
export function getConfigFilePaths<
	Config extends Record<string, CollectionConfig>,
>(config: Config): string[] {
	const filePaths = new Set<string>();

	for (const collectionConfig of Object.values(config)) {
		if (collectionConfig.file && typeof collectionConfig.file === "string") {
			filePaths.add(collectionConfig.file);
		}
	}

	return Array.from(filePaths);
}

/**
 * Check if a collection is configured for persistence.
 *
 * @param config - Database configuration
 * @param collectionName - Name of the collection to check
 * @returns True if the collection has a file path configured
 */
export function isCollectionPersistent<
	Config extends Record<string, CollectionConfig>,
>(config: Config, collectionName: keyof Config): boolean {
	const collectionConfig = config[collectionName];
	return !!(
		collectionConfig?.file && typeof collectionConfig.file === "string"
	);
}

/**
 * Extract collections that should be stored in a specific file.
 *
 * @param data - Full dataset with all collections
 * @param collectionsForFile - Array of collection names to extract
 * @returns Object containing only the specified collections in object format
 */
export function extractCollectionsForFile<T extends Record<string, unknown[]>>(
	data: T,
	collectionsForFile: readonly string[],
): Record<string, Record<string, unknown>> {
	const result: Record<string, Record<string, unknown>> = {};

	for (const collectionName of collectionsForFile) {
		const collectionData = data[collectionName];

		if (Array.isArray(collectionData)) {
			// Validate that all items have string id fields
			const validItems = collectionData.filter(
				(item): item is { id: string } & Record<string, unknown> => {
					return (
						typeof item === "object" &&
						item !== null &&
						"id" in item &&
						typeof item.id === "string"
					);
				},
			);

			result[collectionName] = arrayToObject(validItems);
		}
	}

	return result;
}

/**
 * Merge file data back into the main dataset.
 * Converts object format back to array format for each collection.
 *
 * @param data - Current dataset to update
 * @param fileData - Data loaded from file (in object format)
 * @param collectionsFromFile - Array of collection names to update
 * @returns Updated dataset with arrays
 */
export function mergeFileDataIntoDataset<T extends Record<string, unknown[]>>(
	data: T,
	fileData: Record<string, Record<string, unknown>>,
	collectionsFromFile: readonly string[],
): T {
	const result = { ...data };

	for (const collectionName of collectionsFromFile) {
		const collectionFileData = fileData[collectionName];

		if (collectionFileData && typeof collectionFileData === "object") {
			// Convert back to array format
			const arrayData = objectToArray(collectionFileData);

			// Type-safe assignment using index signature constraint
			if (collectionName in result) {
				(result as Record<string, unknown[]>)[collectionName] = arrayData;
			}
		}
	}

	return result;
}

// ============================================================================
// ReadonlyMap-aware transforms (Effect migration)
// ============================================================================

/**
 * Convert an array of entities to a ReadonlyMap keyed by entity ID.
 *
 * @param items - Array of entities, each must have an 'id' field
 * @returns ReadonlyMap keyed by entity id
 *
 * @example
 * arrayToMap([
 *   { id: 'user-1', name: 'Alice' },
 *   { id: 'user-2', name: 'Bob' }
 * ])
 * // Returns: Map { 'user-1' => { id: 'user-1', name: 'Alice' }, 'user-2' => { id: 'user-2', name: 'Bob' } }
 */
export function arrayToMap<T extends { readonly id: string }>(
	items: readonly T[],
): ReadonlyMap<string, T> {
	return new Map(items.map((item) => [item.id, item]))
}

/**
 * Convert a ReadonlyMap to a Record keyed by entity ID (the on-disk object format).
 *
 * @param map - ReadonlyMap of entities keyed by ID
 * @returns Record keyed by entity id
 *
 * @example
 * mapToObject(new Map([
 *   ['user-1', { id: 'user-1', name: 'Alice' }],
 *   ['user-2', { id: 'user-2', name: 'Bob' }],
 * ]))
 * // Returns: { 'user-1': { id: 'user-1', name: 'Alice' }, 'user-2': { id: 'user-2', name: 'Bob' } }
 */
export function mapToObject<T>(
	map: ReadonlyMap<string, T>,
): Record<string, T> {
	const result: Record<string, T> = {}
	for (const [key, value] of map) {
		result[key] = value
	}
	return result
}

/**
 * Convert a Record keyed by entity ID to a ReadonlyMap.
 * Inverse of mapToObject.
 *
 * @param obj - Record keyed by entity id
 * @returns ReadonlyMap keyed by entity id
 *
 * @example
 * objectToMap({
 *   'user-1': { id: 'user-1', name: 'Alice' },
 *   'user-2': { id: 'user-2', name: 'Bob' },
 * })
 * // Returns: Map { 'user-1' => { id: 'user-1', name: 'Alice' }, 'user-2' => { id: 'user-2', name: 'Bob' } }
 */
export function objectToMap<T>(
	obj: Readonly<Record<string, T>>,
): ReadonlyMap<string, T> {
	return new Map(Object.entries(obj))
}

/**
 * Convert a ReadonlyMap to an array of its values.
 *
 * @param map - ReadonlyMap of entities
 * @returns Array of entity values
 */
export function mapToArray<T>(map: ReadonlyMap<string, T>): readonly T[] {
	return Array.from(map.values())
}

/**
 * Extract collections from ReadonlyMap-based state for file storage.
 *
 * Takes a Record of collection name → ReadonlyMap and a list of collection
 * names to include, returning nested Record format suitable for serialization.
 *
 * @param stateMaps - Record mapping collection names to their ReadonlyMap state
 * @param collectionsForFile - Collection names to extract
 * @returns Nested Record: { collectionName: { id: entity, ... }, ... }
 */
export function extractCollectionsFromMaps<T extends { readonly id: string }>(
	stateMaps: Readonly<Record<string, ReadonlyMap<string, T>>>,
	collectionsForFile: readonly string[],
): Record<string, Record<string, T>> {
	const result: Record<string, Record<string, T>> = {}

	for (const collectionName of collectionsForFile) {
		const collectionMap = stateMaps[collectionName]
		if (collectionMap !== undefined) {
			result[collectionName] = mapToObject(collectionMap)
		}
	}

	return result
}

/**
 * Merge file data (nested Record format) back into ReadonlyMap-based state.
 *
 * Takes existing state maps, file data in Record format, and collection names,
 * returning updated state maps with the file data merged in.
 *
 * @param stateMaps - Current state: Record of collection name → ReadonlyMap
 * @param fileData - Data from file: { collectionName: { id: entity, ... }, ... }
 * @param collectionsFromFile - Collection names to update from file data
 * @returns Updated state maps
 */
export function mergeFileDataIntoMaps<T extends { readonly id: string }>(
	stateMaps: Readonly<Record<string, ReadonlyMap<string, T>>>,
	fileData: Readonly<Record<string, Readonly<Record<string, T>>>>,
	collectionsFromFile: readonly string[],
): Record<string, ReadonlyMap<string, T>> {
	const result: Record<string, ReadonlyMap<string, T>> = { ...stateMaps }

	for (const collectionName of collectionsFromFile) {
		const collectionFileData = fileData[collectionName]
		if (collectionFileData !== undefined) {
			result[collectionName] = objectToMap(collectionFileData)
		}
	}

	return result
}
