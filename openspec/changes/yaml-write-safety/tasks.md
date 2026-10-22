## 1. Track A — Reproduce and fix the encoder (no dependencies)

- [x] 1.1 Add `crates/proseql-formats/tests/yaml_wrap_regression.rs` (first key, later key, nested lists of objects, bare items; fails before the fix), pass the caller's `continuation_indent` into `wrap_yaml_plain_scalar_with_width`, add the seeded property test `yaml_round_trip_property.rs` with the shared generator `tests/support/yaml_values.rs` (indents 2 and 4, widths 20, 80, 120; `PROSEQL_YAML_PROPERTY_CASES`), and fix every shape it finds; add `yaml_codec_with(indent, line_width)`; give the two document-source tests that relied on the old trailing-newline loss a lossy test codec.

  - Done in `2e9e56b`. 40,000 cases per configuration passed in release mode.

## 2. Track B — Write check (blocked by Track A)

- [x] 2.1 Add `FormatCodec::round_trips_exactly` (default `false`, `true` for YAML), the registry write check with `set_write_check`/`write_check`, and `SerializationError` with `cause { reason: "round-trip-mismatch", pointer?, detail }`; test with a codec forced to produce unparseable and wrong output (`proseql-formats/tests/yaml_write_check.rs`) and through the native runtime on the production shape (`proseql-native/tests/yaml_write_safety_runtime.rs`: file unchanged, rollback, no quarantine, multi-partition refusal); add `examples/yaml_write_check_bench.rs` and record the cost.

  - Done in `b2c2af4`.

## 3. Track C — Splice path (blocked by Track A)

- [x] 3.1 Add the document-source property test `proseql-storage/tests/yaml_write_property.rs` (new files and splices over several rounds, all indents and widths) and fix what it finds: record bodies are the shortest span that decodes to the loaded value.

  - Done in `cf7c51c`. 500 seeds per configuration passed in release mode.

## 4. Track D — Parity (blocked by Track A)

- [x] 4.1 Confirm the WASM engine's YAML path, add `packages/engine/tests/engine-yaml-round-trip.test.ts`, add the legacy codec parity test `packages/core/tests/yaml-codec-round-trip.test.ts` with shared hazards in `packages/core/tests/fixtures/yaml-hazards.ts`, and fix the legacy codec only where it fails.

  - Done in `20ccb0b`. The WASM engine uses the TypeScript codec, so it never had the native bug. The `yaml` package failed at indent 4 and width 20; the codec now falls back to quoted output there.

## 5. Track E — Documentation (blocked by Track B + C + D)

- [x] 5.1 Document the write check, its error, cost and setting, the encoder rules, and which files written by the old encoder need repair in `docs/native-sources.md`.

## 6. Track F — Verification (blocked by Track A + B + C + D + E)

- [x] 6.1 Run `nix run .#rust-test`, `nix run .#rust-lint`, `nix run .#rust-format-check`, `nix run .#test`, `nix run .#typecheck`, `nix run .#lint`, and the Coach compatibility example through `./scripts/check-coach-copy.py`.
