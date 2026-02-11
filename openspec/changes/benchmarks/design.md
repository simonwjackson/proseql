# Benchmarks — Design

## Architecture

### New Modules

**`bench/generators.ts`** — Data generator functions that produce synthetic entity arrays at configurable sizes (100, 1K, 10K, 100K). Generates realistic-shaped data with string, numeric, boolean, date, and reference fields. Deterministic seeding so benchmarks are reproducible across runs.

**`bench/scaling.bench.ts`** — Collection size scaling benchmarks. Tests findById (verifies O(1)), indexed filter query (verifies sub-linear), and unindexed filter query (verifies O(n)) across all four collection sizes.

**`bench/crud.bench.ts`** — CRUD operation throughput benchmarks. Measures create, createMany, update, updateMany, delete, deleteMany, and upsert (both create and update paths). Reports ops/sec and latency percentiles.

**`bench/query-pipeline.bench.ts`** — Query pipeline stage benchmarks. Measures filter (equality, range, compound), sort (single-field, multi-field), population (single ref, inverse, nested), select, paginate individually, plus a combined full-pipeline benchmark.

**`bench/serialization.bench.ts`** — Serialization format comparison benchmarks. Measures serialize and deserialize for JSON, YAML, TOML, JSON5, JSONC, TOON, and Hjson on the same dataset. Includes a debounced write coalescing measurement.

**`bench/transactions.bench.ts`** — Transaction overhead benchmarks. Runs the same multi-operation sequence inside and outside a transaction to quantify snapshot/commit cost.

**`bench/runner.ts`** — Benchmark runner and reporter. Discovers and executes all `.bench.ts` files, collects results, and outputs as a formatted table (default) or JSON (`--json` flag). Entry point for `bun run bench`.

**`bench/utils.ts`** — Shared benchmark utilities: database setup helpers, warm-up function, result formatting, percentile calculation.

## Key Decisions

### tinybench as the framework

tinybench is lightweight (~5KB), has no native dependencies, and works directly under Bun. It provides built-in statistical sampling (ops/sec, mean, p50, p95, p99) without needing vitest or any test framework as a host. This keeps benchmarks independent from the test suite and avoids coupling to a specific test runner.

### Data generators for test datasets at scale

Rather than loading fixture files, benchmarks generate data programmatically with deterministic seeds. This makes it trivial to produce 100K-entity collections without storing large files in the repo, and ensures every run operates on identical data. Generators produce entities shaped like real-world usage: users with names, ages, emails; products with prices, categories, stock levels.

### One file per benchmark category

Each benchmark file focuses on a single concern (scaling, CRUD, query pipeline, serialization, transactions). This keeps files small, makes it easy to run a single category in isolation, and avoids ordering dependencies between benchmarks.

### Warm-up runs before measurement

Each benchmark suite runs a configurable number of warm-up iterations (default 5) before collecting measurements. This ensures JIT compilation, memory allocation, and any lazy initialization are complete before timing begins. tinybench supports this natively via the `warmupIterations` option.

### Statistical reporting (ops/sec, mean, p50, p95, p99)

tinybench collects these statistics automatically from its sampling loop. The runner extracts and formats them. This gives both throughput (ops/sec for comparing operations) and latency distribution (percentiles for understanding tail behavior). No custom statistics code is needed.

### JSON output for CI consumption

The `--json` flag causes the runner to output a structured JSON object with all benchmark results, keyed by suite and benchmark name. This enables future CI pipelines to compare results across commits, store historical data, or fail on regressions -- without changing the benchmark suite itself.

### Separate from test suite (bench/ directory)

Benchmarks live in `bench/` at the repo root, not inside any package's `tests/` directory. This prevents `bun test` from accidentally running benchmarks (which are slow) and makes the separation of concerns explicit. Benchmarks are consumers of the packages, not part of them.

## File Layout

```
bench/
  runner.ts                  (new — benchmark runner, CLI entry point)
  generators.ts              (new — deterministic data generators)
  utils.ts                   (new — shared helpers, setup, formatting)
  scaling.bench.ts           (new — collection size scaling benchmarks)
  crud.bench.ts              (new — CRUD throughput benchmarks)
  query-pipeline.bench.ts    (new — query pipeline stage benchmarks)
  serialization.bench.ts     (new — format comparison, debounced writes)
  transactions.bench.ts      (new — transaction overhead benchmarks)
package.json                 (modified — add "bench" script)
```
