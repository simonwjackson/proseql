/** Shared contracts, errors, configuration and codecs. No database runtime. */

export { Schema } from "effect";
export { makeProseQLTag } from "./context-tag.js";
export type { CrudError } from "./errors/crud-errors.js";
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
export type { DatabaseError } from "./errors/index.js";
export type { MigrationErrors } from "./errors/migration-errors.js";
export { MigrationError } from "./errors/migration-errors.js";
export { PluginError } from "./errors/plugin-errors.js";

export type { QueryError } from "./errors/query-errors.js";

export {
	CollectionNotFoundError,
	DanglingReferenceError,
	PopulationError,
} from "./errors/query-errors.js";

export type {
	SourceError,
	SourceRecordOrigin,
} from "./errors/source-errors.js";

export {
	DocumentGraphSourceError,
	DuplicatePhysicalFileError,
	DuplicateRecordError,
	InvalidDocumentSourceError,
	SourceConfigError,
	UnknownCollectionError,
} from "./errors/source-errors.js";

export type { PersistenceError } from "./errors/storage-errors.js";

export {
	SerializationError,
	StorageError,
	UnsupportedFormatError,
} from "./errors/storage-errors.js";
export type {
	DryRunCollectionResult,
	DryRunMigration,
	DryRunResult,
	DryRunStatus,
	Migration,
} from "./migrations/migration-types.js";
export type {
	CustomIdGenerator,
	CustomOperator,
	GlobalHooksConfig,
	PluginRegistry,
	ProseQLPlugin,
} from "./plugins/plugin-types.js";
export {
	validateDependencies,
	validateOperatorConflicts,
	validatePlugin,
} from "./plugins/plugin-validation.js";
export { hjsonCodec } from "./serializers/codecs/hjson.js";
export { jsonCodec } from "./serializers/codecs/json.js";
export { json5Codec } from "./serializers/codecs/json5.js";
export { jsoncCodec } from "./serializers/codecs/jsonc.js";
export type { ParsedLine } from "./serializers/codecs/jsonl.js";
export { jsonlCodec, jsonlDecodeLines } from "./serializers/codecs/jsonl.js";
export type {
	CompiledTemplate,
	ProseCodecOptions,
	ProseSegment,
} from "./serializers/codecs/prose.js";
export { proseCodec } from "./serializers/codecs/prose.js";
export { tomlCodec } from "./serializers/codecs/toml.js";
export { toonCodec } from "./serializers/codecs/toon.js";
export { yamlCodec } from "./serializers/codecs/yaml.js";
export type {
	FormatCodec,
	FormatOptions,
} from "./serializers/format-codec.js";
export {
	makeSerializerLayer,
	mergeSerializerWithPluginCodecs,
} from "./serializers/format-codec.js";
export { inferCodecsFromConfig } from "./serializers/infer-codecs.js";
export {
	AllTextFormatsLayer,
	DefaultSerializerLayer,
} from "./serializers/presets.js";
export type { SerializerRegistryShape } from "./serializers/serializer-service.js";
export {
	getSupportedExtensions,
	SerializerRegistry as SerializerRegistryService,
} from "./serializers/serializer-service.js";
export type {
	DocumentGraphDiagnostic,
	DocumentGraphDiagnosticAction,
	DocumentGraphRecordContribution,
	DocumentGraphRecordProvenance,
} from "./storage/document-types.js";
export type {
	DatabaseSourceConfig,
	DocumentGraphFragmentErrorPolicy,
	DocumentGraphRootConfig,
	DocumentGraphSourceConfig,
	DocumentGraphTransform,
	DocumentGraphTransformContext,
	DocumentSourceConfig,
	NormalizedDatabaseSourceConfig,
	NormalizedDocumentGraphRootConfig,
	NormalizedDocumentGraphSourceConfig,
	NormalizedDocumentSourceConfig,
	NormalizedSourceConfig,
	PartitionedSourceConfig,
	PartitionKey,
	PartitionTimeBucket,
} from "./storage/source-config.js";
export {
	matchesDocumentSourcePattern,
	normalizeSourceConfig,
	relativeToRoot,
} from "./storage/source-config.js";
export type {
	StorageAdapterShape,
	StorageReadWriteError,
} from "./storage/storage-service.js";
export { StorageAdapter as StorageAdapterService } from "./storage/storage-service.js";
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
export type {
	ComputedFieldDefinition,
	ComputedFieldKeys,
	ComputedFieldsConfig,
	InferComputedFields,
	WithComputed,
} from "./types/computed-types.js";
export type { CrudMethods } from "./types/crud-factory.js";
export type { CrudMethodsWithRelationships } from "./types/crud-factory-with-relationships.js";
export type {
	CreateWithRelationshipsInput,
	DeleteWithRelationshipsOptions,
	DeleteWithRelationshipsResult,
	UpdateWithRelationshipsInput,
} from "./types/crud-relationship-types.js";
export type {
	CreateInput,
	CreateManyOptions,
	CreateManyResult,
	DeleteManyResult,
	MinimalEntity,
	TransactionContext,
	UpdateManyResult,
	UpdateWithOperators,
	UpsertInput,
	UpsertManyResult,
	UpsertResult,
} from "./types/crud-types.js";
export type {
	CursorConfig,
	CursorPageInfo,
	CursorPageResult,
	RunnableCursorPage,
} from "./types/cursor-types.js";
export type {
	CollectionConfig,
	ConfiguredCollections,
	DatabaseConfig,
	DatabaseReactiveOptions,
	DerivedIdConfig,
	LegacyDatabaseConfig,
	ReactiveConfig,
	SourceOrientedDatabaseConfig,
} from "./types/database-config-types.js";
export {
	getCollectionConfigs,
	isCollectionDirectoryMode,
	isSourceOrientedDatabaseConfig,
} from "./types/database-config-types.js";
export type {
	DocumentGraphMetadata,
	EffectCollection,
	EffectDatabase,
	EffectDatabaseOptions,
	EffectDatabasePersistenceConfig,
	EffectDatabaseWithPersistence,
	RunnableEffect,
	RunnableStream,
} from "./types/database-types.js";
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
export type {
	CollectionIndexes,
	IndexMap,
	IndexRef,
	NormalizedIndex,
} from "./types/index-types.js";
export type {
	ChangeEvent,
	WatchByIdMethod,
	WatchConfig,
	WatchMethod,
} from "./types/reactive-types.js";
export type {
	EntitySchema,
	InferEncoded,
	InferEntity,
} from "./types/schema-types.js";
export type {
	SearchConfig,
	SearchIndexMap,
	SearchScore,
} from "./types/search-types.js";
export { SEARCH_SCORE_KEY, STOP_WORDS } from "./types/search-types.js";
export type {
	ApplyPopulateObject,
	ApplySelectAndPopulate,
	ApplySelectConfig,
	DatasetFor,
	GenerateDatabase,
	GenerateDatabaseWithPersistence,
	PopulateConfig,
	QueryConfig,
	QueryReturnType,
	RelationshipDef,
	ResolveRelationships,
	RuntimeEntityFromCollection,
	SelectConfig,
	SmartCollection,
	SortConfig,
	WhereClause,
} from "./types/types.js";
export type { IdGeneratorConfig } from "./utils/id-generator.js";
export { getFileExtension, joinPath, normalizePath } from "./utils/path.js";
