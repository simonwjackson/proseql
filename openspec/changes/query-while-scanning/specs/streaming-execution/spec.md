# Streaming execution

## ADDED Requirements

### Requirement: Measure before production replacement

The redesign MUST provide a reproducible Rust SQLite baseline and an isolated streaming spike against identical synthetic source data and the native engine at `61c4322`. Stage 0 MUST stop for user approval.

#### Scenario: Shared-host qualification

- **WHEN** Stage 0 builds, checks or measures software
- **THEN** it runs on yari, with measurements inside a user systemd scope limited to 1 GiB and no swap, nice 10 and an explicit timeout
- **AND** it uses only owned synthetic filesystem-backed data and removes that data after retaining results
- **AND** it never builds or measures on zao or contacts rakku.

### Requirement: Preserve observable semantics

A future streaming executor MUST preserve format bytes, errors, stable ordering, f64 aggregation order, cursors, mutations, exact duplicates, watches, rollback, YAML write safety and WASM/browser parity.

#### Scenario: Disposable derived artifact

- **WHEN** a proposed architecture uses a binary sidecar or column cache
- **THEN** the report presents exact replacement wording for the README principle as a user decision
- **AND** the artifact is disposable, source-validated and unnecessary for correctness
- **AND** Stage 0 does not adopt that production change.

### Requirement: Expose target misses

Reports MUST separate wall time, peak/steady RSS, live/peak heap and source-file cache residency, and identify unmeasured hardware targets.

#### Scenario: Scalar scanner misses SQLite

- **WHEN** a measured scanner does not meet a target
- **THEN** report the measured floor, known reason and cheapest candidate route past it without lowering the target
- **AND** do not infer Celeron acceptance from aarch64 measurements.
