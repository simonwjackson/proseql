# Query while scanning: aka round 5

**Monthly raw puts the warm hour near SQLite; 256-shard raw does not. Lookup, aggregates and append remain slower.** Warm, saved-index samples / 256-shard raw versus SQLite: point: 3.62× / 18.72×; hour: 1.00× / 38.30×; month: 1.91× / 2.46×; ten: 1.18× / 1.35×; append: 8.51× / 45.69×. Monthly raw hour: **1.03×**. First lookup: 36.3× / 87.6×. Fresh open/idle reaches 7.56 MiB versus SQLite 6.08 MiB; back-to-idle is a separate target below. All answers match.

## Source and protocol

Runtime **881a9c3**, including append-lite, index-load, validated-skip and leap-second routing 303beb8. Harness **14b4339** adds only measurement code. Actual source and binary SHA-256 values are in `bench/acceptance/results/round5-provenance.json`. No engine code changed in Verify.

All builds and measurements ran on aka, native `RUSTFLAGS='-C target-cpu=x86-64-v2'`, through `scripts/qws/aka-run bench5 --x86-64-v2`. No WASM build, rakku/yari access, real data or push ran. Each preparation, priming and measured process used `systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout` (600 seconds preparation, 180 seconds otherwise). Builds/checks held `flock -s /home/simonwjackson/work/qws5-aka.lock`; the entire accepted matrix held `flock -x` on the same lock. Load waits and five-second samples ran inside that exclusive lock.

The fresh fixture has 656,640 rows per shape, January–October 2025. Samples use ten months; raw uses 256 hash shards. The added `raw_month` uses the identical complete raw rows, including `shard`, routed by `atUtc` `TimeBucket::Month` with ordered `atUtc`. It matches Logbook's partition/index layout, not its private payload, receipt frequency or revision-link writer. SQLite imports the same typed rows, TEXT primary keys, non-covering `(metric,time)` indexes, NORMAL/WAL, default cache and no mmap. Its third table holds monthly raw. `SQLITE_TMPDIR` is literally `/home/simonwjackson/work/qws-harness-data/bench5/tmp`. Synced text and NORMAL WAL do not have equal power-loss durability.

Each cell has three rotating timing trials plus one independent counting-allocator trial. SQLite/missing/present order rotates by workload, repetition and profile. Missing means no saved indexes before launch; warm reads still prime the operation on the same runtime. Present means a separate process builds ID/validation indexes plus May-hour ordered indexes and closes on the exact destination inode before launch. Copying old sidecars is not treated as valid. First lookup means a fresh process, with open excluded. Cold syncs/evicts only owned file pages, including sidecars; warm prewarms relevant pages. Inode/controller caches remain. Mutation trials have independent `cp -a --reflink=auto` copies; append has no membership preflight in the measured process.

Read timing includes complete-row digest or every aggregate group. Peaks are maximum timing-trial VmHWM; one-second RSS is the median with backend still open, without trim or teardown. Floors below are fastest completed trials, not physical limits. Meter timing never enters a median. All answers, including every group and full-row digest, must match SQLite; every successful mutation must independently persist exactly 1,000 rows. Requested Rust heap is not RSS; null instruction counts mean unmeasured, not zero. This fixture does not qualify general ordering, schema-error or fractional-f64 parity.

Round 4 is the supplied historical measurement, not a fresh baseline build. Point/append use the latest rv4 single observations; open/idle use the original round-4 observations. Round 4 did not measure the hour/month/ten cells, so those entries stay unmeasured. The supplied design file at 881a9c3 contains no validated-skip timing table; this report measures the combined code directly. Logbook's read-only report uses different rows and warm filesystem pages for its cold column, so its times are not substituted for this matrix.

## Wall time by workload

Milliseconds cold / warm. Ratios and verdicts are also cold / warm. A pass must meet both cache modes. R5 first-lookup ≤5×, warm-month ≤1.5× and samples-append ≤3× are subgoals; original #12 limits remain below. Where no new cold target was given, the original #12 limit remains the bar.

### Point lookup

| Shape | SQLite | Round 4, saved | R5 missing | R5 present | Missing / SQLite | Present / SQLite | R5 limit C/W | Missing verdict | Present verdict |
|---|---:|---:|---:|---:|---:|---:|---|---|---|
| samples | 1.094 / 0.030 | 48.311 / 0.096 | 566.053 / 0.107 | 39.644 / 0.110 | 517.599× / 3.509× | 36.251× / 3.621× | 5.000× / 2.000× | miss / miss | miss / miss |
| raw | 1.181 / 0.034 | 107.045 / 0.753 | 701.136 / 0.588 | 103.485 / 0.637 | 593.461× / 17.301× | 87.593× / 18.723× | 5.000× / 2.000× | miss / miss | miss / miss |

### One-hour full rows

| Shape | SQLite | Round 4, saved | R5 missing | R5 present | Missing / SQLite | Present / SQLite | R5 limit C/W | Missing verdict | Present verdict |
|---|---:|---:|---:|---:|---:|---:|---|---|---|
| samples | 1.750 / 0.280 | unmeasured | 53.415 / 0.390 | 1.330 / 0.279 | 30.527× / 1.393× | 0.760× / 0.998× | 1.500× / 1.500× | miss / pass | pass / pass |
| raw | 2.312 / 0.292 | unmeasured | 650.815 / 10.273 | 80.163 / 11.176 | 281.537× / 35.209× | 34.678× / 38.305× | 1.500× / 1.500× | miss / miss | miss / miss |
| raw_month | 1.824 / 0.290 | unmeasured | 55.798 / 0.378 | 1.229 / 0.300 | 30.597× / 1.302× | 0.674× / 1.035× | 1.500× / 1.500× | miss / pass | pass / pass |

### One month, steps by UTC day

| Shape | SQLite | Round 4, saved | R5 missing | R5 present | Missing / SQLite | Present / SQLite | R5 limit C/W | Missing verdict | Present verdict |
|---|---:|---:|---:|---:|---:|---:|---|---|---|
| samples | 33.647 / 19.926 | unmeasured | 105.562 / 38.104 | 87.453 / 38.120 | 3.137× / 1.912× | 2.599× / 1.913× | 1.000× / 1.500× | miss / miss | miss / miss |
| raw | 32.585 / 19.543 | unmeasured | 654.376 / 43.767 | 177.294 / 48.135 | 20.082× / 2.240× | 5.441× / 2.463× | 1.000× / 1.500× | miss / miss | miss / miss |

### Ten months, two metrics by UTC day

| Shape | SQLite | Round 4, saved | R5 missing | R5 present | Missing / SQLite | Present / SQLite | R5 limit C/W | Missing verdict | Present verdict |
|---|---:|---:|---:|---:|---:|---:|---|---|---|
| samples | 428.174 / 289.566 | unmeasured | 508.453 / 345.781 | 443.880 / 342.632 | 1.187× / 1.194× | 1.037× / 1.183× | 1.000× / 1.000× | miss / miss | miss / miss |
| raw | 408.200 / 283.108 | unmeasured | 681.340 / 383.027 | 584.450 / 382.773 | 1.669× / 1.353× | 1.432× / 1.352× | 1.000× / 1.000× | miss / miss | miss / miss |

### Append 1,000

| Shape | SQLite | Round 4, saved | R5 missing | R5 present | Missing / SQLite | Present / SQLite | R5 limit C/W | Missing verdict | Present verdict |
|---|---:|---:|---:|---:|---:|---:|---|---|---|
| samples | 10.598 / 7.239 | 94.559 / 74.004 | 361.195 / 305.036 | 81.764 / 61.625 | 34.081× / 42.139× | 7.715× / 8.513× | 3.000× / 3.000× | miss / miss | miss / miss |
| raw | 11.086 / 7.439 | 520.832 / 329.963 | 732.377 / 563.654 | 562.382 / 339.908 | 66.062× / 75.773× | 50.728× / 45.694× | 1.000× / 1.000× | miss / miss | miss / miss |

### Fresh open

| Shape | SQLite | Round 4, saved | R5 missing | R5 present | Missing / SQLite | Present / SQLite | R5 limit C/W | Missing verdict | Present verdict |
|---|---:|---:|---:|---:|---:|---:|---|---|---|
| samples | 0.576 / 0.200 | 0.431 / 0.261 | 0.450 / 0.198 | 0.432 / 0.193 | 0.782× / 0.988× | 0.750× / 0.966× | unmeasured real-shape ≤1 s | unmeasured | unmeasured |
| raw | 0.598 / 0.197 | 2.677 / 2.593 | 2.887 / 2.727 | 2.907 / 2.832 | 4.828× / 13.835× | 4.861× / 14.368× | unmeasured real-shape ≤1 s | unmeasured | unmeasured |

## Fresh open and idle memory

MiB cold / warm. Ratio denominator is SQLite +20 MiB, not raw SQLite RSS.

| Workload / shape | SQLite | Round 4, saved | R5 missing | R5 present | Missing / bar | Present / bar | Missing verdict | Present verdict |
|---|---:|---:|---:|---:|---:|---:|---|---|
| open/samples | 6.078 / 6.078 | 7.621 / 7.691 | 7.371 / 7.504 | 7.371 / 7.504 | 0.283× / 0.288× | 0.283× / 0.288× | pass / pass | pass / pass |
| open/raw | 6.078 / 6.078 | 7.668 / 7.750 | 7.418 / 7.555 | 7.418 / 7.562 | 0.284× / 0.290× | 0.284× / 0.290× | pass / pass | pass / pass |
| idle/samples | 6.078 / 6.078 | 7.621 / 7.621 | 7.371 / 7.371 | 7.371 / 7.371 | 0.283× / 0.283× | 0.283× / 0.283× | pass / pass | pass / pass |
| idle/raw | 6.078 / 6.078 | 7.668 / 7.668 | 7.418 / 7.418 | 7.418 / 7.418 | 0.284× / 0.284× | 0.284× / 0.284× | pass / pass | pass / pass |

## Read peak and back-to-idle values

MiB cold / warm. Retained is RSS above the matching fresh idle. Historical point/append peak memory comes from their latest round-4 observations. rv4 did not remeasure fresh idle, so its retained delta stays unmeasured rather than mixing blocks; other absent historical cells also stay unmeasured. Append and append-range retention are diagnostics in addition to the read requirement.

| Shape / workload / metric | SQLite | Round 4, saved | R5 missing | R5 present |
|---|---:|---:|---:|---:|
| samples/point peak | 6.320 / 6.320 | 22.285 / 22.285 | 25.547 / 17.852 | 29.074 / 21.293 |
| samples/point retained | 0.242 / 0.242 | unmeasured | 10.543 / 10.543 | 13.984 / 13.984 |
| samples/hour peak | 6.578 / 6.594 | unmeasured | 8.672 / 8.129 | 8.074 / 8.074 |
| samples/hour retained | 0.500 / 0.516 | unmeasured | 0.820 / 0.820 | 0.766 / 0.766 |
| samples/month peak | 10.078 / 10.215 | unmeasured | 9.047 / 8.789 | 9.047 / 8.805 |
| samples/month retained | 2.180 / 4.137 | unmeasured | 0.898 / 1.480 | 0.918 / 1.496 |
| samples/ten peak | 10.078 / 10.297 | unmeasured | 13.168 / 17.691 | 13.172 / 13.695 |
| samples/ten retained | 2.262 / 4.219 | unmeasured | 1.473 / 1.504 | 1.473 / 6.387 |
| samples/append peak | 9.566 / 9.566 | 35.133 / 35.258 | 34.645 / 34.645 | 34.617 / 34.617 |
| samples/append retained | 3.488 / 3.488 | unmeasured | 27.332 / 27.336 | 27.309 / 27.309 |
| samples/append-range peak | 9.613 / 9.613 | unmeasured | 34.781 / 34.844 | 34.805 / 34.848 |
| samples/append-range retained | 3.535 / 3.535 | unmeasured | 27.469 / 27.473 | 27.445 / 27.445 |
| raw/point peak | 6.320 / 6.320 | 18.324 / 18.328 | 26.047 / 18.414 | 27.547 / 19.844 |
| raw/point retained | 0.242 / 0.242 | unmeasured | 11.059 / 11.059 | 12.469 / 12.488 |
| raw/hour peak | 6.582 / 6.594 | unmeasured | 16.547 / 11.926 | 11.680 / 11.746 |
| raw/hour retained | 0.504 / 0.516 | unmeasured | 4.371 / 4.570 | 4.324 / 4.391 |
| raw/month peak | 9.953 / 10.219 | unmeasured | 16.297 / 12.207 | 11.922 / 12.238 |
| raw/month retained | 2.180 / 4.141 | unmeasured | 4.164 / 4.852 | 4.199 / 4.312 |
| raw/ten peak | 10.078 / 10.297 | unmeasured | 16.922 / 17.324 | 16.797 / 17.293 |
| raw/ten retained | 2.262 / 4.219 | unmeasured | 4.977 / 9.969 | 5.082 / 9.938 |
| raw/append peak | 9.629 / 9.629 | 34.961 / 34.961 | 35.020 / 35.020 | 35.152 / 35.156 |
| raw/append retained | 3.551 / 3.551 | unmeasured | 27.664 / 27.664 | 27.797 / 27.797 |
| raw/append-range peak | 9.723 / 9.723 | unmeasured | 38.945 / 38.945 | 38.953 / 38.953 |
| raw/append-range retained | 3.645 / 3.645 | unmeasured | 31.590 / 31.590 | 31.598 / 31.598 |

## Every #12 target and back-to-idle

Cold / warm ratios. Retained = max(0, RSS at 1 s − fresh idle); tolerance = max(SQLite retained, 1 MiB). Fresh-open/idle ratios divide by SQLite +20 MiB. Peak limit is 2×; all other memory ratios have limit 1×. Wall limits remain point 2×, hour 1.5×, month/ten/append 1×. Appended and append-range retained rows are extra diagnostics, not newly invented #12 requirements.

| Shape / target | R5 missing ratio | R5 present ratio | Limit | Missing verdict | Present verdict |
|---|---:|---:|---:|---|---|
| samples/point wall | 517.599× / 3.509× | 36.251× / 3.621× | 2× | miss / miss | miss / miss |
| samples/point peak | 4.042× / 2.824× | 4.600× / 3.369× | 2× | miss / miss | miss / miss |
| samples/point retained | 10.543× / 10.543× | 13.984× / 13.984× | 1× | miss / miss | miss / miss |
| samples/hour wall | 30.527× / 1.393× | 0.760× / 0.998× | 1.5× | miss / pass | pass / pass |
| samples/hour peak | 1.318× / 1.233× | 1.227× / 1.225× | 2× | pass / pass | pass / pass |
| samples/hour retained | 0.820× / 0.820× | 0.766× / 0.766× | 1× | pass / pass | pass / pass |
| samples/month wall | 3.137× / 1.912× | 2.599× / 1.913× | 1× | miss / miss | miss / miss |
| samples/month peak | 0.898× / 0.860× | 0.898× / 0.862× | 2× | pass / pass | pass / pass |
| samples/month retained | 0.412× / 0.358× | 0.421× / 0.362× | 1× | pass / pass | pass / pass |
| samples/ten wall | 1.187× / 1.194× | 1.037× / 1.183× | 1× | miss / miss | miss / miss |
| samples/ten peak | 1.307× / 1.718× | 1.307× / 1.330× | 2× | pass / pass | pass / pass |
| samples/ten retained | 0.651× / 0.356× | 0.651× / 1.514× | 1× | pass / pass | pass / miss |
| samples/append wall | 34.081× / 42.139× | 7.715× / 8.513× | 1× | miss / miss | miss / miss |
| samples/append retained | 7.835× / 7.837× | 7.829× / 7.829× | 1× | miss / miss | miss / miss |
| samples/open fresh RSS | 0.283× / 0.288× | 0.283× / 0.288× | 1× | pass / pass | pass / pass |
| samples/idle fresh RSS | 0.283× / 0.283× | 0.283× / 0.283× | 1× | pass / pass | pass / pass |
| samples/append-range retained | 7.770× / 7.771× | 7.764× / 7.764× | 1× | miss / miss | miss / miss |
| raw/point wall | 593.461× / 17.301× | 87.593× / 18.723× | 2× | miss / miss | miss / miss |
| raw/point peak | 4.121× / 2.913× | 4.358× / 3.140× | 2× | miss / miss | miss / miss |
| raw/point retained | 11.059× / 11.059× | 12.469× / 12.488× | 1× | miss / miss | miss / miss |
| raw/hour wall | 281.537× / 35.209× | 34.678× / 38.305× | 1.5× | miss / miss | miss / miss |
| raw/hour peak | 2.514× / 1.809× | 1.774× / 1.781× | 2× | miss / pass | pass / pass |
| raw/hour retained | 4.371× / 4.570× | 4.324× / 4.391× | 1× | miss / miss | miss / miss |
| raw/month wall | 20.082× / 2.240× | 5.441× / 2.463× | 1× | miss / miss | miss / miss |
| raw/month peak | 1.637× / 1.195× | 1.198× / 1.198× | 2× | pass / pass | pass / pass |
| raw/month retained | 1.910× / 1.172× | 1.927× / 1.042× | 1× | miss / miss | miss / miss |
| raw/ten wall | 1.669× / 1.353× | 1.432× / 1.352× | 1× | miss / miss | miss / miss |
| raw/ten peak | 1.679× / 1.682× | 1.667× / 1.679× | 2× | pass / pass | pass / pass |
| raw/ten retained | 2.200× / 2.363× | 2.247× / 2.356× | 1× | miss / miss | miss / miss |
| raw/append wall | 66.062× / 75.773× | 50.728× / 45.694× | 1× | miss / miss | miss / miss |
| raw/append retained | 7.791× / 7.791× | 7.828× / 7.828× | 1× | miss / miss | miss / miss |
| raw/open fresh RSS | 0.284× / 0.290× | 0.284× / 0.290× | 1× | pass / pass | pass / pass |
| raw/idle fresh RSS | 0.284× / 0.284× | 0.284× / 0.284× | 1× | pass / pass | pass / pass |
| raw/append-range retained | 8.668× / 8.668× | 8.670× / 8.670× | 1× | miss / miss | miss / miss |

### Controlled 16→256-shard peak growth

Same 656,640 rows, ten-month aggregate. Strict observed ratio ≤1, no tolerance or scaling claim.

| Mode | 16 shards peak MiB C/W | 256 shards peak MiB C/W | Ratio C/W | Verdict C/W |
|---|---:|---:|---:|---|
| sqlite | 10.078 / 10.297 | 10.078 / 10.297 | 1.000× / 1.000× | pass / pass |
| missing | 15.422 / 16.125 | 16.922 / 17.324 | 1.097× / 1.074× | miss / miss |
| present | 15.547 / 15.828 | 16.797 / 17.293 | 1.080× / 1.093× | miss / miss |

## Ordered append then range

October last-hour prime, append 1,000 new IDs at the last October timestamp, then range on the same runtime. Returned rows must be 1,090. Cold/warm describes starting file pages; neither is an untouched cold append. All values are ms C/W; this diagnostic does not replace ordinary append.

| Shape / mode | Combined | Append stage | Following range |
|---|---:|---:|---:|
| samples/sqlite | 12.801 / 9.592 | 10.060 / 7.069 | 2.738 / 2.440 |
| samples/missing | 347.187 / 304.557 | 344.240 / 301.565 | 2.981 / 2.983 |
| samples/present | 80.485 / 64.841 | 77.483 / 61.786 | 2.986 / 2.963 |
| raw/sqlite | 13.105 / 9.970 | 10.173 / 7.351 | 2.940 / 2.603 |
| raw/missing | 569.306 / 572.002 | 552.924 / 555.297 | 16.426 / 16.705 |
| raw/present | 585.112 / 344.753 | 568.431 / 328.296 | 16.666 / 16.259 |

## Every miss: floor, reason and next step

Each row names its observed floor and a reason/next-step code below. Missing-index warm reads have already paid their first scan before the timer. Reasons are inferred from code and builder phase profiles, not isolated stage timers in this matrix. No target is lowered.

| Code | Reason | Next step and cost |
|---|---|---|
| P | Missing restart builds full validation/membership; saved restart still reads/checks every locator and a global uniqueness proof. Warm lookup freshly observes all 10/256 files and verifies the hit. | Page-checkable locators plus a generation-set uniqueness certificate; profile prepared host calls. New format/proof/race work. Removing fresh metadata is unsafe without stronger host evidence. |
| R | First-use range validates/builds checkpoints; indexed raw still fans out to 256 files. Large aggregates still decode/fold all matching rows, with schema/identity guards and canonical ordering. | Profile decoder/fold and cold I/O separately. Monthly raw reduces range fanout, but costs consumer migration and does not close the 256-shard target. Further skip work needs the exact-generation and error-parity proofs. |
| A | Fresh membership, first baseline hashing, checked post-sync prefix reads and durable target fanout remain. Raw synchronizes 256 files. | Serializable baseline hash state and prepared target handles; versioning and race/fault tests required. No-prefix proof is blocked without enforced write ownership or per-range filesystem evidence. Do not remove sync. |
| M | Locators/time checkpoints, transient identity/output buffers and allocator-held pages raise peak/retained RSS. More files add metadata. Release does not force glibc to return pages. | Profile allocation sites and bound scratch storage; page-checkable locators may lower the transient uniqueness set. Costs format/proof complexity; no guaranteed OS reclamation, trim or teardown substituted. |

| Shape / workload / mode / cache | Missed target | Observed floor | Median or peak ratio / limit | Reason and next step |
|---|---|---:|---:|---|
| samples/point/missing/cold | wall | 560.766 ms | 517.599× / 2× | P |
| samples/point/missing/warm | wall | 0.104 ms | 3.509× / 2× | P |
| samples/point/present/cold | wall | 39.635 ms | 36.251× / 2× | P |
| samples/point/present/warm | wall | 0.086 ms | 3.621× / 2× | P |
| samples/point/missing/cold | peak | 25.422 MiB | 4.042× / 2× | M |
| samples/point/missing/warm | peak | 17.852 MiB | 2.824× / 2× | M |
| samples/point/present/cold | peak | 28.828 MiB | 4.600× / 2× | M |
| samples/point/present/warm | peak | 21.293 MiB | 3.369× / 2× | M |
| samples/point/missing/cold | retained | 10.543 MiB retained | 10.543× / 1× | M |
| samples/point/missing/warm | retained | 10.543 MiB retained | 10.543× / 1× | M |
| samples/point/present/cold | retained | 13.984 MiB retained | 13.984× / 1× | M |
| samples/point/present/warm | retained | 13.984 MiB retained | 13.984× / 1× | M |
| samples/hour/missing/cold | wall | 53.044 ms | 30.527× / 1.5× | R |
| samples/month/missing/cold | wall | 104.123 ms | 3.137× / 1× | R |
| samples/month/missing/warm | wall | 37.522 ms | 1.912× / 1× | R |
| samples/month/present/cold | wall | 87.270 ms | 2.599× / 1× | R |
| samples/month/present/warm | wall | 37.640 ms | 1.913× / 1× | R |
| samples/ten/missing/cold | wall | 505.976 ms | 1.187× / 1× | R |
| samples/ten/missing/warm | wall | 342.732 ms | 1.194× / 1× | R |
| samples/ten/present/cold | wall | 443.687 ms | 1.037× / 1× | R |
| samples/ten/present/warm | wall | 342.358 ms | 1.183× / 1× | R |
| samples/ten/present/warm | retained | 6.328 MiB retained | 1.514× / 1× | M |
| samples/append/missing/cold | wall | 361.125 ms | 34.081× / 1× | A |
| samples/append/missing/warm | wall | 285.876 ms | 42.139× / 1× | A |
| samples/append/present/cold | wall | 81.394 ms | 7.715× / 1× | A |
| samples/append/present/warm | wall | 59.125 ms | 8.513× / 1× | A |
| samples/append/missing/cold | retained | 27.332 MiB retained | 7.835× / 1× | M |
| samples/append/missing/warm | retained | 27.336 MiB retained | 7.837× / 1× | M |
| samples/append/present/cold | retained | 27.309 MiB retained | 7.829× / 1× | M |
| samples/append/present/warm | retained | 27.309 MiB retained | 7.829× / 1× | M |
| samples/append-range/missing/cold | retained | 27.469 MiB retained | 7.770× / 1× | M |
| samples/append-range/missing/warm | retained | 27.469 MiB retained | 7.771× / 1× | M |
| samples/append-range/present/cold | retained | 27.445 MiB retained | 7.764× / 1× | M |
| samples/append-range/present/warm | retained | 27.445 MiB retained | 7.764× / 1× | M |
| raw/point/missing/cold | wall | 699.094 ms | 593.461× / 2× | P |
| raw/point/missing/warm | wall | 0.577 ms | 17.301× / 2× | P |
| raw/point/present/cold | wall | 103.315 ms | 87.593× / 2× | P |
| raw/point/present/warm | wall | 0.635 ms | 18.723× / 2× | P |
| raw/point/missing/cold | peak | 25.922 MiB | 4.121× / 2× | M |
| raw/point/missing/warm | peak | 18.414 MiB | 2.913× / 2× | M |
| raw/point/present/cold | peak | 27.422 MiB | 4.358× / 2× | M |
| raw/point/present/warm | peak | 19.844 MiB | 3.140× / 2× | M |
| raw/point/missing/cold | retained | 11.059 MiB retained | 11.059× / 1× | M |
| raw/point/missing/warm | retained | 11.059 MiB retained | 11.059× / 1× | M |
| raw/point/present/cold | retained | 12.469 MiB retained | 12.469× / 1× | M |
| raw/point/present/warm | retained | 12.488 MiB retained | 12.488× / 1× | M |
| raw/hour/missing/cold | wall | 649.493 ms | 281.537× / 1.5× | R |
| raw/hour/missing/warm | wall | 9.888 ms | 35.209× / 1.5× | R |
| raw/hour/present/cold | wall | 79.379 ms | 34.678× / 1.5× | R |
| raw/hour/present/warm | wall | 11.011 ms | 38.305× / 1.5× | R |
| raw/hour/missing/cold | peak | 16.410 MiB | 2.514× / 2× | M |
| raw/hour/missing/cold | retained | 4.371 MiB retained | 4.371× / 1× | M |
| raw/hour/missing/warm | retained | 4.570 MiB retained | 4.570× / 1× | M |
| raw/hour/present/cold | retained | 4.324 MiB retained | 4.324× / 1× | M |
| raw/hour/present/warm | retained | 4.391 MiB retained | 4.391× / 1× | M |
| raw/month/missing/cold | wall | 650.800 ms | 20.082× / 1× | R |
| raw/month/missing/warm | wall | 43.151 ms | 2.240× / 1× | R |
| raw/month/present/cold | wall | 176.755 ms | 5.441× / 1× | R |
| raw/month/present/warm | wall | 47.987 ms | 2.463× / 1× | R |
| raw/month/missing/cold | retained | 4.164 MiB retained | 1.910× / 1× | M |
| raw/month/missing/warm | retained | 4.852 MiB retained | 1.172× / 1× | M |
| raw/month/present/cold | retained | 4.199 MiB retained | 1.927× / 1× | M |
| raw/month/present/warm | retained | 4.312 MiB retained | 1.042× / 1× | M |
| raw/ten/missing/cold | wall | 674.829 ms | 1.669× / 1× | R |
| raw/ten/missing/warm | wall | 381.680 ms | 1.353× / 1× | R |
| raw/ten/present/cold | wall | 578.935 ms | 1.432× / 1× | R |
| raw/ten/present/warm | wall | 381.377 ms | 1.352× / 1× | R |
| raw/ten/missing/cold | retained | 4.977 MiB retained | 2.200× / 1× | M |
| raw/ten/missing/warm | retained | 9.969 MiB retained | 2.363× / 1× | M |
| raw/ten/present/cold | retained | 5.082 MiB retained | 2.247× / 1× | M |
| raw/ten/present/warm | retained | 9.938 MiB retained | 2.356× / 1× | M |
| raw/append/missing/cold | wall | 728.551 ms | 66.062× / 1× | A |
| raw/append/missing/warm | wall | 559.373 ms | 75.773× / 1× | A |
| raw/append/present/cold | wall | 555.076 ms | 50.728× / 1× | A |
| raw/append/present/warm | wall | 318.659 ms | 45.694× / 1× | A |
| raw/append/missing/cold | retained | 27.664 MiB retained | 7.791× / 1× | M |
| raw/append/missing/warm | retained | 27.664 MiB retained | 7.791× / 1× | M |
| raw/append/present/cold | retained | 27.797 MiB retained | 7.828× / 1× | M |
| raw/append/present/warm | retained | 27.770 MiB retained | 7.828× / 1× | M |
| raw/append-range/missing/cold | retained | 31.590 MiB retained | 8.668× / 1× | M |
| raw/append-range/missing/warm | retained | 31.590 MiB retained | 8.668× / 1× | M |
| raw/append-range/present/cold | retained | 31.598 MiB retained | 8.670× / 1× | M |
| raw/append-range/present/warm | retained | 31.574 MiB retained | 8.670× / 1× | M |
| raw/ten/missing/cold | 16→256 growth | 1.071 ratio | 1.097× / 1× | M |
| raw/ten/missing/warm | 16→256 growth | 1.074 ratio | 1.074× / 1× | M |
| raw/ten/present/cold | 16→256 growth | 1.074 ratio | 1.080× / 1× | M |
| raw/ten/present/warm | 16→256 growth | 1.093 ratio | 1.093× / 1× | M |
| samples/point/missing/cold | R5 wall | 560.766 ms | 517.599× / 5× | P |
| samples/point/missing/warm | R5 wall | 0.104 ms | 3.509× / 2× | P |
| samples/point/present/cold | R5 wall | 39.635 ms | 36.251× / 5× | P |
| samples/point/present/warm | R5 wall | 0.086 ms | 3.621× / 2× | P |
| raw/point/missing/cold | R5 wall | 699.094 ms | 593.461× / 5× | P |
| raw/point/missing/warm | R5 wall | 0.577 ms | 17.301× / 2× | P |
| raw/point/present/cold | R5 wall | 103.315 ms | 87.593× / 5× | P |
| raw/point/present/warm | R5 wall | 0.635 ms | 18.723× / 2× | P |
| samples/hour/missing/cold | R5 wall | 53.044 ms | 30.527× / 1.5× | R |
| raw/hour/missing/cold | R5 wall | 649.493 ms | 281.537× / 1.5× | R |
| raw/hour/missing/warm | R5 wall | 9.888 ms | 35.209× / 1.5× | R |
| raw/hour/present/cold | R5 wall | 79.379 ms | 34.678× / 1.5× | R |
| raw/hour/present/warm | R5 wall | 11.011 ms | 38.305× / 1.5× | R |
| raw_month/hour/missing/cold | R5 wall | 55.321 ms | 30.597× / 1.5× | R |
| samples/month/missing/cold | R5 wall | 104.123 ms | 3.137× / 1× | R |
| samples/month/missing/warm | R5 wall | 37.522 ms | 1.912× / 1.5× | R |
| samples/month/present/cold | R5 wall | 87.270 ms | 2.599× / 1× | R |
| samples/month/present/warm | R5 wall | 37.640 ms | 1.913× / 1.5× | R |
| raw/month/missing/cold | R5 wall | 650.800 ms | 20.082× / 1× | R |
| raw/month/missing/warm | R5 wall | 43.151 ms | 2.240× / 1.5× | R |
| raw/month/present/cold | R5 wall | 176.755 ms | 5.441× / 1× | R |
| raw/month/present/warm | R5 wall | 47.987 ms | 2.463× / 1.5× | R |
| samples/ten/missing/cold | R5 wall | 505.976 ms | 1.187× / 1× | R |
| samples/ten/missing/warm | R5 wall | 342.732 ms | 1.194× / 1× | R |
| samples/ten/present/cold | R5 wall | 443.687 ms | 1.037× / 1× | R |
| samples/ten/present/warm | R5 wall | 342.358 ms | 1.183× / 1× | R |
| raw/ten/missing/cold | R5 wall | 674.829 ms | 1.669× / 1× | R |
| raw/ten/missing/warm | R5 wall | 381.680 ms | 1.353× / 1× | R |
| raw/ten/present/cold | R5 wall | 578.935 ms | 1.432× / 1× | R |
| raw/ten/present/warm | R5 wall | 381.377 ms | 1.352× / 1× | R |
| samples/append/missing/cold | R5 wall | 361.125 ms | 34.081× / 3× | A |
| samples/append/missing/warm | R5 wall | 285.876 ms | 42.139× / 3× | A |
| samples/append/present/cold | R5 wall | 81.394 ms | 7.715× / 3× | A |
| samples/append/present/warm | R5 wall | 59.125 ms | 8.513× / 3× | A |
| raw/append/missing/cold | R5 wall | 728.551 ms | 66.062× / 1× | A |
| raw/append/missing/warm | R5 wall | 559.373 ms | 75.773× / 1× | A |
| raw/append/present/cold | R5 wall | 555.076 ms | 50.728× / 1× | A |
| raw/append/present/warm | R5 wall | 318.659 ms | 45.694× / 1× | A |

## Target totals

A target row passes only when both cold and warm pass. Diagnostic append retention is excluded from these totals.

| Family / mode | Passed rows | Missed rows |
|---|---:|---:|
| round5/missing | 0 | 11 |
| round5/present | 2 | 9 |
| number12/missing | 12 | 19 |
| number12/present | 13 | 18 |

## Checks, load and cleanup

Accepted block 1; maximum sampled one-minute load **1.113281**. 0 high-load blocks rejected. Start load 0.927246; final load 0.338379. All **432** public-path trials completed: 324 timing and 108 independent meter trials. All **96** mutation trials persisted exactly 1,000 rows. All six backend/shape global-conflict controls passed. No answer mismatch occurred.

Load coordination note: the parent's follow-on consumer check briefly ran outside its shared lock near the start of attempt 1. The parent confirmed it had finished during the first repetition and ran nothing else on aka afterward. Verify held its exclusive lock throughout. The recorded load policy, rather than a claim of perfect host isolation, decides block acceptance; all per-trial loads are checked as well as five-second samples. This remains a source of shared-host variation if attempt 1 is accepted.

Focused harness `cargo check` all-target/all-feature, release tests (**6 passed**), clippy `-D warnings`, Rust format, Python unit tests (**6 passed**), Ruff check/format and all three native release builds passed on aka. The monthly fixture regression checks complete-row SQLite/hash-shard equality and exactly one examined month. No full repository suite ran in Verify; the parent owns the combined release gate.

Final cleanup verified `FINAL_BENCH5_DATA_AND_COPIED_BINARIES_ABSENT`. Synthetic source/SQLite/temp data and per-trial copies under `/home/simonwjackson/work/qws-harness-data/bench5`, the separate check temp directory and all three copied benchmark binaries are absent. Small raw logs/evidence remain under `/home/simonwjackson/work/qws-bench5-results`; Cargo caches remain. No shared source data or service was changed.

Absolute Celeron latency, real Logbook open ≤1 second, equal-power-loss-durability comparison, consumer deployment and the missed targets remain open. aka's Ryzen 5 7600X is only a synthetic same-machine SQLite proxy.
