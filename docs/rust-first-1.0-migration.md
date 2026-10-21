# Rust-first 1.0 migration audit

## Non-type core imports before removal

Production imports are listed below. Re-export-all entry points are package contracts. Host implementations move to engine/host with approval. Tests using the old runtime are retargeted.

- `packages/effect/src/browser/adapters/indexeddb-adapter.ts`: `StorageAdapterService as StorageAdapter` from `@proseql/core`.
- `packages/effect/src/browser/adapters/local-storage-adapter.ts`: `StorageAdapterService as StorageAdapter` from `@proseql/core`.
- `packages/effect/src/browser/adapters/session-storage-adapter.ts`: `StorageAdapterService as StorageAdapter` from `@proseql/core`.
- `packages/effect/src/browser/format-validation.ts`: `UnsupportedFormatError` from `@proseql/core`.
- `packages/effect/tests/browser-entry.test.ts`: `OperationError` from `@proseql/core`.
- `packages/effect/tests/browser-cross-tab-sync.test.ts`: `StorageAdapterService as StorageAdapter` from `@proseql/core`.
- `packages/effect/tests/browser-indexeddb-adapter.test.ts`: `StorageAdapterService as StorageAdapter` from `@proseql/core`.
- `packages/effect/tests/browser-integration.test.ts`: `createPersistentEffectDatabase, jsonCodec, makeSerializerLayer, StorageAdapterService as StorageAdapter, yamlCodec` from `@proseql/core`.
- `packages/effect/tests/browser-local-storage-adapter.test.ts`: `StorageAdapterService as StorageAdapter` from `@proseql/core`.
- `packages/effect/tests/browser-session-storage-adapter.test.ts`: `StorageAdapterService as StorageAdapter` from `@proseql/core`.
- `packages/effect/tests/browser-web-storage-adapter.test.ts`: `StorageAdapterService as StorageAdapter, UnsupportedFormatError` from `@proseql/core`.
- `packages/effect/src/browser.ts`: `*` from `@proseql/core`.
- `packages/effect/src/database.ts`: `CollectionNotFoundError, DocumentGraphSourceError, DuplicateKeyError, DuplicatePhysicalFileError, DuplicateRecordError, ForeignKeyError, getCollectionConfigs, HookError, InvalidDocumentSourceError, MigrationError, NotFoundError, OperationError, PluginError, PopulationError, SerializationError, SerializerRegistryService, SourceConfigError, StorageAdapterService as StorageAdapter, StorageError, TransactionError, UniqueConstraintError, UnknownCollectionError, UnsupportedFormatError, ValidationError` from `@proseql/core`.
- `packages/effect/src/index.ts`: `*` from `@proseql/core`.
- `packages/effect/tests/effect.test.ts`: `DuplicateKeyError, FormatCodec, OperationError, StorageAdapterService as StorageAdapter, StorageError, TransactionError, ValidationError, jsonCodec, makeInMemoryStorageLayer, makeSerializerLayer` from `@proseql/core`.
- `packages/engine/src/browser-storage-host.ts`: `StorageError, UnsupportedFormatError` from `@proseql/core`.
- `packages/engine/src/browser.ts`: `*` from `@proseql/core`.
- `packages/engine/src/browser.ts`: `OperationError` from `@proseql/core`.
- `packages/engine/src/database.ts`: `CollectionNotFoundError, dryRunMigrations, getCollectionConfigs, inferCodecsFromConfig, isSourceOrientedDatabaseConfig, loadCollectionsFromFile, loadData, loadDataFromDirectory, loadDocumentGraphSources, loadDocumentSources, loadPartitionedSource, makeSerializerLayer, mergeSerializerWithPluginCodecs, NotFoundError, normalizeSourceConfig, OperationError, PluginError, removeEntityFromDirectory, SerializerRegistryService, SourceConfigError, saveCollectionsToFile, saveData, saveDocumentSource, saveEntityToDirectory, savePartitionedSource, TransactionError, ValidationError` from `@proseql/core`.
- `packages/engine/src/errors.ts`: `CollectionNotFoundError, ConcurrencyError, DanglingReferenceError, DocumentGraphSourceError, DuplicateKeyError, DuplicatePhysicalFileError, DuplicateRecordError, ForeignKeyError, HookError, InvalidDocumentSourceError, MigrationError, NotFoundError, OperationError, PluginError, PopulationError, SerializationError, SourceConfigError, StorageError, TransactionError, UniqueConstraintError, UnknownCollectionError, UnsupportedFormatError, ValidationError` from `@proseql/core`.
- `packages/engine/src/index.ts`: `*` from `@proseql/core`.
- `packages/engine/src/plugin-registry.ts`: `validateDependencies, validateOperatorConflicts, validatePlugin` from `@proseql/core`.
- `packages/engine/src/schema-compiler.ts`: `getCollectionConfigs, isSourceOrientedDatabaseConfig, ValidationError` from `@proseql/core`.
- `packages/engine/src/storage-host-shared.ts`: `StorageAdapterService as StorageAdapter, StorageError, UnsupportedFormatError` from `@proseql/core`.
- `packages/engine/tests/browser-entry.test.ts`: `OperationError` from `@proseql/core`.
- `packages/engine/tests/engine-duplicate-ids.test.ts`: `createEffectDatabase, DuplicateKeyError, NotFoundError, ValidationError` from `@proseql/core`.
- `packages/engine/tests/engine-time-bucket.test.ts`: `SourceConfigError` from `@proseql/core`.
- `packages/engine/tests/engine-u8.test.ts`: `DuplicateKeyError, HookError, OperationError, SerializationError, StorageError, TransactionError, ValidationError` from `@proseql/core`.
- `packages/engine/tests/engine-u8.test.ts`: `applyPagination` from `../../core/src/operations/query/paginate-stream.js`.
- `packages/engine/tests/engine-u8.test.ts`: `sortData` from `../../core/src/operations/query/sort.js`.
- `packages/engine/tests/engine-u8.test.ts`: `applyPopulate` from `../../core/src/operations/relationships/populate-stream.js`.
- `packages/engine/tests/engine.test.ts`: `DuplicateKeyError, HookError, createPersistentEffectDatabase, inferCodecsFromConfig, makeSerializerLayer` from `@proseql/core`.
- `packages/engine/tests/record-key-checks.test.ts`: `createPersistentEffectDatabase as createCoreDatabase, jsonCodec, makeSerializerLayer` from `@proseql/core`.
- `packages/engine/tests/schema-checks.test.ts`: `createEffectDatabase as createCoreDatabase` from `@proseql/core`.
- `packages/rpc/src/rpc-group.ts`: `getCollectionConfigs` from `@proseql/core`.
- `packages/rpc/tests/rpc-handlers.test.ts`: `OperationError` from `@proseql/core`.

## Core source deletion and relocation

Core exports shared contract/types, tagged errors, source normalization, service tags, codecs and pure required helpers only. Its database type declarations moved out of factory implementation files into `types/database-types.ts` and the CRUD type files. Graph metadata moved into `storage/document-types.ts`. ID-generator code became its configuration type only. The unused plugin ID-reference validator was removed.

The host moves are internal engine modules, not new public engine exports. No new public host runtime export was added. Host modules import core's public contract, not source-tree runtime paths. The approved host layer has no dependency on a query, CRUD, state, index, reactive or transaction engine. Legacy watchers that mutated Ref/PubSub were removed, not moved; engine database.ts already watches files/directories/documents/graphs through host.watch/watchDir and applies atomic Rust reloads. A failed graph load does not replace its last known good state.

| Original core module | Disposition |
|---|---|
| `factories/crud-factory-with-relationships.ts` | Type declarations moved to `packages/core/src/types/crud-factory-with-relationships.ts`. |
| `factories/crud-factory.ts` | Type declarations moved to `packages/core/src/types/crud-factory.ts`. |
| `factories/database-effect.ts` | Runtime deleted; contract declarations extracted to types/database-types.ts. Factories now come only from Effect over Rust. |
| `hooks/hook-runner.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `indexes/index-lookup.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `indexes/index-manager.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `indexes/search-index.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `migrations/migration-runner.ts` | Moved internally to `packages/engine/src/host/migration-runner.ts`. |
| `operations/crud/create-with-relationships.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/crud/create.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/crud/delete-with-relationships.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/crud/delete.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/crud/unique-check.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/crud/update-with-relationships.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/crud/update.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/crud/upsert.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/query/aggregate.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/query/cursor-stream.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/query/filter-stream.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/query/filter.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/query/paginate-stream.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/query/query-helpers.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/query/resolve-computed.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/query/search.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/query/select-stream.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/query/select.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/query/sort-stream.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/query/sort.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/relationships/populate-stream.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `operations/relationships/populate.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `plugins/plugin-hooks.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `plugins/plugin-registry.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `reactive/change-event.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `reactive/change-pubsub.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `reactive/evaluate-query.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `reactive/watch-by-id.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `reactive/watch.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `state/collection-state.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `state/state-operations.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `storage/derived-id.ts` | Moved internally to `packages/engine/src/host/derived-id.ts`. |
| `storage/document-graph-source.ts` | Moved internally to `packages/engine/src/host/document-graph-source.ts`. |
| `storage/document-source.ts` | Moved internally to `packages/engine/src/host/document-source.ts`. |
| `storage/in-memory-adapter-layer.ts` | Moved internally to `packages/engine/src/host/in-memory-adapter-layer.ts`. |
| `storage/origin-index.ts` | Moved internally to `packages/engine/src/host/origin-index.ts`. |
| `storage/partitioned-source.ts` | Moved internally to `packages/engine/src/host/partitioned-source.ts`. |
| `storage/persistence-effect.ts` | Moved internally to `packages/engine/src/host/persistence-effect.ts`. |
| `storage/read-document.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `storage/transforms.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `transactions/transaction.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `types/operators.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `utils/deep-merge.ts` | Moved internally to `packages/engine/src/host/deep-merge.ts`. |
| `utils/glob-match.ts` | Moved internally to `packages/engine/src/host/glob-match.ts`. |
| `utils/nested-path.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `validators/foreign-key.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |
| `validators/schema-validator.ts` | Deleted. No remaining production consumer. Relevant public behaviour is tested through Rust/Effect; exact private test exceptions are in MIGRATED-TESTS.md. |

## Tests and proof

The full per-suite/per-test ledger is [`packages/effect/tests/MIGRATED-TESTS.md`](../packages/effect/tests/MIGRATED-TESTS.md). It accounts for all 120 original core test files, every partial private-helper removal, all 19 former corpus skips, fixed core-oracle fixtures and all 11 native dangling-fixture corrections. The original TypeScript engine is not retained as an oracle.

Verification includes a source export test (`core/tests/contract-only.test.ts`) and packed-package rejection of old core runtime artifact paths. Release verification coordinates all nine 1.0.0 packages, including AI, and runs the Rust-backed consumer rather than a core database factory.

## Browser WASM size audit

Same pinned pipeline, with Bun's node:zlib gzip level 9 and mtime 0. Each Rust fix was built in a scratch clone. Baseline and deltas reproduce the integration size exactly. JS-only fixes add zero WASM bytes.

| Commit | Fix | Browser gzip B | Delta B |
|---|---|---:|---:|
| `70f645f` | integration | 597,078 | +0 |
| `7e0a8f0` | undefined array operators | 597,084 | +6 |
| `bd5a2f2` | undefined string operators | 597,099 | +15 |
| `716e100` | createMany relationship validation | 597,640 | +541 |
| `9e411ce` | upsert field diagnostics | 597,926 | +286 |
| `bc9faad` | invalid logical conditions | 597,958 | +32 |
| `f34d202` | undefined soft-delete timestamps | 597,965 | +7 |
| `415906a` | undefined optional batch fields | 598,135 | +170 |
| `3b331c4` | plain-delete integrity | 599,078 | +943 |

Commit `8b6f3f3` avoids allocated collection snapshots and shares the delete checker, removing 182 B, reaching 598,896 B. A loop/string-concatenation trial was 217 B worse and was reverted. Deduplicating a transaction closure changed 0 B. The coordinator then approved a separate provisional cap change to 599,000 B, still pending user confirmation at landing; the 567,423 B original baseline did not change.

The final single-soft-delete correction adds 194 B, reaching **599,090 B**. The one authorized upsert-string rewrite produced 599,174 B and was reverted. No bug fix was dropped or native-gated. **The final size gate fails by 90 B. The cap remains 599,000 B.** Normal test/parity/release gates must not be reported as passing at this final source state.

Known follow-ups remain: route WASM persistence through Rust proseql-storage; REST route builders do not normalize source-oriented configs; numeric PropertyKey coercion for Record keys; the existing nix rust-format target-discovery failure. Atomic function-valued array removal is not implemented; 1.0 rejects it with ValidationError before mutation and removes it from the TS contract. Historical benchmark IDs named typescript now select the Rust-backed Effect adapter, not a retained TS engine.

An isolated clean core build and `bun pm pack --ignore-scripts` produced an **89,462 B** 1.0.0 tarball (188 dist files). Importing the extracted tarball itself exposed 58 exports and neither database factory. Inspection found no factories/operations/state/indexes/reactive/transactions/hooks/validators runtime paths. This is actual packed-core evidence, not a source-only proxy. The nine-package packed consumer/release gate remains unverified because the production WASM build is size-blocked.

Native-only lazy partition loading and durable append remain native-only. Do not infer those capabilities from the WASM facade. Nothing was published, tagged or pushed.


## Single-soft-delete follow-up

Main rejects unsupported soft deletes at `delete.ts:115-123`, before inbound validation at `126-133`. The follow-up preserves that priority and uses the existing bulk-delete materialization helper for single-delete result identity. No other optimisation is included. Browser production WASM gzip is **599,089 B**, 1 B below `040dc99` and the requested 599,090 B ceiling. The full normal TS run passes 4,067 tests with two unchanged Chromium skips; Rust passes 1,142 with two unchanged subprocess-helper ignores. The normal TS run uses an uncommitted temporary 599,090 B allowance. The source cap stays 599,000 B, so that original gate still blocks by 89 B.

## Final budget decision

After review, the `deleteMany` zero-limit fix brought the browser production WASM gzip to **599,063 B**. The user confirmed raising the cap to **600,000 B** (`browserProductionWasmGzipMaxGrowthRatio` 1.0574121951348465 over the unchanged 567,423 B baseline). The size gate now passes; the earlier "blocked" notes above record the state before that decision.
