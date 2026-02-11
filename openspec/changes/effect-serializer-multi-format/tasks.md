## 1. FormatCodec Type and Compositor

- [x] 1.1 Create `core/serializers/format-codec.ts` with `FormatCodec` interface (`name`, `extensions`, `encode`, `decode`) and `FormatOptions` interface (`indent?`)
- [x] 1.2 Implement `makeSerializerLayer(codecs: ReadonlyArray<FormatCodec>): Layer.Layer<SerializerRegistry>` in the same file. Build extension→codec lookup map, wrap encode/decode in `Effect.try` producing `SerializationError`, produce `UnsupportedFormatError` for unknown extensions. Log `console.warn` on duplicate extensions (last wins).

## 2. Built-in Codecs

- [x] 2.1 Create `core/serializers/codecs/json.ts`: `jsonCodec(options?: { indent?: number }): FormatCodec`. Extensions: `["json"]`. Uses `JSON.stringify`/`JSON.parse`.
- [x] 2.2 Create `core/serializers/codecs/yaml.ts`: `yamlCodec(options?: { indent?: number; lineWidth?: number }): FormatCodec`. Extensions: `["yaml", "yml"]`. Uses `yaml` package.
- [ ] 2.3 Create `core/serializers/codecs/json5.ts`: `json5Codec(options?: { indent?: number }): FormatCodec`. Extensions: `["json5"]`. Uses `json5` package.
- [ ] 2.4 Create `core/serializers/codecs/jsonc.ts`: `jsoncCodec(options?: { indent?: number }): FormatCodec`. Extensions: `["jsonc"]`. Uses `jsonc-parser` to strip comments on decode; `JSON.stringify` on encode.
- [ ] 2.5 Create `core/serializers/codecs/toml.ts`: `tomlCodec(): FormatCodec`. Extensions: `["toml"]`. Uses `smol-toml`. Implement `stripNulls` recursive helper for encode.
- [ ] 2.6 Install dependencies: `bun add json5 jsonc-parser smol-toml`

## 3. Preset Layers

- [ ] 3.1 Create `core/serializers/presets.ts`: export `AllTextFormatsLayer` (all 5 codecs), `DefaultSerializerLayer` (json + yaml).

## 4. Extract getFileExtension

- [ ] 4.1 Create `core/utils/path.ts` with `getFileExtension` function (extracted from `core/utils/file-extensions.ts`).
- [ ] 4.2 Update `core/storage/persistence-effect.ts` to import `getFileExtension` from `../utils/path.js` instead of `../utils/file-extensions.js`.

## 5. Update index.ts Exports

- [ ] 5.1 Remove all legacy serializer type exports (`Serializer`, `LegacySerializerRegistry`, `SerializationError` from types.ts, `UnsupportedFormatError` from types.ts)
- [ ] 5.2 Remove all legacy serializer factory exports (`createJsonSerializer`, `defaultJsonSerializer`, `compactJsonSerializer`, `createYamlSerializer`, `defaultYamlSerializer`, `compactYamlSerializer`, `prettyYamlSerializer`, `createMessagePackSerializer`, `defaultMessagePackSerializer`)
- [ ] 5.3 Remove all legacy persistence exports (`createPersistenceContext`, `legacyLoadData`, `legacySaveData`, `saveDataImmediate`, `watchFile`, `fileExists`, `flushPendingWrites`, `PersistenceContext`)
- [ ] 5.4 Remove legacy storage adapter exports (`LegacyStorageAdapter`, `StorageAdapterOptions`, `createNodeStorageAdapter`, `defaultNodeStorageAdapter`)
- [ ] 5.5 Add new exports: `FormatCodec`, `FormatOptions` types, `makeSerializerLayer`, codec factories (`jsonCodec`, `yamlCodec`, `json5Codec`, `jsoncCodec`, `tomlCodec`), preset Layers (`AllTextFormatsLayer`, `DefaultSerializerLayer`)

## 6. Remove PersistenceOptions/DatabaseOptions

- [ ] 6.1 Remove `PersistenceOptions` and `DatabaseOptions` types from `core/types/database-config-types.ts`. Remove the import of legacy `SerializerRegistry` and `StorageAdapter` from types.ts. Keep all other types.

## 7. Delete Legacy Files

- [ ] 7.1 Delete `core/serializers/types.ts`
- [ ] 7.2 Delete `core/serializers/json.ts`
- [ ] 7.3 Delete `core/serializers/yaml.ts`
- [ ] 7.4 Delete `core/serializers/messagepack.ts`
- [ ] 7.5 Delete `core/storage/persistence.ts`
- [ ] 7.6 Delete `core/storage/types.ts`
- [ ] 7.7 Delete `core/utils/file-extensions.ts`
- [ ] 7.8 Delete `core/storage/node-adapter.ts` (legacy adapter; Effect version in `node-adapter-layer.ts`)
- [ ] 7.9 Remove `msgpackr` dependency: `bun remove msgpackr`

## 8. Update Existing Tests

- [ ] 8.1 Update `tests/json-serializer.test.ts`: replace `JsonSerializerLayer`/`makeJsonSerializerLayer` imports with `makeSerializerLayer([jsonCodec()])`. Adapt tests for new API.
- [ ] 8.2 Update `tests/yaml-serializer.test.ts`: replace `YamlSerializerLayer`/`makeYamlSerializerLayer` imports with `makeSerializerLayer([yamlCodec()])`. Adapt tests.
- [ ] 8.3 Update `tests/messagepack-serializer.test.ts`: delete file (MessagePack removed).
- [ ] 8.4 Update `tests/serializer-service.test.ts`: replace test registry with `makeSerializerLayer`. Verify multi-format dispatch.
- [ ] 8.5 Update `tests/storage-services.test.ts`: replace all `JsonSerializerLayer`/`YamlSerializerLayer`/`MessagePackSerializerLayer` with codec-based layers. Remove MessagePack tests.
- [ ] 8.6 Update `tests/persistence-effect.test.ts`: replace serializer layer imports.
- [ ] 8.7 Update `tests/persistence.test.ts`: replace serializer layer imports. Remove MessagePack test helpers.
- [ ] 8.8 Update `tests/file-watcher.test.ts`: replace serializer layer imports.
- [ ] 8.9 Update `tests/debounced-writer.test.ts`: replace serializer layer imports.
- [ ] 8.10 Update `tests/database-effect.test.ts`: replace serializer layer imports.
- [ ] 8.11 Update `tests/schema-migrations.test.ts`: replace serializer layer imports.

## 9. New Tests

- [ ] 9.1 Create `tests/format-codec.test.ts`: test `makeSerializerLayer` — multi-format dispatch, unknown extension error, duplicate extension warning, error propagation from codecs.
- [ ] 9.2 Create `tests/codecs.test.ts`: round-trip tests for all 5 codecs (json, yaml, json5, jsonc, toml). Test nested objects, arrays, strings, numbers, booleans, null handling.
- [ ] 9.3 Create `tests/toml-nulls.test.ts`: TOML-specific null stripping — nested nulls, arrays with nulls, empty objects after stripping, deeply nested structures.
- [ ] 9.4 Create `tests/jsonc-comments.test.ts`: JSONC decode with line comments, block comments, mixed comments. Verify encode outputs clean JSON.
- [ ] 9.5 Test preset Layers: `AllTextFormatsLayer` dispatches all 5 extensions, `DefaultSerializerLayer` dispatches json/yaml only.

## 10. Verification

- [ ] 10.1 Run `bunx tsc --noEmit` — verify no type errors
- [ ] 10.2 Run `bun test` — verify all tests pass
- [ ] 10.3 Verify no remaining imports of deleted files across the codebase
