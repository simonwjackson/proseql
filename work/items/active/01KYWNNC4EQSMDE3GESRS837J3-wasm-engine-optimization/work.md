# WASM engine optimization

- id: 01KYWNNC4EQSMDE3GESRS837J3
- status: active
- created: 2026-07-31
- plan: plan.md
- driver: make Rust/WASM the single browser engine while every fixed required benchmark individually matches or exceeds paired TypeScript performance

## Current status

- The optimization series is integrated on local `main` through `dc28300 perf(storage): mirror validated persistence state` and remains unpushed.
- The user approved an explicit absolute browser JavaScript heap ceiling of `50,000,000` bytes. The historical `11,739,108`-byte baseline remains recorded and is not rebased.
- Three-trial evidence passes the required CRUD, query, scaling, and transaction throughput cases; explicit persistence flush also meets paired TypeScript throughput.
- The required persistence case with 100 separately awaited creates remains at approximately 55–60% of direct TypeScript throughput and continues to block completion unless the user explicitly reclassifies it.
- Full reports now isolate each benchmark suite in a fresh process to prevent callback/global WASM state from leaking from serialization into query-pipeline. Stale generated bindings are rejected early with the exact WASM rebuild command.
- A complete isolated report now contains all five suites and 55 paired comparisons with no execution failures. Status remains active pending final repeated gates and resolution of the 100-separate-create persistence deficit.
