# Effect Serializer Multi-Format — Design

## Architecture

### New Modules

**`core/serializers/format-codec.ts`** — The `FormatCodec` type and the `makeSerializerLayer` compositor. `FormatCodec` is the minimal per-format definition: name, extensions, encode, decode. `makeSerializerLayer` takes an array of codecs and builds a single `SerializerRegistry` Layer that dispatches by extension.

**`core/serializers/codecs/json.ts`** — JSON codec. Wraps `JSON.stringify`/`JSON.parse` with configurable indent.

**`core/serializers/codecs/yaml.ts`** — YAML codec. Wraps `yaml` package with configurable indent/lineWidth.

**`core/serializers/codecs/json5.ts`** — JSON5 codec. Wraps `json5` package.

**`core/serializers/codecs/jsonc.ts`** — JSONC codec. Uses `jsonc-parser` to strip comments on read; writes standard JSON.

**`core/serializers/codecs/toml.ts`** — TOML codec. Wraps `smol-toml`. Strips `null` values recursively on encode; missing keys naturally become `undefined` on decode.

**`core/serializers/codecs/toon.ts`** — TOON codec. Wraps `@toon-format/toon` package. JSON-equivalent data model — full round-trip for objects, arrays, strings, numbers, booleans, null.

**`core/serializers/codecs/hjson.ts`** — Hjson codec. Wraps `hjson` package. Comments stripped on read; Hjson.stringify on write (produces Hjson output with human-friendly formatting). JSON-equivalent data model.

**`core/serializers/presets.ts`** — Pre-built Layer combinations: `AllTextFormatsLayer`, `JsonYamlLayer`, `DefaultSerializerLayer` (JSON + YAML for backward compat).

### Modified Modules

**`core/serializers/serializer-service.ts`** — No changes. The `SerializerRegistry` tag and `SerializerRegistryShape` interface remain identical. Consumer code is unaffected.

**`core/index.ts`** — Remove all legacy serializer exports. Add new exports: `FormatCodec`, codec instances, `makeSerializerLayer`, preset Layers.

### Deleted Modules

**`core/serializers/types.ts`** — Legacy `Serializer<T>`, `SerializerRegistry` type, `SerializationError` class, `UnsupportedFormatError` class.

**`core/serializers/json.ts`** — Replaced by `core/serializers/codecs/json.ts`.

**`core/serializers/yaml.ts`** — Replaced by `core/serializers/codecs/yaml.ts`.

**`core/serializers/messagepack.ts`** — Removed (binary format; can be re-added as user codec).

**`core/storage/persistence.ts`** — Legacy persistence functions. All functionality lives in `persistence-effect.ts`.

**`core/utils/file-extensions.ts`** — Legacy registry utilities. Extension lookup moves into `makeSerializerLayer`. The `getFileExtension` helper moves to `persistence-effect.ts` (already imported there).

**`core/types/database-config-types.ts`** — Remove `PersistenceOptions`, `DatabaseOptions` types. Keep `CollectionConfig`, `DatabaseConfig`, and related types (they're used by the Effect system).

**`core/storage/types.ts`** — Legacy `StorageAdapter` type and `StorageAdapterOptions`. The Effect `StorageAdapter` service lives in `storage-service.ts`.

## Key Decisions

### FormatCodec is a plain object, not an Effect

```typescript
interface FormatCodec {
  readonly name: string
  readonly extensions: ReadonlyArray<string>
  readonly encode: (data: unknown, options?: FormatOptions) => string
  readonly decode: (raw: string) => unknown
}

interface FormatOptions {
  readonly indent?: number
}
```

Encode/decode are synchronous throwing functions. The compositor wraps them in `Effect.try` with proper `SerializationError` tagging. This keeps codecs simple, testable, and dependency-free on Effect.

### The compositor does all the work

`makeSerializerLayer` handles:
1. Building an extension → codec lookup map
2. Wrapping encode/decode in `Effect.try` with `SerializationError`
3. Producing `UnsupportedFormatError` for unknown extensions
4. Returning a `Layer.Layer<SerializerRegistry>`

This means every codec is identical in shape — no per-format boilerplate.

### TOML null handling: strip on write, absent on read

TOML has no `null` type. The TOML codec strips `null` values recursively before encoding:

```typescript
{ name: "Alice", middleName: null, age: 29 }
→ TOML: name = "Alice"\nage = 29
```

On decode, the key is simply absent. Effect Schema handles this naturally: `Schema.optional(Schema.String)` accepts `undefined` (missing key). Schemas with required nullable fields (`Schema.NullOr(Schema.String)`) won't round-trip through TOML — this is documented, not prevented.

### JSONC: comments lost on write

JSONC files are parsed by stripping comments, then treated as JSON. On write, standard JSON is output. Comments in hand-edited `.jsonc` files do not survive a save cycle. This is the same behavior as VS Code's settings.json and is documented as a known limitation.

### getFileExtension stays as a shared helper

The `getFileExtension` function from `file-extensions.ts` is still needed by `persistence-effect.ts`. Rather than moving it into the compositor, it stays as a small utility — either inline in `persistence-effect.ts` or in a minimal `core/utils/path.ts`.

### Preset Layers provide convenience without magic

```typescript
// All built-in text formats
export const AllTextFormatsLayer = makeSerializerLayer([
  jsonCodec(), yamlCodec(), json5Codec(), jsoncCodec(), tomlCodec(), toonCodec(), hjsonCodec()
])

// JSON + YAML only (backward-compatible default)
export const DefaultSerializerLayer = makeSerializerLayer([
  jsonCodec(), yamlCodec()
])
```

Users can also build custom combinations:
```typescript
const myLayer = makeSerializerLayer([jsonCodec({ indent: 4 }), tomlCodec()])
```

### Codec factories accept options, return FormatCodec

Each codec module exports a factory function (e.g., `jsonCodec(options?)`) that returns a `FormatCodec`. This allows configuration (indent, line width) while keeping the type uniform.

```typescript
export const jsonCodec = (options?: { indent?: number }): FormatCodec => ({
  name: "json",
  extensions: ["json"],
  encode: (data) => JSON.stringify(data, null, options?.indent ?? 2),
  decode: (raw) => JSON.parse(raw),
})
```

### No extension collision protection at the type level

If two codecs claim the same extension, the last one wins (same as the legacy `createSerializerRegistry`). A `console.warn` is emitted. This is a runtime concern, not a type-level one.

## File Layout

```
core/
  serializers/
    format-codec.ts              (new — FormatCodec type, makeSerializerLayer)
    serializer-service.ts        (unchanged — SerializerRegistry tag)
    presets.ts                   (new — AllTextFormatsLayer, DefaultSerializerLayer)
    codecs/
      json.ts                    (new — jsonCodec factory)
      yaml.ts                    (new — yamlCodec factory)
      json5.ts                   (new — json5Codec factory)
      jsonc.ts                   (new — jsoncCodec factory)
      toml.ts                    (new — tomlCodec factory)
      toon.ts                    (new — toonCodec factory)
      hjson.ts                   (new — hjsonCodec factory)
    json.ts                      (deleted)
    yaml.ts                      (deleted)
    messagepack.ts               (deleted)
    types.ts                     (deleted)
  storage/
    persistence.ts               (deleted)
    persistence-effect.ts        (modified — inline getFileExtension or import from utils/path)
    storage-service.ts           (unchanged)
    types.ts                     (deleted)
    node-adapter.ts              (check if still needed or replaced by Effect adapter)
  utils/
    file-extensions.ts           (deleted — getFileExtension extracted to utils/path.ts)
    path.ts                      (new — getFileExtension only)
  types/
    database-config-types.ts     (modified — remove PersistenceOptions, DatabaseOptions)
  index.ts                       (modified — swap legacy exports for new codec/preset exports)
tests/
  serializers/
    format-codec.test.ts         (new — compositor tests)
    codecs.test.ts               (new — per-codec round-trip tests)
    toml-nulls.test.ts           (new — TOML null-stripping edge cases)
```
