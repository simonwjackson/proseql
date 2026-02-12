## 1. Dependencies and Setup

- [x] 1.1 Add `tinybench` as a dev dependency in the root `package.json`
- [x] 1.2 Add `"bench": "bun run bench/runner.ts"` script to root `package.json`
- [x] 1.3 Create `bench/` directory at the repository root
- [x] 1.4 Create `bench/utils.ts` with shared helpers: database factory wrapper (creates an in-memory proseql database with a given schema and dataset), percentile extraction from tinybench results, table formatting for terminal output

## 2. Data Generators

- [x] 2.1 Create `bench/generators.ts` with a seeded pseudo-random number generator for deterministic output
- [x] 2.2 Implement `generateUsers(count)` producing entities with id, name, email, age, role, createdAt fields
- [x] 2.3 Implement `generateProducts(count)` producing entities with id, name, price, category, stock, supplierId fields
- [x] 2.4 Implement `generateAtScale(generator, sizes)` that returns a Map of size to entity array for the standard sizes (100, 1K, 10K, 100K)
- [x] 2.5 Verify generators produce identical output across multiple invocations (determinism check)

## 3. Collection Scaling Benchmarks

- [x] 3.1 Create `bench/scaling.bench.ts` with a tinybench suite for each collection size (100, 1K, 10K, 100K)
- [x] 3.2 Implement findById benchmark: lookup by known ID at each size, verify constant-time behavior across sizes
- [x] 3.3 Implement unindexed filter benchmark: filter on a non-indexed field at each size, verify linear scaling
- [x] 3.4 Implement indexed filter benchmark: filter on an indexed field at each size, verify sub-linear improvement over unindexed

## 4. CRUD Benchmarks

- [x] 4.1 Create `bench/crud.bench.ts` with a tinybench suite on a 10K-entity baseline collection
- [x] 4.2 Implement `create` single-entity benchmark: measure ops/sec for inserting one entity
- [x] 4.3 Implement `createMany` batch benchmark: measure ops/sec for inserting batches of 100 entities, verify better amortized throughput than single create
- [x] 4.4 Implement `update` and `updateMany` benchmarks: measure ops/sec for single and batch updates
- [x] 4.5 Implement `delete` and `deleteMany` benchmarks: measure ops/sec for single and batch deletes
- [x] 4.6 Implement `upsert` benchmark with separate runs for the create path (new entity) and update path (existing entity)

## 5. Query Pipeline Benchmarks

- [x] 5.1 Create `bench/query-pipeline.bench.ts` with a tinybench suite on a 10K-entity collection
- [x] 5.2 Implement filter benchmarks: simple equality filter, range filter ($gt, $lt), compound filter (multiple conditions combined)
- [x] 5.3 Implement sort benchmarks: single-field sort, multi-field sort
- [x] 5.4 Implement population benchmarks: single ref population, inverse population, nested population (requires a multi-collection setup with relationships)
- [x] 5.5 Implement select benchmark: field projection with a subset of fields
- [x] 5.6 Implement paginate benchmark: skip/take on a large result set
- [x] 5.7 Implement combined pipeline benchmark: filter + sort + populate + select + paginate in a single query

## 6. Persistence and Serialization Benchmarks

- [x] 6.1 Create `bench/serialization.bench.ts` with a tinybench suite
- [x] 6.2 Implement serialization comparison: for each of the 7 formats (JSON, YAML, TOML, JSON5, JSONC, TOON, Hjson), measure serialize time on a 1K-entity dataset
- [x] 6.3 Implement deserialization comparison: for each of the 7 formats, measure deserialize time on the same dataset
- [x] 6.4 Implement debounced write coalescing benchmark: perform 100 rapid mutations with debounced persistence, count actual file writes, report coalescing ratio

## 7. Transaction Benchmarks

- [x] 7.1 Create `bench/transactions.bench.ts` with a tinybench suite
- [x] 7.2 Implement direct multi-operation benchmark: run a sequence of create, update, delete operations without a transaction wrapper
- [x] 7.3 Implement transactional multi-operation benchmark: run the same sequence inside a transaction
- [ ] 7.4 Report the overhead delta between transactional and direct execution

## 8. Benchmark Runner and Reporting

- [ ] 8.1 Create `bench/runner.ts` that discovers and imports all `.bench.ts` files in the `bench/` directory
- [ ] 8.2 Implement sequential suite execution with warm-up iterations before measurement
- [ ] 8.3 Implement table output: format results as an aligned table with columns for benchmark name, ops/sec, mean, p50, p95, p99
- [ ] 8.4 Implement `--json` flag: output all results as a structured JSON object keyed by suite and benchmark name
- [ ] 8.5 Implement suite filtering: allow running a single benchmark file via argument (e.g., `bun run bench scaling`)

## 9. Tests and Verification

- [ ] 9.1 Verify data generators produce correct entity counts and field shapes
- [ ] 9.2 Verify the benchmark runner discovers and executes all bench files
- [ ] 9.3 Verify JSON output is valid and contains expected keys
- [ ] 9.4 Verify table output renders without errors
- [ ] 9.5 Run the full benchmark suite end-to-end and confirm all suites complete without failures

## 10. Cleanup

- [ ] 10.1 Run the full test suite (`bun test`) to verify no regressions in existing functionality
- [ ] 10.2 Run type check (`bunx tsc --noEmit`) to verify no type errors
- [ ] 10.3 Run lint (`biome check .`) to verify benchmark files conform to project style
