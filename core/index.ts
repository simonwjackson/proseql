/**
 * Main entry point for the enhanced database library with persistence support.
 * Exports all core functionality including the new persistence features.
 */

// ============================================================================
// Core Database Factory (Enhanced with Persistence)
// ============================================================================

export { createDatabase } from "./factories/database.js";

// ============================================================================
// Types and Configurations
// ============================================================================

// Core database types
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

// Persistence configuration types
export type {
	DatabaseConfig,
	DatabaseOptions,
	PersistenceOptions,
	CollectionConfig,
} from "./types/database-config-types.js";

// ============================================================================
// Storage System
// ============================================================================

// Storage adapter types and implementations
export type {
	StorageAdapter,
	StorageAdapterOptions,
} from "./storage/types.js";
export { StorageError } from "./storage/types.js";
export {
	createNodeStorageAdapter,
	defaultNodeStorageAdapter,
} from "./storage/node-adapter.js";

// Persistence functions
export {
	createPersistenceContext,
	loadData,
	saveData,
	saveDataImmediate,
	watchFile,
	fileExists,
	flushPendingWrites,
	type PersistenceContext,
} from "./storage/persistence.js";

// Data transformation utilities
export {
	arrayToObject,
	objectToArray,
	groupByFile,
	getConfigFilePaths,
	isCollectionPersistent,
	extractCollectionsForFile,
	mergeFileDataIntoDataset,
} from "./storage/transforms.js";

// ============================================================================
// Serialization System
// ============================================================================

// Serializer types and errors
export type {
	Serializer,
	SerializerRegistry,
} from "./serializers/types.js";
export {
	SerializationError,
	UnsupportedFormatError,
} from "./serializers/types.js";

// JSON serializer
export {
	createJsonSerializer,
	defaultJsonSerializer,
	compactJsonSerializer,
} from "./serializers/json.js";

// YAML serializer
export {
	createYamlSerializer,
	defaultYamlSerializer,
	compactYamlSerializer,
	prettyYamlSerializer,
} from "./serializers/yaml.js";

// MessagePack serializer
export {
	createMessagePackSerializer,
	defaultMessagePackSerializer,
	isMessagePackCompatible,
	sanitizeForMessagePack,
} from "./serializers/messagepack.js";

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
	type IdGeneratorConfig,
	defaultIdConfig,
} from "./utils/id-generator.js";

// ============================================================================
// CRUD Operations (Existing)
// ============================================================================

export type {
	CrudError,
	Result,
} from "./errors/crud-errors.js";

export type { CrudMethodsWithRelationships } from "./factories/crud-factory-with-relationships.js";

// ============================================================================
// Query Operations (Existing)
// ============================================================================

export { withToArray } from "./operations/query/query-helpers.js";

// ============================================================================
// Utility Functions for AsyncIterable Processing
// ============================================================================

export {
	collect,
	collectLimit,
	count,
	first,
	map,
} from "./utils/async-iterable.js";
