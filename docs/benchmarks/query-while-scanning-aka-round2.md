# Query while scanning: round-2 acceptance on aka

**Streaming: 10 default #12 target rows pass, 21 miss.** The two explicit-release diagnostics add one pass and one miss. No target is lowered. Rakku-only targets and equal durability remain unmeasured.

## Source and method

Integrated engine: `bd22cf4`. Measured source: `26449c543f51d0f8fbba900ef65749fabf51820f` (harness-only adaptation on top). Lazy collections always stream. The deprecated Resident selector cannot restore the deleted path; the harness drops its column and rejects that CLI backend. Round 1 is the Streaming column in [the round-1 report](query-while-scanning-aka.md), backed by its unchanged `latest.jsonl`.

All compilation, focused tests and measurements ran on aka, AMD Ryzen 5 7600X, with `RUSTFLAGS='-C target-cpu=x86-64-v2'`. This uses the Celeron's instruction level, but a far faster CPU. No WASM build, rakku or yari access. Zao only edited/read/transferred files and used Git. Synthetic data only: 656,640 records per shape, ten January–October sample files, or 256 raw shards. The equal-row-count raw16 fixture supplies the partition-growth proxy.

SQLite uses NORMAL/WAL, TEXT primary keys, non-covering `(metric,time)` indexes, default page cache and no mmap. Temporary files stay under `/home/simonwjackson/work/qws-harness-data/bench2/tmp`. Both fixture preparations used fresh directories. Native sync and SQLite NORMAL differ in power-loss guarantees; matching this timing bar does not qualify equal durability.

272 trials: three rotating timing trials plus one independent counting-allocator trial per cell. Every measured process and preparation used `systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout`: 180 s per operation, 600 s for preparation. The limit was never raised. Cold trials evict only owned files with fsync/fadvise; warm reads also prime the operation on the same open runtime. Warm append only warms pages, never membership. Timed calls consume canonical complete-row digests or all aggregate groups. All answers and all 1,000-row persistence checks match. Global conflicting-ID probes pass for both backends and shapes, without measured-append preflight.

Wall is median of three; peak is maximum of three; retained is median one-second RSS minus independently measured fresh idle. Back-to-idle tolerance remains max(SQLite retained delta, 1 MiB). No `malloc_trim`, runtime close or session teardown occurs before sampling. Point release happens only after the ordinary one-second sample; a second sample is one second after `release_streaming_indexes()` returns. Peak precedes release. Counting-allocator timings do not enter medians.

## Every #12 target

Cold / warm. Read peak limit 2×; wall limits point 2×, hour 1.5×, month/ten/append 1×. Open/idle verdicts use SQLite +20 MiB; their displayed ratios use raw SQLite RSS. Retained ratios use the tolerance, not SQLite raw RSS. A row passes only if both modes meet the target. Verdicts use unrounded values.

| Target | Shape | SQLite round 2 | Round 1 Streaming | Round 2 Streaming | Round 2 / SQLite C/W (retained: tolerance) | Status C/W |
|---|---|---:|---:|---:|---:|---|
| point wall ms | samples | 1.135 / 0.029 | 2550.776 / 0.249 | 650.096 / 0.248 | 572.941 / 8.465× | **miss / miss** |
| hour wall ms | samples | 1.658 / 0.410 | 105.415 / 1.709 | 52.752 / 0.342 | 31.823 / 0.835× | **miss / pass** |
| month wall ms | samples | 33.570 / 19.544 | 294.275 / 91.962 | 105.703 / 46.760 | 3.149 / 2.393× | **miss / miss** |
| ten wall ms | samples | 413.099 / 287.973 | 1779.972 / 835.600 | 530.105 / 432.924 | 1.283 / 1.503× | **miss / miss** |
| append wall ms | samples | 10.205 / 7.803 | 509.959 / 462.410 | 370.443 / 316.396 | 36.301 / 40.546× | **miss / miss** |
| open RSS MiB | samples | 5.996 / 5.996 | 7.230 / 7.297 | 7.094 / 7.223 | 1.183 / 1.205× | **pass / pass** |
| idle RSS MiB | samples | 5.996 / 5.996 | 7.230 / 7.230 | 7.094 / 7.094 | 1.183 / 1.183× | **pass / pass** |
| point peak MiB | samples | 6.227 / 6.227 | 22.578 / 22.578 | 17.809 / 17.809 | 2.860 / 2.860× | **miss / miss** |
| point retained MiB | samples | 0.230 / 0.230 | 15.410 / 15.410 | 10.777 / 10.777 | 10.777 / 10.777× | **miss / miss** |
| hour peak MiB | samples | 6.480 / 6.500 | 7.836 / 7.840 | 8.473 / 8.047 | 1.307 / 1.238× | **pass / pass** |
| hour retained MiB | samples | 0.484 / 0.504 | 0.668 / 0.672 | 1.016 / 1.016 | 1.016 / 1.016× | **miss / miss** |
| month peak MiB | samples | 10.004 / 10.184 | 8.613 / 8.855 | 8.973 / 8.820 | 0.897 / 0.866× | **pass / pass** |
| month retained MiB | samples | 2.230 / 4.188 | 0.516 / 1.688 | 1.152 / 1.789 | 0.517 / 0.427× | **pass / pass** |
| ten peak MiB | samples | 10.129 / 10.266 | 17.738 / 18.395 | 13.098 / 13.605 | 1.293 / 1.325× | **pass / pass** |
| ten retained MiB | samples | 2.309 / 4.270 | 1.188 / 11.227 | 1.723 / 6.574 | 0.746 / 1.540× | **pass / miss** |
| point wall ms | raw | 1.229 / 0.029 | 2879.890 / 3.254 | 835.128 / 3.055 | 679.563 / 106.616× | **miss / miss** |
| hour wall ms | raw | 2.245 / 0.297 | 1442.702 / 314.995 | 616.902 / 10.361 | 274.828 / 34.925× | **miss / miss** |
| month wall ms | raw | 31.621 / 19.303 | 1682.301 / 565.154 | 612.672 / 54.556 | 19.375 / 2.826× | **miss / miss** |
| ten wall ms | raw | 412.871 / 284.169 | 2014.165 / 894.623 | 659.825 / 476.976 | 1.598 / 1.678× | **miss / miss** |
| append wall ms | raw | 11.737 / 8.266 | 862.254 / 739.943 | 771.813 / 632.619 | 65.762 / 76.537× | **miss / miss** |
| open RSS MiB | raw | 5.996 / 5.996 | 7.316 / 7.383 | 7.133 / 7.266 | 1.190 / 1.212× | **pass / pass** |
| idle RSS MiB | raw | 5.996 / 5.996 | 7.316 / 7.316 | 7.133 / 7.133 | 1.190 / 1.190× | **pass / pass** |
| point peak MiB | raw | 6.227 / 6.227 | 22.836 / 22.840 | 18.113 / 18.113 | 2.909 / 2.909× | **miss / miss** |
| point retained MiB | raw | 0.230 / 0.230 | 15.582 / 15.586 | 11.043 / 11.043 | 11.043 / 11.043× | **miss / miss** |
| hour peak MiB | raw | 6.488 / 6.496 | 11.988 / 12.387 | 16.371 / 11.559 | 2.523 / 1.779× | **miss / pass** |
| hour retained MiB | raw | 0.492 / 0.500 | 1.082 / 5.133 | 4.422 / 4.488 | 4.422 / 4.488× | **miss / miss** |
| month peak MiB | raw | 10.129 / 10.184 | 14.965 / 15.410 | 16.348 / 11.980 | 1.614 / 1.176× | **pass / pass** |
| month retained MiB | raw | 2.230 / 4.188 | 0.777 / 8.156 | 4.254 / 4.910 | 1.907 / 1.173× | **miss / miss** |
| ten peak MiB | raw | 10.254 / 10.266 | 17.988 / 18.652 | 16.723 / 17.062 | 1.631 / 1.662× | **pass / pass** |
| ten retained MiB | raw | 2.309 / 4.270 | 1.418 / 11.398 | 5.137 / 9.992 | 2.225 / 2.340× | **miss / miss** |

### Synthetic open timing

Not the unmeasured real-Logbook/rakku ≤1 s target. Native open defers payload work until queries.

| Shape | SQLite ms C/W | Round 1 Streaming ms C/W | Round 2 Streaming ms C/W | Round 2 / SQLite C/W |
|---|---:|---:|---:|---:|
| samples | 0.617 / 0.184 | 0.406 / 0.256 | 0.409 / 0.170 | 0.663 / 0.922× |
| raw | 0.693 / 0.186 | 2.694 / 2.430 | 2.886 / 2.425 | 4.167 / 13.015× |

### Partition-count peak growth

Same 656,640 rows, 16→256 raw shards. Strict observed growth ≤1; no noise tolerance is invented. This is a proxy, not a scaling proof.

| Backend | 16-shard peak MiB C/W | 256-shard peak MiB C/W | Ratio C/W | Status |
|---|---:|---:|---:|---|
| sqlite | 10.129 / 10.266 | 10.254 / 10.266 | 1.012 / 1.000× | miss |
| streaming | 15.223 / 15.988 | 16.723 / 17.062 | 1.099 / 1.067× | miss |

Round 1 Streaming growth: 1.014094× / 1.016606×, miss. SQLite itself has a small cold observed growth in round 2; the strict native target is not relaxed by that variation.

### Point back-to-idle: ordinary and explicit release

| Shape | SQLite retained MiB C/W | Round 1 retained MiB C/W | Round 2 without release MiB C/W | Round 2 after release MiB C/W | Released / tolerance C/W | Released status |
|---|---:|---:|---:|---:|---:|---|
| samples | 0.230 / 0.230 | 15.410 / 15.410 | 10.777 / 10.777 | 0.754 / 0.754 | 0.754 / 0.754× | pass |
| raw | 0.230 / 0.230 | 15.582 / 15.586 | 11.043 / 11.043 | 1.020 / 1.020 | 1.020 / 1.020× | miss |

The raw release miss is 0.020 MiB over the unchanged 1 MiB tolerance. The sample-hour default retained miss is 0.016 MiB over it. These small margins can depend on allocator/page behavior; they remain misses.

Release is an explicit diagnostic, not a waiver of the default no-release target. It discards derived indexes and validated generations. A later lookup must rebuild them. Low requested live heap does not prove RSS reclamation; freed allocator arenas can remain resident. This matrix has one release per process (warm points have a priming lookup); repeated release/rebuild cycles are a separate risk documented by the write report.

## Append → range on the same month

Additional ordered Logbook-style sync: first query October's last hour on the same open runtime, then time a durable 1,000-row append followed immediately by that hour query. New IDs have the final existing October timestamp, preserving order. The result is 1,090 full rows. Both cache labels include that initial range; therefore these are cold/warm **starting-page** states, not untouched cold append measurements. The standard append target above remains unprimed and uses the unchanged backfilled fixture. No Round-1 sync measurement exists.

| Shape | Backend | Append ms C/W | Following range ms C/W | Combined ms C/W | Combined / SQLite C/W | Combined peak MiB C/W |
|---|---|---:|---:|---:|---:|---:|
| samples | sqlite | 9.739 / 7.550 | 2.727 / 2.732 | 12.467 / 10.271 | 1.000 / 1.000× | 9.516 / 9.516 |
| samples | streaming | 362.833 / 317.455 | 3.071 / 2.967 | 365.828 / 320.429 | 29.344 / 31.197× | 35.152 / 35.160 |
| raw | sqlite | 10.713 / 8.003 | 2.920 / 2.912 | 13.760 / 10.924 | 1.000 / 1.000× | 9.625 / 9.629 |
| raw | streaming | 609.521 / 608.250 | 14.700 / 14.600 | 624.332 / 622.926 | 45.375 / 57.021× | 38.512 / 38.512 |

## Every miss: observed floor, reason and cheapest next step

Floors are fastest completed timing trials, smallest observed peak, or smallest retained delta against median fresh idle. They are not physical lower bounds. Causes are inferred from source and prior profiles, not independent attribution of this matrix. Proposed changes are unmeasured and can still miss. No target is lowered.

| Miss | Shape | Floor C/W | Reason | Cheapest next step and cost |
|---|---|---:|---|---|
| point wall | samples | 632.360 / 0.176 ms | Cold global validation/membership; warm listing and per-file generation checks. | Share checked-generation observations; preserves fresh-edit detection but adds proof/race-test complexity. Persistent metadata needs #18 approval. |
| hour wall | samples | 52.704 / 0.268 ms | Cold full-file validation/index construction; warm raw still fans out over 256 shards. | Selectivity-aware pre-indexing or a prunable layout; extra passes/metadata or consumer migration, with persistence approval-gated. |
| month wall | samples | 103.786 / 46.721 ms | Full scalar JSON validation and per-row filter/fold work, plus raw host/checkpoint overhead. | Compile filter/fold field positions against the prepared decoder; more plan/parity complexity and no guaranteed pass. |
| ten wall | samples | 521.223 / 431.081 ms | Full scalar JSON validation and per-row filter/fold work, plus raw host/checkpoint overhead. | Compile filter/fold field positions against the prepared decoder; more plan/parity complexity and no guaranteed pass. |
| append wall | samples | 368.411 / 312.195 ms | Fresh global membership plus synced targets and checked prefix proofs; raw touches 256 files. | Reuse the live owner; stronger conditional-write evidence can reduce proofs but needs a host contract that closes prefix-edit races. NORMAL durability still differs. |
| point peak RSS | samples | 17.809 / 17.809 MiB | The locator retains ~10 MiB of requested metadata. | Bound/page or further pack locator construction; paging adds I/O/plan complexity. Release cannot fix build peak; persistence needs #18 approval. |
| point retained RSS at 1 s / tolerance | samples | 10.777 / 10.777 MiB | Retained derived indexes and/or allocator arenas remain above the strict idle tolerance. | Compact or explicitly release derived state, then measure repeated cycles; rebuild costs latency and release does not guarantee OS reclamation. No trim waiver. |
| hour retained RSS at 1 s / tolerance | samples | 1.016 / 1.016 MiB | Retained derived indexes and/or allocator arenas remain above the strict idle tolerance. | Compact or explicitly release derived state, then measure repeated cycles; rebuild costs latency and release does not guarantee OS reclamation. No trim waiver. |
| ten retained RSS at 1 s / tolerance | samples | 1.723 / 6.574 MiB | Retained derived indexes and/or allocator arenas remain above the strict idle tolerance. | Compact or explicitly release derived state, then measure repeated cycles; rebuild costs latency and release does not guarantee OS reclamation. No trim waiver. |
| point wall | raw | 820.408 / 3.004 ms | Cold global validation/membership; warm listing and per-file generation checks. | Share checked-generation observations; preserves fresh-edit detection but adds proof/race-test complexity. Persistent metadata needs #18 approval. |
| hour wall | raw | 607.494 / 10.083 ms | Cold full-file validation/index construction; warm raw still fans out over 256 shards. | Selectivity-aware pre-indexing or a prunable layout; extra passes/metadata or consumer migration, with persistence approval-gated. |
| month wall | raw | 608.062 / 54.387 ms | Full scalar JSON validation and per-row filter/fold work, plus raw host/checkpoint overhead. | Compile filter/fold field positions against the prepared decoder; more plan/parity complexity and no guaranteed pass. |
| ten wall | raw | 659.781 / 475.991 ms | Full scalar JSON validation and per-row filter/fold work, plus raw host/checkpoint overhead. | Compile filter/fold field positions against the prepared decoder; more plan/parity complexity and no guaranteed pass. |
| append wall | raw | 771.047 / 627.448 ms | Fresh global membership plus synced targets and checked prefix proofs; raw touches 256 files. | Reuse the live owner; stronger conditional-write evidence can reduce proofs but needs a host contract that closes prefix-edit races. NORMAL durability still differs. |
| point peak RSS | raw | 18.113 / 18.113 MiB | The locator retains ~10 MiB plus per-file metadata. | Bound/page or further pack locator construction; paging adds I/O/plan complexity. Release cannot fix build peak; persistence needs #18 approval. |
| point retained RSS at 1 s / tolerance | raw | 11.043 / 11.043 MiB | Retained derived indexes and/or allocator arenas remain above the strict idle tolerance. | Compact or explicitly release derived state, then measure repeated cycles; rebuild costs latency and release does not guarantee OS reclamation. No trim waiver. |
| hour peak RSS | raw | 16.219 / 11.559 MiB | Full first-use identity workspace overlaps dense retained checkpoints. | Compact checkpoint keys or defer construction until identity workspace drops; deferral adds a pass and can worsen cold latency. |
| hour retained RSS at 1 s / tolerance | raw | 4.422 / 4.488 MiB | Retained derived indexes and/or allocator arenas remain above the strict idle tolerance. | Compact or explicitly release derived state, then measure repeated cycles; rebuild costs latency and release does not guarantee OS reclamation. No trim waiver. |
| month retained RSS at 1 s / tolerance | raw | 4.254 / 4.910 MiB | Retained derived indexes and/or allocator arenas remain above the strict idle tolerance. | Compact or explicitly release derived state, then measure repeated cycles; rebuild costs latency and release does not guarantee OS reclamation. No trim waiver. |
| ten retained RSS at 1 s / tolerance | raw | 5.137 / 9.992 MiB | Retained derived indexes and/or allocator arenas remain above the strict idle tolerance. | Compact or explicitly release derived state, then measure repeated cycles; rebuild costs latency and release does not guarantee OS reclamation. No trim waiver. |
| point retained RSS after release at 1 s / tolerance | raw | 1.020 / 1.020 MiB | Indexes are released; codec/per-file allocations and allocator-retained pages remain. Exact RSS attribution is unmeasured. | Profile and shrink the post-release codec/per-file footprint; more ownership/profile work and no guaranteed 20 KiB saving. Repeat cycles because freed arenas can retain more. No trim waiver. |
| peak RSS growth: 16 to 256 shards | raw | 1.099 / 1.067× observed growth | Per-file metadata, denser checkpoints and allocator variation add partition-dependent RSS. | Compact checkpoint/per-file keys, then repeat a shard sweep; more implementation complexity and no constant-memory proof. |

## Counting-allocator evidence

Independent Rust requested live/peak MiB; not glibc arenas. SQLite's C heap is separate in JSONL. No meter timing enters wall medians.

| Streaming workload | Cold live/peak MiB | Warm live/peak MiB |
|---|---:|---:|
| samples/point | 10.091/10.287 | 10.091/10.098 |
| raw/point | 10.277/10.616 | 10.277/10.338 |
| samples/ten | 0.474/6.053 | 0.474/6.053 |
| raw/ten | 3.538/9.147 | 3.538/9.147 |
| raw/append | 12.452/24.318 | 12.452/24.318 |

## Load, checks and limits

Predeclared policy: wait for one-minute load ≤1 after building/preparing, sample every five seconds, reject and repeat the whole matrix if any one-minute sample exceeds 2. Preparation and conflict-probe load snapshots are separate, not timing trials. Load sampling does not prove zero interference on this shared 12-thread host.

| Matrix block | Load before 1/5/15 | Load after 1/5/15 | Maximum 1/5/15 | Action |
|---|---:|---:|---:|---|
| 1 | 0.959 / 1.331 / 1.361 | 0.299 / 0.527 / 0.940 | 0.959 / 1.331 / 1.361 | accept |

Focused harness cargo check, release tests, clippy `-D warnings`, fmt, Python unit tests, Ruff and shellcheck ran on aka; exact results and any initial failures are in [round-2 provenance](../../bench/acceptance/results/round2-provenance.md). No full repository suite was run by this worker; the parent owns combined verification. No engine code changed. No push or deployment.

| Qualification | Status |
|---|---|
| Real Logbook open ≤1 s on rakku | **Unmeasured**: no rakku access by user rule |
| Absolute Celeron times, ten-month ≤SQLite on rakku | **Unmeasured**: aka is not the target CPU |
| Append equal power-loss durability | **Unmeasured**: synced text and NORMAL WAL differ |

Small [numeric summary](../../bench/acceptance/results/round2.jsonl), [generated tables](../../bench/acceptance/results/round2.md) and [provenance](../../bench/acceptance/results/round2-provenance.md) preserve the evidence. Owned aka fixtures, temporary files and binary copies are removed after the final audit; cleanup outcome is recorded in provenance. Runtime source/checksum binding is retained, not large synthetic fixtures.
