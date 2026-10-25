# Query-while-scanning work

Binding implementation scope: [contract.md](contract.md), section 1. All build/test work for stages 1–6 runs on aka. No rakku/yari access or real data is authorized for integration.

## Stage 0 — measured contract (#13)

- [x] Read the source brief and record base SHA, measurement definitions, machine rules and approval boundary.
- [x] Commit isolated SQLite/native/scanner harnesses and synthetic monthly/hash fixtures.
- [x] Commit results, measured floors, conditional level-2 recommendation and architecture report in `docs/benchmarks/sqlite-baseline.md`.
- [x] Complete focused stage-0 checks and clean owned yari work. Historical evidence is not a qualification of the current implementation.

## Builders (#14–#17)

- [x] Borrowed-row executor, global ordering/cursors, folds and differential tests.
- [x] Chunked JSONL framer and range-reading storage hosts; bounded recovery checks.
- [x] Sparse time indexes, global ID locator, custom-codec verification and generation checks.
- [x] Append-only creates, global duplicate checks, rollback/conflicts and crash fault tests without partition residency.
- [x] Streaming watches with delivered-result last-known-good and generation baselines.
- [x] WASM/browser chunk scanner and measured YAML/browser bounds.
- [x] Acceptance harness and unedited consumer override scripts with skeleton-baseline provenance.

## Integration (#19)

- [x] Fast-forward to combined `qws/integration` at `aa40721`.
- [x] Run native conformance/differential suites with Resident and Streaming defaults on aka before deletion.
- [x] Reproduce and obtain parent approval for cache-dependent changed guarantees 12 (unwatched last-known-good) and 13 (Error-policy ID lookup). Verify invalid unwatched reads fail, never return invalid data; verify Resident zero-cache equivalence.
- [x] Trial Streaming default and resident-path removal; identify Logbook's query-then-engine-read hydration dependence. Parent directed deferral rather than silent wrong results.
- [x] Restore Resident as default and retain the public `ExecutionModel` switch and lazy resident path. Keep original Resident conformance tests and Resident-versus-Streaming differential harness unchanged.
- [x] Add explicit opt-in regressions for current-file validation, Error-policy ID lookups, staged-ID exceptions and the default residency/hydration contract. Remove unused internal byte-accounting helpers and integrated dead-code allowances.
- [ ] Flip the default and remove lazy residency/eviction/pinning after consumers adopt returned streaming results. This acceptance item is deferred, not complete.
- [x] Document lazy reads, appends, watches, stats, memory and all approved guarantee changes in `docs/native-sources.md` and `docs/design/query-while-scanning.md`.
- [x] Complete final Resident-default `release-check` on aka, exit 0: Rust 1,284 passed / 7 ignored; TypeScript 4,098 passed / 2 skipped; parity 2,163 passed / 2 skipped and 16/16 examples. Typecheck, lint, Rust format/check/clippy, WASM, packed artifacts and browser smoke/budget passed. Browser gzip: 598,339 / 600,000 B. Logs: `/home/simonwjackson/work/qws-logs/integrator-release-check-final.log` and `integrator-release-final-summary.txt`.
- [x] Commit tested opt-in integration work with the cutover deferred; never push.

The earlier full release-check ran on a discarded streaming-only trial and stopped
at a trial-test clippy lint after its tests passed. It is not final-source evidence.
The parent explicitly authorized the fresh complete final-source run above.

## Verify / consumer qualification (after integration)

- [ ] Run Coach and Logbook override builds/tests against the integration SHA, without editing consumer repositories. Audit Logbook's cached `query_bounded` → `read` sample enumeration pattern.
- [ ] Run the acceptance matrix on aka; add SQLite tables and measured miss/floor explanations. Do not reuse skeleton fallback results as streaming measurements.
- [ ] Report consumer pin, performance and deployment limits. Absolute Celeron/real-data targets remain unmeasured under the current machine rules.
- [ ] Independent review and consumer adoption decision. No publication or push without approval.

## Conditional level 2 (#18)

- [ ] Start only with separate approval if measured misses justify it. No binary on-disk cache or column artifact is implemented by this change.
