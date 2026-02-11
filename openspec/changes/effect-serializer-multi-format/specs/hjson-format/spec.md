# Hjson Format

## Overview

Support for `.hjson` files using the `hjson` npm package. Hjson ("Human JSON") is a JSON superset designed for human editing: it allows comments (`//`, `/* */`, `#`), unquoted strings, trailing commas, and multiline strings. The data model is identical to JSON.

## Codec

```typescript
hjsonCodec(options?: { indent?: number }): FormatCodec
```

- `name`: `"hjson"`
- `extensions`: `["hjson"]`
- `encode`: `Hjson.stringify(data, { space: indent })` — produces Hjson-formatted output (human-friendly, not standard JSON)
- `decode`: `Hjson.parse(raw)` — parses Hjson (superset of JSON; also reads standard JSON)

## Data Model

Identical to JSON: objects, arrays, strings, numbers, booleans, null. Full round-trip without data loss.

## Comment Handling

Hjson supports `//` line comments, `/* */` block comments, and `#` hash comments. Unlike JSONC:
- On **decode**: comments are stripped during parsing
- On **encode**: `Hjson.stringify` outputs clean Hjson without comments

Hand-written comments in `.hjson` files are **not preserved** through a write cycle (same limitation as JSONC).

## Hjson vs JSON5 vs JSONC

All three are JSON supersets with comment support. The distinction:

| Feature | JSON5 | JSONC | Hjson |
|---------|-------|-------|-------|
| Comments | `//`, `/* */` | `//`, `/* */` | `//`, `/* */`, `#` |
| Unquoted keys | Yes | No | Yes |
| Unquoted string values | No | No | Yes |
| Trailing commas | Yes | Yes | Yes |
| Multiline strings | No | No | Yes (`'''`) |
| Write format | JSON5 | Standard JSON | Hjson (human-friendly) |

Hjson's unique feature is **unquoted string values** and **multiline strings**, making it the most permissive for hand editing.

## Dependency

- `hjson` npm package

## Tests

- Round-trip: encode then decode produces structurally equal data
- Decode file with `//` comments → parsed correctly
- Decode file with `#` comments → parsed correctly
- Decode file with unquoted string values → parsed correctly
- Decode file with multiline strings → parsed correctly
- Null values round-trip correctly
- Nested objects and arrays round-trip correctly
- Encode output is valid Hjson (not standard JSON)
