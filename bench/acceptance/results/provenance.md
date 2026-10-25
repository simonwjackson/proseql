# qws/base acceptance evidence

The harness completed on aka. This is the **skeleton baseline**, not the merged streaming implementation. `Streaming` still falls back to `Resident`; timing differences between them are not streaming improvements.

- Measurement source: `cacf9850615e1529fafb8adc7fddfa1ccea1e3d5`.
- Engine source: `qws/base` at `11b3b80a398c985b3c2bf8fb915bd647e99d27f5`. `git diff 11b3b80 -- crates` is empty.
- Run: `20261025T084930Z`, aka, AMD Ryzen 5 7600X, x86_64 Linux 6.18.17.
- Rust builds: `RUSTFLAGS='-C target-cpu=x86-64-v2'`; no distributed Nix builders.
- Synthetic data: 656,640 records per shape; 10 month partitions, 256 raw shards, and a controlled 16-shard raw supplement.
- SQLite 3.51.1: WAL, synchronous=1 (NORMAL), cache_size=-2000, page_size=4096, mmap_size=0, temp_store=0; typed columns and `(metric,time)` indexes.
- Every measured process used `systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout 180`.

Small committed summaries: [`latest.md`](latest.md), [`latest.jsonl`](latest.jsonl), [`evidence.json`](evidence.json), [`consumers.md`](consumers.md). Raw trials, stderr, source-file manifests, environment and binary hashes remain under `results/runs/20261025T084930Z/` on aka and the local ignored copy. Later report/command-logging edits do not change the measured Rust or Python execution paths.

## Verified results

| Evidence | Result |
|---|---|
| Planned trials | 360: 3 timing + 1 meter per cell |
| Executed trials | 324: 312 successful, 12 SIGKILL |
| Skips | 36 later repetitions of SIGKILLed cells; never counted as successful trials |
| Cold trials with resident owned-file pages before launch | 0 |
| Successful appends | 32; each persisted exactly 1,000 genuinely new rows |
| Answer equivalence | Every successful trial matched its canonical answer; full ten-month aggregate also matched across samples, raw256 and raw16 |
| Streaming target rows | 5 pass, 26 miss; 3 separate global qualifications unmeasured |

The five passing Streaming rows are open/idle RSS for both shapes, and the controlled 16-to-256-shard peak-RSS growth proxy. All speed, listed-read peak-RSS and post-query retained-RSS targets miss. The tables show individual ratios and the strict idle denominator, `max(SQLite retained delta, 1 MiB)`.

| Workload / shape | SQLite ms cold / warm | Streaming fallback ms cold / warm | Streaming / SQLite |
|---|---:|---:|---:|
| Ten months / samples | 401.005 / 296.138 | 5258.688 / 4880.813 | 13.114× / 16.482× |
| Ten months / raw | 394.876 / 288.482 | 3464.331 / 3354.531 | 8.773× / 11.628× |
| Append / samples | 10.765 / 7.970 | 507.994 / 495.969 | 47.189× / 62.233×; also correctness miss |
| Point / both shapes | measured in full table | SIGKILL in 1 GiB scope | miss, no completed operation value |
| Append / raw | 11.423 / 8.162 | SIGKILL in 1 GiB scope | miss, no completed operation value |

Point uses public `find_by_id`, not Stage 0's bounded ID-filter query or raw shard hint. The point numbers therefore do not reproduce Stage 0's different public path. SIGKILL is recorded directly; this run did not collect cgroup OOM attribution or a completed RSS peak for those cells.

The sample global-conflict probe fails under Resident and the Streaming fallback. No benchmark preflight hides that miss. The raw 1,000-row batch probe passes. Its routed batch covers all shards (inferred from the unchanged generator and Stage 0's file-count evidence); that does not prove a general global guarantee for smaller Resident batches. Raw append still fails its timing/memory scope.

Inferred cause of these misses: the skeleton retains the existing materialize/index/residency model. The next step is to merge the streaming executor, locator and append paths, then rerun this same task. Raising the memory limit or injecting a benchmark-only preflight is not a remedy. Retained ID metadata counts toward the strict post-query delta, even if it fits the separate SQLite + 20 MiB idle allowance.

## Commands and checks

```sh
# Actual acceptance task (all execution on aka):
bash scripts/qws/aka-run harness --x86-64-v2 --pull -- \
  env QWS_SOURCE_SHA=cacf9850615e1529fafb8adc7fddfa1ccea1e3d5 \
  proseql-task bench-acceptance

# Focused checks:
bash scripts/qws/aka-run harness --x86-64-v2 --pull -- \
  bash bench/acceptance/run.sh check

# All three consumer baselines; see consumers.md for exact Cargo commands:
bash scripts/consumers/run.sh /absolute/path/to/proseql --compare-baseline
```

| Focused check on aka | Result |
|---|---|
| `cargo check --locked --manifest-path bench/acceptance/Cargo.toml --all-targets --all-features` | pass |
| Release `cargo test`, standalone harness, all features | 4 passed, 0 failed |
| `cargo clippy --all-targets --all-features --no-deps -- -D warnings` | pass |
| `cargo fmt --manifest-path bench/acceptance/Cargo.toml --check` | pass |
| `python3 -m unittest discover -s bench/acceptance -p 'test_*.py'` | 4 passed |
| Ruff check and format check, all 3 harness Python files | pass |
| Shellcheck, harness and consumer scripts | pass; rerun after command-record formatting fix |
| Result audit on aka | pass: complete matrix, full-shape equivalence, all successful appends, consumer counts |
| Coach, original pin / main / qws-base | each build pass; each 27 tests passed |
| Logbook, original pin / main / qws-base | each build pass; each 219 tests passed, 2 pre-existing ignored |
| `git diff --check` | pass |

Binary SHA-256: timing `062d1254f71b8c2d1c24465c23ab49a4ca71e554a65a5c47352a16dbc23ef748`; meter `5c67d6e07d19e30700b69781a1a2af02682803ed7c66748c89055a97db5b9e41`. Manifest hashes are in `evidence.json`.

## Limits and follow-up

- No full ProseQL suite was run; the parent runs it on the combined implementation.
- Open ≤1 s on the real Logbook/rakku shape and absolute Celeron times remain **unmeasured**. No rakku/yari access or real health data was used.
- Equal power-loss durability remains **unmeasured**: native synced text appends and SQLite NORMAL WAL have different guarantees.
- All consumers must be rerun after the streaming changes merge. The scripts accept the new source without changing consumer repositories.
- Owned synthetic data, consumer copies and Cargo caches remain in `qws-harness-*` directories for Verify. Large raw logs are not committed. No push or deployment was performed.
