## Why

The serializer system currently exists as two parallel implementations: a legacy `Serializer<T>` interface with manual registry composition, and an Effect-based `SerializerRegistry` service that can only hold one format at a time. This dual system creates several problems:

1. **The Effect system can't handle mixed formats.** If a database has `users.yaml` and `posts.json`, the single-format `SerializerRegistry` Layer fails on one of them. The legacy system solved this with `createSerializerRegistry()`, but that approach is incompatible with the Effect service model.

2. **Adding a new format requires ~140 lines of boilerplate** duplicated across both systems (legacy + Effect), when the actual format logic is 2 functions (encode + decode).

3. **Only 3 formats are supported** (JSON, YAML, MessagePack). Users working with TOML, JSON5, or JSONC config files have no path to use them.

4. **The legacy system is dead weight.** No internal code depends on it — it's only re-exported from `index.ts`. It should be removed, not maintained alongside the Effect system.

## What Changes

- Replace per-format `SerializerRegistryShape` implementations with a `FormatCodec` record type (name, extensions, encode, decode) and a compositor that builds a single multi-format `SerializerRegistry` Layer
- Add built-in codecs for JSON5 (`.json5`), JSONC (`.jsonc`), TOML (`.toml`), TOON (`.toon`), and Hjson (`.hjson`) alongside existing JSON and YAML
- Remove the legacy `Serializer<T>` type, legacy serializer factories, legacy `persistence.ts`, legacy `PersistenceOptions`/`DatabaseOptions` types, and all related re-exports from `index.ts`
- Remove MessagePack (binary format doesn't align with the plain-text identity; can be re-added as a user-provided codec)

## Capabilities

### New Capabilities

- `format-codec`: Minimal per-format definition type — name, extensions, encode/decode functions — that makes adding formats trivial
- `multi-format-registry`: A compositor that builds a single Effect `SerializerRegistry` Layer from multiple `FormatCodec` instances, dispatching by file extension
- `json5-format`: Read/write `.json5` files (comments, trailing commas, unquoted keys on read; pretty output on write)
- `jsonc-format`: Read/write `.jsonc` files (comments stripped on read; standard JSON on write — comments not preserved through round-trip)
- `toml-format`: Read/write `.toml` files (null values omitted on write; missing keys treated as absent on read)
- `toon-format`: Read/write `.toon` files (Token-Oriented Object Notation — compact, LLM-friendly encoding with JSON-equivalent data model)
- `hjson-format`: Read/write `.hjson` files (Human JSON — comments, unquoted strings, trailing commas on read; comments not preserved on write)

### Modified Capabilities

- `effect-persistence`: `SerializerRegistry` Layer now supports multiple formats simultaneously — no change to consumer code (`persistence-effect.ts` already uses extension-based dispatch)

### Removed Capabilities

- `legacy-serializer-types`: `Serializer<T>`, `SerializerRegistry` (legacy type), `SerializationError` (legacy class), `UnsupportedFormatError` (legacy class) from `core/serializers/types.ts`
- `legacy-persistence`: `createPersistenceContext`, `legacyLoadData`, `legacySaveData`, `saveDataImmediate`, `watchFile`, `fileExists`, `flushPendingWrites`, `PersistenceContext` from `core/storage/persistence.ts`
- `legacy-config-types`: `PersistenceOptions`, `DatabaseOptions` from `core/types/database-config-types.ts`
- `legacy-serializer-factories`: `createJsonSerializer`, `createYamlSerializer`, `createMessagePackSerializer` and their preset instances
- `legacy-file-extension-utils`: `findSerializerForFile`, `createSerializerRegistry`, `validateFileExtensions`, `isSupportedExtension`, `getSupportedExtensions`, `isValidExtension` from `core/utils/file-extensions.ts`
- `messagepack-format`: Binary format removed from built-in set (can be provided as user codec)

## Impact

- **Breaking change**: Any external code using the legacy serializer API (`createJsonSerializer`, `Serializer<T>`, `createSerializerRegistry`, `PersistenceOptions`, etc.) will break. This is intentional — the project is migrating to Effect.
- **New dependencies**: `json5`, `jsonc-parser` (or equivalent), `smol-toml` (or equivalent), `@toon-format/toon`, `hjson` npm packages
- **Removed dependency**: `msgpackr`
- **Data files**: No change to on-disk format. JSON and YAML files continue to work. Users can now also use `.json5`, `.jsonc`, `.toml`, `.toon`, `.hjson` extensions.
- **Consumer code**: Effect-based code (`persistence-effect.ts`, `database-effect.ts`) needs no changes — it already uses the `SerializerRegistry` service by extension. The only change is providing a multi-format Layer instead of a single-format one.
