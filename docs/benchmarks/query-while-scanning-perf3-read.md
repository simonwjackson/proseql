# Round 3: read-side query-while-scanning work

**Warm point lookups improve; the SQLite qualification still fails.** The warm sample-hour diagnostic passes. The other measured latency targets miss. Point peaks and the cold raw-hour peak also miss. No target is lowered.

## Source and method

Measured runtime: `41896b98f5fd93afe8f8b8ea7a78aef51022cd5b`, including the shared locator/listing/recovery seams `8ea69f0`, `3dc02e6` and `6512240`. Baseline: `112817e`. The two read commits are `eb54acb` and `41896b9`.

Every build, test and measurement ran on **aka**, Ryzen 5 7600X, through `scripts/qws/aka-run perf3-read --x86-64-v2`. Native binaries use `RUSTFLAGS='-C target-cpu=x86-64-v2'`; no WASM build used that flag. No rakku, yari, real data, push or deployment was used.

The unchanged `bench/acceptance` public APIs and synthetic 656,640-row fixture provide ten sample months and 256 raw shards. SQLite remains NORMAL/WAL with its existing non-covering indexes. SQLite temporary files stayed under `/home/simonwjackson/work/qws-harness-data/perf3-read/tmp`. Preparation used a fresh `base` directory. Every preparation and measured process used `systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout` (600 s preparation; 180 s reads). The limit was not raised.

The runner was a temporary copy of `scripts/qws/perf-read.py`, with only the owned data path changed and `raw/point` added. No harness code was changed. Baseline and intermediate stages have one timing trial per cell. The final has **three rotating timing trials and one separate counting-allocator trial per cell**. All 210 complete answers across all stages match the same SQLite answers, including full-row digests and every aggregate group. The final block contains 98 trials.

Cold trials evict only owned fixture pages. Warm reads prime the same operation on the same runtime. Timing excludes open and includes answer consumption. Wall is the timing median; peak is the maximum timing-trial RSS. Independent `perf stat -e instructions:u` output includes process open/priming; the harness's operation counters delimit the public call. Meter timings do not enter medians. Requested heap is not RSS. No trim or runtime teardown occurs before sampling.

The final block waited for one-minute load ≤1. Five-second samples started at 0.85, ended at 0.54 and peaked at 0.87; none exceeded the rejection limit of 2. This does not prove absence of interference on a shared host. Aka is not absolute Celeron qualification, and synced text versus SQLite NORMAL does not qualify equal power-loss durability.

[Complete compact measurements, per-stage instructions and allocation tables](../../bench/acceptance/results/perf3-read.md), [JSONL](../../bench/acceptance/results/perf3-read.jsonl), [independent perf stat](../../bench/acceptance/results/perf3-read-perf-stat.txt), [source checksums](../../bench/acceptance/results/perf3-read-final-source-files.sha256), [binary checksums](../../bench/acceptance/results/perf3-read-binaries.sha256), and [load samples](../../bench/acceptance/results/perf3-read-load.txt).

## Before and after on aka

Cold / warm milliseconds. Before is this run's **single** baseline timing trial, not the earlier round-2 three-trial median. After and SQLite are final three-trial medians. Point ≤2×; hour ≤1.5×; month/ten ≤1×. Cold point numbers and their comparison are reported, not omitted.

| Workload | Before | After | SQLite | Wall status C/W |
|---|---:|---:|---:|---|
| Ten months, samples | 516.070 / 434.693 | 502.432 / 424.631 | 409.873 / 293.628 | miss / miss |
| Ten months, raw | 642.760 / 474.708 | 619.626 / 484.756 | 401.179 / 292.054 | miss / miss |
| One month, samples | 103.724 / 46.398 | 104.254 / 47.010 | 33.305 / 19.588 | miss / miss |
| Point, samples | 659.442 / 0.169 | 562.411 / 0.083 | 1.055 / 0.021 | miss / miss |
| Point, raw | 792.076 / 2.909 | 712.321 / 0.727 | 1.091 / 0.042 | miss / miss |
| Hour, raw | 605.870 / 9.868 | 607.227 / 10.408 | 1.651 / 0.297 | miss / miss |
| Hour, samples (diagnostic) | 53.891 / 0.254 | 56.943 / 0.257 | 1.434 / 0.289 | miss / pass |

Smaller aggregate instruction counts did not establish a wall-time win for the one-month or warm raw-ten workloads. The baseline has only one trial, so this is not a three-trial regression qualification. It is also not a performance pass.

| Read peak, MiB C/W | Native | SQLite | ≤2× status C/W |
|---|---:|---:|---|
| Samples ten | 13.094 / 13.543 | 10.074 / 10.320 | pass / pass |
| Samples month | 8.969 / 8.695 | 10.184 / 10.238 | pass / pass |
| Samples point | 17.805 / 17.805 | 6.281 / 6.281 | miss / miss |
| Raw ten | 16.555 / 16.938 | 10.059 / 10.320 | pass / pass |
| Raw point | 18.359 / 18.340 | 6.281 / 6.281 | miss / miss |
| Raw hour | 16.469 / 11.496 | 6.543 / 6.551 | miss / pass |
| Samples hour | 8.594 / 8.043 | 6.539 / 6.555 | pass / pass |

## Ordered changes and their costs

| Step | Verified evidence | Cost or limit |
|---|---|---|
| Profile again | Baseline independent perf stat and counting allocator cover all seven reads. Sample ten uses 8.830/8.792B operation instructions; raw point uses 14.161B cold. | Whole-process perf counters include open/priming; heap meters add overhead and do not measure allocator RSS. |
| Compile filter/fold positions | The prepared decoder returns its schema-field presence mask. Filter, candidate-rank and fold plans use positions, including optional holes. Fold duplicate destinations are compiled once. Final sample ten is 8.526/8.489B instructions; raw ten is 9.497/9.122B. | Nested tails keep canonical name lookup. Unsupported schemas/operators keep canonical fallback. Plans add about 9 KiB to the sample-ten requested peak (6.053 → 6.062 MiB). The instruction gain is modest and the wall targets still miss. |
| Share one lookup observation | Validation and locator refresh consume the same fresh per-file generation from one directory listing. Warm lookups avoid schema/decoder setup. Intermediate warm points: samples 0.173 → 0.138 → 0.076 ms; raw 2.964 → 2.109 → 0.676 ms. | Every file still needs fresh metadata. No directory-generation shortcut is trusted. Observations add transient memory; changed tokenless observations conservatively revalidate/rebuild whole files rather than infer append-only growth. |
| Fuse first-use decoding and membership | The validating visitor returns a fully validated ID through the shared decoded seam. Intermediate cold points fall from 689.431/840.369 ms (samples/raw) to 555.246/699.044 ms. Final cold instructions are 9.111B/11.218B. | Each simple row supplies a short-lived boxed ID. Membership built earlier by append still receives a separate payload-validation pass before locator errors. Every row read remains validated. |
| Reuse time observations; skip disjoint files | One selected-file observation replaces exists plus index stat; upper checkpoint lookup is binary. A checked ordered first/last-key summary can produce an empty seek without opening the file. New tests verify 3 first-use opens → 0 warm opens and reopening after an edit creates a match. | **Every synthetic raw shard spans January–October.** No whole-file min/max summary can exclude a shard for the May-hour fixture. Its final warm floor remains 10.244 ms. Changed observations without checked own-append evidence conservatively rebuild time indexes. |

The point locator still retains 10.092 MiB of requested heap for samples and 10.282 MiB for raw. Raw time metadata retains 3.486 MiB. These are not return-to-idle claims. Explicit release still trades retained metadata for rebuild cost and does not guarantee RSS reclamation. No binary index/cache is written.

## Every remaining miss: floor, reason and next step

Floors are fastest completed final timing trials or smallest observed timing-trial peaks. They are **not physical lower bounds**. Causes below are inferred from source and instruction/allocation evidence, not exclusive stage timers. Proposed next steps are unmeasured and can still miss.

| Miss | Observed floor C/W | Reason | Next step and cost |
|---|---:|---|---|
| Samples ten wall | 491.461 / 414.100 ms | Full scalar parse/validation, per-row storage and group work still cost 8.49B warm instructions. | Profile reusable prepared row slots and compiled scalar operators next. This adds parser/plan complexity; all-row validation and f64 order must stay. |
| Raw ten wall | 600.693 / 478.697 ms | The same row work plus 256-file host/checkpoint work; 9.12B warm instructions remain. | The same reusable-row plan, then bounded read-window/host fan-out profiling. More lifetime and host complexity; no guaranteed latency pass. |
| Samples month wall | 95.156 / 46.036 ms | Scalar validation dominates; conservative timestamp pruning can include the next month on first use. | Reuse decoder slots and compile scalar predicates. Tightening pruning needs proof for fractional timestamps, not a fixture-only shortcut. |
| Samples point wall | 507.610 / 0.082 ms | Cold validates all global payloads; warm still lists/stats files and canonically verifies the candidate. | Prepare candidate decoding and profile the remaining host calls. A narrower global proof requires host/race work; a persistent locator remains #18-gated. |
| Raw point wall | 704.147 / 0.710 ms | Cold global validation/build; warm fresh observations still cover 256 shards. | Measure an authoritative batched generation mechanism or a prunable consumer layout. Metadata cannot simply be cached without losing edit detection; layout migration is caller-visible. |
| Raw hour wall | 578.063 / 10.244 ms | All shard summaries overlap May; 256 observations/opens and 32-row checkpoint windows remain. | Bound host reads to the seek window first; consider a time-prunable raw layout separately. Extra reader work may still miss; a layout change costs consumer configuration and migration. |
| Samples hour cold wall | 53.437 ms / warm passes | First use validates the full file and builds checkpoints. | Selectivity-aware key-only pre-indexing can trade an extra pass for fewer validated rows, but still pays key scanning and needs parity checks. Persistent metadata remains #18-gated. |
| Samples point peak | 17.805 / 17.805 MiB | The global locator retains about 10.1 MiB above the open runtime. | Compact or bound/page locator construction. Paging adds I/O; release cannot fix build peak and forces rebuilds. |
| Raw point peak | 18.359 / 18.340 MiB | The locator plus per-file observations and metadata exceed the 12.562 MiB limit. | The same compact/bounded locator work, then reduce transient observation copies. Lower live heap does not guarantee lower RSS. |
| Raw hour cold peak | 16.230 MiB / warm passes | Query identity workspace overlaps dense retained checkpoints. | Compact checkpoint keys or separate their construction from identity workspace. Separation adds a text pass and can worsen cold latency. |

## Semantics, checks and follow-ups

No ordering, f64 accumulation order, first-encounter group order, cursor, error precedence, duplicate, full-scan-policy, custom-codec or write guarantee was changed. The parent approved whole-file empty seeks under the existing round-2 safe-seek rule: a current checked ordered index can skip unread outside-range rows, including invalid payloads there. `candidate_rows` and `partitions_read` retain their meanings and can be smaller. First-use reads still validate the whole file before publishing bounds. Stale metadata cannot hide a newly matching row.

The design's manifest sentence was inaccurate. Both current `streaming_read` and resident `with_scope` at `5d1a2aa` scope over `lazy.known`. Range queries do **not** freshly list files. Reload and the configured poller discover new partitions; lookups and creates also list. The design now states that actual behavior. Fresh listing per range read is an option, not implemented: it adds directory/metadata work and would change immediate new-file visibility relative to watches/status.

Verified on aka at x86-64-v2:

- Engine scan unit tests: **10 passed**; public streaming query conformance: **2 passed**. Prepared positions cover optional holes, nested fields, missing fields, repeated fold fields, group order and f64 addition order.
- Storage `streaming_*` plus host-listing tests: **42 passed, 3 ignored** measurement tests.
- Native `streaming_*` with `bench-observe`: **84 passed, 4 ignored** measurement/subprocess tests. This includes the three new public-path regressions, all query/error parity cases, append-built validation, exact-prefix append/time checks and watches.
- Three-crate all-target/all-feature cargo check and clippy `-D warnings`: **passed**. Focused fmt: **passed**. Clippy and fmt were repeated after the final lookup cleanup.
- All **98 final public native/SQLite timing/meter trials passed**, with all **210** stage answers cross-checked against SQLite.

Initial invocations found two test/setup mistakes, not waived failures: cargo fmt on the virtual workspace needed explicit packages; the same-length-edit fixture initially changed the numeric text length and was corrected to another three-character number. The reruns passed. The engine scan test build emits an existing unused-import warning in validator tests without all features; all-feature clippy passes without warnings.

The parent owns full combined/release, TypeScript and WASM/browser checks. This worker did not run those gates. Browser gzip headroom was only 1,428 bytes in the previous gate; do not infer this Rust-only check proves that budget. Real Logbook open ≤1 s, absolute Celeron timings, strict retained-RSS qualification and equal power-loss durability remain unqualified. #18 remains an open product decision, not permission to persist binary metadata.

The final audit checked every compiled Rust source-file checksum against the current source. It then removed the owned 1,023 MiB data directory, including fixtures, SQLite temp files, benchmark binary copies and raw temporary trial data. Absence was verified (`PERF3_READ_DATA_CLEANED`). Only the small numeric/provenance files are retained.
