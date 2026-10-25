# Round 2: read-side query-while-scanning optimization

**Reads improved, but #20 remains open.** The warm sample-hour target passes. Aggregate and point latency targets still miss. The five requested read workloads meet the peak-RSS target except point lookup. The additional raw-hour probe misses cold peak RSS.

## Verified method

Source: `fae3b93b9be2b3991157ed2557a34bf1c6069bb9`, including perf-write `efb0f95`. Baseline: `aed5154`. All builds, checks and measurements ran on aka, Ryzen 5 7600X, with `RUSTFLAGS='-C target-cpu=x86-64-v2'`. No rakku or yari access. These are synthetic aka results, not Celeron qualification.

The focused runner uses the unchanged `bench/acceptance` public native and SQLite APIs and its synthetic 656,640-row fixture: ten sample months and 256 raw shards. SQLite remains NORMAL/WAL with its existing non-covering indexes. It verifies complete answers against SQLite, including full-row digests and all groups. Baseline and final each have three timing trials and one independent counting-allocator trial per cell. Final backend order rotates. Cold trials evict only owned files; warm trials prime the same operation on the same open runtime. Each process uses `systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout 180`. No consumer trim or untimed mutation preflight was added.

The 84 final trials succeeded and matched. Timings exclude open, include answer consumption, and exclude the separate counting-allocator overhead. Independent `perf stat -e instructions:u` measurements use nixpkgs perf. Those whole-process counters include open/priming; the JSONL operation counters delimit the timed public call. Flat `perf record` instruction profiles are attribution evidence, not isolated stage timers. Intermediate changes were measured with one timing trial, not used to claim target qualification. The field-only spike reused the baseline meter; those redundant meter rows are excluded from the summary.

[Full timing, floor, peak, allocator and per-stage instruction tables](../../bench/acceptance/results/perf-read.md). [Compact JSONL](../../bench/acceptance/results/perf-read.jsonl). [Compiled Rust source checksums](../../bench/acceptance/results/perf-read-source-files.sha256). [Independent perf stat output](../../bench/acceptance/results/perf-read-perf-stat.txt). The compact evidence omits repeated answer payloads after the runner checked equality.

## Requested workloads

Cold / warm milliseconds; medians of three timing trials. No target is lowered.

| Workload | Baseline | Final | SQLite final | Wall status C/W |
|---|---:|---:|---:|---|
| samples, ten months by day/metric | 1821.087 / 858.326 | 536.944 / 439.050 | 404.387 / 286.100 | miss / miss |
| samples, one month by day | 283.183 / 86.233 | 109.416 / 47.848 | 32.817 / 19.326 | miss / miss |
| samples, one hour | 96.731 / 1.371 | 55.268 / 0.349 | 1.664 / 0.279 | miss / **pass** |
| samples, ID-only point lookup | 2561.475 / 0.247 | 654.274 / 0.244 | 1.085 / 0.042 | miss / miss |
| raw, ten months by day/metric | 2054.092 / 928.501 | 680.832 / 483.006 | 411.669 / 286.212 | miss / miss |

The additional raw-hour probe improved from 1434.847 / 514.911 ms to 605.976 / 10.832 ms, against SQLite 1.870 / 0.297 ms. It still misses both latency targets. This focused run is not a replacement for the parent's combined acceptance matrix or the 16/256-shard memory-growth sweep.

## What changed and its cost

| Change | Verified evidence | Cost / limitation |
|---|---|---|
| Decode only the time key during index-only builds | Sample ten-month cold instructions: 30.184B → 21.907B in the single-trial spike | The whole line is parsed; this is not a persistent checked index |
| Build first-use checkpoints during validated scans; omit index work for provably covered time-bucket partitions | Raw ten-month cold: 32.551B baseline → 17.944B in the fused spike | First-use selective reads validate the full file, so their validation scope can exceed later seeks |
| Hash-only ordinary identity arena | Ordinary metadata: 16 → 8 B per visited row; sample ten-month requested peak: 10.594 → 6.053 MiB final | Duplicate IDs or hash collisions replay the visited windows and verify exact IDs; memory remains O(visited rows) |
| Prepared schema layout; first-byte property dispatch; scalar delimiter search; exact recent scalar-group cache | Sample ten-month warm: 15.960B → 8.787B final instructions; complete answers and differential tests match | Still parses and validates every scanned payload; complex schemas/operators keep canonical fallbacks |
| Fuse first-use ID validation with the locator visitor | First point instructions: 37.388B → 11.640B final | Existing append-built membership still gets payload validation before locator errors; final point numbers also include perf-write's compact locator and generation changes |
| Checkpoint stride 1024 → 32 | Warm sample hour: 24.021M → 3.478M final instructions; warm raw hour: 5927.823M → 117.751M | Across 256 shards, structure bytes rise from 216,832 to 3,487,424 (+3,270,592 B). This contributes to the cold raw-hour peak miss |
| Advance time indexes with checked own-append evidence | Post-append range median: 8.740 → 0.121 ms on the same synthetic 40,320-row month | Requires exact `before` generation, checked `after`, and a complete old tail; otherwise rebuilds |

The checkpoint-density measurement built indexes on the same synthetic raw fixture through `FsStorageHost`. Strides 1024 / 32 took 423.186 / 415.873 ms in single warm-text trials before the metadata-only generation change. These build times are not cold-cache or SQLite qualification. Structure byte counts include capacities, keys and generations, not RSS.

The post-append range trials were 9.008 / 8.639 / 8.740 ms before the proof consumer, and 0.140 / 0.116 / 0.121 ms afterward. Only the range call is timed; append is outside that timer. A same-length external edit followed by an own append must not reuse stale checkpoints. Both the storage exact-prefix test and public native regression pass. The public regression moves an early row into a later range, then proves rebuilding detects unsorted text and disables seeking.

## Profiles

The initial cold ten-month profile attributes 10.32% of instructions directly to owned `serde_json::Value` decoding, with substantial separate IndexMap/allocation work. Borrowed decoding is another 10.87%; framing is 6.07%. The initial point profile similarly shows owned decoding, IndexMap, validation and allocation overhead. These are flat self shares, not additive exclusive phase measurements.

After the first fixes, the ten-month warm/priming profile attributes 36.06% to `SimpleDecoder::decode`, 12.83% to `memcmp`, 8.21% to framing, and 3.64% to `GroupFold::push`, plus string serialization and hashing. This motivated first-byte property dispatch, word-at-a-time scalar framing, the direct-field lookup fast path, and exact caching of the last two string/bool/null group keys. Numeric and complex group keys still use canonical serialization. No floating partial sums or candidate-order changes were introduced.

Profiles: [initial ten-month](../../bench/acceptance/results/perf-read-profile-baseline-ten.txt), [initial point](../../bench/acceptance/results/perf-read-profile-baseline-point.txt), [post-fix warm/priming ten-month](../../bench/acceptance/results/perf-read-profile-dense-ten.txt).

## Remaining misses: observed floors and next steps

Floors are the fastest completed final timing trial, not physical lower bounds. Peak floors are the smallest observed final timing-trial peak. Reasons below are inferred from the profiles, source and allocation evidence. Proposed fixes are not measured claims.

| Miss | Final floor C/W | Reason | Cheapest next step and cost |
|---|---:|---|---|
| samples ten-month wall | 536.932 / 435.770 ms | Full JSON decoding/validation and per-row field/operator work remain; warm instructions are 8.787B versus SQLite's 4.416B | Compile filter/fold field positions against the prepared row layout. This adds plan/parity complexity; it may still miss. A disposable column cache remains #18 approval-gated |
| samples month wall | 107.278 / 47.107 ms | Warm per-row work remains; conservative fractional-timestamp bounds also select the next month on first use | The same compiled field plan first. A checked reusable index can avoid first-use work but adds invalidation/retention; persistence needs #18 approval |
| samples hour cold wall | 54.037 ms / warm passes | First-use full-file schema validation and checkpoint construction | Selectivity-aware key-only pre-indexing could avoid validating skipped rows, trading an extra pass on broad reads; it does not remove index construction. A persistent checked index needs policy approval |
| point wall | 650.312 / 0.157 ms | Cold validates global payloads and builds membership; warm lists partitions, repeats generation checks and canonically decodes the candidate | Share one checked-generation witness between validation and locator refresh, without trusting stale metadata. Requires a coordinated internal proof seam/race tests and may still miss the 2× limit |
| raw ten-month wall | 659.555 / 478.922 ms | Full scalar decode/validation/folding plus 256-file host overhead and checkpoint construction | The same compiled field plan, then profile/batch host probes. More plan/host complexity; no approved persistent artifact |
| raw hour wall (extra probe) | 603.241 / 10.585 ms | Cold scans every shard; warm still opens/checks 256 files and scans checkpoint windows | A layout that permits pruning or a validated cross-file range index. Layout migration changes consumer configuration; an index costs more metadata and persistence needs approval |
| point peak RSS | 17.984 / 17.984 MiB | The compact locator still retains about 10.1 MiB of requested heap above the open runtime | Further compact or bound/page locator construction. Eviction helps retained RSS, not build peak, and forces repeat work; persistent paging needs #18 approval |
| raw hour cold peak (extra probe) | 16.336 MiB / warm passes | Full first-use identity workspace overlaps denser retained checkpoints | Compact checkpoint key representation or defer index construction until the identity arena is dropped. Deferral adds another text pass and worsens cold latency |

Return-to-idle is not qualified by low live heap. Dense raw checkpoints retain about 3.5 MiB of requested allocations; the point locator retains about 10.1 MiB. Allocator-retained RSS can be higher. No memory target, cold target, or equal-durability qualification is waived.

## Contracts and checks

Parent-approved observable changes: first-use range reads can validate an outside-filter invalid row that later indexed seeks skip; every row actually scanned is validated. `BoundedQueryStats::candidate_rows` is additive. Streaming counts validated scan rows after pruning/seeking; Resident bounded visits count visited rows, cached reads count the selected scope, and eager reads count collection rows. External Rust callers constructing stats literals must include the new field; the parent checked Coach and Logbook do not do that. Natural/group order, stable ties, f64 addition order, error precedence, custom-codec fallback and Resident default remain unchanged.

On aka at x86-64-v2:

- Engine scan unit tests: 9 passed. Streaming query conformance: 2 passed.
- Storage streaming index/readers/performance tests: 24 passed, 3 ignored measurement tests. The density measurement was explicitly selected and passed.
- Native `streaming_*` tests with `bench-observe`: 81 passed, 4 ignored measurement tests. The append→range measurement was explicitly selected and passed.
- Three-crate all-target/all-feature `cargo check`, clippy `-D warnings`, and focused fmt check passed. Clippy first found test-module placement; moving those modules to the file ends fixed it.
- Ruff check/format passed for both focused measurement scripts. One initial test implementation failed to compile because `GroupResult` is not `Serialize`; comparing its existing `PartialEq` contract fixed that test.
- A final review reproduced loss of time-index eligibility on canonical schema transforms. The prepared decoder now declines unsupported schemas, and canonical fallback rows still supply raw index keys. The new NumberFromString regression passes; the pinned 84-trial matrix above was rerun after that fix.
- Final 84 public native/SQLite timing/meter trials passed. No full repository suite, push, deployment, consumer cutover or Celeron qualification was run by this builder.

The focused scripts are `scripts/qws/perf-read.py` and `scripts/qws/summarize-perf-read.py`; use them only inside `scripts/qws/aka-run perf-read --x86-64-v2 --pull -- ...`. Build the acceptance timing/meter binaries separately, prepare the owned synthetic fixture at `/home/simonwjackson/work/qws-perf-read-data/base`, set `SQLITE_TMPDIR` to the owned `/home/simonwjackson/work/qws-harness-data/perf-read-tmp`, then invoke the runner through nixpkgs perf/python. The existing acceptance README documents the build, cache and scope controls. Owned fixture data and temporary perf recordings were removed after reporting; no derived persistent index/cache was written.
