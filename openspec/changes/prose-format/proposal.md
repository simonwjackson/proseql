## Why

Every format ProseQL supports today (JSON, YAML, TOML, JSON5, JSONC, Hjson, TOON) is schema-ignorant — universal containers that know nothing about the data they hold. ProseQL *does* know the schema, but persisted files don't reflect that knowledge. The `.prose` format bridges this gap: a template-driven text format where each collection file reads like a purpose-built document for its data, not a generic serialization dump. It makes data files genuinely readable, produces clean single-line git diffs per record, and embodies the project's name — prose.

## What Changes

- Add a new `proseCodec()` factory returning a `FormatCodec` with extension `["prose"]`
- The codec parses and produces `.prose` files: a `@prose` template header followed by records that match the template pattern
- Template syntax uses `{fieldName}` placeholders with literal delimiter text between them (e.g., `@prose #{id} "{title}" by {authorId} ({year}) — {genre}`)
- Multi-line templates: indented lines after `@prose` define overflow field templates using the same literal + `{field}` syntax
- Values support: bare strings, `"quoted"` strings (when value contains delimiter characters), numbers, booleans (`true`/`false`), null (`~`), arrays (`[a, b, c]`)
- No nested objects — `.prose` is for flat, record-oriented collections
- Comments by omission: any non-indented line that doesn't match the headline template is preserved as a comment
- Multi-line field values via deeper indentation (continuation lines)
- IDs are explicit in templates (e.g., `#{id}`) — required for stable foreign key references across collections
- Register the codec in `AllTextFormatsLayer`

## Capabilities

### New Capabilities

- `prose-format`: Template-driven text format codec — template syntax, parsing rules, encoding rules, value types, quoting/escaping, overflow fields, multi-line continuation, comment preservation, and round-trip fidelity

### Modified Capabilities

- `multi-format-registry`: `AllTextFormatsLayer` adds the prose codec to the built-in format list (8 formats becomes 9)

## Impact

- `packages/core/src/serializers/codecs/` — new `prose.ts` codec implementation
- `packages/core/src/serializers/format-codec.ts` — add `proseCodec()` export, update `AllTextFormatsLayer`
- `packages/core/src/index.ts` — export `proseCodec`
- `packages/core/tests/` — new test file for prose codec
- No breaking changes to existing APIs
- No new dependencies (parser is hand-written, no external library needed)
