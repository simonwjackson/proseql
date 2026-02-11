# JSONC Format

## Overview

Support for `.jsonc` files (JSON with Comments). Comments are stripped on read; standard JSON is written on save. Comments in hand-edited files are **not preserved** through a write cycle.

## Codec

```typescript
jsoncCodec(options?: { indent?: number }): FormatCodec
```

- `name`: `"jsonc"`
- `extensions`: `["jsonc"]`
- `encode`: `JSON.stringify(data, null, indent)` — outputs standard JSON (no comments)
- `decode`: Strip comments using `jsonc-parser`, then `JSON.parse`

## Data Model

Identical to JSON. No data loss on round-trip (except comments in the source file).

## Comment Handling

JSONC supports `//` line comments and `/* */` block comments. The decode step strips all comments before parsing. The encode step outputs standard JSON with no comment support.

This means:
- User writes `data.jsonc` with comments by hand
- Database reads it (comments stripped)
- Database writes it back (standard JSON, comments gone)

This is a known and documented limitation, consistent with how VS Code handles `settings.json`.

## Dependency

- `jsonc-parser` npm package (Microsoft's JSONC parser, same one VS Code uses)

## Tests

- Round-trip: encode then decode produces structurally equal data
- Decode file with line comments → parsed correctly
- Decode file with block comments → parsed correctly
- Encode output contains no comments
- Null values round-trip correctly
