# Integrated query-while-scanning acceptance on aka

**Streaming: 12 measured target rows pass, 19 miss.** Three rakku/durability
qualifications remain unmeasured. This is not #12/#19 completion or cutover approval.
Resident is still the default; Streaming is explicitly selected by the harness.

- Source: `qws/integration`, `267427c69c819a7612e50b596be12409019e0ba5`.
- Accepted matrix: `20261025T102804Z`, 2026-10-25 10:28:04–10:43:50 UTC.
- Host: aka, x86_64 AMD Ryzen 5 7600X, 6 cores/12 threads, Linux 6.18.17,
  filesystem-backed btrfs `/home`; Rust/Cargo 1.92.0.
- Rust builds: `RUSTFLAGS='-C target-cpu=x86-64-v2'`, the Celeron's instruction
  level, on a much faster CPU. No distributed Nix builders. No rakku/yari access.
- Synthetic records only: 656,640 per shape, 10 month sample files, 256 raw
  hash shards; equal-row-count raw16 supplement. Generator 1 fixtures were reused
  and checked for row count, uncapped generation and partition counts.
- SQLite 3.51.1 uses the committed bundled dependency, NORMAL/WAL, typed records
  and non-covering `(metric,time)` indexes. [`sqlite.json`](sqlite.json) records the
  actual timing binary's version, PRAGMAs and index SQL on a fresh fixture.
- Every matrix operation: `systemd-run --user --scope -p MemoryMax=1G -p
  MemorySwapMax=0 nice -n 10 timeout 180`. Preparation uses 600 seconds. No limit
  was raised. There was no consumer `malloc_trim` or runtime close before the
  one-second RSS reading.

The [report](../../../docs/benchmarks/query-while-scanning-aka.md) and appended
[design section](../../../docs/design/query-while-scanning.md#measured-on-aka)
contain every #12 target. Small source data: [Markdown](latest.md),
[JSONL](latest.jsonl), [miss floors](floors.md), [evidence](evidence.json),
[OOM diagnostics](oom.json). The prior skeleton results remain in Git at
`267427c:bench/acceptance/results/provenance.md`; they are not these measurements.
`consumers.md` remains separate skeleton-era consumer evidence, not an integrated
consumer qualification by this worker.

## Verified matrix and memory

| Check | Result |
|---|---|
| Planned matrix | 360: three rotating timing trials plus one independent meter trial per cell |
| Executed | 342: 336 succeeded, six Resident SIGKILL; 18 later repetitions skipped after kills |
| Answers | Every successful trial matched; complete ten-month aggregates matched samples/raw/raw16 |
| Append persistence | All 40 successful trials persisted exactly 1,000 genuinely new rows |
| Global-conflict probe | SQLite and Streaming pass both shapes; Resident fails samples; raw probe pass is not a general Resident guarantee |
| Cold file pages | Zero cold trials had owned fixture pages resident before launch |
| Source binding | Source/harness/binary SHA-256 manifests verified against actual bytes after the run |
| Counting allocator | Separate binary covers every successful cell, including ten-month reads, point lookups and raw append |
| Streaming passes | Four open/idle RSS rows, six non-point read peak rows, sample hour/month retained RSS |
| Streaming misses | All ten wall rows, both point peaks, six retained-RSS rows, strict partition-count growth proxy |

The matrix records SIGKILL, not cgroup attribution. Six **independent** cold/warm
reproductions of the same Resident cells confirmed OOM: point on both shapes and
raw append. Each fresh scope recorded `memory.peak=1,073,741,824` and
`oom_kill=1`. They use the same binary, data, options and 1 GiB/no-swap limit;
`OOMPolicy=continue` and a one-second shell tail preserve counters after the
victim exits. An outer timeout is 185 seconds; the operation timeout stays 180.
Those diagnostics are not pooled into matrix timing/RSS. Sampled process RSS is
a lower bound, not the completed peak or retained RSS. RSS can include shared
pages charged outside that cgroup, so RSS and cgroup charge are not identical.

The sample Resident conflict probe is a reproduction of the known global-check
gap: an October requested ID already exists with different content in May, yet
public `create_many` accepts the batch. The harness adds no preflight to hide it.
No engine bug was fixed during Verify.

## aka load

aka also builds for the fleet. The policy was set before the run: prebuild both
binaries, wait for one-minute load ≤1, sample load every five seconds, reject
and repeat the **whole matrix block** if any one-minute sample exceeds 2.
This is conservative on a 12-thread host; it does not prove zero interference.

| Block | Load 1/5/15 min before | Load 1/5/15 min after | Maximum sampled 1/5/15 min | Action |
|---|---|---|---|---|
| Matrix, 190 samples | 0.85 / 1.35 / 1.41 | 0.59 / 0.65 / 0.91 | 1.19 / 1.35 / 1.41 | Accept first block; no high-load repeat needed |
| Six independent OOM reproductions | Per-cell values in `oom.json` | Per-cell values in `oom.json` | Highest one-minute load 0.814453 | Accept all first attempts |
| Fresh SQLite info preparation | 0.041 / 0.280 / 0.652 | 0.468 / 0.364 / 0.673 | 0.509 / 0.371 / 0.677 | Accept first attempt |

Our compilation left one-minute load at 2.00 at 10:25:04 UTC. Measurement waited
until 10:28:04 UTC and load 0.85. Build/cooldown samples do not enter timings.
The fresh SQLite info preparation has its own before/after/max load in
`sqlite.json`; it is not another timing matrix.

## Commands and checks

The actual outer driver was `results/runs/verify-run.sh` (ignored). It applied
the load policy above around the standard task. The reproducible task and checks,
from a checkout of the recorded source, are:

```sh
bash scripts/qws/aka-run bench --x86-64-v2 --pull -- \
  env QWS_SOURCE_SHA=267427c69c819a7612e50b596be12409019e0ba5 \
  proseql-task bench-acceptance
bash scripts/qws/aka-run bench --x86-64-v2 --pull -- \
  env ACCEPTANCE_REQUIRE_GLOBAL=1 bash bench/acceptance/run.sh check
```

| Focused check on aka | Result |
|---|---|
| Cargo check, standalone harness, all targets/features, locked | Pass |
| Release harness tests, all features, global checks required | 4 passed, 0 failed |
| Cargo clippy, all targets/features, no deps, `-D warnings` | Pass |
| Cargo fmt check | Pass |
| Python harness unit tests | 4 passed |
| Ruff check and format check, three harness Python files | Pass |
| Shellcheck, harness and consumer shell scripts | Pass |
| Independent result audits | Pass: complete matrix, three repeats, all answers/appends, cold eviction, required heap cells, manifests and load policy; every miss has a floor; doc tables match generated data; original design is an unchanged prefix |
| Git diff check on zao | Pass; engine and harness execution code unchanged; design additions only |

No full repository suite or consumer override was run by this worker. The parent
owns combined verification. All execution/builds were on aka through aka-run;
zao did Git, file edits/reads and source/result transport only. Nothing ran on
rakku or yari. Stage 0's yari/aarch64 absolute numbers are not compared with aka.

## Cleanup and limits

After results were pulled and the final source/result audit passed, cleanup ran
through `aka-run bench --x86-64-v2` at **2026-10-25T10:52:06Z**, exit 0.

| Owned path on aka | Size before (`du -sh`) | Verified result |
|---|---:|---|
| `/home/simonwjackson/work/qws-harness-data` | 2.1G | Removed; `test ! -e` passed |
| `/home/simonwjackson/work/qws-bench-target` | 455M | Removed; `test ! -e` passed |
| `/home/simonwjackson/work/qws-bench` | 24M | Removed; `test ! -e` passed |

No active named diagnostic scope remained. Other workers and shared Cargo/Nix
caches were not removed. Ignored per-trial logs, manifests and driver scripts
remain only in this local worktree under `results/runs/`; committed summaries
remain in Git. No updated file exceeds 1 MB; the largest is `latest.jsonl`,
49,985 bytes. No push or deployment was performed.

Open ≤1 s on Logbook's real shape, absolute Celeron times and equal-durability
qualification remain **unmeasured**, with no rakku access by user rule. Native
synced text and NORMAL WAL also have different power-loss guarantees. The strict
idle tolerance is retained RSS ≤max(SQLite retained delta, 1 MiB) after one
second. No target was lowered. Proposed next steps in the report are not measured
fixes or evidence that text-only performance is impossible.
