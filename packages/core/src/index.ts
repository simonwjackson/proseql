/**
 * Main entry point for the plan-text-db library.
 *
 * Exports the Effect-based API: typed errors, Schema validation,
 * Stream query pipeline, Ref state, Service/Layer persistence.
 */

// ============================================================================
// Effect-Based Database Factory
// ============================================================================

export {
	createEffectDatabase,
	createPersistentEffectDatabase,
} from "./factories/database-effect.js";

export type {
	RunnableEffect,
	RunnableStream,
	EffectCollection,
	EffectDatabase,
	EffectDatabaseWithPersistence,
	EffectDatabasePersistenceConfig,
} from "./factories/database-effect.js";

// ============================================================================
// CRUD Method Types
// ============================================================================

export type { CrudMethods } from "./factories/crud-factory.js";
export type { CrudMethodsWithRelationships } from "./factories/crud-factory-with-relationships.js";

// ============================================================================
// Error Types (Effect TaggedError)
// ============================================================================

// CRUD errors
export {
	NotFoundError,
	DuplicateKeyError,
	ForeignKeyError,
	ValidationError,
	UniqueConstraintError,
	ConcurrencyError,
	OperationError,
	TransactionError,
	HookError,
} from "./errors/crud-errors.js";

export type { CrudError } from "./errors/crud-errors.js";

// Query errors
export {
	DanglingReferenceError,
	CollectionNotFoundError,
	PopulationError,
} from "./errors/query-errors.js";

export type { QueryError } from "./errors/query-errors.js";

// Migration errors
export { MigrationError } from "./errors/migration-errors.js";

export type { MigrationErrors } from "./errors/migration-errors.js";

// Storage errors
export {
	StorageError,
	SerializationError,
	UnsupportedFormatError,
} from "./errors/storage-errors.js";

export type { PersistenceError } from "./errors/storage-errors.js";

// Union type
export type { DatabaseError } from "./errors/index.js";

// ============================================================================
// Schema Types
// ============================================================================

export type {
	EntitySchema,
	InferEntity,
	InferEncoded,
} from "./types/schema-types.js";

// ============================================================================
// Migration Types
// ============================================================================

export type {
	Migration,
	DryRunResult,
	DryRunStatus,
	DryRunMigration,
	DryRunCollectionResult,
} from "./migrations/migration-types.js";

// ============================================================================
// Core Types and Configurations
// ============================================================================

export type {
	GenerateDatabase,
	DatasetFor,
	SmartCollection,
	QueryConfig,
	QueryReturnType,
	WhereClause,
	SelectConfig,
	PopulateConfig,
	SortConfig,
	RelationshipDef,
} from "./types/types.js";

export type {
	DatabaseConfig,
	CollectionConfig,
} from "./types/database-config-types.js";

// ============================================================================
// Aggregate Types
// ============================================================================

export type {
	AggregateResult,
	GroupResult,
	GroupedAggregateResult,
	ScalarAggregateConfig,
	GroupedAggregateConfig,
	AggregateConfig,
	InferAggregateResult,
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
	IndexMap,
	IndexRef,
	CollectionIndexes,
	NormalizedIndex,
} from "./types/index-types.js";

// ============================================================================
// Lifecycle Hook Types
// ============================================================================

export type {
	// Before hook contexts
	BeforeCreateContext,
	BeforeUpdateContext,
	BeforeDeleteContext,
	// After hook contexts
	AfterCreateContext,
	AfterUpdateContext,
	AfterDeleteContext,
	// onChange contexts (discriminated union)
	OnChangeContext,
	OnChangeCreateContext,
	OnChangeUpdateContext,
	OnChangeDeleteContext,
	// Hook function signatures
	BeforeCreateHook,
	BeforeUpdateHook,
	BeforeDeleteHook,
	AfterCreateHook,
	AfterUpdateHook,
	AfterDeleteHook,
	OnChangeHook,
	// Hooks configuration
	HooksConfig,
} from "./types/hook-types.js";

// ============================================================================
// Transaction Types
// ============================================================================

export type { TransactionContext } from "./types/crud-types.js";

// ============================================================================
// Transaction Functions
// ============================================================================

export { createTransaction, $transaction } from "./transactions/transaction.js";

// ============================================================================
// Index Functions
// ============================================================================

export {
	normalizeIndexes,
	buildIndexes,
	addToIndex,
	removeFromIndex,
	updateInIndex,
	addManyToIndex,
	removeManyFromIndex,
} from "./indexes/index-manager.js";

export { resolveWithIndex } from "./indexes/index-lookup.js";

// ============================================================================
// Schema Validation
// ============================================================================

export { validateEntity, encodeEntity } from "./validators/schema-validator.js";

// ============================================================================
// State Management (Ref-based)
// ============================================================================

export { createCollectionState } from "./state/collection-state.js";

export {
	getEntity,
	getEntityOrFail,
	getAllEntities,
	setEntity,
	removeEntity,
	updateEntity,
} from "./state/state-operations.js";

// ============================================================================
// Query Pipeline (Stream-based)
// ============================================================================

export { applyFilter } from "./operations/query/filter-stream.js";
export { applySort } from "./operations/query/sort-stream.js";
export { applySelect } from "./operations/query/select-stream.js";
export { applyPagination } from "./operations/query/paginate-stream.js";
export { applyPopulate } from "./operations/relationships/populate-stream.js";

// Non-stream filter utility (for direct array filtering)
export { filterData } from "./operations/query/filter.js";

// Object-based field selection utilities
export {
	applyObjectSelection,
	applySelectionToArray,
	applySelectionSafe,
	createFieldSelector,
	mergeObjectFieldSelections,
} from "./operations/query/select.js";

// ============================================================================
// Storage Services (Effect Layer)
// ============================================================================

// Storage adapter service
export {
	StorageAdapter as StorageAdapterService,
} from "./storage/storage-service.js";

export type { StorageAdapterShape } from "./storage/storage-service.js";

// In-memory adapter (for testing)
export {
	InMemoryStorageLayer,
	makeInMemoryStorageLayer,
} from "./storage/in-memory-adapter-layer.js";

// Persistence utilities
export {
	loadData,
	saveData,
	loadCollectionsFromFile,
	saveCollectionsToFile,
	createDebouncedWriter,
	createFileWatcher,
	createFileWatchers,
} from "./storage/persistence-effect.js";

export type {
	DebouncedWriter,
	FileWatcher,
	FileWatcherConfig,
	LoadCollectionConfig,
	LoadDataOptions,
	SaveDataOptions,
	SaveCollectionConfig,
} from "./storage/persistence-effect.js";

// ============================================================================
// Serializer Services (Effect Layer)
// ============================================================================

// Serializer registry service
export {
	SerializerRegistry as SerializerRegistryService,
} from "./serializers/serializer-service.js";

export type { SerializerRegistryShape } from "./serializers/serializer-service.js";

// FormatCodec compositor and types
export { makeSerializerLayer } from "./serializers/format-codec.js";

export type {
	FormatCodec,
	FormatOptions,
} from "./serializers/format-codec.js";

// Individual codec factories
export { jsonCodec } from "./serializers/codecs/json.js";
export { yamlCodec } from "./serializers/codecs/yaml.js";
export { json5Codec } from "./serializers/codecs/json5.js";
export { jsoncCodec } from "./serializers/codecs/jsonc.js";
export { tomlCodec } from "./serializers/codecs/toml.js";
export { toonCodec } from "./serializers/codecs/toon.js";
export { hjsonCodec } from "./serializers/codecs/hjson.js";

// Preset Layers
export {
	AllTextFormatsLayer,
	DefaultSerializerLayer,
} from "./serializers/presets.js";

// ============================================================================
// Data Transformation Utilities
// ============================================================================

export {
	arrayToObject,
	objectToArray,
	arrayToMap,
	mapToObject,
	objectToMap,
	mapToArray,
	groupByFile,
	getConfigFilePaths,
	isCollectionPersistent,
	extractCollectionsForFile,
	mergeFileDataIntoDataset,
	extractCollectionsFromMaps,
	mergeFileDataIntoMaps,
} from "./storage/transforms.js";

// ============================================================================
// Path Utilities
// ============================================================================

export { getFileExtension } from "./utils/path.js";

// ============================================================================
// ID Generation Utilities
// ============================================================================

export {
	generateTimestampId,
	generateNanoId,
	generateUUID,
	generatePrefixedId,
	generateULID,
	generateTypedId,
	isValidId,
	isValidIdFormat,
	createIdGenerator,
	generateId,
	CollectionIdGenerators,
	extractTimestamp,
	extractType,
	compareIds,
	defaultIdConfig,
} from "./utils/id-generator.js";

export type { IdGeneratorConfig } from "./utils/id-generator.js";

