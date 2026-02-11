# Coverage Reporting — Design

## Architecture

### New Files

**`coverage/`** (directory, gitignored) — Output directory for generated coverage reports. Contains `lcov.info` (machine-readable) and an HTML report tree (human-readable). Created automatically by the coverage tool; never committed.

### Modified Files

**`bunfig.toml`** — Add `[test.coverage]` section that configures:
- `coverageReporter`: Array of reporter types (`["text", "lcov"]`) to produce terminal summary and LCOV output.
- `coverageDirectory`: Output path (`"coverage"`).
- `coverageThreshold`: Object with `line`, `branch`, `function`, and `statement` percentage minimums. Set to actual measured values from the initial coverage run, rounded down to the nearest integer.

**`justfile`** — Add `coverage`, `coverage-core`, and `coverage-node` recipes that run `bun test --coverage` scoped to the appropriate packages. Add a `coverage-report` recipe that generates the HTML report if an HTML reporter is needed beyond LCOV.

**`.gitignore`** — Add `coverage/` to prevent committing generated reports.

## Key Decisions

### Bun's built-in coverage, not a third-party tool

Bun has native V8 coverage collection via `--coverage`. This avoids adding `c8`, `istanbul`, or `vitest` as dependencies. The project already uses Bun as its test runner and has no other test infrastructure. Keeping everything in Bun reduces moving parts.

### LCOV as the machine-readable format

LCOV is the most widely supported coverage interchange format. Every CI service, GitHub Action, and coverage aggregator understands it. Cobertura XML offers no advantage here and requires additional tooling to generate from Bun's output.

### Thresholds set from actual coverage, not aspirational targets

The spec requires thresholds based on current actual coverage. The first task measures coverage, and subsequent tasks configure thresholds at or slightly below the measured values. This ensures the threshold acts as a regression guard from day one rather than a perpetually failing aspirational target.

### Exclusion patterns match the spec

The following are excluded from coverage measurement:
- `tests/` — test files should not count toward source coverage
- `examples/` — example code is not library source
- `effect/` — vendored dependency, not our code (also gitignored, but excluded explicitly for safety)
- `**/index.ts` — barrel re-export files that contain no logic
- `**/*.d.ts` — type declaration files with no runtime code

### No HTML reporter in default coverage run

The terminal summary and LCOV file are sufficient for local development and CI. HTML reports are expensive to generate and only useful for interactive browsing. A separate `just coverage-html` recipe can be added later if needed, or users can generate HTML from the LCOV file using `genhtml`.

### Default test run unchanged

Coverage is only collected when `--coverage` is passed or when using the `just coverage` recipes. The `[test.coverage]` section in `bunfig.toml` configures behavior *when coverage is requested*, not for every test run. `bun test` and `just test` remain fast with zero overhead.

## File Layout

```
bunfig.toml              (modified — add [test.coverage] section)
justfile                 (modified — add coverage recipes)
.gitignore               (modified — add coverage/)
coverage/                (new, gitignored — generated reports)
  lcov.info              (generated — LCOV coverage data)
```
