# Benchmarks

## Overview

A benchmark suite that measures and reports proseql's performance characteristics across collection sizes, query types, and mutation patterns. Benchmarks validate the O(1) lookup claims, index acceleration, and establish a performance baseline for regression detection.

## Requirements

### Requirement: Collection size scaling benchmarks

Benchmarks SHALL measure operations across varying collection sizes to demonstrate scaling behavior.

#### Scenario: findById scaling
- **WHEN** findById is benchmarked against collections of 100, 1K, 10K, and 100K entities
- **THEN** results SHALL show O(1) constant time (no significant increase with size)

#### Scenario: Full scan query scaling
- **WHEN** an unindexed filter query is benchmarked across the same sizes
- **THEN** results SHALL show linear O(n) scaling

#### Scenario: Indexed query scaling
- **WHEN** an indexed filter query is benchmarked across the same sizes
- **THEN** results SHALL show sub-linear performance improvement over full scan

### Requirement: CRUD operation benchmarks

Individual CRUD operations SHALL be benchmarked.

#### Scenario: Create throughput
- **WHEN** single `create` and batch `createMany` are benchmarked
- **THEN** ops/sec and p50/p95/p99 latencies SHALL be reported
- **AND** createMany SHALL show better amortized throughput than individual creates

#### Scenario: Update and delete throughput
- **WHEN** `update`, `updateMany`, `delete`, `deleteMany` are benchmarked
- **THEN** ops/sec SHALL be reported for each

#### Scenario: Upsert throughput
- **WHEN** `upsert` is benchmarked for both create and update paths
- **THEN** both paths SHALL be reported separately

### Requirement: Query pipeline benchmarks

Each stage of the query pipeline SHALL be benchmarked independently and combined.

#### Scenario: Filter benchmarks
- **WHEN** filter is benchmarked with simple equality, range, and compound conditions
- **THEN** each filter type SHALL report ops/sec

#### Scenario: Sort benchmarks
- **WHEN** sort is benchmarked with single-field and multi-field configurations
- **THEN** results SHALL be reported per sort complexity

#### Scenario: Population benchmarks
- **WHEN** population is benchmarked with single ref, inverse, and nested population
- **THEN** per-entity and total query latencies SHALL be reported

#### Scenario: Combined pipeline
- **WHEN** a full pipeline (filter + sort + populate + select + paginate) is benchmarked
- **THEN** total query time SHALL be reported

### Requirement: Persistence benchmarks

File I/O operations SHALL be benchmarked per format.

#### Scenario: Serialization format comparison
- **WHEN** save and load are benchmarked for JSON, YAML, TOML, JSON5, JSONC, TOON, Hjson
- **THEN** serialize/deserialize times SHALL be compared across formats for the same dataset

#### Scenario: Debounced write coalescing
- **WHEN** 100 rapid mutations are performed with debounced persistence
- **THEN** the benchmark SHALL show how many actual file writes occurred

### Requirement: Transaction benchmarks

Transaction overhead SHALL be measured.

#### Scenario: Transaction vs direct
- **WHEN** the same multi-operation sequence is run inside and outside a transaction
- **THEN** the overhead of snapshot/commit SHALL be reported

### Requirement: Reproducible benchmark runner

A CLI command SHALL run all benchmarks and produce structured output.

#### Scenario: Run benchmarks
- **WHEN** `bun run bench` is executed
- **THEN** all benchmarks SHALL run and produce a report to stdout
- **AND** results SHALL include ops/sec, mean, p50, p95, p99 latencies

#### Scenario: JSON output
- **WHEN** `bun run bench --json` is executed
- **THEN** results SHALL be written as JSON for programmatic consumption

## Out of Scope

- Comparison benchmarks against SQLite, LokiJS, or other databases
- Automated regression detection in CI (could be added later)
- Memory usage profiling (separate concern)
