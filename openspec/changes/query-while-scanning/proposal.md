# Query while scanning (#12)

## Why

At `61c4322` native reads decode and index entire partitions before evaluating queries. Stage 0 (#13) must measure SQLite, that unchanged runtime, and an isolated portable scalar scanner before a production design is approved.

## Scope

Stage 0 adds only benchmark code, a flake task, synthetic evidence, and this design. Measure point lookup, one-hour reads, monthly/day and ten-month/two-metric/day aggregates, 1,000-row duplicate-checked appends, open, and idle. Use identical logical records in UTC-month JSONL and 256 hash shards, and a Rust/rusqlite WAL database with equivalent indexes. Separate warm/cold wall time, process RSS, requested heap, and owned-file page-cache residency.

All builds, checks, and measurements run on yari. Use a 1 GiB no-swap user scope, nice 10 and explicit timeouts. Synthetic files live under `/home/simon/work/proseql-stage0-data`, never tmpfs. Do not contact rakku. zao is editing/commit only. These machine rules supersede the brief and older issue wording.

## Approval boundary

Stop after the report. Stages 1–6 require user approval. Preserve text bytes, exact errors, ordering, f64 addition order, cursors, duplicate semantics, transactions, watches, YAML safety and WASM parity. Do not change the README principle or introduce a production binary cache in Stage 0.
