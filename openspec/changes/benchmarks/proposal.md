## Why

proseql makes specific performance claims -- O(1) findById via Map lookup, sub-linear indexed queries, efficient debounced persistence -- but there is no way to verify these claims, detect regressions, or compare serialization formats. Anyone evaluating proseql for a project has to trust the architecture rather than measure it. And contributors modifying the query pipeline, storage layer, or index system have no way to know whether their change made things faster or slower.

A benchmark suite is the baseline requirement for performance accountability. Without one, every optimization is a guess and every regression is invisible.

## What Changes

Add a `bench/` directory at the repository root containing a benchmark suite built on `tinybench`. Each benchmark category gets its own file. A data generator module produces synthetic datasets at configurable scales (100, 1K, 10K, 100K entities). A runner script orchestrates execution, collects results, and outputs them as a formatted table (terminal) or JSON (programmatic/CI). The suite is invoked via `bun run bench` and is completely separate from the test suite.

## Capabilities

### New Capabilities

- **Collection size scaling benchmarks**: Measure findById, indexed query, and unindexed query performance across 100, 1K, 10K, and 100K entity collections to verify O(1), sub-linear, and O(n) scaling claims respectively.
- **CRUD throughput benchmarks**: Measure ops/sec and p50/p95/p99 latencies for create, createMany, update, updateMany, delete, deleteMany, and upsert (both create and update paths).
- **Query pipeline benchmarks**: Measure each pipeline stage independently (filter with equality/range/compound, sort with single/multi-field, population with single/inverse/nested, select, paginate) and a combined full-pipeline benchmark.
- **Serialization format comparison**: Measure serialize and deserialize times for all 7 formats (JSON, YAML, TOML, JSON5, JSONC, TOON, Hjson) on the same dataset.
- **Debounced write coalescing benchmark**: Measure how many actual file writes occur when 100 rapid mutations are performed with debounced persistence enabled.
- **Transaction overhead benchmark**: Compare the same multi-operation sequence run inside and outside a transaction to quantify snapshot/commit overhead.
- **Benchmark runner**: A CLI command (`bun run bench`) that runs all benchmarks, performs warm-up iterations, and produces output as a formatted table or JSON (`bun run bench --json`).
- **Data generators**: Reusable functions that produce synthetic entity datasets at configurable sizes for consistent, reproducible benchmarks.

### Modified Capabilities

- `package.json`: Gains a `bench` script entry pointing to the benchmark runner.

## Impact

- **New directory**: `bench/` at the repository root, containing all benchmark files, data generators, and the runner.
- **Dependencies**: `tinybench` added as a dev dependency.
- **Existing code**: No modifications to any source files in `packages/`. Benchmarks import from `@proseql/core` and `@proseql/node` as external consumers.
- **CI**: JSON output enables future CI integration for regression detection (out of scope for this change, but the format is ready).
- **Breaking changes**: None. This is purely additive infrastructure.
