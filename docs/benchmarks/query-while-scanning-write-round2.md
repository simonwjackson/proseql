# Query while scanning: write and ID-locator round 2

**Overflow duplicate-error precedence is fixed. Writes and locator memory improve, but the SQLite targets still miss. No target was lowered.**

## Source and method

Before: `aed5154`. Matrix after: `70cb580545e6f79aa42f55bc9a81604186ddb742`, including perf-read through `0ae216c`. Point latency therefore includes perf-read's prepared validation and fused locator scan; do not attribute that whole improvement to compaction. Subsequent fix `5f2297d91a00a6b6a8dad9364e3506ef8aba805b` restores the legacy speculative metadata path's speed; its focused checks and separate measurement passed. The matrix's built-in checked-append route does not use that speculative path. Review fix `cbfef2b9a2943fb293ad1f6fd4c24282eed0d209` restores source-order duplicate errors when locations overflow; the matrix fixture has no duplicates, and both overflow error-precedence probes were verified separately.

All compilation, tests and measurements ran on aka through `scripts/qws/aka-run perf-write --x86-64-v2`. No command ran on rakku or yari. Rust used `-C target-cpu=x86-64-v2`. Data was synthetic: 656,640 rows per shape, ten sample months or 256 raw shards. No binary index or cache was added.

Profiling preceded the runtime changes. The shell lacked the `perf` executable, so the attempted `perf stat -e instructions:u` could not run. The acceptance harness's `perf_event_open` user-instruction counter supplied that same event instead. A separate counting-allocator binary measured requested live/peak heap, not allocator arenas or RSS. The initial meter profile counted 6.092 billion instructions for sample append and 8.095 billion for raw append. Its point live/peak heap was 15,857,122/16,056,805 bytes for samples and 16,041,979/16,261,856 bytes for raw.

The final focused acceptance run used the existing acceptance public paths and cache helpers: 90 timing trials and 16 separate meter trials, rotating backend order, three timing trials per cell. Every process used `systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout 180`. Cold trials evicted only owned fixture pages; warm trials warmed those pages. Warm point primed the operation on the same runtime. Warm append did **not** prebuild the locator. Every append used a fresh fixture copy.

All 106 trials succeeded and matched complete answers. All 44 append trials persisted exactly 1,000 new rows. Wall values below are medians; peaks are maximum timing-trial RSS; retained memory is median RSS at one second minus independently measured fresh-idle RSS. [Numeric evidence](query-while-scanning-write-round2.json) includes floors, counters, allocator samples and verdicts.

## Final before/after

Cold / warm. SQLite uses NORMAL/WAL. Native still synchronizes each appended file and the directory for a new file. Their power-loss contracts differ; these numbers do not establish equal durability.

| Measure | Shape | SQLite | Before | After | Target status |
|---|---|---:|---:|---:|---|
| Append 1,000, ms | samples | 10.386 / 7.689 | 517.927 / 462.403 | 363.194 / 314.247 | miss / miss, limit 1× SQLite |
| Append 1,000, ms | raw | 11.369 / 8.065 | 869.875 / 750.906 | 769.460 / 640.575 | miss / miss, limit 1× SQLite |
| Point, ms | samples | 0.988 / 0.0238 | 2541.095 / 0.239 | 625.826 / 0.231 | miss / miss, limit 2× SQLite |
| Point, ms | raw | 1.170 / 0.0375 | 2863.167 / 2.996 | 800.610 / 2.845 | miss / miss, limit 2× SQLite |
| Point peak, MiB | samples | 6.230 / 6.230 | 22.527 / 22.527 | 17.879 / 17.879 | miss / miss, limit 2× SQLite |
| Point peak, MiB | raw | 6.230 / 6.230 | 22.785 / 22.789 | 18.238 / 18.238 | miss / miss, limit 2× SQLite |
| Point retained, MiB | samples | 0.141 / 0.141 | 15.410 / 15.410 | 10.777 / 10.777 | miss / miss, tolerance 1 MiB |
| Point retained, MiB | raw | 0.141 / 0.141 | 15.582 / 15.586 | 11.051 / 11.051 | miss / miss, tolerance 1 MiB |
| Append peak, MiB | samples | 9.477 / 9.477 | 39.313 / 39.316 | 34.918 / 35.043 | reduced; no read-peak qualification |
| Append peak, MiB | raw | 9.535 / 9.535 | 39.668 / 39.668 | 34.836 / 34.836 | reduced; no read-peak qualification |

Timing-binary append instruction medians fell from 6.063 to 4.600 billion for samples, and 8.058 to 7.188 billion for raw. Separate meter append live/peak bytes fell from 16,012,727/30,290,426 to 10,606,816/28,226,862 for samples, and 18,302,316/30,718,034 to 13,028,812/25,442,482 for raw.

An intermediate whole-target post-commit proof raised sample append peak to 57.9 MiB. That implementation was replaced. The final proof hashes through at most 64 KiB `read_range` requests; the final table above verifies that the peak regression is gone. Initial append-baseline construction retains its existing one-target-buffer bound.

## What changed, and its cost

- Common locator entries are 16 bytes instead of 24. They retain the full 64-bit ID hash. Packed locations cover file indexes below 4,095, offsets through `u32::MAX`, and row ordinals through 1,048,575. A sparse overflow table handles larger locations and unknown speculative ordinals without truncation. Overflow-heavy shapes cost more memory.
- Equal-hash entries now compare decoded `(file, offset)` everywhere, including partition builds, delta sorting and merges. Packed overflow addresses are not source order. Review reproduced the wrong duplicate error/path with 1,048,577 rows in file `a` and another duplicate in `b`. Both reported probes failed before the fix, then passed with exact baseline messages and paths. Overflow ties pay extra location lookups; ordinary unequal-hash comparisons do not.
- On the storage-only 656,640-row fixture, the locator built in 221.347 ms and retained 10,554,656 structure bytes (16.074 bytes/row). Round 1 measured 360.200 ms and 15,762,680 bytes. Verified warm candidate lookup/read/JSON decode was 6.637 µs versus 6.499 µs before. These are single warm-text trials, not isolated attribution or SQLite qualification.
- `SourceGeneration` observes one trustworthy host token instead of hashing the prefix on identity-aware hosts. An unchanged token skips text reads. A changed token means `Replaced`, not a guessed append. External append refresh therefore rebuilds the changed file: 32.834 ms in the single changed-month storage trial. Hosts without a token keep checked-prefix hashing.
- `FileStat::change_id = Some` now explicitly requires a change on every content edit, append, truncation or replacement. Hosts unable to promise that return `None`. This clarifies the unreleased round-1 API. Fs uses dev/inode/ctime; Memory uses the tokenless default; captured read snapshots return `None`; the other in-tree wrappers forward `stat` unchanged. Tests verify Fs tokens on same-length in-place edits, append and truncation.
- Own appends reuse checked locator coverage. After durable success, the runtime hashes the accepted complete text in bounded chunks, compares the existing stored fingerprint, reads the new suffix, and checks the generation again. A post-commit `stat` alone never blesses coverage. Failure discards derived metadata without reversing or failing a durable success. The append delta is not merged on an unchanged refresh.
- Legacy `IdLocator::record_appended` remains public. A compaction draft made 256 calls × four rows take 8.586 ms instead of round 1's 0.614 ms. Tagged deterministic addresses now make common speculative-idempotence checks use the same single overflow table directly; the fixed measurement was 0.320 ms, and 0.371 ms after the subsequent source-order tie fix, with 10,609,800/10,734,472 resident structure bytes before/after. Rare wide locations keep their checked fallback. Tests cover repeats across delta/base merges and conversion into checked coverage. There is still one production caller: `IdLocator::accept_appended` delegates custom-codec/partition-level invalidation to this method. Built-in native writes use checked `accept_appended` instead. Storage tests and the measurement also call the public method.
- `AppendProof { before, after, start }` exposes that checked evidence to time indexes. It is non-consuming and records only the latest own append. Each time index must match `before` exactly and check `after` before extending. An index that missed several appends rebuilds. A bounded chain is a possible later optimization, not implemented here.
- `release_streaming_indexes()` drops streaming ID/time indexes, validated generations and append proofs, while retaining codec context. It does not promise RSS reclamation. The next ID read repeats construction and payload validation; measured rebuilds take roughly 0.6–0.8 s on aka with perf-read's decoder.

A three-batch, same-open-runtime public append probe prepared 1,000 distinct rows per batch outside the timer. It did no locator preflight. Samples touched one target; raw touched all 256. Final sample batches took 330.655, 25.952 and 26.001 ms; their prefix proofs took 11.931, 11.951 and 12.054 ms. Raw took 723.104, 206.311 and 204.064 ms; proofs took 116.101, 115.117 and 115.946 ms. These are warm-text single trials, not new SQLite target qualifications. Fresh-runtime acceptance remains the table above.

## Own append followed by range

The example's `append-range` mode primes the last hour of October, appends at the last stored timestamp to keep time order valid, then reads that hour after each 1,000-row batch. The three result sizes are 1,090, 2,090 and 3,090. The example asserts each increase, through the public file-scanning query path. This isolates a valid ordered sync pattern, not backfilled out-of-order appends.

The comparison uses perf-read at `dc8d024` before the proof consumer and final bounded-proof source `70cb580` after it:

| Shape | Range after batch 1 / 2 / 3, before hook (ms) | Final range after batch 1 / 2 / 3 (ms) |
|---|---:|---:|
| samples | 29.104 / 31.207 / 34.255 | 2.198 / 3.647 / 5.052 |
| raw | 283.734 / 282.690 / 288.066 | 13.166 / 14.269 / 15.818 |

The same validated rows and ordered-index candidate counts are retained: samples 1,112/2,112/3,112; raw 5,224/6,224/7,224. Out-of-order appends still disable positional seeking; external changes still rebuild.

## Explicit release and allocator diagnostic

Without the release API, the strict retained-memory target misses. Dropping the locator is not the same as returning allocator pages to the OS. The final two-cycle probe shows both cases (RSS in bytes, sampled one second after each operation):

| Shape / cycle | Fresh idle RSS | RSS after lookup | RSS after release | Lookup ms |
|---|---:|---:|---:|---:|
| samples / first | 7,114,752 | 18,280,448 | 7,770,112 | 583.570 |
| samples / second | 7,114,752 | 18,415,616 | 18,415,616 | 611.605 |
| raw / first | 7,204,864 | 18,657,280 | 8,146,944 | 790.456 |
| raw / second | 7,204,864 | 18,857,984 | 18,857,984 | 739.088 |

The first releases leave 0.625/0.898 MiB above idle. The second releases drop the locator's requested allocations but do not return to idle. Glibc arena retention is consistent with this result; the exact allocator-policy attribution is inferred, not independently traced.

The separate `point-release-trim` diagnostic calls the existing session owner's explicit `IdleMemoryReclaim::GlibcTrim` helper after release. Its final second-cycle sample RSS falls from 18,415,616 to 7,528,448 bytes in 0.938 ms, and raw RSS from 18,862,080 to 7,745,536 bytes in 0.796 ms. This is not enabled by default, not a new allocator, and not a no-trim qualification. Its cost is an allocator-specific, process-wide reclamation call and repeat index construction after release.

## Every remaining miss

Floors are the fastest completed trial or smallest observed peak/delta, not physical lower bounds.

| Miss | Observed floor, cold / warm | Reason | Cheapest next step and cost |
|---|---:|---|---|
| Sample append | 352.369 / 307.683 ms, versus 10.386 / 7.689 ms bar | Fresh global membership still scans all history; synced append and checked prefix proof remain | Reuse the live owner (already measured); persistent checked membership needs #18 policy/invalidation work. Extend the durable-host contract to reduce proof work; not a safety-free change. |
| Raw append | 769.375 / 637.895 ms, versus 11.369 / 8.065 ms bar | Global build, many baseline preparations, 256 synced targets and prefix reads | Host-supported conditional append evidence first; fewer durable targets requires a consumer layout change and migration. SQLite NORMAL remains a different power-loss contract. |
| Cold point | samples 624.576 ms; raw 797.432 ms | Global payload validation and ID build remain required on first use | A persistent locator plus source/schema-bound validation evidence needs #18 approval and correct invalidation. Moving work into open changes startup cost, not the amount of work. |
| Warm point | samples 0.230 ms; raw 2.708 ms | Directory listing and repeated per-file generation checks, especially 256 shards | Share one checked generation observation across validation and locator refresh; fresh external-edit detection still costs host I/O. A change journal is a larger host contract. |
| Sample point peak | 17.879 MiB, versus 12.461 MiB limit | About 10 MiB of locator metadata remains | Further packing/paging or a checked persistent locator; neither is proved to meet the target. Release helps retention, not build peak. |
| Raw point peak | 18.238 MiB, versus 12.461 MiB limit | Same table plus per-file metadata | Same next step; larger/overflow-heavy locations cost more. |
| Sample point retained | 10.777 MiB, versus 1 MiB tolerance | Keeping the locator makes later operations fast; freed allocator pages can also remain | Explicit release trades memory for a rebuild; explicit existing trim can reclaim pages, but is not the default target. |
| Raw point retained | 11.051 MiB, versus 1 MiB tolerance | Same cause, plus per-file state | Same next step and cost. |

A proposed follow-up is for `append_durable` to return before/after identities from the same open file descriptor. **That pair alone does not close the race with an external prefix edit during the append.** Removing the prefix proof needs a stronger ownership/conditional-write guarantee, serialization, or equally checked evidence. This round deliberately keeps the proof. There is no new filesystem lock or snapshot isolation.

## Checks and guarantees

On aka at x86-64-v2:

- Storage: `--lib`, `streaming_index`, `streaming_write_index`, `streaming_perf_time`: 34 passed across the focused runs, three measurement tests ignored in routine selection.
- Native: `--lib`, `streaming_append`, `streaming_index`, `streaming_watch`, `append_runtime`, `streaming_write_locator`, `streaming_time_append`: 71 passed, four subprocess/measurement entries ignored. The crash tests invoke their subprocess children explicitly.
- Explicit ignored 656k storage measurement: passed. Explicit 256-call append-delta measurement: passed, 0.371 ms after the source-order fix.
- Scoped `cargo check` for both crates' libraries, tests and examples: passed.
- Scoped clippy, including tests and the benchmark with `allocation-meter`, `-D warnings`: passed.
- Scoped `cargo fmt --check`: passed.
- No full workspace test suite, push, deployment or GitHub comment ran.

Global duplicate checks, validated `ignore_identical`, custom-codec partition candidates, full-scan policy, torn-suffix repair, synced appends, rollback, partial-file crash behavior and quarantine stay unchanged. A deterministic test edits an old ID at `AppendSync`; the post-commit proof rejects that coverage, and the next create still detects the edited ID. Candidate verification checks the source generation before and after decoding. The public release method and the clarified token contract are approved additions; `GenerationCheck` conservatively reports replacement for changed trusted tokens.

Raw final trials and summaries are retained as text JSON under `/home/simonwjackson/work/qws-perf-write-{final.jsonl,final-summary.json}` on aka. Owned synthetic fixture directories, trial copies, SQLite temporary files and standalone benchmark binary copies are removed after measurement. The source checkout and Cargo build cache remain for checks.
