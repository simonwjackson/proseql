# WASM performance reports

The benchmark contract compares the supported Rust/WASM path through `@proseql/effect` with the direct TypeScript implementation in `@proseql/core`.

## Release contract

- Every case marked `required` in `bench/workloads.ts` must report `throughputRatio >= 1.0` independently.
- Ratios are compared without rounding. Aggregate and geometric-mean results are summaries only.
- CRUD, query-pipeline, transaction, persistence, and callback-characterization fixtures use 10,000 records per collection.
- Required scaling reads use fixed 100, 1,000, and 10,000-record fixtures.
- The 100,000-record cases are safety and memory gates, not throughput gates.
- Browser JavaScript heap has an explicit absolute maximum of `50,000,000` bytes. The historical `11,739,108`-byte measurement remains the recorded baseline rather than being rebased.
- Every blocking result requires both engines, finite positive throughput, at least 30 samples per engine, matching decoded-value checksums, and manifest-identical category, case type, fixture size, logical operation count, and normal-interaction metadata.
- Logical operation count records the fixed work represented by one timed invocation: batch mutations use 100, transaction and hook sequences use 3, and ordinary reads/single operations use 1.

The comparator and fixtures must not be made slower or smaller to satisfy the contract. A required case remains a failure until the Rust/WASM median throughput matches or exceeds its paired TypeScript median.

## Evidence

`bench/baselines/browser-wasm.json` is the complete pre-optimization paired baseline. It is expected to fail the strict parity target while remaining valid evidence: execution, coverage, engine pairing, and checksums must still be complete. `collectBaselineParityFailures` reads it in fixed manifest order and reports every required case below parity.

`bench/reports/u2-browser-evidence.json` records browser delivery and interaction evidence after U2. It is not a substitute for a complete paired TypeScript/WASM throughput report.

Generated raw reports belong under `bench/generated/` and are not release artifacts. Checked-in reports must be reproducible from repository-local commands and must not contain absolute temporary paths.

## Commands

```bash
# Focused contract tests
bunx vitest run --dir bench performance-contract.test.ts baseline.test.ts

# Complete paired report
bun run bench:report

# Capture the complete pre-optimization-compatible summary format
bun run bench:baseline

# Real Chromium startup, interaction, and memory report
bun run bench:browser-report
```

A complete report may finish successfully as a command while its machine-readable `contract.passed` field is false. Execution failures, missing cases, missing engine results, undersampling, metadata drift, or checksum mismatches remain hard failures and cannot be treated as performance-only evidence.
