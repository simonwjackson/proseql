## Why

On 2026-10-21 a native consumer (a personal data server) wrote about 1,200 meals into a partitioned YAML source. The process kept running from memory. At the next restart, open failed and the service went into a restart loop:

```
[SerializationError] Failed to deserialize yaml data: could not find expected ':' at line 2659 column 7, while scanning a simple key at line 2658 column 7
```

The native YAML encoder (`crates/proseql-formats/src/codecs.rs`) computed a folded plain scalar's continuation indent from the prefix's leading spaces. For the first key of a list item (`- food: `) that put the continuation on the key's own column. The partitioned write path had no check that the bytes it wrote could be read again.

## What Changes

1. **Encoder.** The wrapper takes the caller's continuation indent. A seeded round-trip property test found and fixed the other shapes that did not read back: folds next to runs of blanks, `|-` blocks that lose trailing breaks or read a leading blank as indentation, plain scalars that the decoder reads as non-strings or indicators, misaligned list-item keys at indent 4, and root-level markers.
2. **Write check.** `FormatRegistry::serialize` decodes the output of every codec that declares `FormatCodec::round_trips_exactly` (the built-in YAML codec) and refuses output that does not decode to the input, with a typed `SerializationError` (`cause.reason = "round-trip-mismatch"`). It is on by default; `FormatRegistry::set_write_check(false)` turns it off.
3. **Splicer.** A YAML record's body is the shortest span that decodes to its loaded value, so a block-scalar line that looks like a blank line or comment stays with its record.
4. **Legacy TypeScript codec.** The parity test found that the `yaml` package fails at indent 4 and at width 20. When its output has a block scalar that does not read back, the codec writes quoted, unfolded scalars instead.

## Capabilities

### New Capabilities

- `yaml-write-safety`: YAML output always reads back to the written value; a write that would not is refused before it reaches disk.

### Modified Capabilities

- `FormatCodec` (Rust) gains the provided method `round_trips_exactly` (default `false`). Existing implementations compile unchanged.
- `FormatRegistry` gains `set_write_check` and `write_check`. Its fields stay private.
- `YamlCodec` gains `yaml_codec_with(indent, line_width)`.

## Impact

- **Compatibility.** No public struct gains a field. Coach builds `NativeSourceRuntimeOptions` with `..Default::default()`; the default registry has the check on. Unchanged records and blocks keep their bytes. At indent 2, output changes only for values that did not read back, plus keys starting with `---`/`...` and strings with a BOM, which are now quoted.
- **Cost.** One decode per written file: about 8 ms for an 8,346-line (287 KB) partition, about 40% of a durable create of that size (`docs/native-sources.md`, "YAML writes").
- **Parity.** The WASM engine persists through `@proseql/core`'s TypeScript codec, not the Rust codec, so it never had the native bug. A new engine test pins its YAML round trip.
- **Privacy.** All tests and the benchmark use synthetic data. No consumer data enters the repository.
