# Deprecated shim export migration (1.0.0)

Every old public export is retained by a pure re-export. This inventory comes from the pre-migration package entry declarations, including inherited core contracts. Runtime smoke tests compare every namespace member by identity. The replacement entries preserve type-only exports through the same declarations.

| Old export | Old import | New location | Shim status |
|---|---|---|---|
| `AfterCreateContext` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `AfterCreateHook` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `AfterDeleteContext` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `AfterDeleteHook` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `AfterUpdateContext` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `AfterUpdateHook` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `AggregateConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `AggregateResult` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `AllTextFormatsLayer` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ApplyPopulateObject` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ApplySelectAndPopulate` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ApplySelectConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `BeforeCreateContext` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `BeforeCreateHook` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `BeforeDeleteContext` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `BeforeDeleteHook` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `BeforeUpdateContext` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `BeforeUpdateHook` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `BrowserEngineStorageHost` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `BrowserStorageHostConfig` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `BrowserStorageLayer` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `ChangeEvent` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CollectionConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CollectionIndexes` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CollectionNotFoundError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CompiledTemplate` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ComputedFieldDefinition` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ComputedFieldKeys` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ComputedFieldsConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ConcurrencyError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ConfiguredCollections` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CreateInput` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CreateManyOptions` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CreateManyResult` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CreateWithRelationshipsInput` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CrudError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CrudMethods` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CrudMethodsWithRelationships` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CursorConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CursorPageInfo` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CursorPageResult` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CustomIdGenerator` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `CustomOperator` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DEFAULT_STORAGE_KEY_PREFIX` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `DanglingReferenceError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DatabaseConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DatabaseError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DatabaseReactiveOptions` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DatabaseSourceConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DatasetFor` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DefaultSerializerLayer` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DeleteManyResult` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DeleteWithRelationshipsOptions` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DeleteWithRelationshipsResult` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DerivedIdConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DocumentGraphDiagnostic` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DocumentGraphDiagnosticAction` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DocumentGraphFragmentErrorPolicy` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DocumentGraphMetadata` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DocumentGraphRecordContribution` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DocumentGraphRecordProvenance` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DocumentGraphRootConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DocumentGraphSourceConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DocumentGraphSourceError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DocumentGraphTransform` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DocumentGraphTransformContext` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DocumentSourceConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DryRunCollectionResult` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DryRunMigration` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DryRunResult` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DryRunStatus` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DuplicateKeyError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DuplicatePhysicalFileError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `DuplicateRecordError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `EffectCollection` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `EffectDatabase` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `EffectDatabaseOptions` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `EffectDatabasePersistenceConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `EffectDatabaseWithPersistence` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `EngineStorageHost` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `EngineStorageWatchEvent` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `EntitySchema` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ForeignKeyError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `FormatCodec` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `FormatOptions` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `GenerateDatabase` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `GenerateDatabaseWithPersistence` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `GlobalHooksConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `GroupResult` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `GroupedAggregateConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `GroupedAggregateResult` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `HookError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `HooksConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `IdGeneratorConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `IndexMap` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `IndexRef` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `IndexedDBConfig` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `IndexedDBEngineHostConfig` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `IndexedDBStorageLayer` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `InferAggregateResult` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `InferComputedFields` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `InferEncoded` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `InferEntity` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `InvalidDocumentSourceError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `LegacyDatabaseConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `LocalStorageEngineStorageHostConfig` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `LocalStorageLayer` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `Migration` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `MigrationError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `MigrationErrors` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `MinimalEntity` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `NodeAdapterConfig` | `@proseql/node` | `@proseql/effect/node` | Retained |
| `NodeStorageLayer` | `@proseql/node` | `@proseql/effect/node` | Retained |
| `NormalizedDatabaseSourceConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `NormalizedDocumentGraphRootConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `NormalizedDocumentGraphSourceConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `NormalizedDocumentSourceConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `NormalizedIndex` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `NormalizedSourceConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `NotFoundError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `OnChangeContext` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `OnChangeCreateContext` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `OnChangeDeleteContext` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `OnChangeHook` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `OnChangeUpdateContext` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `OperationError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ParsedLine` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `PartitionKey` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `PartitionTimeBucket` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `PartitionedSourceConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `PersistenceError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `PluginError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `PluginRegistry` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `PopulateConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `PopulationError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ProseCodecOptions` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ProseQLPlugin` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ProseSegment` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `QueryConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `QueryError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `QueryReturnType` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ReactiveConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `RelationshipDef` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ResolveRelationships` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `RunnableCursorPage` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `RunnableEffect` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `RunnableStream` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `RuntimeEntityFromCollection` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `SEARCH_SCORE_KEY` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `STOP_WORDS` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ScalarAggregateConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `Schema` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `SearchConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `SearchIndexMap` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `SearchScore` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `SelectConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `SerializationError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `SerializerRegistryService` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `SerializerRegistryShape` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `SessionStorageEngineStorageHostConfig` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `SessionStorageLayer` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `SmartCollection` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `SortConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `SourceConfigError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `SourceError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `SourceOrientedDatabaseConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `SourceRecordOrigin` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `StorageAdapterService` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `StorageAdapterShape` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `StorageError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `StorageReadWriteError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `TransactionContext` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `TransactionError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `UniqueConstraintError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `UnknownCollectionError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `UnsupportedFormatError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `UpdateManyResult` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `UpdateWithOperators` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `UpdateWithRelationshipsInput` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `UpsertInput` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `UpsertManyResult` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `UpsertResult` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ValidationError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `WasmEngineDefectError` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `WatchByIdMethod` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `WatchConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `WatchImplementation` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `WatchMethod` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `WebStorageConfig` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `WebStorageEngineHostConfig` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `WhereClause` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `WithComputed` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `createEffectDatabase` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `createEngineDatabase` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `createEngineStorageAdapter` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `createIndexedDBEngineStorageHost` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `createLocalStorageEngineStorageHost` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `createNodeDatabase` | `@proseql/node` | `@proseql/effect/node` | Retained |
| `createPersistentEffectDatabase` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `createPersistentEngineDatabase` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `createSessionStorageEngineStorageHost` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `createWebStorageEngineStorageHost` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `getCollectionConfigs` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `getFileExtension` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `getSupportedExtensions` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `hjsonCodec` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `inferCodecsFromConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `isCollectionDirectoryMode` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `isGroupedAggregateConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `isSourceOrientedDatabaseConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `joinPath` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `json5Codec` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `jsonCodec` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `jsoncCodec` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `jsonlCodec` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `jsonlDecodeLines` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `makeEngineStorageLayer` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `makeIndexedDBAdapter` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `makeIndexedDBStorageLayer` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `makeLocalStorageAdapter` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `makeLocalStorageLayer` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `makeNodePersistenceLayer` | `@proseql/node` | `@proseql/effect/node` | Retained |
| `makeNodeStorageLayer` | `@proseql/node` | `@proseql/effect/node` | Retained |
| `makeProseQLLayer` | `@proseql/node` | `@proseql/effect/node` | Retained |
| `makeProseQLTag` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `makeSerializerLayer` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `makeSessionStorageAdapter` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `makeSessionStorageLayer` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `makeWebStorageAdapter` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `matchesDocumentSourcePattern` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `mergeSerializerWithPluginCodecs` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `normalizePath` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `normalizeSourceConfig` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `pathToKey` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `proseCodec` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `relativeToRoot` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `tomlCodec` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `toonCodec` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `validateAllowedFormat` | `@proseql/browser` | `@proseql/effect/browser` | Retained |
| `validateDependencies` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `validateOperatorConflicts` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `validatePlugin` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `yamlCodec` | `@proseql/node`, `@proseql/browser` | `@proseql/effect/node`, `@proseql/effect/browser` | Retained |
| `ServiceWorkerIndexedDBEngineHostConfig` | `@proseql/browser/worker` | `@proseql/effect/browser/worker` | Retained |
| `WasmInitializationError` | `@proseql/browser/worker` | `@proseql/effect/browser/worker` | Retained |
| `WorkerWasmInitializationError` | `@proseql/browser/worker` | `@proseql/effect/browser/worker` | Retained |
| `createServiceWorkerEngineDatabase` | `@proseql/browser/worker` | `@proseql/effect/browser/worker` | Retained |
| `createServiceWorkerIndexedDBEngineStorageHost` | `@proseql/browser/worker` | `@proseql/effect/browser/worker` | Retained |
| `getLoadedWasmMemoryByteLength` | `@proseql/browser/worker` | `@proseql/effect/browser/worker` | Retained |
| `initializeWorkerWasmBindings` | `@proseql/browser/worker` | `@proseql/effect/browser/worker` | Retained |
| `workerWasmUrl` | `@proseql/browser/worker` | `@proseql/effect/browser/worker` | Retained |

`getFileExtension` uses the core implementation already inherited by the Effect entry. Both previous implementations were identical. Node and browser database factories retain their existing platform-specific defaults. The Effect root does not add the Node convenience exports.
