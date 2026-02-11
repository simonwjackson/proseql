# JSON5 Format

## Overview

Support for `.json5` files using the `json5` npm package. JSON5 is a superset of JSON that allows comments, trailing commas, unquoted keys, and other human-friendly syntax on read. On write, output is formatted JSON5 (or standard JSON, depending on library behavior).

## Codec

```typescript
json5Codec(options?: { indent?: number }): FormatCodec
```

- `name`: `"json5"`
- `extensions`: `["json5"]`
- `encode`: `JSON5.stringify(data, null, indent)`
- `decode`: `JSON5.parse(raw)`

## Data Model

JSON5 has the same data model as JSON: objects, arrays, strings, numbers, booleans, null. All data types supported by the database round-trip without loss.

## Dependency

- `json5` npm package

## Tests

- Round-trip: encode then decode produces structurally equal data
- Decode file with comments → comments stripped, data intact
- Decode file with trailing commas → parsed correctly
- Decode file with unquoted keys → parsed correctly
- Null values round-trip correctly
- Nested objects and arrays round-trip correctly
