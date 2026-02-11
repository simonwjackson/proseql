/**
 * Main entry point for the plan-text-db library.
 *
 * Exports the Effect-based API: typed errors, Schema validation,
 * Stream query pipeline, Ref state, Service/Layer persistence.
 */

// ============================================================================
// Effect-Based Database Factory
// ============================================================================

export type {
	EffectCollection,
	EffectDatabase,
	EffectDatabasePersistenceConfig,
	EffectDatabaseWithPersistence,
	RunnableEffect,
	RunnableStream,
} from "./factories/database-effect.js";
export {
	createEffectDatabase,
	createPersistentEffectDatabase,
} from "./factories/database-effect.js";

// ============================================================================
// CRUD Method Types
// ============================================================================

export type { CrudMethods } from "./factories/crud-factory.js";
export type { CrudMethodsWithRelationships } from "./factories/crud-factory-with-relationships.js";

// ============================================================================
// Error Types (Effect TaggedError)
// ============================================================================

export type { CrudError } from "./errors/crud-errors.js";
// CRUD errors
export {
	ConcurrencyError,
	DuplicateKeyError,
	ForeignKeyError,
	HookError,
	NotFoundError,
	OperationError,
	TransactionError,
	UniqueConstraintError,
	ValidationError,
} from "./errors/crud-errors.js";
// Union type
export type { DatabaseError } from "./errors/index.js";
export type { MigrationErrors } from "./errors/migration-errors.js";

// Migration errors
export { MigrationError } from "./errors/migration-errors.js";
export type { QueryError } from "./errors/query-errors.js";
// Query errors
export {
	CollectionNotFoundError,
	DanglingReferenceError,
	PopulationError,
} from "./errors/query-errors.js";

export type { PersistenceError } from "./errors/storage-errors.js";
// Storage errors
export {
	SerializationError,
	StorageError,
	UnsupportedFormatError,
} from "./errors/storage-errors.js";

// ============================================================================
// Schema Types
// ============================================================================

export type {
	EntitySchema,
	InferEncoded,
	InferEntity,
} from "./types/schema-types.js";

// ============================================================================
// Migration Types
// ============================================================================

export type {
	DryRunCollectionResult,
	DryRunMigration,
	DryRunResult,
	DryRunStatus,
	Migration,
} from "./migrations/migration-types.js";

// ============================================================================
// Core Types and Configurations
// ============================================================================

export type {
	CollectionConfig,
	DatabaseConfig,
} from "./types/database-config-types.js";
export type {
	DatasetFor,
	GenerateDatabase,
	PopulateConfig,
	QueryConfig,
	QueryReturnType,
	RelationshipDef,
	SelectConfig,
	SmartCollection,
	SortConfig,
	WhereClause,
} from "./types/types.js";

// ============================================================================
// Aggregate Types
// ============================================================================

export type {
	AggregateConfig,
	AggregateResult,
	GroupedAggregateConfig,
	GroupedAggregateResult,
	GroupResult,
	InferAggregateResult,
	ScalarAggregateConfig,
} from "./types/aggregate-types.js";

export { isGroupedAggregateConfig } from "./types/aggregate-types.js";

// ============================================================================
// Cursor Pagination Types
// ============================================================================

export type {
	CursorConfig,
	CursorPageInfo,
	CursorPageResult,
	RunnableCursorPage,
} from "./types/cursor-types.js";

// ============================================================================
// Index Types
// ============================================================================

export type {
	CollectionIndexes,
	IndexMap,
	IndexRef,
	NormalizedIndex,
} from "./types/index-types.js";

// ============================================================================
// Lifecycle Hook Types
// ============================================================================

export type {
	// After hook contexts
	AfterCreateContext,
	AfterCreateHook,
	AfterDeleteContext,
	AfterDeleteHook,
	AfterUpdateContext,
	AfterUpdateHook,
	// Before hook contexts
	BeforeCreateContext,
	// Hook function signatures
	BeforeCreateHook,
	BeforeDeleteContext,
	BeforeDeleteHook,
	BeforeUpdateContext,
	BeforeUpdateHook,
	// Hooks configuration
	HooksConfig,
	// onChange contexts (discriminated union)
	OnChangeContext,
	OnChangeCreateContext,
	OnChangeDeleteContext,
	OnChangeHook,
	OnChangeUpdateContext,
} from "./types/hook-types.js";

// ============================================================================
// Transaction Types
// ============================================================================

export type { TransactionContext } from "./types/crud-types.js";

// ============================================================================
// Transaction Functions
// ============================================================================

export { $transaction, createTransaction } from "./transactions/transaction.js";

// ============================================================================
// Index Functions
// ============================================================================

export { resolveWithIndex } from "./indexes/index-lookup.js";
export {
	addManyToIndex,
	addToIndex,
	buildIndexes,
	normalizeIndexes,
	removeFromIndex,
	removeManyFromIndex,
	updateInIndex,
} from "./indexes/index-manager.js";

// ============================================================================
// Schema Validation
// ============================================================================

export { encodeEntity, validateEntity } from "./validators/schema-validator.js";

// ============================================================================
// State Management (Ref-based)
// ============================================================================

export { createCollectionState } from "./state/collection-state.js";

export {
	getAllEntities,
	getEntity,
	getEntityOrFail,
	removeEntity,
	setEntity,
	updateEntity,
} from "./state/state-operations.js";

// ============================================================================
// Query Pipeline (Stream-based)
// ============================================================================

// Non-stream filter utility (for direct array filtering)
export { filterData } from "./operations/query/filter.js";
export { applyFilter } from "./operations/query/filter-stream.js";
export { applyPagination } from "./operations/query/paginate-stream.js";
// Object-based field selection utilities
export {
	applyObjectSelection,
	applySelectionSafe,
	applySelectionToArray,
	createFieldSelector,
	mergeObjectFieldSelections,
} from "./operations/query/select.js";
export { applySelect } from "./operations/query/select-stream.js";
export { applySort } from "./operations/query/sort-stream.js";
export { applyPopulate } from "./operations/relationships/populate-stream.js";

// ============================================================================
// Storage Services (Effect Layer)
// ============================================================================

// In-memory adapter (for testing)
export {
	InMemoryStorageLayer,
	makeInMemoryStorageLayer,
} from "./storage/in-memory-adapter-layer.js";
export type {
	DebouncedWriter,
	FileWatcher,
	FileWatcherConfig,
	LoadCollectionConfig,
	LoadDataOptions,
	SaveCollectionConfig,
	SaveDataOptions,
} from "./storage/persistence-effect.js";
// Persistence utilities
export {
	createDebouncedWriter,
	createFileWatcher,
	createFileWatchers,
	loadCollectionsFromFile,
	loadData,
	saveCollectionsToFile,
	saveData,
} from "./storage/persistence-effect.js";
export type { StorageAdapterShape } from "./storage/storage-service.js";
// Storage adapter service
export { StorageAdapter as StorageAdapterService } from "./storage/storage-service.js";

// ============================================================================
// Serializer Services (Effect Layer)
// ============================================================================

export { hjsonCodec } from "./serializers/codecs/hjson.js";
// Individual codec factories
export { jsonCodec } from "./serializers/codecs/json.js";
export { json5Codec } from "./serializers/codecs/json5.js";
export { jsoncCodec } from "./serializers/codecs/jsonc.js";
export { tomlCodec } from "./serializers/codecs/toml.js";
export { toonCodec } from "./serializers/codecs/toon.js";
export { yamlCodec } from "./serializers/codecs/yaml.js";
export type {
	FormatCodec,
	FormatOptions,
} from "./serializers/format-codec.js";
// FormatCodec compositor and types
export { makeSerializerLayer } from "./serializers/format-codec.js";
// Preset Layers
export {
	AllTextFormatsLayer,
	DefaultSerializerLayer,
} from "./serializers/presets.js";
export type { SerializerRegistryShape } from "./serializers/serializer-service.js";
// Serializer registry service
export { SerializerRegistry as SerializerRegistryService } from "./serializers/serializer-service.js";

// ============================================================================
// Data Transformation Utilities
// ============================================================================

export {
	arrayToMap,
	arrayToObject,
	extractCollectionsForFile,
	extractCollectionsFromMaps,
	getConfigFilePaths,
	groupByFile,
	isCollectionPersistent,
	mapToArray,
	mapToObject,
	mergeFileDataIntoDataset,
	mergeFileDataIntoMaps,
	objectToArray,
	objectToMap,
} from "./storage/transforms.js";

// ============================================================================
// Path Utilities
// ============================================================================

export { getFileExtension } from "./utils/path.js";

// ============================================================================
// Computed Field Types
// ============================================================================

// Computed field resolution functions
export {
	hasSelectedComputedFields,
	resolveComputedFields,
	resolveComputedStream,
	resolveComputedStreamWithLazySkip,
	stripComputedFields,
} from "./operations/query/resolve-computed.js";
export type {
	ComputedFieldDefinition,
	ComputedFieldKeys,
	ComputedFieldsConfig,
	InferComputedFields,
	WithComputed,
} from "./types/computed-types.js";

// ============================================================================
// Search Types
// ============================================================================

// Search index functions
export {
	addToSearchIndex,
	buildSearchIndex,
	lookupSearchIndex,
	removeFromSearchIndex,
	resolveWithSearchIndex,
	updateInSearchIndex,
} from "./indexes/search-index.js";
export type {
	SearchConfig,
	SearchIndexMap,
	SearchScore,
} from "./types/search-types.js";
export { SEARCH_SCORE_KEY, STOP_WORDS } from "./types/search-types.js";

// ============================================================================
// ID Generation Utilities
// ============================================================================

export type { IdGeneratorConfig } from "./utils/id-generator.js";
export {
	CollectionIdGenerators,
	compareIds,
	createIdGenerator,
	defaultIdConfig,
	extractTimestamp,
	extractType,
	generateId,
	generateNanoId,
	generatePrefixedId,
	generateTimestampId,
	generateTypedId,
	generateULID,
	generateUUID,
	isValidId,
	isValidIdFormat,
} from "./utils/id-generator.js";

// ============================================================================
// Plugin System Types
// ============================================================================

export type {
	CustomIdGenerator,
	CustomOperator,
	GlobalHooksConfig,
	PluginRegistry,
	ProseQLPlugin,
} from "./plugins/plugin-types.js";

// Plugin errors
export { PluginError } from "./errors/plugin-errors.js";

// Plugin validation
export {
	validateOperatorConflicts,
	validatePlugin,
} from "./plugins/plugin-validation.js";
