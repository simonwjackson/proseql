# YAML writes always read back

- id: 01M5H18KXNQ27CGEK5NYB6G7AZ
- status: completed
- created: 2026-10-22
- completed: 2026-10-22
- plan: plan.md
- driver: a native consumer's partitioned YAML file did not parse after restart (2026-10-21); the encoder folded the first key of a list item onto its own column

## Outcome

The native YAML encoder reads back exactly at indents 2 and 4 and widths 20, 80 and 120 (seeded property tests for full documents and splices). `FormatRegistry::serialize` refuses YAML output that does not decode to its input, on by default, at about 8 ms per 8,346-line write. The splicer keeps block-scalar lines that look like comments with their record. The legacy TypeScript codec falls back to quoted output where the `yaml` package's block scalars do not read back. The WASM engine never used the Rust codec. Design record: `openspec/changes/yaml-write-safety/`.
