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
- U2–U5 not started.

## Parity decisions (native only on purpose)

- Partitioned append without rewrite: native only. The WASM engine keeps its rewrite path for partitioned sources.
- Lazy partitions: native only.
