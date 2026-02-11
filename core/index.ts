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
	DatabaseOptions,
	PersistenceOptions,
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

// ============================================================================
// Storage Services (Effect Layer)
// ============================================================================

// Storage adapter service
export {
	StorageAdapter as StorageAdapterService,
} from "./storage/storage-service.js";

export type { StorageAdapterShape } from "./storage/storage-service.js";

// Node.js filesystem adapter
export {
	NodeStorageLayer,
	makeNodeStorageLayer,
} from "./storage/node-adapter-layer.js";

export type { NodeAdapterConfig } from "./storage/node-adapter-layer.js";

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
} from "./storage/persistence-effect.js";

// ============================================================================
// Serializer Services (Effect Layer)
// ============================================================================

// Serializer registry service
export {
	SerializerRegistry as SerializerRegistryService,
} from "./serializers/serializer-service.js";

export type { SerializerRegistryShape } from "./serializers/serializer-service.js";

// JSON serializer
export {
	JsonSerializerLayer,
	makeJsonSerializerLayer,
	serializeJson,
	deserializeJson,
} from "./serializers/json.js";

export type { JsonSerializerOptions } from "./serializers/json.js";

// YAML serializer
export {
	YamlSerializerLayer,
	makeYamlSerializerLayer,
	serializeYaml,
	deserializeYaml,
} from "./serializers/yaml.js";

export type { YamlSerializerOptions } from "./serializers/yaml.js";

// MessagePack serializer
export {
	MessagePackSerializerLayer,
	serializeMessagePack,
	deserializeMessagePack,
} from "./serializers/messagepack.js";

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
// File Extension Utilities
// ============================================================================

export {
	getFileExtension,
	findSerializerForFile,
	isSupportedExtension,
	getSupportedExtensions,
	createSerializerRegistry,
	validateFileExtensions,
} from "./utils/file-extensions.js";

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

// ============================================================================
// Legacy Serializer Types (for backward compatibility)
// ============================================================================

export type {
	Serializer,
	SerializerRegistry as LegacySerializerRegistry,
} from "./serializers/types.js";

// Legacy serializer factories
export {
	createJsonSerializer,
	defaultJsonSerializer,
	compactJsonSerializer,
} from "./serializers/json.js";

export {
	createYamlSerializer,
	defaultYamlSerializer,
	compactYamlSerializer,
	prettyYamlSerializer,
} from "./serializers/yaml.js";

export {
	createMessagePackSerializer,
	defaultMessagePackSerializer,
} from "./serializers/messagepack.js";

// ============================================================================
// Legacy Persistence Functions (for backward compatibility)
// ============================================================================

export {
	createPersistenceContext,
	loadData as legacyLoadData,
	saveData as legacySaveData,
	saveDataImmediate,
	watchFile,
	fileExists,
	flushPendingWrites,
	type PersistenceContext,
} from "./storage/persistence.js";

// Legacy storage adapter types
export type {
	StorageAdapter as LegacyStorageAdapter,
	StorageAdapterOptions,
} from "./storage/types.js";

export {
	createNodeStorageAdapter,
	defaultNodeStorageAdapter,
} from "./storage/node-adapter.js";
