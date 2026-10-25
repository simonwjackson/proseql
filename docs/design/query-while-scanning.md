# Query while scanning

Streaming is opt-in. `ExecutionModel::Resident` remains the default because unedited Logbook depends on lazy residency to hydrate query results. Set `NativeSourceRuntimeOptions::execution_model` to `ExecutionModel::Streaming` only after adapting those call sites. Text remains the source of truth. No binary index or cache is written to disk.

Stage #19's removal of the old lazy resident path is **deferred until consumers adopt Streaming**. Making Streaming the default now would silently lose rows for residency-dependent callers. The parent directed integration to retain both paths and the public switch after source inspection reproduced this incompatibility. This is a provisional cutover decision, not a claim that #19's removal acceptance is complete. The architecture below describes the opt-in Streaming path; Resident behavior is unchanged.

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

Under Streaming, `max_loaded_partitions` is retained for source compatibility but ignored. It no longer bounds anything on that path; streaming memory no longer depends on it. `lazy_partition_status` keeps its shape: `loaded` and `pinned` are always empty under Streaming. Resident still uses the configured cache bound and watch pins. Eager records and transaction-staged creates are not streaming partition residency.

## Read path

Opening lists partition names without decoding rows. Before a lazy operation, the runtime refreshes the manifest and conservatively prunes it using the existing partition-field conditions. `FullScanPolicy` is applied before indexes: an index cannot bypass a refused scan.

The storage host supplies byte ranges. The shared `LineFramer` accepts chunks, handles lines spanning chunks, tracks byte offsets and physical line numbers, and classifies valid unterminated and torn final lines. The scalar Rust executor decodes borrowed rows, validates read rows, filters, projects and folds during the scan. It materializes owned values for output or operations that need them. No lazy partition is installed in the engine collection.

Partition path and file ordinal define natural order. Shared engine candidate-order rules preserve equality unions, stable ties, first-encounter group order, cursor comparisons and `limit + 1` page flags. Aggregates add individual f64 values in canonical order, not partition partial sums. An invalid row still fails a read even when its filter or limit would discard it. Rows excluded by partition pruning or safe positional seeking were not scanned.

A sparse time index records an offset every 1,024 rows for eligible configured ordered fields. It seeks only when ordering and generation checks permit it. Unsorted data or a custom JSONL codec disables seeking. A stale index is rebuilt or the operation scans correctly; it is never authoritative data.

## ID locator and generations

First ID use builds a compact global membership/location table. `find_by_id` also validates every payload once per checked generation. A create builds membership by scanning ID fields and validates only matching duplicate candidates. The locator stores hashes and source locations, not full IDs or rows. A possible hit is verified against the authoritative text and schema; a hash cannot prove equality. Custom codecs use partition-level locations and decode the whole candidate partition through the registered codec.

`find_by_id` and creates use this same locator. Creates check duplicates globally, including IDs outside the target partition. `ignore_identical` compares validated records, returns the stored record and writes nothing. An ID's apparent embedded timestamp is not trusted for routing: no configured invariant says it equals the row's timestamp.

Generations include file length, identity/metadata and checked content-prefix evidence. Appends can extend derived metadata; hand edits, removals and out-of-order appends invalidate or disable affected indexes. Concurrent edits during building or verification fail explicitly. These checks do not add snapshot isolation, filesystem locking or multi-process write ownership.

## Append and transaction path

The append adapter resolves IDs, captures target generations, locates and verifies duplicate candidates, and stages only the batch and verified duplicate candidates in the engine. The engine remains responsible for validation, defaults, duplicate policy, journal rollback and change events. Existing partitions never enter its collection.

Before durable commit, the runtime checks target generations, including same-length prefix edits. The existing append planner encodes new lines, repairs an unterminated separator or truncates a torn suffix, and writes once per target file in sorted path order. `append_durable` keeps its file/directory synchronization contract.

After success, the runtime captures committed watch changes, updates derived ID metadata, silently removes staged lazy rows, unlocks, refreshes streaming watches, and dispatches deferred callbacks. On failure it rolls back bookkeeping and the engine journal; external watch changes can still be delivered without replacing the original error. A write-stage failure still quarantines the runtime. There is no cross-file batch journal: crashes can leave a durable prefix of files. Synced text appends are not the same power-loss contract as SQLite NORMAL WAL.

## Watches and reload

A streaming watch owns its delivered result, a serialized equality baseline and covered file generations. It does not pin or retain covered rows. Own commits and external edits re-evaluate through the scanner; subscriptions preserve existing debounce, initial delivery and last-known-good delivered results after invalid edits. Failed generations are retried when they change. Dropping the last watch releases the subscription's result owner; inactive watch entries and baselines are pruned by subsequent runtime/poller work.

The lazy poller lists files and checks watch-covered generations outside the runtime lock. It does not recursively hash all lazy history. `lazy_watch_interval` and explicit `reload` remain available. Runtime `read(|db| ...)` is for eager engine collections, not lazy row access; a prior runtime query no longer populates the engine for a subsequent `read`.

## Changed guarantees

All 13 changes below apply **only when Streaming is selected**. Resident is unchanged. Items 12 and 13 were approved by the parent during integration after reproducing the cache-dependent differences. Item 11 was corrected against the implementation and approved by the parent.

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
11. The first find_by_id on a lazy collection validates every row once per file generation (about 1.8 s for 656,640 rows on aka; slower on the Celeron, unmeasured). A create's first duplicate check builds the ID locator by scanning only ID fields (about 360 ms) and validates only matching candidate rows (see #3).
12. Last-known-good after an invalid external edit is kept only for lazy partitions a live watch covers. Other reads see the current file: an invalid edit makes them fail with the validation error, as Resident already did whenever the partition was not cached, and `reload()` reports errors only for watched partitions.
13. Under FullScanPolicy::Error, find_by_id on a lazy collection is always refused (lazy-full-scan), except for records created earlier in the same mutation. Resident allowed it when an earlier filtered query or watch had happened to load the record; that history-dependent exception is gone. Use FullScanPolicy::Allow (find_by_id is then served by the ID locator) or a filtered query on the partition field.

Item 3 describes validation, not zero I/O: append preparation can read target bytes for fingerprints/torn-tail handling. Custom codecs retain whole-partition validation. Item 12 preserves watch deliveries, not a hidden copy of every previously read file. A scan detects duplicates across its visited scope; there is no outside-scope resident cache to add historical rows to that scope. Global create checks use the locator.

## Measured costs, not SQLite qualification

The [index measurements](../../crates/proseql-storage/src/index/MEASUREMENTS.md) are single warm-text trials on aka with scalar `x86-64-v2` builds and synthetic data. They do not establish cold-cache, RSS or SQLite targets.

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

The append delta retains an unsorted bounded suffix, then merges it at 4,096 entries. It avoids sorting the entire base table for each touched shard. Its measured 256-shard structure grows from 15,885,440 to 16,028,544 B. First ID use retains about 15 MiB even after results drop; that can miss the strict post-query return-to-unindexed-idle target. A text-validated sidecar or explicit prebuild could move startup work, but neither is implemented. Compact entries could reduce memory, not validation I/O.

The [formats evidence](../../packages/engine/benchmarks/blob-scan.json) measured 100 MiB framing with at most 65,536 host chunk bytes, 66,559 framer capacity bytes and a 197,631 B simultaneous-buffer upper bound. This is buffer capacity, not whole-process memory. The framer bound grows with the longest line.

The WASM chunk scanner keeps WASM memory flat (1.25 → 1.38 MB for 100 MiB), but per-row owned JS bytes raise the JS heap (13.5 → 58.5 MB sampled; 7.6 MB after GC). Follow-up: keep rows inside WASM. This is raw framing evidence, not lazy browser query execution. Existing browser database collections remain resident.

The committed [acceptance provenance](../../bench/acceptance/results/provenance.md) measures the skeleton where Streaming fell back to Resident, not this implementation: 312 successful trials, 12 SIGKILL, 36 skipped repetitions. Do not relabel those numbers as streaming results. The Verify stage adds the new SQLite tables. This integration stage runs no benchmarks and changes no target. Absolute Celeron timings, real Logbook open ≤1 s and equal-power-loss-durability comparison remain unmeasured.

## Residency-dependent APIs

Under Streaming, `NativeRuntime::read` exposes the engine, which contains eager records and no durable lazy rows. Mutation-time ID lookup sees staged creates; it does not hydrate partitions. A `query_bounded { limit: 0 }` probe does not load anything into that engine. `NativeMutation` reads must use its streaming-aware `find_by_id`, not assume earlier operations installed lazy rows. The public restricted mutation view remains available; no raw engine access is added.

A caller must consume the scanner's returned rows, request required fields with `select`, use `aggregate_grouped_bounded`, or use `find_by_id` under `FullScanPolicy::Allow`. These replacements can allocate owned output where Resident allowed borrowing a cached row; that is an explicit adoption cost. Retaining Resident avoids a silent behavioral change while consumers make that trade-off.

## Logbook adoption

Existing configuration literals need no changes to keep Resident. Opting in requires `execution_model: ExecutionModel::Streaming` and the call-site changes below. Under Streaming, `max_loaded_partitions` is ignored; `full_scan` is not. Logbook must complete these changes before it selects Streaming. A dependency pin alone must not change its model.

| Call site | Adoption and cost |
|---|---|
| `query_bounded` / `query_bounded_with_stats` | Same global page semantics. Consume returned rows; do not use a query to warm an engine cache for `read`. Resident/pinned/retained-limit stats are zero. |
| `aggregate_grouped_bounded` | Keep grouping in the runtime; individual f64 additions preserve order. Group cardinality and reordered matching-row buffers still cost memory. |
| `find_by_id` | First use validates all rows and builds membership. Allow policy uses the locator; Error policy always refuses except staged creates. Use a partition-filtered query instead. |
| `mutate` / `create_many` | Same durability and rollback APIs. Global duplicate checks pay first-ID-use cost; new batches do not load all target partitions. IDs remain gap-tolerant. |
| `watch*` | No cache tuning or pins. Budget for delivered results and their serialized comparison baselines. |

### Audit at Logbook `5dbb01551ecc9ff9530e9e193e60a48daedd025c`

The paths below are relative to `crates/logbook-core/src/`. This is source inspection, not a consumer test result. Both lazy collections (`raw`, `samples`) configure `FullScanPolicy::Error`. No literal `find_by_id("raw", ...)` or `find_by_id("samples", ...)` was found. The generic `storage.rs::put` helper calls ID lookup and must remain restricted to eager collections or adopt a filtered lookup. Current specialized raw/sample writes use other paths.

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
| `storage.rs:2084/2109` tests | Assert sample engine residency after writes. New opt-in tests must assert durable/query results and zero residency instead; leave Resident tests intact. |

`storage/superseded.rs:164` only checks runtime availability. It does not enumerate lazy rows. The bounded-read query gate serializes these consumer phases but cannot recreate missing residency under Streaming.

A partition layout change is not required. Month files permit time pruning. Raw's 256 hash shards make every time range fan out to every shard. In the [stage-0 proxy report](../benchmarks/sqlite-baseline.md), a one-hour raw scan cost 372.63 / 32.35 ms cold / warm versus 1.40 / 0.45 ms for month-partitioned samples; a denser raw index still cost 217.79 / 5.29 ms. These are yari spike measurements, not current aka or Celeron claims. Per-metric/time partitions could prune metric and time workloads but add files, routing/configuration work and migration cost; metric-only partitions do not by themselves solve long-history time ranges. Measure the consumer workload before changing layout.

## Integration verification

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
headroom is small; future WASM changes must keep the gate. Cutover and consumer
adoption remain deferred despite these passing library checks.
