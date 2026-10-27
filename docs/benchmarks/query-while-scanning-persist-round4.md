# Round 4: disposable native streaming indexes

**Saved indexes reduce cold point and append latency. All eight measured wall-time targets still miss.** Fresh open/idle RSS passes SQLite +20 MiB. Post-append RSS remains a separate miss. No target or text durability rule changes.

## Source and method

Runtime: `81951f9a8f08eeababd95c59a8d61d0efc4e4820`, including the reproduced validation-precedence fix. Base: `1dfbce5`. Only documentation, numeric evidence and Python formatting follow that runtime commit. [Numeric cells](query-while-scanning-persist-round4.json) and [binary hashes/toolchain](query-while-scanning-persist-round4-provenance.txt) accompany this report.

Everything compiled and ran on **aka**, with native `RUSTFLAGS='-C target-cpu=x86-64-v2'`, through `scripts/qws/aka-run persist`. No WASM build, rakku/yari access, real data, push, GitHub action or deployment ran. The parent owns combined release-check and WASM/browser qualification.

The unchanged acceptance public APIs supply 656,640 synthetic rows per shape, ten sample month files and 256 raw shards. `scripts/qws/persist-measure.py` runs **96 timing/RSS trials**: three repetitions for point/append, one for fresh open/idle, rotating SQLite/missing/sidecar order, each cold/warm. All 96 complete answers match. All 36 append trials independently persist exactly 1,000 rows. Fresh copied fixtures use the harness's `cp -a --reflink=auto` path. SQLite keeps NORMAL/WAL and its original indexes. Its temp directory stays under `/home/simonwjackson/work/qws-harness-data/persist/tmp`.

Preparation starts from a fresh directory. Every preparation, priming probe and measured process uses `systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout` (600 seconds preparation, 180 seconds otherwise). No limit was raised. Before a sidecar trial, a separate process builds and closes indexes for that exact copied directory, then exits. Copying changes inode generations, so merely copying old sidecars would not qualify an unchanged-token restart. The timed process is fresh. The cold helper syncs/evicts only owned files, including sidecars; warm primes file pages and, for reads only, the same operation on the same runtime. Append has no membership preflight in the timed process. Timing excludes open and answer checking consumes full rows/digests.

The block waited for one-minute load ≤1. Per-trial samples peaked at **0.7002**, below the rejection bar of 2. This is not isolation from every shared-host effect. The first exploratory block used Python file copying instead of the harness copy path; its SQLite append times were materially different. It is not the accepted table. The final block uses the harness path and supersedes it. An initial launcher also lacked Python in the dev shell; the explicit Nix Python invocation fixed that setup error.

## Before / without / with sidecars

Cold / warm milliseconds. Final values are three-trial medians. “Round 3” is the supplied prior report, not a new baseline build. Missing-sidecar trials retain the full text scan/validation/build path; they do not hide that work in open. Their differences from round 3 are separate-run variation, not a proven no-regression bound.

| Workload | Round 3 | Final, missing sidecars | Final, saved sidecars | SQLite, final | Target C/W |
|---|---:|---:|---:|---:|---|
| Point, samples | 562.411 / 0.083 | 525.155 / 0.126 | 59.649 / 0.096 | 1.354 / 0.040 | miss / miss, ≤2× |
| Point, raw | 712.321 / 0.727 | 691.651 / 1.011 | 116.026 / 0.800 | 1.190 / 0.026 | miss / miss, ≤2× |
| Append 1,000, samples | 373.953 / 322.334 | 358.017 / 300.470 | 105.547 / 85.086 | 11.631 / 7.431 | miss / miss, ≤1× |
| Append 1,000, raw | 732.828 / 594.753 | 749.989 / 570.146 | 572.626 / 335.952 | 11.825 / 8.134 | miss / miss, ≤1× |

Saved cold point lookup no longer decodes/validates every row. It still loads all per-file locator entries, sorts/merges global membership, checks duplicate candidates and verifies the returned row from text. Saved append avoids first-use historical ID parsing, but still pays target baseline reads, durable append prefix read-back and file synchronization. It does **not** eliminate all prefix-byte reads. The raw missing-sidecar cold append is about 2% above the prior separate-run median; exact equality to the earlier report is not established. No threshold is relaxed.

## Every wall-time miss

Floors are fastest completed final trials, not physical lower bounds. Reasons and proposed next steps are inferred from code and the earlier phase profiles, not newly isolated stage timers.

| Miss | Saved-index floor C/W | Reason | Next step and cost |
|---|---:|---|---|
| Samples point | 59.135 / 0.093 ms | Cold whole-locator loading/reconstruction/global sort; warm fresh observations and canonical candidate decoding | Measure sorted-run merging or checked paged lookup with per-page checksums and a generation-set duplicate proof. More format/proof complexity; cannot skip the global duplicate check without evidence. |
| Raw point | 115.155 / 0.762 ms | The same global work plus 256 file/sidecar observations and cold file fanout | First profile/batch sidecar metadata and compact the load representation. A manifest/page design must still detect external edits and new files; caching directory metadata alone is unsafe. |
| Samples append | 105.273 / 84.175 ms | Locator reconstruction plus baseline and checked prefix reads, validation of the new batch and durable writes | Reuse a serializable append-baseline/hash state and profile prepared host handles. The current `DefaultHasher` streaming state is not serializable; its finished hash alone cannot resume it. A new hash-state contract costs compatibility/race tests. |
| Raw append | 555.529 / 333.493 ms | The same work plus 256 target baseline reads, checked prefix read-backs and synchronized appends | Baseline/hash-state work first, then prepared per-file handles. Fewer synchronized targets needs a separate consumer layout/migration decision. Synced text durability is not lowered to NORMAL WAL. |

## Disk cost

Measured after ID validation plus the May-hour time-index query. Each shape still contains 656,640 text rows. The sample hour creates one ordered-field index for May; raw creates that field's index in all 256 shards. No claim is made that all ten sample months were time-indexed.

| Shape | ID files, logical B | Validation files, logical B | Time files, logical B | Total logical B | Allocated B | File count |
|---|---:|---:|---:|---:|---:|---:|
| samples | 15,760,850 | 1,250 | 90,964 | 15,853,064 | 15,917,056 (15.180 MiB) | 21 |
| raw | 15,796,224 | 30,720 | 879,336 | 16,706,280 | 18,575,360 (17.715 MiB) | 768 |

ID payloads use 24 B/row, with 24 B/file metadata. Each envelope adds 112 B plus the relative-path length. Validation payloads are empty. Time checkpoints use JSON scalar keys/locations inside the checksummed binary envelope, at stride 32. More ordered fields/files cost more disk space. The 16-byte in-memory locator is unchanged; disk representation prioritizes portable exact offsets/ordinals over compression.

## Publication alternatives and memory

A separate public-API probe builds missing indexes, then immediately releases or closes. These are **single warm-text probes**, not latency qualification. Immediate post-build publication would add approximately the same synchronous save cost to the first operation; it is not implemented. The selected default defers it to explicit release/successful close.

| First-build publication, ms | release | close |
|---|---:|---:|
| samples | 127.210 | 127.636 |
| raw | 153.660 | 154.000 |

In the timing matrix, release after a missing-index lookup costs median 144.773 ms samples / 174.141 ms raw (cold trials). After a saved-index lookup it costs 52.148 / 129.171 ms. Publication reuses an unchanged loaded full-prefix hash, but still serializes/writes locator files. Repeated release currently republishes eligible files; avoiding unchanged rewrites is a follow-up. No source fsync is removed. Sidecar temp/rename publication deliberately does not fsync disposable data; loss is a cache miss.

RSS in MiB. Open/idle are single-trial fresh-runtime observations, not post-operation retention. Each fresh sidecar open/idle cell is below SQLite +20 MiB. The open runtime does not eagerly load sidecars.

| Shape | SQLite fresh open / idle | Saved-index fresh open / idle | Point, RSS after 1 s | Append, RSS after 1 s |
|---|---:|---:|---:|---:|
| samples | 6.137 / 6.137 | 7.621 / 7.621 | 17.984 | 34.820 |
| raw | 6.137 / 6.137 | 7.668 / 7.668 | 18.484 | 35.129 |

Warm fresh-open maxima are 7.691 / 7.750 MiB samples/raw; still pass. Cold point peaks are 20.625 / 18.422 MiB versus SQLite 6.270 MiB: the older ≤2× point-peak target still misses. These are RSS measurements, not counting-allocator evidence. Fresh open time with sidecars is 0.431 / 2.677 ms cold samples/raw; this does not qualify real Logbook or Celeron open ≤1 s.

Post-append RSS also exceeds SQLite +20 MiB if “idle” is applied after the mutation: samples 34.820 versus a 29.516 MiB bar; raw 35.129 versus 29.574. The existing append path's large transient baseline buffers/allocator retention remain; saved metadata does not solve them. Next: bounded streaming baseline construction and allocation-site profiling. That adds hash/torn-tail bookkeeping and does not guarantee OS RSS reclamation. No trim or teardown was used to hide retention. Point retention also does not pass the older return-to-unindexed-idle tolerance merely because the +20 MiB fresh-idle bar passes.

## Semantics and checks

The user approved the README change to **“No binary source of truth”** in the same code change that introduces sidecars. Text remains authoritative; files are disposable and generation/schema/version/checksum checked. Native Fs persists; memory/WASM/browser hosts keep safe no-persistence defaults. Host wrappers forward the additive methods. Custom codecs, callback/default/check schemas and migration configurations conservatively keep the text path because closure implementations cannot be fingerprinted across processes.

Whole-file validated generations authorize time publication. A failed read disables pending time publication. A grown saved time index canonically validates its suffix before seeking; invalid original/appended rows have identical errors with/without sidecars. Merging saved ID files still performs cross-partition duplicate checks. A new regression first reproduced a membership-only sidecar reporting a duplicate before an invalid old payload. The final fix refuses that file's cached membership during a validating build unless its validation record is checked, restoring validation-before-duplicate precedence.

No ordering, cursor, f64 accumulation, duplicate equality, error policy, quarantine or text-durability contract changes. Cold range stats can now report a saved ordered seek, with fewer examined rows/files, under the existing physical-stat meanings. The existing safe-seek rule remains. There is no snapshot isolation or protection from an attacker forging both sidecar contents and checksums.

Verified on aka at x86-64-v2:

- Storage focused library, all `streaming_*`, touched filesystem durability and persistence tests: **93 passed / 0 failed / 4 ignored**. The new crash parent explicitly runs the ignored child at the temp-write/before-rename seam, both with and without an old file.
- Native focused library/all-feature, all `streaming_*`, and touched append/lazy/runtime/source-wrapper tests: **180 passed / 0 failed / 8 ignored**. Crash parents explicitly invoke their subprocess children. Ten new persistence tests pass across native/storage.
- Native/storage all-target/all-feature cargo check and clippy `-D warnings`: passed. Scoped Rust fmt: passed. Acceptance example release build and focused clippy: passed. Python helper Ruff check/format: passed.
- All **96 accepted public API trials** match complete SQLite answers. All **36 append trials** persist 1,000 rows. Source-file checksums match the measured runtime source before the final focused rerun. Binary checksums are committed beside this report.
- Required cases cover present/missing/deleted/truncated/bit-flipped/older-format/older-index-version caches, schema changes, same-length edits, external append/replacement, cross-file duplicates and stale duplicate creates, partition listings, watcher suppression, own checked append publication, and crash-before-rename behavior.

Earlier local test/setup errors (constructor/config-field typos, an error-conversion type, and a clippy type alias/multiple-of lint) were corrected and rerun; none are waived. Only Git, reading and editing ran on zao. No full workspace suite ran.

All owned synthetic data, copied trials and SQLite temporary files under `/home/simonwjackson/work/qws-harness-data/persist` were removed. Absence was checked twice (`PERSIST_DATA_CLEANED True`, `FINAL_DATA_ABSENT`). Small logs/numeric evidence remain at `/home/simonwjackson/work/qws-persist-results`; the source checkout and Cargo build cache remain. Real consumer deployment, real-data/Celeron qualification, independent review and all missed speed/retention targets remain open.
