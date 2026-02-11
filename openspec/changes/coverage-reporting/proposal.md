## Why

The project has 1591+ tests across `core` and `node` packages, but there is no way to know what those tests actually cover. Without coverage data, untested branches and dead code paths remain invisible. Contributors have no signal about which areas need more testing, and maintainers have no guard against coverage regression when reviewing PRs. Coverage reporting is foundational infrastructure — it must exist before any other testing improvement (property-based testing, benchmarks) can be prioritized effectively.

## What Changes

Configure Bun's built-in coverage support in `bunfig.toml` and add justfile recipes for coverage collection. Add a `coverage/` output directory (gitignored) for HTML and LCOV reports. Set initial coverage thresholds based on the actual current coverage of the codebase so the threshold acts as a ratchet, not an aspiration. Wire coverage into the CI workflow so reports are generated on every run.

No application code changes. No new runtime modules. This is purely build/test infrastructure.

## Capabilities

### New Capabilities

- `just coverage`: Run the full test suite with coverage collection enabled, producing a terminal summary, an HTML report in `coverage/`, and an LCOV file at `coverage/lcov.info`.
- `just coverage-core`: Run only core package tests with coverage.
- `just coverage-node`: Run only node package tests with coverage.
- Coverage threshold enforcement: `bun test --coverage` exits non-zero when line or branch coverage drops below configured minimums.

### Modified Capabilities

- `bunfig.toml`: Gains a `[test.coverage]` section configuring coverage source patterns, exclusions, thresholds, and output reporters.
- `justfile`: Gains coverage recipes that invoke `bun test --coverage` with appropriate flags.
- `.gitignore`: Gains `coverage/` entry to exclude generated reports from version control.

## Impact

- **Runtime code**: No changes. Coverage is a test-time concern only.
- **Test execution**: Default `bun test` and `just test` remain unchanged — no coverage overhead unless explicitly requested.
- **CI**: Coverage collection adds modest time to CI runs (typically 10-30% overhead). Reports are available as CI artifacts.
- **Breaking changes**: None. All existing commands behave identically.
