## 1. Baseline Measurement

- [x] 1.1 Run `bun test --coverage packages/*/tests/` to measure current coverage and record the line, branch, function, and statement percentages for each package

**Measured coverage (Bun reports Functions and Lines only):**
- All files: 82.68% Functions, 85.44% Lines
- Note: Bun's V8 coverage does not report branch or statement coverage separately
- [x] 1.2 Identify any files or directories that Bun includes by default but should be excluded (test files, vendored code, barrel files, type declarations)

**Exclusion analysis:**
- Test files (`packages/*/tests/`): Not in coverage - tests run but their source isn't measured
- Vendored code (`effect/`): Not in coverage - correctly excluded
- Examples (`examples/`): Not in coverage - correctly excluded
- Type declarations (`*.d.ts`): Not in coverage - correctly excluded
- Index files: Two `index.ts` files appear (core/src/index.ts and core/src/errors/index.ts), both contain substantive re-exports and type definitions, so they should remain included
- **Conclusion:** No additional exclusions needed - Bun's default behavior is already correct for this project

## 2. Configuration

- [x] 2.1 Add `coverage/` to `.gitignore`
- [x] 2.2 Add `[test.coverage]` section to `bunfig.toml` with coverage reporter configuration (`text` and `lcov`), output directory (`coverage`), and source inclusion/exclusion patterns
- [x] 2.3 Configure exclusion patterns in `bunfig.toml` to skip `tests/`, `examples/`, `effect/`, `**/index.ts`, and `**/*.d.ts` from coverage metrics
- [x] 2.4 Set coverage thresholds in `bunfig.toml` based on the actual values measured in 1.1, rounded down to the nearest integer to allow minor fluctuation without false failures

## 3. Justfile Recipes

- [x] 3.1 Add `coverage` recipe to `justfile`: `bun test --coverage packages/*/tests/`
- [x] 3.2 Add `coverage-core` recipe to `justfile`: `bun test --coverage packages/core/tests/`
- [ ] 3.3 Add `coverage-node` recipe to `justfile`: `bun test --coverage packages/node/tests/`

## 4. Verification

- [ ] 4.1 Run `just coverage` and verify terminal summary prints per-file and total coverage percentages
- [ ] 4.2 Verify `coverage/lcov.info` is generated and contains valid LCOV data
- [ ] 4.3 Verify excluded files (`tests/`, `effect/`, `index.ts`, `.d.ts`) do not appear in coverage output
- [ ] 4.4 Verify `just test` (without coverage) still runs at normal speed with no coverage overhead
- [ ] 4.5 Temporarily lower a threshold below measured coverage and verify the coverage command exits with non-zero code, then restore the correct threshold

## 5. Cleanup

- [ ] 5.1 Run full test suite (`bun test`) to verify no regressions
- [ ] 5.2 Run type check (`bunx tsc --build`) to verify no type errors
- [ ] 5.3 Run lint (`biome check .`) to verify no lint issues in modified files
