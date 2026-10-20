# Native time-series collections

- id: 01M5DDHWKTVGPK5A72D8WNX86T
- status: active
- created: 2026-10-20
- plan: plan.md
- openspec: openspec/changes/native-timeseries/
- driver: let a native consumer keep 10 years of high-volume samples in partitioned JSONL with open, append and range-query cost independent of history size

## Current status

- U1 (baseline benchmark) in progress on branch `ts/bench` from `0e3666a`.
- U2–U5 not started.

## Parity decisions (native only on purpose)

- Partitioned append without rewrite: native only. The WASM engine keeps its rewrite path for partitioned sources.
- Lazy partitions: native only.
