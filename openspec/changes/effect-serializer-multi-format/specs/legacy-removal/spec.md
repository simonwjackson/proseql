# Legacy Removal

## Overview

Remove the legacy (pre-Effect) serializer system, legacy persistence functions, and legacy configuration types. This code is no longer used internally — it's only re-exported from `core/index.ts` for backward compatibility.

## Files to Delete

### `core/serializers/types.ts`
Contains: `Serializer<T>` type, legacy `SerializerRegistry` type, legacy `SerializationError` class, `UnsupportedFormatError` class.

The Effect equivalents already exist:
- `SerializerRegistryShape` / `SerializerRegistry` tag in `serializer-service.ts`
- `SerializationError` / `UnsupportedFormatError` in `errors/storage-errors.ts`

### `core/serializers/json.ts`
Replaced by `core/serializers/codecs/json.ts`. Delete the entire file (both legacy factory and old Effect Layer constructor).

### `core/serializers/yaml.ts`
Replaced by `core/serializers/codecs/yaml.ts`. Delete the entire file.

### `core/serializers/messagepack.ts`
Removed entirely (binary format). Users who need MessagePack can provide a custom `FormatCodec`.

### `core/storage/persistence.ts`
Legacy persistence functions: `createPersistenceContext`, `loadData`, `saveData`, `saveDataImmediate`, `watchFile`, `fileExists`, `flushPendingWrites`. All functionality lives in `persistence-effect.ts`.

### `core/storage/types.ts`
Legacy `StorageAdapter` type and `StorageAdapterOptions`. The Effect `StorageAdapter` lives in `storage-service.ts`.

### `core/utils/file-extensions.ts`
Legacy utilities: `findSerializerForFile`, `createSerializerRegistry`, `validateFileExtensions`, `isSupportedExtension`, `getSupportedExtensions`, `isValidExtension`. Extension dispatch moves into `makeSerializerLayer`. The `getFileExtension` helper is extracted to `core/utils/path.ts`.

## Types to Remove from `core/types/database-config-types.ts`

- `PersistenceOptions` — references legacy `StorageAdapter` and `SerializerRegistry` types
- `DatabaseOptions` — wraps `PersistenceOptions`

Keep: `CollectionConfig`, `DatabaseConfig`, `isCollectionPersistent`, `PersistentCollections`, `InMemoryCollections`, `ExtractFilePaths`, `FileToCollectionsMap`.

## Exports to Remove from `core/index.ts`

All items under the `// Legacy Serializer Types`, `// Legacy serializer factories`, `// Legacy Persistence Functions`, and `// Legacy storage adapter types` sections.

## Exports to Add to `core/index.ts`

- `FormatCodec`, `FormatOptions` types
- `makeSerializerLayer` compositor
- Codec factories: `jsonCodec`, `yamlCodec`, `json5Codec`, `jsoncCodec`, `tomlCodec`
- Preset Layers: `AllTextFormatsLayer`, `DefaultSerializerLayer`

## Impact on `core/storage/persistence-effect.ts`

- Replace `import { getFileExtension } from "../utils/file-extensions.js"` with `import { getFileExtension } from "../utils/path.js"`
- No other changes needed — it already uses the Effect `SerializerRegistry` service

## Impact on `core/factories/database-effect.ts`

- No changes needed — it already uses the Effect `SerializerRegistry` service
- The provided Layer changes from `JsonSerializerLayer` to a multi-format Layer, but that's a consumer concern

## Dependency Removal

- Remove `msgpackr` from `package.json` dependencies

## Tests

- Existing tests that use `JsonSerializerLayer` or `YamlSerializerLayer` updated to use `DefaultSerializerLayer` or `makeSerializerLayer([jsonCodec()])`
- Verify `bun test` passes after removal
- Verify `bunx tsc --noEmit` passes after removal
