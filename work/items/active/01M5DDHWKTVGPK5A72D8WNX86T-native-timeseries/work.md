# Native time-series collections

- id: 01M5DDHWKTVGPK5A72D8WNX86T
- status: active
- created: 2026-10-20
- plan: plan.md
- openspec: openspec/changes/native-timeseries/
- driver: let a native consumer keep 10 years of high-volume samples in partitioned JSONL with open, append and range-query cost independent of history size

## Current status

- All step branches (`ts/bench`, `ts/append`, `ts/index`, `ts/lazy`) are merged into `main`. The branch names below record where each step was first made.
- U1 (baseline benchmark) done on branch `ts/bench` from `0e3666a`. Results: `docs/benchmarks/timeseries.md`.
  - 140k rows: open 4.5 s, 780 MiB; insert median 1.07 s (rewrites the whole partition); one-hour query 170 ms over all 120 partitions.
  - 1M rows: open 27 s, 5.6 GiB; insert median 7.3 s; one-hour query 1.5 s.
  - 10M rows: did not finish. Open was stopped at the 15.3 GiB RSS limit after 90 s. Linear extrapolation needs about 54 GiB through open (inferred), more than the 31 GiB machine.
  - The 600 s insert budget allowed 495 (140k) and 76 (1M) of the 1,000 inserts.
- U2 (native append-only + `duplicate_ids`) and U3 (time-bucket keys) done on branch `ts/append`. Results: `docs/benchmarks/timeseries.md`, "Step 2 append" and "Step 3 time bucket".
  - Append median 0.54 ms at 140k and 0.58 ms at 1M (rewrite path: 1.2 s and 7.3 s). 127 bytes written per insert (the line), 4 KiB read (conflict-check tail), earlier bytes unchanged, all 1,000 inserts timed.
  - Time bucket: no `month` field; data 14% smaller, RSS after open 4.5% lower, append cost unchanged.
  - 10M: does not fit before lazy loading (OOM-killed in open). The harness RSS guard uses a limit fixed at start; on the shared machine the OOM killer acted first.
- U4 (ordered index) done on branch `ts/index` from `ts/bench` (439ccd8). Results: `docs/benchmarks/timeseries.md`, "Step 4 ordered index". It ran on the baseline `Field { month }` key; steps 2 and 3 are on other branches.
  - One-hour query: 134 ms to 1.5 µs at 140k; 1,141 ms to 21 µs at 1M; `index_used = ordered`, candidates = matching rows.
  - Newest 100 (sort desc, limit 100): 219 ms to 65 µs at 140k; 2,017 ms to 96 µs at 1M.
  - Cost: about 175 B RSS per row; open 7% to 14% longer. 10M still aborts in open at the memory limit (needs U5).
  - WASM browser production size: 591,428 B gzip (ts/bench tip 578,760 B; budget 595,794 B).
- Branch `ts/lazy` merges `ts/append` and `ts/index` (merge `3bbc08a`; browser WASM production 593,245 B gzip after the merge, 593,179 B after U5; budget 595,794 B). `--mode ordered` is now cumulative.
- U5 (lazy partitions) done on branch `ts/lazy` (`b36cddc` engine resident records, `96fcdb9` storage pruning, `c1cbe86` native runtime, `03d0dbc` and `6d29c55` harness). Results: `docs/benchmarks/timeseries.md`, "Step 5 lazy" and "Before and after".
  - Lazy open: 3 to 11 ms and 5 MiB at 140k, 1M and 10M rows (eager cumulative: 4.1 s / 769 MiB at 140k, 24 s / 5.5 GiB at 1M).
  - Append median over 1,000 appends: 0.78 ms (140k) and 0.85 ms (10M); 109 B written = line length; earlier bytes unchanged.
  - One-hour query: `partitions_loaded = 1`, `index_used = ordered` at every size; 0.0090 ms at 140k, 0.287 ms at 10M (31.7×). **Acceptance target "time ≤ 2×" not met**: the hour holds 1 row at 140k and 114 at 10M, and the cost is about 2.2 to 2.5 µs per returned row. A one-slot window (about one row at every size) takes 8.5 µs at 140k and 8.3 µs at 10M.
  - The first append into an unloaded partition loads it for the ID check: 1.2 s and 9.2 MB read for an 83,000-row month at 10M.
  - The harness memory guard now also aborts when `MemAvailable` falls below 1 GiB.
  - Conformance: `crates/proseql-native/tests/lazy_partitions_runtime.rs` (15 tests, every result compared with an eager runtime on the same files), `crates/proseql-engine/tests/resident_conformance.rs`, unit tests in `crates/proseql-storage/src/partition_prune.rs`.
  - Runtime boundary: the native runtime decides which partitions are resident; the engine gains only `Database::load_resident_records` / `unload_resident_records` / `refresh_reactive_snapshot`, which the WASM engine never calls. Recorded in `docs/native-sources.md` ("Lazy partitions") and the openspec design.
  - Contract deviations: `NativeSourceRuntimeOptions.lazy_watch_interval` added (poll interval of the lazy watcher; not in the contract). Pinned partitions do not count against `max_loaded_partitions`.
  - Coach: `coach_compatibility` ran against an empty synthetic directory with the schema-only fixture and opened all 42 collections without a mutation. It was not run through `scripts/check-coach-copy.py`, because that script copies `~/.local/share/coach/`, which this stage must not read or copy. Coach's own server tests (27) pass against `24d79a6` in a `/tmp` copy of `coach/server` and `coach/contract` with only the pinned rev changed; Coach itself was not changed.

- Review round 1 fixes on `ts/lazy`: reload kept lazy records (`76092a5`), torn JSONL tails classified before UTF-8 decoding (`c215dce`), failed watched partitions retried (`a86a7f6`), `full_scan: Error` independent of residency (`17429c2`), `skipDuplicates` cannot skip an `ignore_identical` conflict (`60c8d15`), own appends explained by changed path under shared graph roots (`032aa65`), `just bench-timeseries` runs lazy mode (`994e554`), typed TS results and ValidationError (`8f307e9`, `0e460fc`, `65b5b01`). Lazy rerun after the fixes: append 1.17×, open 0.43×, one-hour query 22.5× (still not met).

## Parity decisions (native only on purpose)

- Partitioned append without rewrite: native only. The WASM engine keeps its rewrite path for partitioned sources. Its source-oriented configuration also rejects `appendOnly` as an old-style persistence field. Recorded in `docs/native-sources.md` ("Runtime parity").
- Lazy partitions: native only, on purpose. The WASM engine and the legacy core stay fully in memory. Recorded in `docs/native-sources.md` ("Runtime parity").
- Ordered index: native and WASM plan with it. In WASM it narrows ranges only, because the binding sorts through the host (`localeCompare`). The legacy TypeScript core accepts `orderedIndexes` and does not plan with it.
