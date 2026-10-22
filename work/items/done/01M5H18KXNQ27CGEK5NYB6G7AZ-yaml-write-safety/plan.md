---
title: "fix: YAML writes always read back"
type: fix
status: completed
date: 2026-10-22
verify_command: "nix run .#rust-test && nix run .#test"
---

# fix: YAML writes always read back

The proposal, design, requirements and task record are in `openspec/changes/yaml-write-safety/`. User-facing behaviour, cost and repair guidance are in `docs/native-sources.md`, section "YAML writes".

## Requirements

- R1. A failing reproduction: the first key of a list item holds a long plain string with spaces; the same case for a later key and for nested lists of objects.
- R2. Every wrapped plain scalar continues deeper than its key's column.
- R3. A seeded property test: encode then decode returns the same value over generated JSON values, at indents 2 and 4 and widths 20, 80 and 120, for full-document encoding and the YAML splice path.
- R4. Before a YAML write becomes durable, decode the bytes and compare them with the intended value; refuse a mismatch with a typed error and leave the file unchanged. Measure the cost on a file of about 8,000 lines.
- R5. Parity: the WASM engine and the legacy TypeScript codec pass the same round trip.
- R6. Unchanged blocks and records keep their bytes; Coach's compatibility example keeps passing; no consumer data enters the repository.

## Verification

- `crates/proseql-formats/tests/yaml_wrap_regression.rs` failed before the fix (3 of 4 tests) and passes after.
- `yaml_round_trip_property.rs` and `yaml_write_property.rs` pass; run more cases with `PROSEQL_YAML_PROPERTY_CASES`.
- `yaml_write_check.rs` and `yaml_write_safety_runtime.rs` force bad encoder output.
- `nix run .#rust-test`, `nix run .#test`, `./scripts/check-coach-copy.py`.
