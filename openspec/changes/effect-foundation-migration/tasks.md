## 1. Project Setup

- [x] 1.1 Add `effect` dependency to package.json (create package.json at v2 level if needed), remove `zod` dependency
- [x] 1.2 Update tsconfig.json for Effect compatibility (ensure `strict: true`, `exactOptionalPropertyTypes: true`, target ES2022+)
- [x] 1.3 Create `core/errors/` module with all Effect TaggedError types: NotFoundError, DuplicateKeyError, ForeignKeyError, ValidationError, UniqueConstraintError, ConcurrencyError, OperationError, TransactionError, DanglingReferenceError, CollectionNotFoundError, StorageError, SerializationError, UnsupportedFormatError

## 2. Effect Schema Definitions

- [x] 2.1 Create `core/types/schema-types.ts` with Effect Schema equivalents of the current entity types (Schema.Struct-based). Export helper types: `EntitySchema<T>`, `InferEntity<S>`, `InferEncoded<S>`
- [x] 2.2 Update `core/types/database-config-types.ts` to accept `Schema.Schema` in the `schema` field instead of `z.ZodType`. Update CollectionConfig, DatabaseConfig types
- [x] 2.3 Create `core/validators/schema-validator.ts` with Effect Schema decode/encode wrappers: `validateEntity(schema, data)` returning `Effect<T, ValidationError>`, `encodeEntity(schema, entity)` returning `Effect<Encoded, ValidationError>`
- [x] 2.4 Write tests for schema validation: valid data decodes, invalid data produces ParseError, round-trip encode/decode preserves data

## 3. Error Model Migration

- [x] 3.1 Define all CRUD error types as Data.TaggedError classes in `core/errors/crud-errors.ts` (replace the current tagged union). Preserve all existing error fields (collection, id, field, value, message)
- [x] 3.2 Define query error types: DanglingReferenceError, CollectionNotFoundError, PopulationError in `core/errors/query-errors.ts`
- [x] 3.3 Define storage error types: StorageError, SerializationError, UnsupportedFormatError in `core/errors/storage-errors.ts`
- [x] 3.4 Remove the hand-rolled Result<T, E> type, isOk/isErr helpers, and error factory functions. Export new error types from `core/errors/index.ts`
- [x] 3.5 Write tests for error creation, _tag discrimination, and Effect.catchTag pattern matching

## 4. State Management (Ref)

- [x] 4.1 Create `core/state/collection-state.ts` with `createCollectionState(initialData: T[])` returning `Effect<Ref<ReadonlyMap<string, T>>>`. Convert array to ReadonlyMap keyed by ID
- [x] 4.2 Create `core/state/state-operations.ts` with atomic state helpers: `getEntity(ref, id)`, `getAllEntities(ref)`, `setEntity(ref, entity)`, `removeEntity(ref, id)`, `updateEntity(ref, id, updater)` — all returning Effect
- [x] 4.3 Write tests for Ref state: initial state from array, O(1) lookup by ID, atomic updates, snapshot consistency (read during write sees consistent state)

## 5. Storage Services

- [x] 5.1 Create `core/storage/storage-service.ts` defining StorageAdapter as an Effect Service with Context.Tag. Methods return Effect<T, StorageError>
- [x] 5.2 Create `core/storage/node-adapter-layer.ts` implementing the StorageAdapter service as a Layer using Node.js fs with atomic writes and retry via Effect.retry + Schedule.exponential
- [x] 5.3 Create `core/storage/in-memory-adapter-layer.ts` implementing StorageAdapter as an in-memory Map for testing
- [x] 5.4 Create `core/serializers/serializer-service.ts` defining SerializerRegistry as an Effect Service. Methods: `serialize(data, extension)` and `deserialize(content, extension)` returning Effect
- [x] 5.5 Migrate `core/serializers/json.ts` to return Effect values. Create JsonSerializerLayer
- [x] 5.6 Implement real YAML serializer in `core/serializers/yaml.ts` using js-yaml (replace mock). Create YamlSerializerLayer
- [x] 5.7 Implement real MessagePack serializer in `core/serializers/messagepack.ts` using msgpackr (replace mock). Create MessagePackSerializerLayer
- [x] 5.8 Write tests for storage services: read/write via service, serialization round-trips, Layer swapping (in-memory vs filesystem)

## 6. Query Pipeline (Stream-based)

- [x] 6.1 Create `core/operations/query/filter-stream.ts` implementing filter as a Stream combinator: `applyFilter(where)` returning `<T>(stream: Stream<T>) => Stream<T>`. Migrate all operator matching logic from current filter.ts
- [x] 6.2 Create `core/operations/query/sort-stream.ts` implementing sort as a Stream combinator: `applySort(sort)` returning `<T>(stream: Stream<T>) => Stream<T>`. Uses Stream.runCollect → sort → Stream.fromIterable
- [x] 6.3 Create `core/operations/query/select-stream.ts` implementing select as a Stream combinator: `applySelect(select)` returning `<T>(stream: Stream<T>) => Stream<Selected<T>>`. Support both object and array selection
- [x] 6.4 Create `core/operations/query/paginate-stream.ts` implementing pagination as Stream combinators: `applyPagination(offset, limit)` using Stream.drop/Stream.take
- [x] 6.5 Write tests for each query stage independently: filter with all operators ($eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $startsWith, $endsWith, $contains, $all, $size, $or, $and, $not), sort asc/desc, select object/array, pagination offset/limit

## 7. Population (Stream-based)

- [x] 7.1 Create `core/operations/relationships/populate-stream.ts` implementing population as a Stream combinator: `applyPopulate(config, stateRefs, dbConfig)` returning `<T>(stream: Stream<T>) => Stream<T & Populated>`. Resolve ref and inverse relationships from Ref state
- [x] 7.2 Handle nested population recursively (depth limit of 5 from current PopulateConfig type)
- [x] 7.3 Handle population errors: produce DanglingReferenceError for missing targets in error channel
- [x] 7.4 Write tests for population: ref relationships, inverse relationships, nested population, population with select, dangling reference handling

## 8. CRUD Operations (Effect-based)

- [x] 8.1 Migrate `core/operations/crud/create.ts`: create and createMany return Effect<T, ValidationError | DuplicateKeyError | ForeignKeyError>. Use Ref.update for state mutation, Schema.decodeUnknown for validation
- [x] 8.2 Migrate `core/operations/crud/update.ts`: update and updateMany return Effect. Preserve all update operators ($increment, $decrement, $multiply, $append, $prepend, $remove, $toggle, $set)
- [x] 8.3 Migrate `core/operations/crud/delete.ts`: delete and deleteMany return Effect. Preserve soft delete, foreign key constraint checking, cascade handling
- [x] 8.4 Migrate `core/operations/crud/upsert.ts`: upsert and upsertMany return Effect
- [x] 8.5 Migrate `core/operations/crud/create-with-relationships.ts`: createWithRelationships returns Effect
- [x] 8.6 Migrate `core/operations/crud/update-with-relationships.ts`: updateWithRelationships returns Effect
- [x] 8.7 Migrate `core/operations/crud/delete-with-relationships.ts`: deleteWithRelationships and deleteManyWithRelationships return Effect
- [x] 8.8 Migrate `core/validators/foreign-key.ts` to return Effect values for validation checks
- [ ] 8.9 Write tests for all CRUD operations: create with validation, update with operators, delete with cascade, upsert, relationship operations

## 9. Persistence Integration

- [ ] 9.1 Create `core/storage/persistence-effect.ts`: loadData using StorageAdapter + SerializerRegistry services, decode through Schema, return Effect. saveData encoding through Schema before serializing
- [ ] 9.2 Implement debounced writes using Effect.schedule with configurable delay. Multiple rapid mutations coalesce into one write
- [ ] 9.3 Implement file watching using Effect.acquireRelease for managed lifecycle. File changes update collection Refs
- [ ] 9.4 Migrate `core/storage/transforms.ts` to work with ReadonlyMap (arrayToMap, mapToObject for file format)
- [ ] 9.5 Write tests for persistence: load/save round-trip, debounce coalescing, file watch reload, Schema decode on load, Schema encode on save

## 10. Database Factory

- [ ] 10.1 Rewrite `core/factories/database.ts`: createDatabase returns `Effect<Database, DatabaseError, DatabaseEnv>`. Wire Ref state, query pipeline (Stream-based), CRUD methods (Effect-based), persistence (Service-based)
- [ ] 10.2 Implement the composable query function: read Ref snapshot → Stream.fromIterable → pipe(filter, populate, sort, paginate, select). Return Stream with typed error channel
- [ ] 10.3 Add convenience `.runPromise` property/method to query results and CRUD return values for non-Effect consumers
- [ ] 10.4 Wire persistence hooks: after each CRUD mutation, trigger debounced save via Effect.fork
- [ ] 10.5 Wire database cleanup via Effect.acquireRelease: stop watchers, flush writes on scope close
- [ ] 10.6 Implement `findById(id)` as a first-class method using O(1) ReadonlyMap lookup

## 11. Type System Update

- [ ] 11.1 Update `core/types/types.ts`: replace z.ZodType references with Schema.Schema. Simplify GenerateDatabase, SmartCollection, QueryReturnType to leverage pipe composition instead of deep conditional nesting
- [ ] 11.2 Update QueryConfig to support Stream return type. Ensure WhereClause, PopulateConfig, SelectConfig, SortConfig types work with Effect Schema entity types
- [ ] 11.3 Update CrudMethodsWithRelationships interface: all methods return Effect instead of Promise<Result<T, E>>
- [ ] 11.4 Update `core/index.ts` exports: export new error types, Effect-based factory, Stream-based query, remove old Result/AsyncIterable exports

## 12. Tests and Examples

- [ ] 12.1 Rewrite `tests/filtering.test.ts` and `tests/filter.test.ts` using Effect test utilities (Effect.runPromise, Stream.runCollect)
- [ ] 12.2 Rewrite `tests/sorting.test.ts` for Stream-based sort
- [ ] 12.3 Rewrite `tests/populate.test.ts` for Stream-based population
- [ ] 12.4 Rewrite `tests/field-selection.test.ts`, `tests/select.test.ts`, `tests/object-select.test.ts`, `tests/select-integration.test.ts` for Stream-based select
- [ ] 12.5 Rewrite `tests/pagination.test.ts` for Stream-based pagination
- [ ] 12.6 Rewrite `tests/conditional-logic.test.ts` — fix the relationship filtering TODOs that were broken in the current implementation
- [ ] 12.7 Rewrite `tests/array-operators.test.ts` for Effect-based filtering
- [ ] 12.8 Rewrite `tests/persistence.test.ts` using Effect test Layers (in-memory storage adapter)
- [ ] 12.9 Rewrite all `tests/crud/*.test.ts` files (create, update, delete, upsert, relationships, batch-operations, type-safety)
- [ ] 12.10 Delete debug test files: cascade-debug, connect-debug, disconnect-debug, nested-create-debug, relationships-debug, type-trace
- [ ] 12.11 Rewrite at least 3 example files demonstrating the new API: basic CRUD, query with population, persistence setup

## 13. Cleanup

- [ ] 13.1 Remove all Zod imports and references from the codebase
- [ ] 13.2 Remove `core/utils/async-iterable.ts` (collect, first, count, map — replaced by Stream utilities)
- [ ] 13.3 Remove old `core/errors/crud-errors.ts` hand-rolled Result type if not already replaced
- [ ] 13.4 Verify no `as unknown as` casts remain in the database factory (the type system should be cleaner)
- [ ] 13.5 Run full test suite and verify all tests pass
