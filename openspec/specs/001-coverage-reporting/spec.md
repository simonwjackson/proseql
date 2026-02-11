# Coverage Reporting

## Overview

Test coverage measurement and reporting to quantify how much of the codebase is exercised by the 1591+ test suite. Coverage reports identify untested branches, missed edge cases, and provide confidence metrics for consumers evaluating the library.

## Requirements

### Requirement: Coverage collection during test runs

Running tests SHALL optionally collect code coverage data.

#### Scenario: Coverage-enabled test run
- **WHEN** `bun test --coverage` or equivalent is executed
- **THEN** line, branch, function, and statement coverage SHALL be collected for all files in `core/`

#### Scenario: Default test run unchanged
- **WHEN** `bun test` is executed without coverage flags
- **THEN** tests SHALL run at normal speed with no coverage overhead

### Requirement: Coverage report output

Coverage data SHALL be rendered as human-readable and machine-readable reports.

#### Scenario: Terminal summary
- **WHEN** coverage collection completes
- **THEN** a summary table SHALL be printed showing per-file and total coverage percentages for lines, branches, functions, and statements

#### Scenario: HTML report
- **WHEN** coverage is collected
- **THEN** an HTML report SHALL be generated in `coverage/` showing annotated source with covered/uncovered lines highlighted

#### Scenario: Machine-readable output
- **WHEN** coverage is collected
- **THEN** an LCOV or Cobertura XML file SHALL be generated for CI integration

### Requirement: Coverage thresholds

Minimum coverage thresholds SHALL be enforced to prevent regression.

#### Scenario: Threshold enforcement
- **GIVEN** coverage thresholds are configured (e.g., 80% lines, 75% branches)
- **WHEN** coverage drops below any threshold
- **THEN** the coverage command SHALL exit with a non-zero code

#### Scenario: Threshold configuration
- **THEN** thresholds SHALL be configurable in the test/coverage config file
- **AND** initial thresholds SHALL be set based on current actual coverage (not aspirational)

### Requirement: Coverage exclusions

Generated code, test files, and configuration SHALL be excluded from coverage metrics.

#### Scenario: Exclusions
- **THEN** the following SHALL be excluded from coverage:
  - `tests/` directory
  - `examples/` directory
  - `effect/` directory (vendored dependency)
  - `core/index.ts` (re-export barrel file)
  - Type-only files (`.d.ts`)

### Requirement: CI integration

Coverage SHALL be collected and reported in CI.

#### Scenario: Coverage in CI
- **WHEN** CI runs the test suite
- **THEN** coverage SHALL be collected and the report SHALL be available as a CI artifact

#### Scenario: PR coverage comment (optional)
- **WHEN** a PR is opened
- **THEN** a coverage summary MAY be posted as a PR comment showing coverage delta

## Out of Scope

- Coverage badge in README (nice-to-have, not required)
- Upload to third-party services (Codecov, Coveralls)
- Per-commit coverage tracking over time
