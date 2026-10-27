# Query while scanning

Streaming is now the default and the only lazy execution model. Eager collections
keep the resident engine. Text remains the source of truth. No binary index or
cache is written to disk.

`ExecutionModel::{Resident, Streaming}` and
`NativeSourceRuntimeOptions::execution_model` remain as deprecated compatibility
items. Both variants stream lazy collections. The field defaults to Streaming;
Logbook's adoption branch compiles without edits. `LazyPartitionPolicy` keeps
both fields; `max_loaded_partitions` is ignored and `full_scan` remains binding.

The deferred #19/#21 cutover is implemented after Logbook adopted returned rows
(commits `d2ada9e`, `53417a6`, `ad70bd9` on its `streaming-adoption` branch).
Before this cutover, that branch passed 221 tests, 0 failures and 2 existing
ignores under both models against `c523e6f`. This removes the earlier blocker,
not the outstanding SQLite or real-shape measurement requirements.

## Scope and bounds

The scope is sources named in `NativeSourceRuntimeOptions::lazy_partitions`: partitioned JSONL/NDJSON, append-only, without unique fields, relationships in either direction, hooks, computed fields or migrations. Opening checks these preconditions. Update, delete and upsert still fail with `OperationError`, reason `append-only`.

Eager collections stay resident. Their collection files, document graphs, relationships, population, search and computed fields still use the engine `Database`. This change does not bound their memory by JSONL chunk size.

YAML is never lazy. YAML sources retain the eager, resident engine path. Memory scales with document size, including original bytes, decoded records and candidate serialized output during writes, not JSONL chunk size. Multiple configured eager documents can retain their combined sizes. Existing byte-preservation and fail-closed write-safety rules remain unchanged.

Streaming is not a constant-memory promise for every query. Memory includes:

- A 64 KiB host chunk and reusable framing buffers, plus the longest physical line.
- Query-local duplicate-ID metadata, output, stable sort/top-k or cursor workspace, and aggregate/group state. Search and equality-index unions can buffer matching rows to preserve candidate order and f64 accumulation order.
- Derived time indexes, a lazily built global ID locator, and checked generations. These retain metadata, not record payloads.
- Delivered watch results and serialized equality baselines. Callers can retain results indefinitely.
- One decoded partition for custom codecs or canonical error replay. Append preparation can also read one target partition's bytes to build its compact durable-append baseline.
- Allocator-held free pages. Dropping query allocations is not an RSS or one-second reclamation guarantee.

For every lazy collection, `max_loaded_partitions` is retained for source compatibility but ignored. It no longer bounds anything on that path; streaming memory no longer depends on it. `lazy_partition_status` keeps its shape: `loaded` and `pinned` are always empty. No lazy cache bound or watch pins remain. Eager records and transaction-staged creates are not streaming partition residency.

## Read path

Opening lists partition names without decoding rows. Range queries conservatively prune the known manifest using the existing partition-field conditions; they do not list new files on each read. Explicit `reload` and the configured lazy poller discover new partitions. ID lookups and creates also refresh the manifest. This matches the pre-streaming `with_scope` path at `5d1a2aa`, which also used `lazy.known`. `FullScanPolicy` is applied before indexes: an index cannot bypass a refused scan.

The storage host supplies byte ranges. The shared `LineFramer` accepts chunks, handles lines spanning chunks, tracks byte offsets and physical line numbers, and classifies valid unterminated and torn final lines. The scalar Rust executor decodes borrowed rows, validates read rows, filters, projects and folds during the scan. It materializes owned values for output or operations that need them. No lazy partition is installed in the engine collection.

Partition path and file ordinal define natural order. Shared engine candidate-order rules preserve equality unions, stable ties, first-encounter group order, cursor comparisons and `limit + 1` page flags. Aggregates add individual f64 values in canonical order, not partition partial sums. An invalid row still fails a read even when its filter or limit would discard it. Rows excluded by partition pruning or safe positional seeking were not scanned.

A sparse time index records an offset every 32 rows for eligible configured ordered fields. On first use, the canonical full-file scan builds checkpoints as a side effect. Existing indexes seek only when ordering and generation checks permit it. A query whose validated UTC bounds conservatively cover an entire time-bucket partition does no index work for that file. Index-only rebuilds decode the key field, not owned payloads. Unsorted data or a custom JSONL codec disables seeking. A stale index is rebuilt or the operation scans correctly; it is never authoritative data. A current ordered index can prove an entire file is outside the range from its first/last keys and skip opening it. `partitions_read` then excludes that file and `candidate_rows` excludes its rows, consistent with their examined-file/row meanings. This does not help raw shards whose keys all span the requested time range.

Whether an invalid row outside the queried range fails a Streaming read can depend on index state: a first-use full scan validates it, while a later safe seek may skip it. Every row actually scanned is still validated. `BoundedQueryStats::candidate_rows` counts those validated scan rows, including filter and page rejections, not index-maintenance rows. `NativeQueryStats::index_used` is None for a first-use full scan and Ordered only when the scanner uses a positional seek. Eager bounded reads report the collection row count.

Ordinary query-local identity metadata is 8 bytes per visited row. Equal hashes replay only the visited windows to recover candidate locations, then verify exact IDs from text. This halves ordinary identity storage, but duplicates or hash collisions add replay I/O. First-use ID lookup validates borrowed rows during the locator build; membership built earlier by append still requires payload validation before locator errors.

Own appends can advance time indexes through checked `AppendProof` evidence. The cached generation must exactly match `before`, the host must still match `after`, and the old indexed prefix must end on a complete line. Otherwise the index refreshes normally; an external change clears append evidence. This prevents a same-length external edit followed by an own append from blessing stale checkpoints. Thirty-two-row checkpoints trade faster narrow ranges for more retained metadata: the 256-shard fixture uses 3,487,424 bytes versus 216,832 at stride 1,024. See the [round-2 read report](../benchmarks/query-while-scanning-perf-read.md).


## Disposable index files

Native `FsStorageHost` can write derived files under each lazy partitioned
source's `<root>/.proseql-index/` directory. For `2025-05.jsonl` the files are
`2025-05.jsonl.ids.idx`, `2025-05.jsonl.valid.idx`, and
`2025-05.jsonl.time-<field-hash>.idx` for each used ordered field. Partition
listings and managed filesystem watch notifications ignore this directory.
WASM/browser and memory hosts do not persist indexes. Custom codecs, schemas
with checks/default callbacks, and migration configurations keep the text path:
closure implementations cannot be fingerprinted across processes.

Text remains the only source of truth. Delete `.proseql-index` at any time,
including while the runtime runs. Missing, unreadable, truncated, damaged,
old-format, old-index-version or different-schema files are cache misses, never
new database errors. Files can reappear on release or close. Orphan `*.tmp`
files are ignored and can also be deleted. Cache files are not an interchange
format or a substitute for text backups.

The little-endian versioned envelope contains magic, format/index versions,
relative text path, covered byte length, trusted change token and modification
time, a checked prefix hash, schema/config fingerprint, payload length and a
checksum over the entire envelope/payload. Index version 2 rejects earlier
round-4 sidecars, whose time-validation proof could omit duplicate checks.
Persisted row counts, resume positions and checkpoint/locator locations are
bounded and checked for consistency before traversal. An unchanged trusted generation
needs metadata checks, not a text read. A grown file needs one checked hash
read per distinct covered prefix, shared across sidecar kinds, followed by
suffix scanning. Edits, truncation, replacement or mismatched prefixes rebuild
from text. Every restored source is checked again before publication. These
checks retain the existing race window; they do not add locking or snapshots.

ID sidecars contain hashes and exact file-local locations, never authoritative
IDs or records. The merged locator still checks cross-partition duplicate IDs,
including collisions verified against text. A stale or missing sidecar cannot
make a duplicate create succeed. Reads still decode/validate candidate records.
Validation records certify only the checked text generation under the saved
schema/config fingerprint. Loading membership without a validation record does
not bypass payload validation or validation-before-duplicate precedence. Its
checked validation prefix must cover the cached membership prefix; otherwise
the locator scans that file and validates the uncovered gap before merging.

Time sidecars are eligible only after whole-file canonical validation succeeded
under that fingerprint. A failed read disables pending time publication. A
grown time sidecar falls back to the canonical full-file scan: payload validation
of the suffix alone cannot prove that its IDs are unique against the prefix.
Existing in-memory safe-seek semantics remain unchanged. Tests compare invalid
original and appended payload errors with and without sidecars.

Publication uses a unique `create_new` temporary file and a same-directory
rename. There is deliberately no file or directory fsync for this derived data:
losing it only costs rebuilding. A crash before rename leaves the old index or
none; a power-loss-damaged file fails checksum/generation checks. Text append
sync, read-back evidence, rollback and quarantine rules do not change.

Writes are deferred to `release_streaming_indexes()` and successful `close()`,
not performed per appended row or per query. Checked own-appends advance locator
and validation coverage through the existing append evidence. A process that
exits without release/close may lose recent index work, never text. Index writes
and hashing can increase release/close latency. After loading a checked index,
publication reuses its checked full-prefix hash when the token is unchanged.

Disk cost: an ID payload is 24 bytes per row plus 24 bytes per file; a validation
payload is empty. Each envelope adds 112 bytes plus the relative-path byte
length. Time payloads use JSON scalar checkpoints inside the binary envelope,
one checkpoint every 32 rows, so cost depends on key length and field count.
The reader caps each individual sidecar at 64 MiB; larger indexes fall back to
text. This caps corrupt-file allocation, not collection size. Checksums detect
accidental damage, not a hostile writer forging cache files and checksums.
[Round-4 measured sizes, latency, memory and remaining misses](../benchmarks/query-while-scanning-persist-round4.md).

## ID locator and generations

First ID use builds a compact global membership/location table. `find_by_id` also validates every payload once per checked generation. A create builds membership by scanning ID fields and validates only matching duplicate candidates. The locator stores hashes and source locations, not full IDs or rows. A possible hit is verified against the authoritative text and schema; a hash cannot prove equality. Custom codecs use partition-level locations and decode the whole candidate partition through the registered codec.

`find_by_id` and creates use this same locator. Creates check duplicates globally, including IDs outside the target partition. `ignore_identical` compares validated records, returns the stored record and writes nothing. An ID's apparent embedded timestamp is not trusted for routing: no configured invariant says it equals the row's timestamp.

Generations include file length and identity/metadata. Hosts with trustworthy identity/ctime tokens, including `FsStorageHost`, check unchanged generations through metadata without hashing; a changed token means Replaced, not an inferred append. Tokenless hosts retain checked prefix hashes and can classify append-only growth. Own appends can extend derived metadata through explicit checked append evidence. Hand edits, removals and out-of-order appends invalidate or disable affected indexes. Concurrent edits during building or verification fail explicitly. These checks do not add snapshot isolation, filesystem locking or multi-process write ownership.

## Append and transaction path

The append adapter resolves IDs, captures target generations, locates and verifies duplicate candidates, and stages only the batch and verified duplicate candidates in the engine. The engine remains responsible for validation, defaults, duplicate policy, journal rollback and change events. Existing partitions never enter its collection.

Before durable commit, the runtime checks target generations, including same-length prefix edits. The existing append planner encodes new lines, repairs an unterminated separator or truncates a torn suffix, and writes once per target file in sorted path order. `append_durable` keeps its file/directory synchronization contract.

After success, the runtime captures committed watch changes, updates derived ID metadata, silently removes staged lazy rows, unlocks, refreshes streaming watches, and dispatches deferred callbacks. On failure it rolls back bookkeeping and the engine journal; external watch changes can still be delivered without replacing the original error. A write-stage failure still quarantines the runtime. There is no cross-file batch journal: crashes can leave a durable prefix of files. Synced text appends are not the same power-loss contract as SQLite NORMAL WAL.

## Watches and reload

A streaming watch owns its delivered result, a serialized equality baseline and covered file generations. It does not pin or retain covered rows. Own commits and external edits re-evaluate through the scanner; subscriptions preserve existing debounce, initial delivery and last-known-good delivered results after invalid edits. Failed generations are retried when they change. Dropping the last watch releases the subscription's result owner; inactive watch entries and baselines are pruned by subsequent runtime/poller work.

The lazy poller lists files and checks watch-covered generations outside the runtime lock. It does not recursively hash all lazy history. `lazy_watch_interval` and explicit `reload` remain available. Runtime `read(|db| ...)` is for eager engine collections, not lazy row access; a prior runtime query no longer populates the engine for a subsequent `read`.

## Changed guarantees

The 13 round-1 changes below now apply to **every lazy collection caller**. Eager behavior is unchanged. Items 12 and 13 were approved by the parent during integration after reproducing the cache-dependent differences. Item 11 was corrected against the implementation and approved by the parent. The round-2 additions below were approved separately.

1. Own creates appear in natural order (partition path, then file order) immediately under streaming; Resident put them at the end until the next reload. Explicitly sorted queries are unchanged.
2. `create_many` with generated IDs resolves every ID before validating; on a failed batch a stateful generator may have advanced past the first invalid record. Generated IDs were never guaranteed gap-free.
3. A create with a new ID does not read or validate other rows of its target partition; an invalid existing row no longer blocks it, but every read that scans the row still fails with the same error.
4. Schema-check and query callbacks may run in a different order and number of times (interleaved with filtering, or again when an error is reported). Results and the first reported error are unchanged. Callbacks must be side-effect-free predicates.
5. Duplicate IDs across partitions are now checked globally on create (previously only loaded/routed partitions). Cross-partition duplicates in files can be detected earlier (at ID-locator build).
6. Stats: resident/pinned/cache counts are 0; `candidate_rows` counts validated scan rows; `index_used` reports positional seeking.
7. Concurrent external edits during index building or candidate verification fail with an explicit `source-changed`/`streaming-source-changed` OperationError; no snapshot isolation is added.
8. Commit-time conflict detection now also catches same-length prefix edits.
9. Lazy sources with a custom JSONL codec read and verify one whole partition at a time through the codec (transient memory: one partition), with no positional seeks.
10. A streaming watch holds its delivered result, a serialized equality baseline and file generations, not the covered rows.
11. The first find_by_id on a lazy collection validates every row once per file generation. Round 2 fuses this validation with locator construction; complete first-lookup timing is in the round-2 read report. Celeron latency remains unmeasured. A create's first duplicate check scans only ID fields and validates only matching candidate rows (see #3).
12. Last-known-good after an invalid external edit is kept only for lazy partitions a live watch covers. Other reads see the current file: an invalid edit makes them fail with the validation error, as Resident already did whenever the partition was not cached, and `reload()` reports errors only for watched partitions.
13. Under FullScanPolicy::Error, find_by_id on a lazy collection is always refused (lazy-full-scan), except for records created earlier in the same mutation. Resident allowed it when an earlier filtered query or watch had happened to load the record; that history-dependent exception is gone. Use FullScanPolicy::Allow (find_by_id is then served by the ID locator) or a filtered query on the partition field.

### Approved round-2 additions

First-use range reads validate a full file while building checkpoints. A later indexed read may skip invalid rows outside the queried range. This follows section 5's rule that only rows actually scanned require validation; it does not weaken row validation or add snapshot isolation. The additive `BoundedQueryStats::candidate_rows` field exposes examined-row counts as described above.

`release_streaming_indexes()` releases ID/time metadata, validated generations
and append proofs, not codec context or allocator-held RSS. Rebuilding adds
latency. `FileStat::change_id = Some` requires a token change on every content
edit, append, truncation or replacement; hosts that cannot guarantee this return
None. Checked own-append prefix proof remains required.

### Approved round-3 host additions

`StorageHost::list_directory_with_stat` and `SourceGeneration::observe_stat`
share directory observations without a second stat per ordinary file. Fs uses
one directory pass and the same content-token rules as `stat`; symlinks keep
`stat`'s follow-link behavior. Sibling recovery artifacts trigger recovery and
fresh metadata only for affected paths. The default lists then stats through
the host. Observations are not a snapshot. Trusted listed tokens require the
consumer's fresh post-scan check; tokenless observations hash and reject changed
metadata before returning.

`DurableStorageHost::append_durable_with_identity` safely defaults to no evidence.
Fs supplies `AppendIdentity { before, after, preserved_prefix_hash }` only after
reading the kept prefix and verifying the exact suffix through the append's
open descriptor after sync, with unchanged metadata across that read-back. The
runtime compares the hash with the pre-append baseline and freshly checks the
accepted path generation before extending the locator and `AppendProof`. Torn
baselines and missing/failed evidence retain the old proof. No metadata pair
alone authorizes a shortcut, and the prefix is still read once. There is no
exclusivity claim: another writer can edit after the final check and before
publication; the next operation checks cached generations again. Durability,
quarantine, duplicate equality/error rules and the 13 guarantees above do not
change. The [round-3 write report](../benchmarks/query-while-scanning-write-round3.md)
records the measurements and every remaining append miss.

### Round-5 append evidence limit

The requested no-prefix-read shortcut is **not implemented**. A trusted token
and length equal to the generation recorded after the previous own append can
rule out an intervening edit only up to the new append descriptor's `before`
observation. They cannot prove preservation across the new write. An external
same-length prefix edit after that observation and before the post-sync
read-back changes the token, but our own suffix writes also change it. The final
token does not identify which bytes changed. Even a suffix read-back plus an
unchanged token across that read-back can bless the edited prefix. The
`prefix_edit_during_durable_append_is_not_blessed_by_the_postcommit_token`
AppendSync regression covers that window. A saved finished hash is not evidence
that the current prefix still has that hash.

Fs therefore still reads and hashes the kept prefix after every durable append,
compares it with the checked pre-append baseline, verifies the exact suffix and
checks the path generation before publishing derived coverage. Reusing the
verified suffix bytes for locator bookkeeping removes a second suffix open/read;
it does not remove that final fresh generation check. Missing or rejected append
evidence keeps the canonical text proof and suffix read.

One runtime must own writable paths. Checks do not enforce that rule. An external
edit after the final generation check and before metadata publication remains
possible; the next operation freshly checks the generation. The proposed shortcut
would widen that residual window to the write itself, so the single-writer rule
alone does not justify it while retaining existing edit regressions. Unblocking
it requires OS-enforced exclusive write ownership that every writer honours, or
filesystem per-range change information. Neither is approved or added here.

Append baseline construction now visits bounded chunks through one Fs descriptor
and retains only the conflict tails, resumable hash and final physical line.
Only a torn file needs a second bounded pass to count physical lines for its
diagnostic. That pass counts only the originally covered bytes and checks length,
hash and metadata against the captured baseline; changed bytes fail closed. It
still reads and hashes healthy target bytes once on first preparation; a finished saved
hash cannot resume `DefaultHasher`. The additive `StorageHost::visit_bytes`
default preserves `read_bytes` semantics and allocation. Load-only `ReadSnapshot`
keeps that default to preserve captured bytes; runtime mutation preparation uses
the durable host directly. No durability, duplicate or error guarantee changes.

Item 3 describes validation, not zero I/O: append preparation can read target bytes for fingerprints/torn-tail handling. Custom codecs retain whole-partition validation. Item 12 preserves watch deliveries, not a hidden copy of every previously read file. A scan detects duplicates across its visited scope; there is no outside-scope resident cache to add historical rows to that scope. Global create checks use the locator.

## Measured costs, not SQLite qualification

The historical round-1 [index measurements](../../crates/proseql-storage/src/index/MEASUREMENTS.md) are single warm-text trials on aka with scalar `x86-64-v2` builds and synthetic data. Round 2's current timings and allocation costs are in the [read report](../benchmarks/query-while-scanning-perf-read.md). They do not establish cold-cache, RSS or SQLite targets.

| Operation | Measured cost | Limit |
|---|---:|---|
| ID locator, 656,640 rows | 360.200 ms; 15,762,680 resident structure bytes (24.005 B/row) | Storage-only build; not native schema validation |
| Sparse time index, one 20,804,378 B month | 89.462 ms; 13,217 structure bytes | Stride 1,024; first-use cost |
| Storage candidate lookup and verification | 6.499 µs mean, 1,000 warm hits | Excludes native locking and generation/schema work |
| Native first-use payload validation | 1,807.381 ms | Full schema, callbacks, partition and generation checks |
| Complete first native ID lookup | 2,157.654 ms | Includes locator build and validation |
| Later native ID lookups | 114.311 µs mean, 1,000 hits | Includes generation checks |
| Changed-month prefix proof | 10.545 ms | Text must be checked; no trusted append token |
| External one-row append refresh | 22.556 ms | One changed month |
| 256 locator append calls, four rows each | 0.614 ms | Metadata only, excludes writes and full append latency |

The append delta retains an unsorted bounded suffix, then merges it at 4,096 entries. It avoids sorting the entire base table for each touched shard. Its measured 256-shard structure grows from 15,885,440 to 16,028,544 B. First ID use retains about 15 MiB even after results drop; that can miss the strict post-query return-to-unindexed-idle target. Round 4 adds checked disposable sidecars; the historical measurements in this table predate them. Compact entries could reduce memory, not validation I/O.

The [formats evidence](../../packages/engine/benchmarks/blob-scan.json) measured 100 MiB framing with at most 65,536 host chunk bytes, 66,559 framer capacity bytes and a 197,631 B simultaneous-buffer upper bound. This is buffer capacity, not whole-process memory. The framer bound grows with the longest line.

The WASM chunk scanner keeps WASM memory flat (1.25 → 1.38 MB for 100 MiB), but per-row owned JS bytes raise the JS heap (13.5 → 58.5 MB sampled; 7.6 MB after GC). Follow-up: keep rows inside WASM. This is raw framing evidence, not lazy browser query execution. Existing browser database collections remain resident.

The committed [acceptance provenance](../../bench/acceptance/results/provenance.md) measures the skeleton where Streaming fell back to Resident, not this implementation: 312 successful trials, 12 SIGKILL, 36 skipped repetitions. Do not relabel those numbers as streaming results. The Verify stage adds the new SQLite tables. This integration stage runs no benchmarks and changes no target. Absolute Celeron timings, real Logbook open ≤1 s and equal-power-loss-durability comparison remain unmeasured.

## Residency-dependent APIs

`NativeRuntime::read` exposes the engine, which contains eager records and no durable lazy rows. Mutation-time ID lookup sees staged creates; it does not hydrate partitions. A `query_bounded { limit: 0 }` probe does not load anything into that engine. `NativeMutation` reads must use its streaming-aware `find_by_id`, not assume earlier operations installed lazy rows. The public restricted mutation view remains available; no raw engine access is added.

A caller must consume the scanner's returned rows, request required fields with `select`, use `aggregate_grouped_bounded`, or use `find_by_id` under `FullScanPolicy::Allow`. These replacements can allocate owned output where Resident allowed borrowing a cached row; that is an explicit adoption cost. All lazy callers must make that trade-off; selecting Resident no longer restores borrowing or hydration.

## Logbook adoption

Existing option literals still compile, including explicit
`execution_model: ExecutionModel::Streaming`, with deprecation warnings. No
selector is needed now. Logbook completed the replacements below on its scratch
adoption branch; its two lazy sources retain FullScanPolicy::Error. A dependency
pin for an unported application is not enough: migrate residency-dependent reads
first. No partition layout change is required by this cutover.

| Call site | Adoption and cost |
|---|---|
| `query_bounded` / `query_bounded_with_stats` | Same global page semantics. Consume returned rows; do not use a query to warm an engine cache for `read`. Resident/pinned/retained-limit stats are zero. |
| `aggregate_grouped_bounded` | Keep grouping in the runtime; individual f64 additions preserve order. Group cardinality and reordered matching-row buffers still cost memory. |
| `find_by_id` | First use validates all rows and builds membership. Allow policy uses the locator; Error policy always refuses except staged creates. Use a partition-filtered query instead. |
| `mutate` / `create_many` | Same durability and rollback APIs. Global duplicate checks pay first-ID-use cost; new batches do not load all target partitions. IDs remain gap-tolerant. |
| `watch*` | No cache tuning or pins. Budget for delivered results and their serialized comparison baselines. |

### Historical adoption audit at Logbook `5dbb01551ecc9ff9530e9e193e60a48daedd025c`

The paths below are relative to `crates/logbook-core/src/`. This historical table explains the pre-adoption blocker; the scratch branch replaced these lazy call sites. Both lazy collections (`raw`, `samples`) configure `FullScanPolicy::Error`. No literal `find_by_id("raw", ...)` or `find_by_id("samples", ...)` was found. The generic `storage.rs::put` helper calls ID lookup and must remain restricted to eager collections or adopt a filtered lookup. Current specialized raw/sample writes use other paths.

| Call site | Residency dependency / streaming replacement |
|---|---|
| `storage.rs:280` `load_sample_month` | Zero-limit probe used to load a month. Replace downstream use with returned filtered rows; remove the warm-up probe. |
| `storage.rs:443` query hydration | Queries IDs, then borrows rows from `db.collection(collection)`. Request all needed fields in `query_bounded` (or `select`) and hydrate returned values. This is a core wrong-results blocker. |
| `storage/latest.rs:114–163` `collect` | Zero-limit sample probe then engine enumeration. Query each known month with the fields the latest fold needs; fold returned rows or use `aggregate_grouped_bounded` where semantics permit it. |
| `storage.rs:857–880` raw heads | Borrows resident raw rows after a shard query. Query the shard/key scope with `select` for `rawKey`, `receivedAt`, `id`, then fold heads from returned rows. |
| `storage.rs:957–970` linked raw IDs | Loads a sample month then probes both collections inside `read`. Keep eager readings access; fetch sample IDs/raw links with a partition-filtered `query_bounded`. |
| `storage.rs:1039–1085` duplicate and selector modes | Borrows samples after `load_sample_month`. Query the month's candidate IDs and selector fields with `select`, preserving cross-collection duplicate checks. ID-locator use requires changing to Allow; do not bypass Error. |
| `migrate.rs:543–564` conversion resume | Zero-limit month probe, then samples engine ID probes. Query the month's batch IDs and required comparison fields. Alternatively use `find_by_id` with Allow, accounting for first-use validation. |
| `storage.rs:347` considered-row instrumentation | Reads the resident collection length. Use `NativeQueryStats.candidate_rows` for scan diagnostics, or a filtered count aggregate for logical row counts. These are different measures. |
| `storage.rs:777` `resident_sample_count` | Streaming correctly reports zero residency. Keep as residency telemetry, or replace a desired logical count with partition-filtered aggregates; do not treat zero as an empty dataset. |
| `storage.rs:242` `repair_latest` | The closure reads eager `supersededRaw`; candidates already come from queries. This access can stay eager, but its query helper must use returned rows after the hydration fix. |
| `storage/superseded.rs:22/73/210` | These closures enumerate eager `supersededRaw`, not lazy raw/sample records. Keep it eager or replace enumeration with ordinary query/`select` if refactoring the consumer. No lazy exception is needed. |
| `storage.rs:691/801/1009`; `storage/latest.rs:33/145/198` | Audited reads use eager collections or membership. They can stay on the eager engine; preserve that configuration explicitly. |
| `storage.rs:2084/2109` tests | Assert sample engine residency after writes. The adoption branch asserts durable/query results and zero residency instead. |

`storage/superseded.rs:164` only checks runtime availability. It does not enumerate lazy rows. The bounded-read query gate serializes these consumer phases but cannot recreate missing residency under Streaming.

A partition layout change is not required. Month files permit time pruning. Raw's 256 hash shards make every time range fan out to every shard. In the [stage-0 proxy report](../benchmarks/sqlite-baseline.md), a one-hour raw scan cost 372.63 / 32.35 ms cold / warm versus 1.40 / 0.45 ms for month-partitioned samples; a denser raw index still cost 217.79 / 5.29 ms. These are yari spike measurements, not current aka or Celeron claims. Per-metric/time partitions could prune metric and time workloads but add files, routing/configuration work and migration cost; metric-only partitions do not by themselves solve long-history time ranges. Measure the consumer workload before changing layout.

## Historical round-1 integration verification

The final Resident-default source passed `nix run --builders '' path:.#release-check`
on aka. The gate includes the full suites and the real browser/packed-package paths.

| Check | Verified result |
|---|---|
| Rust workspace | 1,284 passed, 0 failed, 7 ignored |
| Full TypeScript | 4,098 passed, 0 failed, 2 skipped |
| Effect parity | 2,163 passed, 0 failed, 2 skipped; 16/16 examples |
| Typecheck, lint, Rust format/check/clippy, WASM target | Passed |
| Packed packages and browser smoke | Passed |
| Browser budgets | Three cold trials passed; gzip 598,339 / 600,000 B |
| Cutover regressions | 4 passed; both model behaviors are explicit |

Outputs are under `/home/simonwjackson/work/qws-logs` on aka, principally
`integrator-release-check-final.log`, `integrator-release-final-summary.txt` and
`integrator-release-final-browser-evidence.json`. Focused native checks also pass
with `RUSTFLAGS='-C target-cpu=x86-64-v2'` and all-feature clippy. No SQLite/native acceptance benchmark,
consumer override, push or deployment was run by integration. The 1,661 B gzip
headroom is small; future WASM changes must keep the gate. That run predates the round-2 adoption and cutover; it is not current-source verification.

## Measured on aka

Verify source: `267427c69c819a7612e50b596be12409019e0ba5`, run `20261025T102804Z`. This section supersedes the historical skeleton-only acceptance paragraph above; earlier sections are preserved unchanged. At that historical source Streaming was opt-in and Resident was the default. **Streaming: 12 measured target rows pass, 19 miss.** No target was lowered.

aka is x86_64 (Ryzen 5 7600X), compiled with `RUSTFLAGS='-C target-cpu=x86-64-v2'` at the Celeron's instruction level, but a much faster CPU. These are synthetic same-machine SQLite NORMAL/WAL comparisons, not absolute comparisons with the yari/aarch64 Stage 0 report or Celeron qualification.

Cold / warm; wall medians of three rotating trials, maximum timing-trial peak, median one-second RSS. Verdicts are Resident / Streaming. Point ≤2× SQLite; hour ≤1.5×; month/ten/append ≤1×; read peak ≤2×; open/idle ≤SQLite +20 MiB. Retained rows divide the delta above fresh idle by max(SQLite retained delta, 1 MiB), not raw SQLite RSS. All operations used 1 GiB/no-swap scopes, nice 10 and timeouts; no consumer malloc_trim.

| #12 workload | Shape | SQLite | Resident | Streaming | Streaming / SQLite | Resident / Streaming |
|---|---|---:|---:|---:|---:|---|
| point wall ms | samples | 1.600 / 0.032 | killed / killed | 2550.776 / 0.249 | 1593.910× / 7.829× | miss / miss |
| hour wall ms | samples | 1.598 / 0.365 | 557.187 / 0.464 | 105.415 / 1.709 | 65.948× / 4.684× | miss / miss |
| month wall ms | samples | 32.871 / 19.805 | 1059.388 / 616.783 | 294.275 / 91.962 | 8.952× / 4.643× | miss / miss |
| ten wall ms | samples | 406.403 / 292.580 | 5197.456 / 4883.010 | 1779.972 / 835.600 | 4.380× / 2.856× | miss / miss |
| append wall ms | samples | 10.690 / 7.475 | 518.536 / 500.945 | 509.959 / 462.410 | 47.702× / 61.862× | miss / miss |
| open RSS MiB | samples | 6.074 / 6.074 | 7.230 / 7.297 | 7.230 / 7.297 | 1.190× / 1.201× | pass / pass |
| idle RSS MiB | samples | 6.074 / 6.074 | 7.230 / 7.230 | 7.230 / 7.230 | 1.190× / 1.190× | pass / pass |
| point peak MiB | samples | 6.305 / 6.305 | killed / killed | 22.578 / 22.578 | 3.581× / 3.581× | miss / miss |
| point retained MiB at 1 s | samples | 0.230 / 0.230 | killed / killed | 15.410 / 15.410 | 15.410× / 15.410× tolerance | miss / miss |
| hour peak MiB | samples | 6.562 / 6.578 | 206.055 / 198.973 | 7.836 / 7.840 | 1.194× / 1.192× | miss / pass |
| hour retained MiB at 1 s | samples | 0.488 / 0.504 | 191.805 / 191.805 | 0.668 / 0.672 | 0.668× / 0.672× tolerance | miss / pass |
| month peak MiB | samples | 10.145 / 10.262 | 211.645 / 386.172 | 8.613 / 8.855 | 0.849× / 0.863× | miss / pass |
| month retained MiB at 1 s | samples | 2.230 / 4.188 | 204.477 / 299.910 | 0.516 / 1.688 | 0.231× / 0.403× tolerance | miss / pass |
| ten peak MiB | samples | 10.145 / 10.344 | 279.688 / 476.469 | 17.738 / 18.395 | 1.749× / 1.778× | miss / pass |
| ten retained MiB at 1 s | samples | 2.309 / 4.270 | 272.520 / 409.711 | 1.188 / 11.227 | 0.514× / 2.629× tolerance | miss / miss |
| point wall ms | raw | 1.296 / 0.034 | killed / killed | 2879.890 / 3.254 | 2221.696× / 96.639× | miss / miss |
| hour wall ms | raw | 1.854 / 0.296 | 3257.378 / 3134.927 | 1442.702 / 314.995 | 778.212× / 1063.554× | miss / miss |
| month wall ms | raw | 34.904 / 19.507 | 3282.601 / 3167.672 | 1682.301 / 565.154 | 48.197× / 28.971× | miss / miss |
| ten wall ms | raw | 397.536 / 285.081 | 3443.967 / 3313.977 | 2014.165 / 894.623 | 5.067× / 3.138× | miss / miss |
| append wall ms | raw | 11.156 / 7.898 | killed / killed | 862.254 / 739.943 | 77.293× / 93.689× | miss / miss |
| open RSS MiB | raw | 6.074 / 6.074 | 7.316 / 7.383 | 7.316 / 7.383 | 1.205× / 1.215× | pass / pass |
| idle RSS MiB | raw | 6.074 / 6.074 | 7.316 / 7.316 | 7.316 / 7.316 | 1.205× / 1.205× | pass / pass |
| point peak MiB | raw | 6.305 / 6.305 | killed / killed | 22.836 / 22.840 | 3.622× / 3.623× | miss / miss |
| point retained MiB at 1 s | raw | 0.230 / 0.230 | killed / killed | 15.582 / 15.586 | 15.582× / 15.586× tolerance | miss / miss |
| hour peak MiB | raw | 6.566 / 6.574 | 92.488 / 110.566 | 11.988 / 12.387 | 1.826× / 1.884× | miss / pass |
| hour retained MiB at 1 s | raw | 0.492 / 0.500 | 68.871 / 103.309 | 1.082 / 5.133 | 1.082× / 5.133× tolerance | miss / miss |
| month peak MiB | raw | 10.145 / 10.262 | 92.234 / 110.293 | 14.965 / 15.410 | 1.475× / 1.502× | miss / pass |
| month retained MiB at 1 s | raw | 2.230 / 4.188 | 68.531 / 103.035 | 0.777 / 8.156 | 0.349× / 1.948× tolerance | miss / miss |
| ten peak MiB | raw | 10.145 / 10.344 | 92.566 / 110.578 | 17.988 / 18.652 | 1.773× / 1.803× | miss / pass |
| ten retained MiB at 1 s | raw | 2.309 / 4.270 | 68.863 / 102.410 | 1.418 / 11.398 | 0.614× / 2.670× tolerance | miss / miss |

Equal-row-count peak RSS, 16→256 raw shards. Ratios are 256/16, cold / warm; limit ≤1 with no invented tolerance. This is a controlled observed proxy, not a scaling proof.

| Backend | 16-shard peak MiB C/W | 256-shard peak MiB C/W | Growth C/W | Status |
|---|---:|---:|---:|---|
| sqlite | 10.145 / 10.344 | 10.145 / 10.344 | 1.000000× / 1.000000× | pass |
| resident | 211.219 / 322.246 | 92.566 / 110.578 | 0.438249× / 0.343148× | pass |
| streaming | 17.738 / 18.348 | 17.988 / 18.652 | 1.014094× / 1.016606× | miss |

Open ≤1 s on Logbook's real shape, absolute Celeron times and equal-durability qualification remain **unmeasured**: no rakku access by user rule; native synced text and NORMAL WAL also differ in power-loss guarantees.

See the [aka report](../benchmarks/query-while-scanning-aka.md) for every miss's observed floor, inferred cause and cheapest next step, counting-allocator evidence, load policy and limits. [Acceptance provenance](../../bench/acceptance/results/provenance.md) records the exact source, checks and cleanup. The same-row-count shard sweep is not a constant-memory proof. No engine code, consumer pin or default changed in Verify.

## Round-2 cutover removal (#19 / #21)

The native lazy resident path is deleted, not hidden behind the deprecated switch.
Eager collections still use the engine. Shared engine load/unload primitives stay
because streaming mutations stage verified duplicate candidates with them.

| File | Removed code (approximate net lines) |
|---|---|
| `proseql-native/src/lazy.rs` | 870: `Resident`, `BoundedLoad`, `Pin`, clock/pending/pin maps, `pinned`, `watch_covers`, `LoadedPartition`, `read_partition`, `lazy_position`, `lazy_ensure`, `lazy_ensure_impl`, `lazy_touch`, `lazy_visit`, `lazy_scope_is_resident`, `lazy_read_stats`, `lazy_ensure_for_record`, `lazy_trim`, `lazy_evict`, `lazy_pin`, `lazy_unpin`, `lazy_refresh`, `lazy_reload_partition`, `lazy_resident_count`, resident fingerprints |
| `proseql-native/src/lib.rs` | 350: `prepare_creates`, mutation/runtime full-scope ID loading, lazy branches of `with_scope` / `watch_scoped`, `PinGuard`, pending-unpin queue/worker, `drain_unpins`, `release_unpins`, `sources_trim`, resident `refresh_lazy_locked` branch |
| `proseql-native/src/bounded.rs` | 270: `CachedRead`, `ReadScope`, `bounded_fold`, lazy resident read cache, resident fold/visit accumulators |
| `proseql-engine/src/{resident.rs,collection.rs,reactive/mod.rs,scan/mod.rs}` | Unused `validate_resident_records`, `replace_resident_records` (Database and Collection), `retain_reactive_snapshot_records`, `retain_collection_snapshot_records`, and the rollout-only `unimplemented_seam` helper |
| `sources.rs`, `streaming.rs`, `locate.rs`, `write/{append,tx,watch}.rs` | Per-collection execution selector, Resident target checks and execution-model branches; refresh uses streaming manifest/watch invalidation only |

The historical benchmark `resident` backend now refuses to run against this
source. Use its pinned historical source for baseline measurements. It must not
silently measure the deprecated Resident alias as though the old path remained.

### Test assertion ledger

Differential tests now compare a lazy runtime with an eager runtime over identical
files. Writes get independent copies. Invalid-file comparisons account for eager
validation at open versus lazy validation at first use. Existing error tests
already excluded copy-dependent SourceConfig paths; the fixture now also applies
that normalization to eager open errors. Values and all other error payloads
remain exact. No result fixture or page/group/cursor assertion was dropped.

The following Resident-internal expectations were replaced. Repeated assertions
within one test are listed together; their result assertions remain.

| Test file / original test | Former internal assertions | Replacement |
|---|---|---|
| `lazy_partitions_runtime`: `filtered_queries_match_eager_with_sorts_and_pages` | resident count ≥ min(selected, 2) | resident count 0 |
| `unfiltered_queries_and_aggregates_match_eager_then_return_to_the_bound` | resident count 2; loaded length 2 in loop and after aggregates | zero residency; same rows/groups/sums |
| `find_by_id_loads_everything_under_allow_and_returns_to_the_bound` | loaded length 1 | empty loaded; same hit/miss |
| `eviction_drops_the_least_recently_used_partition_and_reloads_it_identically` | loaded Jan/Feb, Jan/Mar, Mar/Apr; engine length 22; candidate count below resident length | empty status/engine; identical reread/eager results; physical candidate count |
| `watches_pin_the_partitions_their_filter_touches` | Jan remains loaded; loaded length 2; one Jan pin; Feb loaded after drop | empty loaded/pinned throughout; initial/update delivery assertions kept |
| `appends_into_unloaded_evicted_and_new_partitions` | loaded Jan, Feb, Mar, Sep and post-batch length 1 | no residency; exact append bytes, duplicate refusals and reopened rows kept |
| `external_files_are_listed_and_loaded_partitions_refresh_while_lazy` | June loaded; March ID visible in raw engine | no residency; same March ID checked in returned rows |
| `unchanged_reload_keeps_loaded_records_and_identical_retries_write_nothing` | engine length 11 after reload | length 0; same 11 returned rows; byte-identical retries |
| `a_watched_new_partition_that_fails_to_load_is_retried_after_it_is_corrected` | corrected June pinned | no pins; same corrected watch delivery |
| `full_scan_error_applies_to_empty_and_fully_loaded_collections` | every queried month loaded | no loaded months; scan refusals kept |
| `a_conflicting_cold_append_rolls_back_and_keeps_the_loaded_partition` | Jan loaded after failed batch | empty status; unchanged bytes and exact old row retained through query |
| `bounded_queries_keep_global_natural_sort_page_cursor_search_and_selection_semantics` | retained limit equals configured bound | retained limit 0; all result comparisons kept |
| `bounded_load_errors_pins_and_duplicates_across_evicted_partitions_are_not_hidden` | one pin/two resident files before drop; one resident file after; failed-load cache membership | zero counts; watch LKG delivery remains unchanged; current-file reads fail |
| `bounded_windows_read_each_file_at_most_once_and_warm_hits_keep_lru_and_indexes` | cached month avoids I/O; each incoming file decoded once; Mar LRU; warm Nov/Jan membership; resident ordered index | every selected file opens; no membership; scan/index stats replace resident-index stats |
| `bounded_id_checks_include_the_initial_cache_outside_the_query_scope` | Nov/Dec remain resident and participate outside scope | no cache; duplicate error kept for full visited scope and global create check |
| `bounded_live_runtime` | retained payloads = bound × rows (three sites), one pin, N-dependent peak bound | zero retained payloads/pins; stronger bound-independent peak; all query/count/group/error assertions kept |
| `streaming_cutover` | default Resident; returned rows can be borrowed from engine; zero-limit probe hydrates; Resident Error-policy cached ID hit | default Streaming; eager/lazy result equality and empty lazy engine; both compatibility variants refuse cached-hit exception |
| `schema_checks_runtime`: source/lazy reload test | Unwatched lazy reload fails and engine lookup returns LKG | Live lazy watch preserves the same allowed row after failed reload; current-file ID lookup rejects the invalid predicate. Eager LKG assertions unchanged (#12). |
| `streaming_parity` | default Resident | default Streaming |
| `proseql-engine/tests/resident_conformance`: replacement validation test | Calls to the removed replacement/eviction helper | Stage/unload through the primitives still used by streaming writes; every invalid/duplicate/state/index result assertion kept |
| `streaming_candidate_stats` | Resident selected/cached scope counts | eager collection counts versus lazy validated scan counts |
| `write/append.rs` unit test; `write/watch.rs` ignored measurement | private `lazy.resident.is_empty()` | public-shaped status is empty |

Approved behavioral differences are also explicit: Error-policy cached ID hits
are now refused (#13); LKG belongs to delivered watches, not subsequent current-file
reads (#12); global create checks read membership outside the target (#5); scan
stats replace resident indexes (#6 and round 2). The old no-I/O assertion for a
new target is replaced by an assertion that no read addresses that nonexistent
target before its creation; global locator/proof I/O remains permitted. Failed
watch generations retry after an edit, not by rereading unchanged bad text.

### Remaining #19 items

The removed-path requirement is implemented. The tested consumer pin still needs
to be adopted in the real consumers; no manifest, real repository or deployment
is changed here. SQLite latency/retained-memory misses remain in #20 and the
round-2 read/write reports. Real Logbook shape, open ≤1 s and Celeron/rakku
qualification remain unmeasured and excluded by the machine rule. No target was
lowered. Publication/push remains a separate user decision.


## Round-2 cutover verification

Tested runtime SHA: `56e994370d6919ef4e3effa735381ab4b17fe0f0`, including
`ba90773` (idempotent checked append publication and the single tokenless proof
hash). All checks below ran on aka. The final complete release-check omitted
native x86-64-v2 flags so they could not reach the WASM build.

| Check | Verified result |
|---|---|
| Rust workspace | 1,316 passed / 0 failed / 10 ignored |
| Full TypeScript | 4,098 passed / 0 failed / 2 skipped |
| Effect parity | 2,163 passed / 0 failed / 2 skipped; 16/16 examples |
| Typecheck, lint, Rust format/check/clippy, WASM | Passed |
| Packed packages and browser smoke | Passed |
| Browser budget | 3/3 cold trials pass; gzip 598,572 / 600,000 B |
| Coach unedited (`0671989`) | Build passed; 27 passed / 0 failed |
| Logbook streaming-adoption (`ad70bd9`) | Build passed; 221 passed / 0 failed / 2 ignored |

The consumer runs used cutover `1c4f79f`. The parent accepted those results for
the later localized locator/append fix; the complete final gate includes that
fix. The read-only consumer sources were not edited. Git hashes of all tracked
files matched the aka source checkout after the final gate. Only documentation
changes follow the tested SHA.

Full log: `/home/simonwjackson/work/qws-logs/round2-cutover-release-check.log`.
[Cutover report and initial failed-invocation explanation](../../bench/acceptance/results/cutover-round2.md).
The initial full-gate attempt stopped before suites because a native CPU flag
reached WASM. Its affected build retry and the final complete run passed without
that flag. Browser gzip has only 1,428 B headroom. Performance, real-data and
consumer pin/deployment limits above remain unchanged. No push or publication.

## Measured on aka — round 2

Integrated runtime: `bd22cf4`. Measured harness source:
`26449c543f51d0f8fbba900ef65749fabf51820f`. Lazy collections now always
stream; the deprecated Resident selector does not restore the deleted path.
The harness rejects that historical backend and omits its column.

**10 default #12 target rows pass; 21 miss**, compared with round 1's 12/19.
Latency improves, but no default wall-time row passes in both cold and warm
modes. Warm sample-hour latency passes. Dense raw checkpoints and retained RSS
cause additional memory misses. No target is lowered. The explicit point-release
diagnostics are additional: samples pass; raw misses by 0.020 MiB.

Cold / warm milliseconds; medians of three rotating timing trials. Round 1 is
Streaming from the historical aka report. These are synthetic same-machine
comparisons, not absolute Celeron qualification.

| Workload | Shape | SQLite round 2 | Round 1 Streaming | Round 2 Streaming | Round 2 / SQLite |
|---|---|---:|---:|---:|---:|
| Point | samples | 1.135 / 0.029 | 2550.776 / 0.249 | 650.096 / 0.248 | 572.941× / 8.465× |
| Hour | samples | 1.658 / 0.410 | 105.415 / 1.709 | 52.752 / 0.342 | 31.823× / 0.835× |
| Month by day | samples | 33.570 / 19.544 | 294.275 / 91.962 | 105.703 / 46.760 | 3.149× / 2.393× |
| Ten months by day/metric | samples | 413.099 / 287.973 | 1779.972 / 835.600 | 530.105 / 432.924 | 1.283× / 1.503× |
| Append 1,000 | samples | 10.205 / 7.803 | 509.959 / 462.410 | 370.443 / 316.396 | 36.301× / 40.546× |
| Point | raw | 1.229 / 0.029 | 2879.890 / 3.254 | 835.128 / 3.055 | 679.563× / 106.616× |
| Hour | raw | 2.245 / 0.297 | 1442.702 / 314.995 | 616.902 / 10.361 | 274.828× / 34.925× |
| Month by day | raw | 31.621 / 19.303 | 1682.301 / 565.154 | 612.672 / 54.556 | 19.375× / 2.826× |
| Ten months by day/metric | raw | 412.871 / 284.169 | 2014.165 / 894.623 | 659.825 / 476.976 | 1.598× / 1.678× |
| Append 1,000 | raw | 11.737 / 8.266 | 862.254 / 739.943 | 771.813 / 632.619 | 65.762× / 76.537× |

The complete [round-2 report](../benchmarks/query-while-scanning-aka-round2.md)
contains every target's SQLite/round-1/round-2 values, ratios, verdicts and every
miss's observed floor, inferred reason and cheapest next step. Floors are best
observed trials, not proofs of a text-only physical limit.

Point peak falls from 22.578/22.840 MiB to 17.809/18.113 MiB for samples/raw
(warm maxima), but still exceeds twice SQLite's 6.227 MiB. Default point
retention is 10.777/11.043 MiB above idle. One second after explicit
`release_streaming_indexes()`, it is 0.754/1.020 MiB, without trim. Release does
not guarantee OS reclamation, and the next lookup rebuilds metadata. Repeated
release/rebuild cycles can retain more allocator pages, as the write report
shows. Sample-hour retention also narrowly misses at 1.016 MiB; the 1 MiB
tolerance remains unchanged. Raw cold-hour peak is 16.371 MiB versus SQLite's
6.488 MiB, a new peak miss. The strict 16→256-shard growth proxy also misses:
1.099× / 1.067×. SQLite's own cold proxy varies by 1.012×; no noise tolerance is
invented for the native target.

The ordered sync probe primes October's last hour, appends 1,000 unique IDs at
the last October timestamp, then reads the same hour on the same runtime.
All answers contain 1,090 full rows. Native combined medians are
365.828 / 320.429 ms (samples) and 624.332 / 622.926 ms (raw), versus SQLite's
12.467 / 10.271 and 13.760 / 10.924 ms. Following-range medians alone are
3.071 / 2.967 ms and 14.700 / 14.600 ms. This is an ordered sync measurement,
not an untouched cold append or a claim about out-of-order checkpoint reuse.
The ordinary append target remains unprimed, with independent fixture copies
and global duplicate safety.

All 272 accepted trials succeed and match complete answers. All 64 mutation
trials persist exactly 1,000 new rows; all four cross-partition conflict probes
pass. Independent counting-allocator evidence covers point, ten-month aggregate
and raw append. Raw append requested live/peak is 12.452/24.318 MiB; sample ten
is 0.474/6.053 MiB; raw ten is 3.538/9.147 MiB. Requested heap is not RSS.

Every build, focused check and measurement ran on aka with native
`RUSTFLAGS='-C target-cpu=x86-64-v2'`, never WASM. aka's Ryzen 5 7600X is a far
faster CPU than the Celeron. Each measured operation/preparation used a
1 GiB/no-swap user scope, nice 10 and a timeout; the limit was never raised.
The 656,640-row shapes are synthetic: ten month files or 256 raw shards.
SQLite uses NORMAL/WAL; its temporary files stay in the bench2-owned filesystem
directory. Synced text and NORMAL WAL do not establish equal power-loss
durability. Real Logbook open ≤1 s, absolute Celeron times and equal durability
remain **unmeasured**; no rakku or yari access occurred.

The accepted block's load before was 0.959/1.331/1.361, after
0.299/0.527/0.940, with maximum one-minute load 0.959. The predeclared policy
waits for ≤1 and repeats a whole block above 2; no high-load repeat was needed.
Focused harness check/clippy/fmt, five Rust tests, four Python tests, Ruff and
shellcheck pass. No engine code changed. The parent owns full combined checks.
[Round-2 provenance and cleanup](../../bench/acceptance/results/round2-provenance.md)
and [small numeric evidence](../../bench/acceptance/results/round2.jsonl) record
the source binding and limits. No push, consumer pin change or deployment.
