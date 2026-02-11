# Multi-Format Registry

## Overview

The `makeSerializerLayer` compositor takes an array of `FormatCodec` instances and builds a single `SerializerRegistry` Effect Layer that dispatches serialize/deserialize calls by file extension. This replaces the single-format-per-Layer limitation and the legacy `createSerializerRegistry` utility.

## API

```typescript
const makeSerializerLayer: (
  codecs: ReadonlyArray<FormatCodec>
) => Layer.Layer<SerializerRegistry>
```

The returned Layer provides a `SerializerRegistryShape` that:
1. On `serialize(data, extension)`: finds the codec whose `extensions` includes `extension`, calls `codec.encode(data)` wrapped in `Effect.try`, maps errors to `SerializationError`
2. On `deserialize(raw, extension)`: finds the codec whose `extensions` includes `extension`, calls `codec.decode(raw)` wrapped in `Effect.try`, maps errors to `SerializationError`
3. For unknown extensions: fails with `UnsupportedFormatError`

## Extension Dispatch

Internally, the compositor builds a `Map<string, FormatCodec>` keyed by extension at Layer construction time. Lookup is O(1).

If two codecs claim the same extension, the last codec in the array wins. A warning is logged via `console.warn`.

## Preset Layers

Pre-built combinations for convenience:

```typescript
// All 7 built-in text formats
const AllTextFormatsLayer: Layer.Layer<SerializerRegistry>

// JSON + YAML (backward-compatible default)
const DefaultSerializerLayer: Layer.Layer<SerializerRegistry>
```

## Error Mapping

- Codec `encode`/`decode` throws → `SerializationError` with `format` set to codec name
- Extension not found → `UnsupportedFormatError` with `format` set to the requested extension and `message` listing available extensions

## Tests

- Registry with multiple codecs dispatches correctly by extension
- Unknown extension produces `UnsupportedFormatError`
- Duplicate extension: last codec wins, warning emitted
- Empty codecs array: all extensions produce `UnsupportedFormatError`
- Codec that throws on encode → `SerializationError` propagated
- Codec that throws on decode → `SerializationError` propagated
- Preset Layers: `AllTextFormatsLayer` dispatches all 7 formats, `DefaultSerializerLayer` dispatches json/yaml only
