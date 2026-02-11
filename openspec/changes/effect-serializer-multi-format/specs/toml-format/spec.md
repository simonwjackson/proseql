# TOML Format

## Overview

Support for `.toml` files using `smol-toml`. TOML is a human-readable configuration format with typed values. It has a data model gap: **no null type**. This codec handles the mismatch by stripping null values on write and treating missing keys as absent on read.

## Codec

```typescript
tomlCodec(): FormatCodec
```

- `name`: `"toml"`
- `extensions`: `["toml"]`
- `encode`: Strip null values recursively from the data, then `TOML.stringify`
- `decode`: `TOML.parse(raw)` — TOML dates are returned as `Date` objects; all other types map naturally to JS

## Null Handling

### On Write (encode)

Null values are recursively removed before TOML serialization:

```
Input:  { name: "Alice", middleName: null, age: 29 }
TOML:   name = "Alice"
        age = 29
```

The `stripNulls` helper recursively walks the object:
- `null` values → key omitted
- `undefined` values → key omitted
- Nested objects → recursed
- Arrays → null elements removed (TOML arrays must be homogeneous)
- All other values → preserved

### On Read (decode)

Missing keys are simply absent from the parsed object. Effect Schema handles this naturally:
- `Schema.optional(Schema.String)` → accepts missing key (undefined)
- `Schema.NullOr(Schema.String)` → **will fail** because TOML returns `undefined` (missing), not `null`

Schemas with required nullable fields (`NullOr`) are incompatible with TOML. This is a documented limitation.

## TOML-Specific Type Behavior

- **Integers and floats**: TOML distinguishes integers from floats. `42` parses as integer, `42.0` as float. Both map to JS `number`.
- **Dates**: TOML has first-class date/time types. `smol-toml` returns them as `Date` objects. If the database stores ISO date strings, they'll need to be stringified in the schema's encode step (not the codec's responsibility).
- **Arrays**: Must be homogeneous in TOML. `["a", 1]` is invalid TOML. The codec does not validate this — `smol-toml` will throw on encode, which becomes a `SerializationError`.
- **Nested tables**: TOML represents nested objects as `[section]` headers. Deeply nested data works but produces verbose output.

## Dependency

- `smol-toml` npm package

## Tests

- Round-trip: encode then decode produces structurally equal data (for TOML-compatible data)
- Null values stripped on encode, absent on decode
- Nested objects with null leaves → nulls stripped at all levels
- Arrays with null elements → nulls removed
- TOML date values decoded correctly
- Mixed-type array on encode → throws (SerializationError)
- Deeply nested objects round-trip correctly
