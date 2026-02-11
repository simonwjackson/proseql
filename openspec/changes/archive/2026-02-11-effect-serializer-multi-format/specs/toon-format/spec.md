# TOON Format

## Overview

Support for `.toon` files using the `@toon-format/toon` npm package. TOON (Token-Oriented Object Notation) is a compact, human-readable encoding with a JSON-equivalent data model. It uses YAML-style indentation for nested objects and CSV-style tabular layout for uniform arrays of objects.

TOON is designed for LLM token efficiency (~40% fewer tokens than JSON), but also serves as a readable persistence format. For this database's typical data shape (objects keyed by ID), TOON output resembles YAML with indentation-based nesting.

## Codec

```typescript
toonCodec(): FormatCodec
```

- `name`: `"toon"`
- `extensions`: `["toon"]`
- `encode`: `encode(data)` from `@toon-format/toon`
- `decode`: `decode(raw)` from `@toon-format/toon`

## Data Model

TOON has a JSON-equivalent data model: objects, arrays, strings, numbers, booleans, null. All data types supported by the database round-trip without loss.

- Null values: supported (no stripping needed, unlike TOML)
- Mixed-type arrays: supported (falls back to JSON-style representation)
- Nested objects: supported (indentation-based)
- Uniform arrays of objects: optimized (CSV-style tabular layout)

## Dependency

- `@toon-format/toon` npm package

## Tests

- Round-trip: encode then decode produces structurally equal data
- Null values round-trip correctly
- Nested objects round-trip correctly
- Arrays of uniform objects round-trip correctly
- Mixed-type arrays round-trip correctly
- Empty objects and arrays round-trip correctly
