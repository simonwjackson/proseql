# Native time-series collections

- id: 01M5DDHWKTVGPK5A72D8WNX86T
- status: active
- created: 2026-10-20
- plan: plan.md
- openspec: openspec/changes/native-timeseries/
- driver: let a native consumer keep 10 years of high-volume samples in partitioned JSONL with open, append and range-query cost independent of history size

## Current status

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
- Branch `ts/lazy` merges `ts/append` and `ts/index`; U5 (lazy partitions) is built there.

## Parity decisions (native only on purpose)

- Partitioned append without rewrite: native only. The WASM engine keeps its rewrite path for partitioned sources. Its source-oriented configuration also rejects `appendOnly` as an old-style persistence field. Recorded in `docs/native-sources.md` ("Runtime parity").
- Lazy partitions: native only.
- Ordered index: native and WASM plan with it. In WASM it narrows ranges only, because the binding sorts through the host (`localeCompare`). The legacy TypeScript core accepts `orderedIndexes` and does not plan with it.
