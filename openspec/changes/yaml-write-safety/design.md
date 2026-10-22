## Context

Every native write of codec output goes through `FormatRegistry::serialize`: collection files and partitions (`persistence::save_data`), document sources (`document_source::plan_document_source`, which also splices), single-file mode and migration write-back. Planning encodes every changed file before the first durable write (`proseql-native` `commit_source_mutation`). Document sources already decoded the spliced file before writing; partitions and collection files did not.

## Decisions

### Fix the encoder at the caller's indent

The caller of `wrap_yaml_plain_scalar_with_width` already knows the column of the key or entry that owns the scalar and passes `continuation_indent` for block scalars. The wrapper now takes the same value. At indent 2 this is the old continuation for every prefix except `- key: `, so other output keeps its bytes. Quoting or a block scalar for long list-item values was rejected: it changes bytes for valid shapes and is not needed.

### Quote what does not read back; keep plain and `|-` otherwise

Each rule was found by the property test and is the narrowest change that makes the shape read back. Numbers in YAML forms (`0x1A`, `.inf`) are detected by asking the decoder itself, after a cheap character prefilter, in the value position the encoder uses. Multi-line text keeps `|-` when it reads back and is double-quoted otherwise, rather than computing indentation indicators.

### Check at the registry, opt in per codec

The check sits in `FormatRegistry::serialize`, the one path to disk, and runs for codecs that declare `round_trips_exactly`. A per-codec flag keeps lossy codecs (TOML drops nulls, Prose keeps a template) and third-party codecs unchanged. Putting the check inside `YamlCodec::encode` was rejected: a test could not force bad output through it, and a replacement YAML codec would bypass it.

The error is `SerializationError` with a structured cause, not a new `EngineError` variant, so the TypeScript `_tag` contract does not change. The cause names a JSON pointer, never values, because messages reach logs.

Because the refusal happens during planning, no file is touched, memory rolls back, and the runtime is not quarantined. This follows the existing crash rule: quarantine applies after a write-stage error.

### Default on

Measured cost is one decode per written file (about 8 ms at 8,346 lines). A file that cannot be opened costs a restart loop and manual repair. The setting exists for callers that already verify their exact bytes.

### Splice record bodies by value, not by line class

The splicer classified trailing blank and `#` lines as separators. That is wrong when a block scalar ends with such a line. The body is now the shortest prefix of the entry's span that decodes to the entry's loaded value. An extra decode runs only for entries followed by trivia.

### Legacy TypeScript codec: fall back only when needed

The `yaml` package fails at indent 4 (`|2-` indicator) and at narrow widths (folded leading break). The codec decodes only output that contains a block-scalar header, and falls back to `lineWidth: 0, blockQuote: false` when it does not read back. Output without block scalars keeps its bytes and costs nothing extra; decoding every write would cost about 79 ms for an 8,000-line file in TypeScript.

## Risks

- The check doubles decode work for changed YAML documents, which also run the splice check.
- Values that no YAML text reproduces exactly would be refused. JSON values from the engine have none; the property test covers numbers, unicode, control characters and line breaks.
- Files written by the old encoder that parsed but changed strings (for example `0x1A` read as `26`) cannot be detected.
