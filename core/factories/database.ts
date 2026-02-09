import type { z } from "zod";
import type {
	GenerateDatabase,
	DatasetFor,
	SortOrder,
	SelectConfig,
	SmartCollection,
	ExtractEntityTypes,
	ResolveRelationships,
	RelationshipDef,
	QueryConfig,
	WhereClause,
	QueryReturnType,
} from "../types/types.js";
import type {
	DatabaseConfig,
	DatabaseOptions,
	PersistenceOptions,
} from "../types/database-config-types.js";
import { isValidWhereClause, filterData } from "../operations/query/filter.js";
import { populateRelationships } from "../operations/relationships/populate.js";
import type { PopulateValue } from "../operations/relationships/populate.js";
import { sortData } from "../operations/query/sort.js";
import { applyObjectSelection } from "../operations/query/select.js";
import { createCrudMethodsWithRelationships } from "./crud-factory-with-relationships.js";
import type { CrudMethodsWithRelationships } from "./crud-factory-with-relationships.js";
import { withToArray } from "../operations/query/query-helpers.js";
import type { MinimalEntity } from "../types/crud-types.js";

// Type guards for safe type checking
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPopulateConfigValue(
	value: unknown,
): value is Record<string, PopulateValue> {
	return isRecord(value);
}

function isSelectConfigValue(value: unknown): value is Record<string, unknown> {
	return isRecord(value);
}
import {
	createPersistenceContext,
	loadData,
	saveData,
	saveDataImmediate,
	watchFile,
	type PersistenceContext,
} from "../storage/persistence.js";
import {
	groupByFile,
	extractCollectionsForFile,
	mergeFileDataIntoDataset,
	getConfigFilePaths,
} from "../storage/transforms.js";
import { validateFileExtensions } from "../utils/file-extensions.js";

// Helper function to extract populate configuration from object-based select
function extractPopulateFromSelect(
	select: Record<string, unknown>,
	relationships: Record<
		string,
		{ type: "ref" | "inverse"; target: string; foreignKey?: string }
	>,
): Record<string, PopulateValue> {
	const populate: Record<string, PopulateValue> = {};

	for (const [key, value] of Object.entries(select)) {
		if (key in relationships) {
			if (value === true) {
				// This is a relationship field with full population
				populate[key] = true;
			} else if (
				typeof value === "object" &&
				value !== null &&
				!Array.isArray(value)
			) {
				// This is a relationship field with nested selection
				populate[key] = { select: value, ...value };
			}
		}
	}

	return populate;
}

// Type constraint for config to ensure literal types are preserved
type LegacyDatabaseConfig = Record<
	string,
	{
		schema: z.ZodType<unknown>;
		relationships: Record<
			string,
			{ type: "ref" | "inverse"; target: string; foreignKey?: string }
		>;
	}
>;

// ============================================================================
// Type-Safe Database Builder
// ============================================================================

/**
 * Type-safe builder for constructing databases with full TypeScript inference
 * Replaces dynamic object construction to preserve types through the build process
 * Now supports persistence with optional file-based storage
 */
class DatabaseBuilder<Config extends DatabaseConfig> {
	private collections = new Map<
		keyof Config,
		SmartCollection<
			unknown,
			Record<string, RelationshipDef<unknown, "ref" | "inverse", string>>,
			GenerateDatabase<Config>
		> &
			CrudMethodsWithRelationships<
				MinimalEntity,
				Record<string, RelationshipDef<unknown, "ref" | "inverse", string>>,
				GenerateDatabase<Config>
			>
	>();

	constructor(
		private config: Config,
		private data: DatasetFor<Config>,
		private persistenceContext?: PersistenceContext,
		private fileWatchers: Map<string, () => void> = new Map(),
	) {}

	/**
	 * Add a collection with full type preservation
	 */
	addCollection(
		name: keyof Config,
		collection: SmartCollection<
			unknown,
			Record<string, RelationshipDef<unknown, "ref" | "inverse", string>>,
			GenerateDatabase<Config>
		> &
			CrudMethodsWithRelationships<
				MinimalEntity,
				Record<string, RelationshipDef<unknown, "ref" | "inverse", string>>,
				GenerateDatabase<Config>
			>,
	): this {
		this.collections.set(name, collection);
		return this;
	}

	/**
	 * Build the final database with complete type safety
	 */
	build(): GenerateDatabase<Config> {
		const result: Record<string, unknown> = {};

		for (const [name, collection] of Array.from(this.collections.entries())) {
			result[name as string] = collection;
		}

		return result as GenerateDatabase<Config>;
	}

	/**
	 * Wrap CRUD methods with persistence hooks
	 */
	private wrapWithPersistence<T>(
		crudMethods: T,
		collectionName: keyof Config,
	): T {
		const saveAfterMutation = async () => {
			await this.saveCollectionData(collectionName);
		};

		// Helper to wrap any async method
		const wrapMethod = (methodName: string, originalMethod: unknown) => {
			if (typeof originalMethod === "function") {
				return async (...args: unknown[]) => {
					const result = await (
						originalMethod as (...args: unknown[]) => Promise<unknown>
					)(...args);
					await saveAfterMutation();
					return result;
				};
			}
			return originalMethod;
		};

		// List of mutation methods that need persistence hooks
		const mutationMethods = [
			"create",
			"createMany",
			"update",
			"updateMany",
			"delete",
			"deleteMany",
			"upsert",
			"upsertMany",
			"createWithRelationships",
			"updateWithRelationships",
			"deleteWithRelationships",
			"deleteManyWithRelationships",
		];

		const wrapped: Record<string, unknown> = {
			...(crudMethods as Record<string, unknown>),
		};
		for (const methodName of mutationMethods) {
			if (methodName in wrapped) {
				wrapped[methodName] = wrapMethod(methodName, wrapped[methodName]);
			}
		}

		return wrapped as T;
	}

	/**
	 * Create a typed collection for the given configuration
	 */
	private createTypedCollection<K extends keyof Config>(
		collectionName: K,
	): GenerateDatabase<Config>[K] {
		const def = this.config[collectionName];

		// Capture data and config in method scope for use in inner functions
		const data = this.data;
		const config = this.config;

		// Type aliases for clarity
		type EntityType = Config[K] extends { schema: z.ZodType<infer Entity> }
			? Entity
			: never;
		type RelationsType = Config[K] extends { relationships: infer Relations }
			? ResolveRelationships<Relations, ExtractEntityTypes<Config>>
			: Record<string, never>;
		type DBType = GenerateDatabase<Config>;

		// Create a query function that properly implements the generic signature
		const queryFunction = function query<
			C extends QueryConfig<EntityType, RelationsType, DBType> = {
				where?: WhereClause<EntityType, RelationsType, DBType>;
			},
		>(options?: C): QueryReturnType<EntityType, RelationsType, C, DBType> {
			async function* generate(): AsyncGenerator<unknown, void, unknown> {
				// Get the raw data for this collection
				// Safely access collection data with proper type checking
				if (!isRecord(data)) {
					return;
				}
				const rawCollectionData = data[collectionName as string];
				if (!Array.isArray(rawCollectionData)) {
					return;
				}

				// Filter out non-object items from the array
				const collectionData = rawCollectionData.filter(
					(item): item is Record<string, unknown> => isValidWhereClause(item),
				);

				// Apply filtering
				const allDataRecord: Record<string, unknown[]> = {};
				if (isRecord(data)) {
					for (const [key, value] of Object.entries(data)) {
						if (Array.isArray(value)) {
							allDataRecord[key] = value;
						}
					}
				}
				const filteredData = filterData(
					collectionData,
					options?.where,
					allDataRecord,
					def.relationships,
					collectionName as string,
					config,
				);

				// Determine populate configuration
				let populateConfig: Record<string, PopulateValue> | undefined;

				// Check if options has populate property
				if (
					options &&
					"populate" in options &&
					isPopulateConfigValue(options.populate)
				) {
					populateConfig = options.populate;
				}

				// If using object-based select, extract populate configuration from it
				if (
					options?.select &&
					!Array.isArray(options.select) &&
					!populateConfig &&
					isSelectConfigValue(options.select)
				) {
					populateConfig = extractPopulateFromSelect(
						options.select,
						def.relationships,
					);
				}

				// Apply population
				const populatedData = populateRelationships(
					filteredData,
					populateConfig,
					allDataRecord,
					def.relationships,
					collectionName as string,
					config,
				);

				// Apply sorting
				const sortedData = sortData(populatedData, options?.sort);

				// Apply offset and limit
				// Handle negative values as 0 and floor fractional values
				let itemsToSkip = Math.max(0, Math.floor(options?.offset ?? 0));
				let itemsYielded = 0;
				const limit = Math.max(0, Math.floor(options?.limit ?? Infinity));

				// Yield each item
				for (const item of sortedData) {
					if (itemsToSkip > 0) {
						itemsToSkip--;
						continue;
					}

					if (itemsYielded >= limit) {
						break;
					}

					// Apply field selection if specified
					let finalItem = item;

					if (options?.select) {
						if (Array.isArray(options.select)) {
							// Array-based selection - convert to object format
							const objectSelect: Record<string, boolean> = {};
							for (const field of options.select) {
								if (typeof field === "string") {
									objectSelect[field] = true;
								}
							}
							const selectedItem = applyObjectSelection(item, objectSelect);

							// If populate was used, preserve populated fields
							if (populateConfig) {
								// Merge selected fields with populated fields
								finalItem = { ...selectedItem };

								// Add any populated fields that exist in the item
								for (const populateKey of Object.keys(populateConfig)) {
									if (
										populateKey in item &&
										isRecord(finalItem) &&
										isRecord(item)
									) {
										finalItem[populateKey] = item[populateKey];
									}
								}
							} else {
								finalItem = selectedItem;
							}
						} else if (isSelectConfigValue(options.select)) {
							// Object-based selection - apply directly as population was handled earlier
							finalItem = applyObjectSelection(item, options.select);
						}
					}

					yield finalItem;
					itemsYielded++;
				}
			}
			// TypeScript cannot infer that our AsyncGenerator matches QueryReturnType
			// because QueryReturnType uses complex conditional types based on the config.
			// This double assertion is necessary due to TypeScript's limitations with conditional types.
			// It is safe because we've implemented the logic to match the expected behavior.
			// Add toArray helper method
			return withToArray(generate()) as unknown as QueryReturnType<
				EntityType,
				RelationsType,
				C,
				DBType
			>;
		};

		// Transform relationships to RelationshipDef format
		const transformedRelationships: Record<
			string,
			RelationshipDef<unknown, "ref" | "inverse", string>
		> = {};
		for (const [key, rel] of Object.entries(def.relationships)) {
			const relDef: RelationshipDef<unknown, "ref" | "inverse", string> = {
				type: rel.type,
			};
			if (rel.foreignKey !== undefined) {
				relDef.foreignKey = rel.foreignKey;
			}
			if (rel.target !== undefined) {
				relDef.target = rel.target;
				relDef.__targetCollection = rel.target;
			}
			transformedRelationships[key] = relDef;
		}

		// Transform config to have RelationshipDef format
		const transformedConfig: Record<
			string,
			{
				schema: z.ZodType<unknown>;
				relationships: Record<
					string,
					RelationshipDef<unknown, "ref" | "inverse", string>
				>;
			}
		> = {};
		for (const [collName, collDef] of Object.entries(config)) {
			const transformedRels: Record<
				string,
				RelationshipDef<unknown, "ref" | "inverse", string>
			> = {};
			for (const [relKey, relDef] of Object.entries(collDef.relationships)) {
				const rel: RelationshipDef<unknown, "ref" | "inverse", string> = {
					type: relDef.type,
				};
				if (relDef.foreignKey !== undefined) {
					rel.foreignKey = relDef.foreignKey;
				}
				if (relDef.target !== undefined) {
					rel.target = relDef.target;
					rel.__targetCollection = relDef.target;
				}
				transformedRels[relKey] = rel;
			}
			transformedConfig[collName] = {
				schema: collDef.schema,
				relationships: transformedRels,
			};
		}

		// Create CRUD methods with relationship support
		// Since isBaseEntitySchema always returns true, we always add CRUD methods
		const baseCrudMethods = createCrudMethodsWithRelationships(
			collectionName as string,
			def.schema as z.ZodType<EntityType & MinimalEntity>,
			transformedRelationships,
			data as Record<string, unknown[]>,
			transformedConfig,
		) as unknown as CrudMethodsWithRelationships<
			EntityType & MinimalEntity,
			RelationsType,
			DBType
		>;

		// Wrap CRUD methods with persistence hooks if persistence is enabled
		const crudMethods =
			this.persistenceContext && def.file
				? this.wrapWithPersistence(baseCrudMethods, collectionName)
				: baseCrudMethods;

		// Create the collection with query and CRUD methods
		const collection = {
			query: queryFunction,
			...crudMethods,
		};

		// TypeScript cannot verify that our implementation matches the complex conditional
		// types in GenerateDatabase<Config>[K]. This is a known limitation when working
		// with mapped types and conditional types. The double assertion through unknown
		// is necessary here and is safe because we've constructed the object to match
		// the expected SmartCollection structure with all required methods.
		return collection as unknown as GenerateDatabase<Config>[K];
	}

	/**
	 * Load data from all configured files and merge with existing data
	 */
	async loadAllData(): Promise<void> {
		if (!this.persistenceContext) {
			return; // No persistence configured
		}

		const fileGroups = groupByFile(this.config);

		for (const [filePath, collectionNames] of Array.from(
			fileGroups.entries(),
		)) {
			try {
				const fileData = await loadData(this.persistenceContext, filePath);
				// loadData already returns Record<string, unknown>, but we need to validate it's the right shape
				if (isRecord(fileData)) {
					// Type assertion here is safe because we've validated the structure
					const typedFileData = fileData as Record<
						string,
						Record<string, unknown>
					>;
					this.data = mergeFileDataIntoDataset(
						this.data,
						typedFileData,
						collectionNames,
					);
				}
			} catch (error) {
				// Log error but continue with other files
				console.error(`Failed to load data from ${filePath}:`, error);
			}
		}
	}

	/**
	 * Set up file watching for automatic reloading
	 */
	setupFileWatching(): void {
		if (!this.persistenceContext) {
			return; // No persistence configured
		}

		const fileGroups = groupByFile(this.config);

		for (const [filePath, collectionNames] of Array.from(
			fileGroups.entries(),
		)) {
			const stopWatching = watchFile(
				this.persistenceContext,
				filePath,
				async () => {
					try {
						const fileData = await loadData(this.persistenceContext!, filePath);
						// loadData already returns Record<string, unknown>, but we need to validate it's the right shape
						if (isRecord(fileData)) {
							// Type assertion here is safe because we've validated the structure
							const typedFileData = fileData as Record<
								string,
								Record<string, unknown>
							>;
							this.data = mergeFileDataIntoDataset(
								this.data,
								typedFileData,
								collectionNames,
							);
						}
					} catch (error) {
						console.error(`Failed to reload data from ${filePath}:`, error);
					}
				},
			);

			this.fileWatchers.set(filePath, stopWatching);
		}
	}

	/**
	 * Clean up file watchers
	 */
	cleanup(): void {
		for (const stopWatching of Array.from(this.fileWatchers.values())) {
			stopWatching();
		}
		this.fileWatchers.clear();
	}

	/**
	 * Save data for a specific collection
	 */
	async saveCollectionData(collectionName: keyof Config): Promise<void> {
		if (!this.persistenceContext) {
			return; // No persistence configured
		}

		const collectionConfig = this.config[collectionName];
		if (!collectionConfig.file) {
			return; // Collection not configured for persistence
		}

		const fileGroups = groupByFile(this.config);
		const filePath = collectionConfig.file;
		const collectionsForFile = fileGroups.get(filePath) ?? [];

		if (collectionsForFile.length === 0) {
			return;
		}

		const fileData = extractCollectionsForFile(this.data, collectionsForFile);
		await saveData(this.persistenceContext, filePath, fileData);
	}

	/**
	 * Build all collections and add them to the builder
	 */
	buildAllCollections(): this {
		// Process each collection name individually to avoid union type complexity
		const collectionNames = Object.keys(this.config);
		for (let i = 0; i < collectionNames.length; i++) {
			const collectionName = collectionNames[i];
			// Use type assertion to avoid union complexity
			const typedName = collectionName as keyof Config;
			const collection = this.createTypedCollection(typedName);
			// The double assertion here is necessary because TypeScript cannot handle
			// the complexity of all possible collection types in a union
			this.addCollection(
				typedName,
				collection as unknown as SmartCollection<
					unknown,
					Record<string, RelationshipDef<unknown, "ref" | "inverse", string>>,
					GenerateDatabase<Config>
				> &
					CrudMethodsWithRelationships<
						MinimalEntity,
						Record<string, RelationshipDef<unknown, "ref" | "inverse", string>>,
						GenerateDatabase<Config>
					>,
			);
		}
		return this;
	}
}

// ============================================================================
// Function Overloads for Backward Compatibility
// ============================================================================

// Synchronous overload - no persistence options (2 parameters)
export function createDatabase<Config extends DatabaseConfig>(
	config: Config,
	initialData: DatasetFor<Config>,
): GenerateDatabase<Config>;

// Synchronous overload - no persistence options (1 parameter)
export function createDatabase<Config extends DatabaseConfig>(
	config: Config,
): GenerateDatabase<Config>;

// Asynchronous overload - with persistence options (3 parameters)
export function createDatabase<Config extends DatabaseConfig>(
	config: Config,
	initialData: DatasetFor<Config> | undefined,
	options: DatabaseOptions,
): Promise<GenerateDatabase<Config>>;

// Implementation
export function createDatabase<Config extends DatabaseConfig>(
	config: Config,
	initialData?: DatasetFor<Config>,
	options?: DatabaseOptions,
): GenerateDatabase<Config> | Promise<GenerateDatabase<Config>> {
	// If no options provided, use synchronous mode for backward compatibility
	if (!options) {
		return createDatabaseSync(
			config,
			initialData ?? ({} as DatasetFor<Config>),
		);
	}

	// If options provided, use asynchronous mode with persistence
	return createDatabaseAsync(config, initialData, options);
}

// ============================================================================
// Internal Implementation Functions
// ============================================================================

// Legacy function signature for backward compatibility
function createDatabaseSync<Config extends DatabaseConfig>(
	config: Config,
	data: DatasetFor<Config>,
): GenerateDatabase<Config> {
	// Use the type-safe builder to construct the database without persistence
	const builder = new DatabaseBuilder(config, data);
	return builder.buildAllCollections().build();
}

// New async function signature with persistence support
async function createDatabaseAsync<Config extends DatabaseConfig>(
	config: Config,
	initialData?: DatasetFor<Config>,
	options?: DatabaseOptions,
): Promise<GenerateDatabase<Config>> {
	// Default empty data if not provided
	const data = initialData ?? ({} as DatasetFor<Config>);

	// Set up persistence context if provided
	let persistenceContext: PersistenceContext | undefined;
	if (options?.persistence) {
		const { adapter, serializerRegistry, writeDebounce, watchFiles } =
			options.persistence;

		// Validate that all configured file paths have supported extensions
		const filePaths = getConfigFilePaths(config);
		if (filePaths.length > 0) {
			validateFileExtensions(filePaths, serializerRegistry);
		}

		persistenceContext = createPersistenceContext(
			adapter,
			serializerRegistry,
			writeDebounce,
		);
	}

	// Create the database builder with persistence support
	const builder = new DatabaseBuilder(config, data, persistenceContext);

	// Load existing data from files if persistence is configured
	if (persistenceContext) {
		await builder.loadAllData();

		// Set up file watching if enabled
		if (options?.persistence?.watchFiles) {
			builder.setupFileWatching();
		}
	}

	// Build and return the database
	const database = builder.buildAllCollections().build();

	// Add cleanup method to the database for graceful shutdown
	if (persistenceContext) {
		Object.defineProperty(database, "cleanup", {
			value: () => builder.cleanup(),
			enumerable: false,
			writable: false,
		});
	}

	return database;
}
