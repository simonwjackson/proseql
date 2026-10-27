# Round 5: saved ID-table loading

**Saved-table CPU work falls, but all four latency targets still miss. Cold RSS
peaks also increase.** Saved membership stays in per-file sorted tables. A
restart does not rebuild or sort a global locator. No target is lowered.

## Source and method

Runtime: `c1fc76018ffdde5a6c6045427064f5db742bf04f`, including
`cd721ef` (candidate validation), `17975df` (direct tables) and `3719276`
(validation accessors). Baseline binaries
were built at `3719276849eba8d867d778369a71807fc57b5104`: round-4 runtime plus
the exact-generation accessor, before the locator changes. The base is `517bdea`.
Only Git, reading and editing ran on zao. All compilation, execution, tests and
profiling ran on aka through `scripts/qws/aka-run index-load --x86-64-v2`.
There was no rakku/yari access, real data, push or deployment.

`scripts/qws/index-load-measure.py` uses the unchanged acceptance binary, public
`find_by_id`, full-row answer digest and 656,640-row synthetic fixture. Samples
have ten files; raw has 256. SQLite retains NORMAL/WAL and its original indexes.
The first operation after a fresh process starts loads saved indexes. Warm trials
also prime the same operation on the same runtime. Timing excludes open, but
includes complete answer consumption. Cold eviction covers owned text, SQLite
and sidecar files, not controller or inode caches.

Each accepted baseline/final block has three rotating timing trials per cell
and one separate counting-allocator/perf trial per cell: 32 trials per block,
64 total. Meter timings do not enter the medians. Independent
`perf stat -e instructions:u` covers the whole process, including open, priming
and deferred index release. The harness's instruction counter delimits the
public operation. Requested heap is not RSS.

Every preparation and measured process uses
`systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout`.
Preparation starts from a fresh directory. SQLite temp files are under
`/home/simonwjackson/work/qws-harness-data/index-load/tmp`. Builds/tests use
`flock -s /home/simonwjackson/work/qws5-aka.lock`; each entire measurement block
uses `flock -x` on that lock. Blocks wait for one-minute load <=1, sample it every
five seconds and reject a block exceeding 2. Earlier exploratory trials are not
used for the final table. There is no trim, teardown or larger memory limit to
hide retention.

## Why file-local tables

Each checked saved table becomes its own compact 16-byte-entry vector. Loading
checks its sorted order and bounded, unique, monotonically located row ordinals.
A missing, damaged or unsorted table falls back to text. Old sorted version-2
files remain usable. Old append-produced unsorted tables safely rebuild. There
is no format-version change. Publication sorts pending appended entries within
each file, and serializes one file at a time.

Lookup performs one binary search per file table, then checks the bounded append
delta. It does not allocate a merged table. The older global merge/sort remains
a fallback when changed text or a large append delta needs consolidation, not
the saved-index restart path. The direct-table intermediate measurement at
`17975df` used 154,637,384 cold raw operation instructions; its baseline used
about 387 million in the first exploratory profile. That instruction gain did
not remove the cold file-read fanout.

The global duplicate proof still runs at locator construction, after every
required payload-validation scan. It inserts the complete u64 hashes into a
temporary open-addressed set. The set retains every bit; table collisions use
linear probing and cannot suppress a duplicate. Hash zero has an explicit
occupied flag. The 656,640-row fixture uses exactly **8,388,608 transient bytes**
for this set. Only repeated hashes are sorted. Each such group is replayed from
text in the original `(hash, file, offset)` order. Exact IDs, not hashes, decide
equality. Same-file and cross-file errors and validation-before-duplicate
precedence remain unchanged. This chooses linear-time uniqueness work instead
of a full global sort, at the cost of the transient set.

`Store::load` reuses the checked envelope allocation for its payload instead of
allocating a second copy. Compact entries are decoded without hashing an empty
string for each saved row and without an intermediate 24-byte tuple vector.

## Warm path and edit detection

An exact, trusted fresh listing can prove that every file's membership and
validation generation still match. That path skips generation-map reconstruction,
path/generation cloning and no-op locator refresh. Missing/new paths, a changed
token/length/mtime, a dirty locator, tokenless hosts or incomplete validation use
the full checked path. Candidate verification retains both generation checks.
Eligible callback/default/migration-free, unversioned provided-ID schemas use
the existing borrowed decoder for candidate validation; unsupported schemas and
all errors keep canonical decoding.

**No fresh per-file metadata read was removed.** A different partition can gain
an invalid payload or a duplicate of the requested ID. Checking only the hit file
would hide the required error. A directory mtime also cannot detect in-place
edits. The parent confirmed that no coarser host token is available this round.
The consumer's move from 256 raw shards to about ten month files is separate work;
it does not qualify this engine's 256-file number.

## Measurements

The tables use the accepted locked `baseline3` and `final-safe` blocks. Floors
mean the fastest completed timing trial, not a physical lower bound. The targets remain first-after-restart <=5x SQLite
and warm <=2x SQLite. The earlier issue's <=2x cold point target is not declared
passed or removed by this round.

Milliseconds, cold / warm; three-trial medians. The supplied round-4 single
observations were 48.311 / 0.096 for samples and 107.045 / 0.753 for raw.
The fresh before column is this worker's controlled rerun, not those older cells.

| Shape | Before | After | SQLite, final | After / SQLite | Target C/W |
|---|---:|---:|---:|---:|---|
| samples | 51.905 / 0.136 | 40.102 / 0.090 | 1.117 / 0.031 | 35.914x / 2.942x | miss / miss, <=5x / <=2x |
| raw | 109.638 / 1.037 | 104.025 / 0.637 | 1.293 / 0.032 | 80.427x / 19.943x | miss / miss, <=5x / <=2x |

All 64 accepted complete answers match SQLite. Maximum sampled one-minute load
was 0.975586 before and 0.987793 after. Neither block required a high-load repeat.
These are synthetic same-machine results, not Celeron qualification. Separate
blocks and three repetitions do not remove all shared-host or filesystem-layout
variation.

### Instructions and allocations

Operation-delimited user instructions; requested Rust heap peak in MiB. The
independent counting allocator does not measure glibc arenas or OS RSS.

| Shape/mode | Instructions before | Instructions after | Heap peak before | Heap peak after |
|---|---:|---:|---:|---:|
| samples cold | 374,487,078 | 135,247,383 | 19.614 | 18.060 |
| samples warm | 455,723 | 308,251 | 10.062 | 10.058 |
| raw cold | 387,392,386 | 154,613,560 | 16.623 | 18.551 |
| raw warm | 8,835,938 | 4,925,087 | 10.508 | 10.434 |

Cold operation instructions fall about 64% / 60% for samples/raw. Cold wall
medians fall only about 23% / 5%. **Inferred:** whole-sidecar reads, envelope
checksums, bounded-entry decoding, the remaining uniqueness pass and filesystem
fanout now dominate the restart path. Those stages are not isolated wall timers;
this does not prove a physical I/O floor. Loading still examines every saved ID
entry. It is not a paged lookup.

Independent whole-process `perf stat -e instructions:u` counts include open,
priming and deferred publication, so they must not be substituted for operation
counts:

| Shape, C/W | Before | After |
|---|---:|---:|
| samples | 450,874,104 / 451,739,472 | 224,057,691 / 224,371,674 |
| raw | 487,911,580 / 496,788,908 | 267,444,803 / 272,319,379 |

Requested live heap is essentially unchanged: 10.052 MiB samples and 10.341 MiB
raw after lookup. Raw grows by 6,216 requested bytes versus before. The 8 MiB
uniqueness set is transient, but allocation layout and allocator-retained pages
still matter. Actual timing-process memory has a cost:

| Shape | Cold peak RSS before/after, MiB | Maximum RSS at 1 s before/after, MiB |
|---|---:|---:|
| samples | 22.363 / 29.445 | 22.426 / 21.680 |
| raw | 18.434 / 27.918 | 18.496 / 20.238 |

Both cold peaks worsen; raw post-lookup RSS also worsens. No memory target is
waived. SQLite's final peak is 6.191 MiB: both still miss the older <=2x point-peak
target. Fresh open/idle was not remeasured. This change is not a strict
return-to-unindexed-idle qualification.

### Every latency miss

| Miss | Observed floor | Final target bar | Inferred reason | Next step and cost |
|---|---:|---:|---|---|
| samples first lookup | 37.191 ms | 5.583 ms | All roughly 15 MiB of ID payloads still load and receive bounds/checksum/uniqueness checks. | Persist a generation-set uniqueness certificate and page-checkable tables. This needs a new format and corruption/race proofs; it must not skip duplicate detection. |
| raw first lookup | 101.972 ms | 6.467 ms | The same work plus ID/validation sidecar and metadata fanout over 256 files. | The certificate/page design, then a bundled metadata layout. Extra format/publication complexity; every source generation still needs a fresh check. |
| samples warm | 0.081251 ms | 0.061114 ms | Ten fresh observations, two candidate generation guards and candidate read/decode remain. | Profile host recovery/open/verification calls next. Prepared host operations add a seam and race tests; do not simply remove either candidate guard. |
| raw warm | 0.628341 ms | 0.063900 ms | Every one of 256 source files still needs fresh metadata, plus 256 binary probes. | Measure the separately owned month-partition consumer layout. It costs migration/configuration and does not close this engine's 256-file target. No safe coarser host token is available in this round. |

The global certificate/page design could also avoid the temporary set and lower
peak memory. That is an unimplemented next step, not a speed or memory claim.

## Guarantees and checks

No caller-visible guarantee changed. Ordering, errors, duplicate equality,
full-scan policy, schema checks and text durability are unchanged. The validation
accessors record only a complete canonical scan of an exact generation, including
its duplicate checks. Their sidecars still publish only on release/successful
close. A grown validation record never certifies the new generation. Saved prefix
hashes never authorize own appends; only the existing checked post-commit
`accept_appended` / `AppendProof` path advances them.

Verified on aka, native x86-64-v2:

| Check | Result |
|---|---|
| Storage ID unit tests plus every `streaming_*` integration test | 47 passed, 0 failed, 4 ignored |
| Native locate unit tests plus every `streaming_*` integration test | 102 passed, 0 failed, 4 ignored |
| Native/storage all-target/all-feature `cargo check` | passed |
| Native/storage all-target/all-feature clippy, `-D warnings` | passed |
| Scoped Rust fmt check; helper Ruff check/format | passed |
| Normal and counting-allocator acceptance release builds; lifecycle example | passed |

Crash parents invoke their ignored subprocess children. Other ignored tests are
measurements, not waived failures. New regressions cover actual per-file restore,
all lookup probes, global duplicate/error precedence, hash collisions including
zero, append acceptance/republication, unsorted sidecars, exact listing proofs,
changed tokens, new/removed files, tokenless/dirty states, validation mismatch,
schema changes, crafted/old sidecars, same-length edits outside a warm hit, and
optional/nested/transformed candidate parity against the canonical eager path.

An initial accessor test used the wrong Fs constructor, one new test needed an
explicit `Vec<String>` type, and clippy rejected a cloned one-element slice.
Those setup errors were fixed and rerun. One focused test caught an unnecessary
extra tokenless full-file proof after an ordinary text scan; final post-checks
now apply only to restored files, while scans retain their existing own check.
No assertion was relaxed. Final inspection also found that a rejected table
could leave unreferenced overflow addresses from partial decoding. A regression
now proves that repeated malformed wide-location payloads retain neither those
addresses nor their allocation cursor. The final runtime and final measurement
block include that cleanup. Disabling just the cleanup reproduces the test
failure (3 retained overflow addresses instead of 1); restoring it passes. The
red/green check ran on aka under the shared build lock.

Evidence remains on aka under
`/home/simonwjackson/work/qws-index-load-results/{baseline3,final-safe}/`:
`trials.json`, `summary.json`, `load.json`, `provenance.json` and independent
`*.perf` outputs. Runtime source-file SHA-256 values were checked again after
the final block (`FINAL_SOURCE_HASHES_MATCH`). Only this report/helper follow
the measured runtime commit.

| Binary | SHA-256 |
|---|---|
| baseline timing | `455064243047a186f634bc8e66e5511003a631e101c91caf57277baf2cedfb0d` |
| baseline allocator | `cda5531203975094115623e68926aa599bac0095ee25062f59713c8f1c62d50a` |
| final timing | `ab7e65dab5472e20cac328c426dd705c123fa4f597cfe0ea6a077d86ab492ca6` |
| final allocator | `f3ee93cac9391c3de3ea3534719996e99ea9adc81a256154d526a1a17f0b646e` |

Each block removed its synthetic fixtures and SQLite temp files. Final absence
was checked again (`FINAL_DATA_ABSENT True`). All copied benchmark binaries were
also removed (`COPIED_BINARIES_REMOVED True`). Small evidence files and Cargo
build caches remain. No real source data or shared service was changed.

The parent owns combined release, TypeScript, WASM/browser and consumer checks.
This worker did not run those gates. Absolute Celeron/real-data timing, equal
power-loss durability, all missed latency targets and point peak/retention
qualification remain open.
