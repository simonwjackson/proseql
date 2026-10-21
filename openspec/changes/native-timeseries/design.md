# Native time-series — Design

The approved contract (2026-10-20) is binding. This design restates it in repository terms.

## Architecture

```
NativeRuntime::mutate
  └─ engine transaction (duplicate_ids policy, append_only refusals)
       └─ SourceState::plan
            ├─ append-only JSONL source  → append plan: complete "\n"-terminated lines   (step 2)
            └─ other sources             → existing rewrite plan (plan_partitioned_source)
  └─ DurableStorageHost: append + fsync file (+ directory when new)   |  replace_durable
  └─ publish engine state

PartitionKey::{Field, Prefix, TimeBucket}  → partition_path                         (step 3)
CollectionDescriptor.ordered_indexes        → query planner range narrowing          (step 4)
NativeSourceRuntimeOptions.lazy_partitions  → partition catalogue + LRU loaded set   (step 5)
```

## Config shapes

| Setting | Where | Shape | Default / compatibility |
|---|---|---|---|
| Append-only | existing `CollectionDescriptor.append_only` | `true` | Unchanged field. In native source mode, a `true` collection on a JSONL/NDJSON `CollectionFile` or `Partitioned` source appends lines with `append_data` (`crates/proseql-storage/src/persistence.rs`). Other formats keep the rewrite path. |
| Duplicate IDs | new `CollectionDescriptor.duplicate_ids: DuplicateIdPolicy` | serde `"error"` \| `"ignore_identical"` | `"error"`; serde default, skipped when default. TS (`packages/engine` config): `duplicateIds?: "error" \| "ignoreIdentical"`. |
| Time bucket | new variant `PartitionKey::TimeBucket { field: String, bucket: TimeBucket }`, `enum TimeBucket { Year, Month, Day }` | key `YYYY` / `YYYY-MM` / `YYYY-MM-DD` | Additive variant. The field must be a UTC timestamp string ending in `Z` (`YYYY-MM-DDTHH:MM:SS(.f+)?Z`). Other values fail with `SourceConfigError` on write and on load. TS: `{ kind: "timeBucket", field, bucket: "year" \| "month" \| "day" }` in `packages/core/src/storage/source-config.ts` / `partitioned-source.ts`, shared by `packages/engine`. |
| Ordered index | new `CollectionDescriptor.ordered_indexes: Vec<String>` | one field per entry | Empty; serde default, skipped when empty. TS: `orderedIndexes?: ReadonlyArray<string>`. |
| Lazy partitions | new `NativeSourceRuntimeOptions.lazy_partitions: IndexMap<String /* source id */, LazyPartitionPolicy>` | `LazyPartitionPolicy { max_loaded_partitions: usize, full_scan: FullScanPolicy::{Allow, Error} }`, LRU eviction | Empty map in `Default`. |

## Key Decisions

### Coach compatibility

Coach pins `proseql-native`, `-engine`, `-storage` and `-formats` at `0e3666a`. It builds `DocumentSourceConfig`, `DocumentGraphRootConfig`, `DocumentGraphSourceConfig` and `NativeSourceRuntimeConfig` with struct literals and `NativeSourceRuntimeOptions { .., ..Default::default() }`. It deserializes `Vec<CollectionDescriptor>` from JSON. Therefore no field is added to the first four structs, and new descriptor fields use `#[serde(default, skip_serializing_if = ...)]`. No Coach collection sets `append_only: true`, so step 2 does not change Coach behaviour.

### Re-append semantics (`duplicate_ids: "ignore_identical"`)

- Applies to `create` and `createMany` in the engine, one implementation for native and WASM.
- Same ID and same payload: success, no write, returns the stored record. The comparison runs after schema decode and defaults, with JS number semantics, and ignores engine-filled `createdAt`/`updatedAt`.
- Same ID and a different payload: `DuplicateKeyError` with the existing tag and payload. If any record in a batch conflicts, nothing in the batch is written.
- The policy is a separate opt-in, so existing `appendOnly` users see no change.

### Failure rules for append

- Order: engine candidate → one append write of complete `\n`-terminated lines → fsync the file (and the directory when the file is new) → the runtime publishes the engine state.
- Lines use the same encoder as a full rewrite, so a later rewrite gives the same bytes.
- Write failure: the caller gets `StorageError`; the engine journal rolls back; the runtime quarantines under the existing crash rule in `docs/native-sources.md`. Memory never goes ahead of disk.
- Torn final line on open, append-only JSONL files only:
  - no trailing newline and the line does not parse → interrupted append. The loader ignores it and reports a diagnostic. The next append first truncates the file to the last complete line.
  - no trailing newline but the line parses → a valid record. The next append writes the missing `\n` first.
  - Any other malformed line is still an error (strict codec).
- File watcher: the runtime's own appends update the stored state and do not trigger a reload.

### Lazy partitions (native only)

- Requires a `Partitioned` JSONL source, `append_only: true`, no `unique_fields` and no relationships in or out. Otherwise open fails with `SourceConfigError`.
- Open lists file names only and decodes nothing.
- A query or aggregate filtered on the partition field (eq, `$in`, range, or a time range through the bucket) loads only the partitions it can touch. Pruning compares string intervals, so it is conservative: it never skips a partition that could match.
- An unfiltered query loads everything and exceeds the bound for that query only. With `full_scan: Error` it fails with a typed error instead.
- Indexes (equality, ordered, search) are built per loaded partition and dropped on eviction.
- The ID uniqueness check covers the target partition only. This is a documented limit; IDs should derive from the partition field, for example `heartrate:<timestamp>`. Wrong-partition and duplicate checks run when a partition loads.
- Watches pin the partitions their filter touches. Pinned partitions are not evicted.
- The file watcher hashes only loaded partitions and checks the directory listing for new or removed files.
- A native query stats API returns `partitions_loaded` and `index_used`.

### Where the lazy runtime boundary goes (step 5 decision)

The engine assumes that a collection holds every record a query can match. Two places could change that assumption:

| Option | What changes | Cost |
|---|---|---|
| Engine: a partition provider behind `Collection` | query, aggregate, populate, transactions, reactive snapshots and indexes learn about unloaded records; the engine calls back into a loader during a query | large change in shared code; WASM size budget (about 2.5 KB of headroom); every engine path needs a lazy variant |
| **Native runtime (chosen)** | before an operation, the runtime makes every partition the filter can touch resident; after it, the runtime evicts | the engine gains three small methods that move records in and out without a mutation; operations must go through `NativeRuntime` methods, and `read(|db| ..)` sees loaded partitions only |

The runtime layer keeps the engine's assumption true for each operation: the resident set always contains every partition that can hold a match, so the engine's query, index, sort, aggregate, transaction and watch code is unchanged and shared with WASM. The engine methods are `Database::load_resident_records`, `unload_resident_records` and `refresh_reactive_snapshot`; the WASM crate never calls them, so the linker drops them (browser production stayed at 593,179 B gzip). The preconditions (no relationships, no unique fields) are what make the runtime boundary sound: no query reads another collection's lazy records, and the only cross-record check on create is the ID, which the target partition covers.

Pruning lives in `proseql-storage` (`partition_prune.rs`, next to the partition keys). The lazy state (listing, resident partitions, LRU clock, watch pins) lives in the native `SourceState`. The managed watch polls lazy roots itself (listing plus loaded partitions only) instead of the host's recursive content-hashing poller.

### Parity

| Feature | Native | WASM (`packages/engine`) | Legacy core (`packages/core` runtime) |
|---|---|---|---|
| `duplicate_ids` | yes | yes (engine) | config rejected (fail closed) |
| Partitioned append without rewrite | yes | no, on purpose (keeps rewrite) | no |
| TimeBucket key | yes | yes (core's `partitioned-source.ts`, shared) | yes |
| Ordered index | yes | yes (engine) | accepted, not used for planning; same results |
| Lazy partitions | yes | no, on purpose | no |

The "on purpose" rows are recorded in the work item and in `docs/native-sources.md`.

### Benchmark harness

- `crates/proseql-native/examples/timeseries_bench.rs`, run by `just bench-timeseries`. It is an example rather than a Criterion bench because it measures one process per size (peak RSS from `/proc/self/status` `VmHWM`) and durable filesystem writes, and needs no new dependency.
- Synthetic rows `{"id":"heartrate:<iso>","timestamp":"<iso ms Z>","bpm":<int>,"source":"…","month":"YYYY-MM"}` are generated with a fixed seed into the system temp directory, never into git, and cached by size, span and seed.
- Each size runs in a fresh child process on a fresh copy of the cached data. A storage-host wrapper counts bytes read and written per operation.
- `--mode baseline|append|timebucket|ordered|lazy` selects cumulative feature sets. Each later step switches on its mode without changing the harness.

## File Layout

```
crates/proseql-native/examples/timeseries_bench.rs   (step 1, new)
justfile                                               (step 1, bench-timeseries recipe)
docs/benchmarks/timeseries.md                          (step 1 baseline; steps 2–5 fill their sections)
crates/proseql-engine/src/descriptor.rs                (steps 2, 4: duplicate_ids, ordered_indexes)
crates/proseql-engine/src/collection.rs                (steps 2, 4)
crates/proseql-engine/src/query/indexes.rs             (step 4)
crates/proseql-storage/src/source_config.rs            (step 3: TimeBucket)
crates/proseql-storage/src/partitioned.rs              (steps 2, 3, 5)
crates/proseql-storage/src/persistence.rs              (step 2: append_data wiring, torn-line handling)
crates/proseql-native/src/lib.rs, sources.rs           (steps 2, 5)
crates/proseql-native/src/lazy.rs                      (step 5: lazy state, eviction, watcher)
crates/proseql-storage/src/partition_prune.rs          (step 5: filter → partition keys)
crates/proseql-engine/src/resident.rs                  (step 5: resident records)
packages/core/src/storage/source-config.ts, partitioned-source.ts   (step 3)
packages/engine/src/…                                  (steps 2, 3, 4: config mapping)
docs/native-sources.md                                 (steps 2–5)
```
