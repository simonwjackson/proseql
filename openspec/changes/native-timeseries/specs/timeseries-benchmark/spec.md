## ADDED Requirements

### Requirement: Repeatable time-series benchmark

The repository SHALL provide `nix run .#bench-timeseries`, which runs the `timeseries_bench` example of `proseql-native` in release mode with `--rows 140000,1000000,10000000 --years 10`. The benchmark SHALL use synthetic data only.

#### Scenario: Synthetic data with a fixed seed
- **WHEN** the benchmark runs twice with the same `--rows`, `--years` and `--seed`
- **THEN** both runs use byte-identical partition files generated outside the git checkout, and the second run reuses the cached files

#### Scenario: One process per size
- **WHEN** the benchmark runs several sizes
- **THEN** each size runs in a fresh child process on a fresh copy of the data, so peak RSS (`VmHWM`) belongs to that size only

#### Scenario: Machine-readable result
- **WHEN** a size completes or aborts
- **THEN** the benchmark prints one line `TSBENCH {json}` with the mode, rows, partitions, open time, RSS after open, peak RSS, insert count, median and p95 insert time, median bytes written and read per insert, range-query time, rows returned, `partitions_loaded`, `index_used` and a status

#### Scenario: Later steps switch features with a flag
- **WHEN** a later step adds append-only, time buckets, ordered indexes or lazy partitions
- **THEN** it enables them with `--mode append|timebucket|ordered|lazy` and the harness, data and output format stay the same

#### Scenario: Resource limit
- **WHEN** a child process exceeds `--max-rss-mb` or the insert time budget
- **THEN** the benchmark stops that measurement, reports the partial numbers and the reason, and does not silently shrink the target size
