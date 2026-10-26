# Query while scanning: write round 3

**Raw fresh append improves; samples do not. All four SQLite wall targets still miss.** The separate post-commit prefix traversal is gone on Fs, but the prefix is still checked once through the append descriptor. No target or durability rule changed.

## Source and method

Before: `112817e6ebc865675b54990f6b880ce4267092bf`, built from a pinned scratch clone. Final runtime: `3908e1319f3734bbdde4fd320ea13f223390e53a`. These are write-only measurements; parallel `perf3-read` changes are not included. Commits `8ea69f0`, `3dc02e6` and `6512240` supply its approved shared-observation, decoded-visitor and directory-metadata seams. `d5ee547` supplies append evidence; `3908e13` bypasses empty visitors for append membership.

Everything compiled and ran on aka through `scripts/qws/aka-run perf3-write --x86-64-v2`. Rust used portable scalar code and no new dependencies. All measured processes used `systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout 180` (600 seconds for fixture creation). No rakku or yari access occurred.

Each source's focused acceptance block had 24 timing and eight independent allocator trials: three timing repetitions per shape/backend/cache cell, one meter repetition, rotating backend order. Each append used a fresh fixture copy and no locator preflight. The existing acceptance cache helpers evicted only owned pages for cold trials and warmed relevant pages for warm trials. Cold residency was zero; warm text was fully resident. The fixture has 656,640 rows per shape, ten sample files or 256 raw files. Source bytes are 237,594,045 / 246,130,365.

All 64 before/final trials succeeded, matched complete answers and persisted exactly 1,000 new rows. Both sources also passed all four backend/shape global-conflict probes. Blocks waited for one-minute load ≤1 and sampled it every five seconds; maxima were 0.876 before and 0.905 final, below the rejection bar of 2. The instruction counter came from the acceptance harness's `perf_event_open`; allocator trials used its separate counting binary. `strace` ran separately, never as a wall-time qualification.

[Numeric evidence](query-while-scanning-write-round3.json) includes final and baseline cells, allocator samples, phase timers, syscall counts, and the intermediate `d5ee547` block. That intermediate block was faster in wall time despite executing more instructions than the final source. The final source, not the faster exploratory block, sets the numbers below. Three trials and load checks do not isolate CPU frequency, thermal state or every system effect.

## Fresh-runtime results

Cold / warm, median milliseconds. SQLite uses NORMAL/WAL. Native still synchronizes each file and the containing directory for a new file. Their power-loss contracts differ; this is not an equal-durability qualification.

| Shape | SQLite final | Before | Final | Final target |
|---|---:|---:|---:|---|
| samples | 10.791 / 7.566 | 370.024 / 319.895 | 373.953 / 322.334 | miss / miss, ≤1× |
| raw | 11.866 / 8.365 | 784.980 / 649.838 | 732.828 / 594.753 | miss / miss, ≤1× |

Raw falls about 7% cold and 8% warm. Sample medians rise about 1%; this run does not establish a fresh-sample wall improvement. Sample instructions also rise from 4.647 to 4.830 billion; raw falls from 7.244 to 6.266 billion. The empty-visitor bypass reduces samples from the intermediate 4.876 billion, but does not remove the regression against main. The remaining instruction attribution is not isolated.

Requested final heap live/peak is 10,562,534 / 28,227,086 bytes for samples and 13,028,480 / 25,486,350 for raw. These are allocator requests, not RSS or arenas. Peak RSS remains about 35 MiB; no new read-memory or idle-memory qualification is claimed.

## What changed, and what it costs

- `append_durable_with_identity` is additive. Its default calls `append_durable` and returns None, retaining the old proof. Fs captures before/after metadata from the same append descriptor, reads the kept prefix after sync, verifies the suffix equals the requested bytes, and checks unchanged descriptor metadata across read-back. The runtime compares the prefix hash with its **pre-apply** baseline and freshly checks the path generation before publishing locator coverage and `AppendProof`. Failed read-back discards evidence, not a durable success. Torn baselines retain the old path. The prefix still incurs one read and hash.
- There is no lock or exclusivity claim. A prefix edit during the write changes the checked hash; a suffix edit fails read-back; a path replacement fails the fresh path check. An edit after the last check and before publication remains possible, just as with the old proof. The next operation checks cached generations again. This is not snapshot isolation. Both the existing AppendSync same-length-prefix regression and the new suffix-edit regression pass.
- Cold locator construction no longer retains all earlier entries once per new shard. This removes its `files × rows` initial-build work. Capacity grows in bounded steps of at most 65,536 entries instead of reallocating every 4,096; successful construction releases spare capacity. The existing borrowed, field-only serde ID decoder remains. Empty visitors are bypassed; decoded visitors and their fresh post-scan checks remain available to reads. The price is a small extra internal routing path; global history still must be parsed and sorted.
- Fs `read_range` no longer fstats each ordinary chunk. Initial allocation stays bounded for requests larger than a file. Final generation checks remain.
- `list_directory_with_stat` and `observe_stat` share metadata with reads. Fs uses one directory pass, follows symlinks as `stat` does, and discovers recovery artifacts in that same pass. Only affected paths recover and get fresh metadata. Tests cover pending first writes, committed cleanup, restored missing destinations and zero recovery calls for normal entries. Trusted listed tokens add no second stat; consumers check after scans. Tokenless observations hash and reject changed metadata.

The approved `lib.rs` integration edits only the durable-append arm. Eager append-only collections still call ordinary `append_durable`. Error mapping, sorted write order, rollback and quarantine are unchanged. Wrappers forward additions while keeping snapshot, tokenless and fault hooks. Replace-only hosts retain the safe default.

## Live-owner profile and remaining per-file work

A separate warm-text, counting-allocator probe prepares each distinct batch outside the timer. One process appends three 1,000-row batches. It is not a cache qualification or a SQLite comparison.

| Shape | Before batch 1 / 2 / 3, ms | Final batch 1 / 2 / 3, ms | Prefix check, before → final, batches 2 / 3 |
|---|---:|---:|---:|
| samples | 307.103 / 30.275 / 30.337 | 284.921 / 24.614 / 24.785 | 12.540 / 12.631 → 8.922 / 8.994 ms |
| raw | 626.638 / 219.168 / 216.762 | 555.725 / 196.474 / 198.454 | 115.959 / 116.214 → 96.768 / 98.938 ms |

Final first-build membership takes 238.959 ms samples / 254.205 ms raw, including about 25 ms sorting. Initial baseline preparation takes 16.625 / 99.542 ms. Raw's first 256-file commit takes 173.061 ms, including 98.380 ms read-back. Later bookkeeping takes 4.4–4.9 ms. These spans nest; do not add a nested proof to its commit again.

First-batch requested allocation traffic falls from 1,178,104,080 to 379,168,884 bytes for samples and 1,657,513,069 to 633,986,064 for raw. The counter includes full realloc destination sizes, not only copies or live memory. Peak requested heap barely changes. Later raw allocation traffic falls from about 288 MB to 38 MB because prefix checking reuses one descriptor and one bounded buffer.

To isolate one further raw batch, separate `strace` processes measured repeat(2) minus repeat(1), each from a fresh identical fixture. It touches exactly 256 files:

| Syscall | Before per batch (per file) | Final per batch (per file) |
|---|---:|---:|
| statx | 18,948 (74.016) | 6,916 (27.016) |
| openat / close, each | 4,611 (18.012) | 771 (3.012) |
| read | 4,360 (17.031) | 4,616 (18.031) |
| lseek | 4,608 (18.000) | 1,024 (4.000) |
| fdatasync | 256 (1.000) | 256 (1.000) |
| mkdir | 256 (1.000) | 256 (1.000) |

The extra read verifies the exact suffix; reads do not vanish. The remaining three per-file opens are tail-conflict checking, durable append and suffix bookkeeping. Preparation, locator refresh, transaction checks, recovery probes and final generation checks still issue metadata calls. This call-site attribution follows the source; syscall counts themselves are measured. The final three-batch trace spends 48.570 ms in 768 fdatasync calls, about 16.190 ms per batch. That is a sampled kernel-time cost under strace, **not** a physical lower bound or an equal-durability comparison.

## Every miss: floor, reason, next step

Floors below are the fastest final timing trial, not physical lower bounds. No target is lowered.

| Miss | Observed floor / current SQLite median | Reason | Next step and cost |
|---|---:|---|---|
| samples cold | 373.264 / 10.791 ms | Fresh global ID parsing/sorting, target baseline preparation and checked read-back | Profile and specialize remaining ID-only decode/adapter work. Persistent checked membership needs #18's decision and invalidation rules; it adds storage/ownership complexity and is not approved here. |
| samples warm | 315.422 / 7.566 ms | Warm pages do not prebuild global membership; instructions regress | Same membership work first. Reusing the live owner reaches 24.6 ms in this probe but still misses and is not a target waiver. Stronger exclusive/conditional host evidence could remove the remaining prefix read; a metadata pair alone cannot. |
| raw cold | 727.845 / 11.866 ms | Global membership, 256 initial baselines, 256 checked prefixes and synced targets | Share baseline accumulation with the first ID pass through a checked streaming builder. This adds incremental hash/torn-tail state and error-precedence/race tests. Persistence still needs #18. |
| raw warm | 588.861 / 8.365 ms | Fresh membership plus the same file fanout; a live owner still pays about 98 ms prefix checking | Prepared per-file handles could combine redundant opens/checks, at the cost of retained descriptors and a larger host contract. Fewer durable targets needs a consumer layout change and migration. The 256 syncs are retained, not weakened or called equal to NORMAL. |

## Checks and cleanup

On aka, scalar x86-64-v2:

- Storage tests before the final ID-only routing patch: **189 passed, three ignored**. This includes filesystem durability, recovery, listing and host tests.
- Final related storage rerun (`--lib`, `streaming_index`, `streaming_write_index`, `streaming_write_observed`): **37 passed, two ignored**.
- Final native `--lib`, `streaming_append`, `streaming_write_locator`, `streaming_watch`, `append_runtime`: **61 passed, five routine ignored entries**. Crash parents explicitly invoke their subprocess children; the crash tests passed.
- `cargo check -p proseql-native -p proseql-storage --lib --tests --examples`: passed.
- Scoped clippy for both crates' libraries/tests/examples with `allocation-meter`, `-D warnings`: passed.
- Scoped `cargo fmt --check`: passed. Numeric JSON, all four miss/floor comparisons, final runtime source hashes and removal of the synthetic data directory were independently checked on aka. Rust was `rustc 1.92.0 (ded5c06cf 2025-12-08)`. No full workspace suite ran.

For clarity, earlier progress messages misstated two individual counts: filesystem durability is **13**, not 14; native `append_runtime` is **15**, not 14.

No push, deployment, GitHub comment or issue filing ran. All owned aka fixture data, trial copies, SQLite files and standalone executable copies were removed from `/home/simonwjackson/work/qws-harness-data/perf3-write`. The baseline scratch clone was removed. Text trials, source hashes and traces remain under `/home/simonwjackson/work/qws-perf3-write-{before,final,d5ee547}`; the source checkout and Cargo build cache remain. The parent still needs its combined read/write verification and performance run.
