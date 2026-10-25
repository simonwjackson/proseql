# Round-2 lazy-streaming cutover

Runtime cutover: `1c4f79f`; merged locator fixes through `ba90773` in `827dea3`.
Final tested runtime SHA: `56e994370d6919ef4e3effa735381ab4b17fe0f0`. Streaming is the default and only lazy model. Eager
collections keep the resident engine. No binary cache, dependency or source
format was added. All builds and tests run on aka; no rakku/yari access.

## Compatibility

`ExecutionModel` (both variants) and `NativeSourceRuntimeOptions::execution_model`
remain deprecated compatibility items. Both values stream lazy collections;
`Resident` cannot restore residency. Existing Logbook source compiles unchanged,
with deprecation warnings. `LazyPartitionPolicy` retains both fields and ignores
`max_loaded_partitions`. `lazy_partition_status.loaded` and `.pinned` are empty.
`read` remains public but sees no durable lazy rows. Runtime query, aggregate,
ID lookup, mutation, create_many, watch, statistics and index-release APIs remain.

## Verification

| Check | Result |
|---|---|
| Focused lazy/eager read, cursor, fold, append, watch and error tests | Passed on aka with x86-64-v2 |
| Native/engine all-target, all-feature clippy, -D warnings | Passed |
| TypeScript project build/typecheck | Passed |
| Rust format and consumer-script syntax | Passed |
| Full final release-check | Exit 0 at 56e9943, without x86-64-v2 |
| Rust workspace | 1,316 passed, 0 failed, 10 ignored |
| Full TypeScript | 4,098 passed, 0 failed, 2 skipped |
| Effect parity and examples | 2,163 passed, 0 failed, 2 skipped; 16/16 examples |
| Workflow/TS lint, typecheck, Rust format/check/clippy, WASM check | Passed |
| Packed packages and browser smoke | Passed |
| Browser budget | 3/3 cold trials passed; gzip 598,572 / 600,000 B (1,428 B headroom) |
| Coach unedited, `06719890e27212cf61fa77987dc4432cd68f1dd4` | Build passed; 27 passed, 0 failed, against 1c4f79f |
| Logbook streaming-adoption, `ad70bd9464f72b4a53a42f83feb1118f34fd0ad5` | Build passed; 221 passed, 0 failed, 2 ignored, against 1c4f79f |

The first release-check stopped before the suites: passing `--x86-64-v2` to
aka-run leaked a native target-cpu flag into WASM and bindgen failed to find
`__wbindgen_externref_table_dealloc`. The affected `build-release-artifacts`
retry passed without that flag. No code change was needed for this failure.
The final complete run omitted it and passed. Initial log:
`/home/simonwjackson/work/qws-logs/round2-cutover-release-check-attempt1.log`.
Affected retry: `round2-cutover-wasm-retry.log` in the same directory.
A focused post-merge native run and seven storage write-index tests pass,
including the idempotent checked-publication and tokenless-proof regressions.
One remaining schema reload test reproduced an unwatched resident-cache LKG
assumption; it now verifies the same allowed record through a live lazy watch,
while current-file ID lookup rejects the invalid edit (approved guarantee #12).

Consumer command:

```sh
QWS_WORKER=cutover QWS_LOGBOOK_REPO=/tmp/forgerie-scratch/f-ad87c1da/logbook-r2 \
  bash scripts/consumers/run.sh "$PWD"
```

The runner archives committed source and synthetic contract fixtures only, copies
them to owned aka workspaces and applies path patches there. It does not edit the
real consumers or the read-only Logbook scratch branch. Logs and resolved Cargo
paths are in ignored `scripts/consumers/results/current/` (local and aka
`/home/simonwjackson/work/qws-cutover/`).

The complete final log is on aka at
`/home/simonwjackson/work/qws-logs/round2-cutover-release-check.log`.
Browser evidence is `.artifacts/browser/evidence.json` in the aka source checkout
`/home/simonwjackson/work/qws-cutover`. After the gate, Git content hashes of
**every tracked file** matched between the local committed source and the aka
checkout. The later results-recording commit changes documentation only.

During test conversion, two initial native runs stopped on old fixture-selector
imports. The first runnable focused set exposed the expected Resident-only
cache/stats expectations and eager-open error timing; the corrected differential
suites pass. Clippy found a single-element policy-test loop; the test now checks
both deprecated compatibility variants. The focused schema reload regression
failed before its watch-owner update and passes afterward. The final complete
gate required no product-code fix or further full-suite rerun.

## Scope, assertions and remaining work

The [design](../../../docs/design/query-while-scanning.md#round-2-cutover-removal-19--21)
lists removed functions and each replaced Resident-internal test expectation.
Differential tests compare real eager and lazy runtimes on identical files. No
result fixture/page/cursor/group assertion was dropped. Approved cache-dependent
changes are now tested unconditionally, rather than leaving a second lazy model.

The 13 round-1 guarantees and the approved first-use full-file validation,
`candidate_rows`, `release_streaming_indexes` and `FileStat::change_id` contracts
are the complete behavior-change scope. Real consumer pin updates and deployment
remain outside this worktree. #20 performance misses, real Logbook shape and
Celeron qualification remain open; no target was lowered. No push/publication.
