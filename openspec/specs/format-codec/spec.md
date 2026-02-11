# Format Codec

## Overview

A `FormatCodec` is the minimal definition for a serialization format: a name, supported file extensions, and encode/decode functions. This replaces the per-format `SerializerRegistryShape` implementations and legacy `Serializer<T>` type with a single, uniform plugin point.

## Type Definition

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

- `name`: Human-readable identifier (e.g., `"json"`, `"yaml"`, `"toml"`)
- `extensions`: File extensions without dots (e.g., `["yaml", "yml"]`)
- `encode`: Synchronous function that serializes a JS value to a string. Throws on failure.
- `decode`: Synchronous function that parses a string back to a JS value. Throws on failure.

## Codec Factories

Each built-in format is a factory function returning `FormatCodec`:

```typescript
jsonCodec(options?: { indent?: number }): FormatCodec
yamlCodec(options?: { indent?: number; lineWidth?: number }): FormatCodec
json5Codec(options?: { indent?: number }): FormatCodec
jsoncCodec(options?: { indent?: number }): FormatCodec
tomlCodec(): FormatCodec
```

Factory functions allow per-instance configuration while keeping the type uniform.

## Contracts

- `encode` and `decode` are pure synchronous functions. They throw on failure — the compositor wraps them in `Effect.try`.
- `encode(decode(encode(data)))` must produce the same string as `encode(data)` for any data the format can represent (idempotent round-trip).
- `extensions` must be lowercase, without dots, and non-empty.

## Tests

- Each codec round-trips nested objects, arrays, strings, numbers, booleans
- `encode` then `decode` produces structurally equal data
- Invalid input to `decode` throws (not silently returns undefined)
- `encode` with options (indent) produces expected formatting
