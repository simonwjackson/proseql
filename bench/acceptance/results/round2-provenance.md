# Integrated acceptance on aka — round 2

Measured runtime integration: `bd22cf4`. Harness source:
`26449c543f51d0f8fbba900ef65749fabf51820f`.
Branch: `c-35a30c74e7dfc76f72a87bfdb3818a7ff2ae3b552eba1c29bb0d5bc45230ea24`.
The only source changes are acceptance tooling. Lazy collections always stream;
the removed Resident backend is rejected, not counted as another contender.
Round-1 summaries and provenance remain unchanged.

## Commands

Every build, test, measurement and result audit ran on aka. Zao only used Git,
read/edited files and transferred source/results. No rakku or yari access.
No WASM build. All native builds use `RUSTFLAGS='-C target-cpu=x86-64-v2'`.

```sh
bash scripts/qws/aka-run bench2 --x86-64-v2 --pull -- \
  bash bench/acceptance/run.sh check
bash scripts/qws/aka-run bench2 --x86-64-v2 --pull -- \
  env QWS_SOURCE_SHA=26449c543f51d0f8fbba900ef65749fabf51820f \
  ACCEPTANCE_RESULT_PREFIX=round2 bash bench/acceptance/run.sh all
```

Every timed trial and both fresh fixture preparations use
`systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout`.
Operations use 180 s; preparation uses 600 s. The memory limit was never raised.
Synthetic records only. SQLite temporary files and fixtures use the owned
`/home/simonwjackson/work/qws-harness-data/bench2` directory.

## Focused checks

| Check on aka | Result |
|---|---|
| Initial integrated harness check at bd22cf4 | Reproduced compile error: `an inner attribute is not permitted in this context`, main.rs:8. Removing the obsolete deprecated selector removed that invalid attribute. No engine fix. |
| Cargo check, all targets/features, locked | Pass |
| Release harness tests, all features | 5 passed, 0 failed |
| Cargo clippy, all targets/features, no deps, `-D warnings` | Pass |
| Cargo fmt check | Pass |
| Python harness unit tests | 4 passed |
| Ruff check and format check, three Python files | Pass |
| Shellcheck, harness and consumer scripts | Pass |

The added public-path test verifies ordered append → same-month range equality,
release → point-lookup equality and rejection of the removed Resident backend.
Global duplicate safety is now required unconditionally by the harness tests.
No engine code changed, no full repository suite, no push, no deployment.
The parent owns combined verification.

## Measurement and audit

Accepted run: `20261025T182942Z`; timing/meter block
2026-10-25 18:30:20–18:37:56 UTC. **10 default target rows pass; 21 miss.**
Two extra release diagnostics add one pass (samples) and one miss (raw).
This is not #12 completion. No target is lowered.

| Verification | Result |
|---|---|
| Planned / completed trials | 272 / 272: 204 normal timing, 68 independent meter |
| Failures / skips / SIGKILL | 0 / 0 / 0 |
| Per-cell repeats | Exactly three timing trials and one meter trial in each of 68 cells |
| Answers | Every complete-row digest and every aggregate group matched SQLite; all three shapes' ten-month answers match |
| Append persistence | All 64 standard/sync mutation trials persisted exactly 1,000 new rows |
| Ordered sync answer | All 32 sync trials return 1,090 full rows |
| Global duplicate probes | SQLite and Streaming pass samples and raw, with no partial append |
| Cold owned file pages | Zero before launch in every cold trial |
| Required heap evidence | Point and ten-month aggregate on both shapes, raw append; separate binary |
| Point index release | No trim; ordinary one-second sample first, then one second after explicit release |
| Source binding | All Rust/harness/binary checksum entries verified against actual aka bytes |
| Independent audit | [Passed](round2-audit.txt): scopes, exact repeat counts, answers, append persistence, heap/release, cold caches, load, manifests, all 22 default/diagnostic miss floors, append-only design |

SQLite 3.51.1: WAL, `synchronous=1` (NORMAL), `cache_size=-2000`,
`page_size=4096`, `mmap_size=0`, `temp_store=0`. Its two non-covering indexes
remain `(metric,time)`. [Fresh preparation evidence](round2-prepare.json) and
[raw16 preparation](round2-prepare16.json) record uncapped generation and the
656,640-row count. `prepare` rejects an existing data directory; both preparations
completed on new paths.

### Load

The policy was committed before the run: wait for one-minute load ≤1 after
compilation/preparation; sample every five seconds; reject and repeat a complete
matrix if any one-minute sample exceeds 2. No high-load repeat was needed.
Two cooldown samples preceded the accepted block. Shared-host sampling does not
prove zero interference.

| Block | Load 1/5/15 before | Load 1/5/15 after | Maximum sampled 1/5/15 | Action |
|---|---:|---:|---:|---|
| Preparation + independent probes, non-timing block | 1.00 / 1.38 / 1.38 | 1.13 / 1.38 / 1.38 | Not continuously sampled; snapshots only | Accept preparation; wait before timing |
| Full matrix, 92 samples | 0.959 / 1.331 / 1.361 | 0.299 / 0.527 / 0.940 | 0.959 / 1.331 / 1.361 | Accept first block |

### Small evidence

[Report](../../../docs/benchmarks/query-while-scanning-aka-round2.md),
[generated tables](round2.md), [numeric summary](round2.jsonl),
[per-trial compact evidence](round2-evidence.json), [miss floors](round2-floors.md),
[environment](round2-environment.txt), [runtime source hashes](round2-source-files.sha256),
[harness hashes](round2-harness.sha256), [binary hashes](round2-binaries.sha256).
The normal matrix is unchanged apart from dropping Resident. Added measurements
are ordered append→range and the explicit post-point index release.

Real Logbook open ≤1 s, absolute Celeron times and equal power-loss durability
remain **unmeasured**. aka uses x86-64-v2 but its Ryzen 5 7600X is far faster than
the Celeron. Native synced text and SQLite NORMAL do not establish equal durability.
The strict retained-RSS tolerance stays max(SQLite's retained delta, 1 MiB).
No consumer trim or source-runtime teardown hides retained memory.

## Cleanup

The final independent audit passed before cleanup. Cleanup completed on aka at
**2026-10-25T18:42:11Z**, exit 0. [Exact cleanup record](round2-cleanup.txt).

| Owned aka path | Size before (`du -sh`) | Verified result |
|---|---:|---|
| `/home/simonwjackson/work/qws-harness-data/bench2` | 2.0G | Removed, including synthetic fixtures, SQLite temporary files and binary copies; `test ! -e` passed |
| `/home/simonwjackson/work/qws-bench2-target` | 455M | Removed; `test ! -e` passed |
| `/home/simonwjackson/work/qws-bench2` | 25M | Removed after results were pulled; `test ! -e` passed |

Other workers, the shared data parent and shared Cargo/Nix caches were not
removed. Ignored per-trial logs and drivers remain only in this local worktree
under `results/runs/`; small summaries remain in Git. Every new committed result
file is below 1 MB. The design document preserves the complete bd22cf4 file as
an unchanged prefix. Git diff checks pass; engine and non-harness runtime source
are unchanged. Nothing was pushed or deployed.
