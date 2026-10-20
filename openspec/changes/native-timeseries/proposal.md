## Why

A native consumer (a headless health-data store) wants to keep years of high-volume samples, such as heart rate and steps, as partitioned JSONL collections in proseQL. Today the native runtime does not scale with history:

- Opening a database reads and decodes every partition file (`load_partitioned_source`, `crates/proseql-storage/src/partitioned.rs`). Open time and memory grow with total history.
- One insert into a partitioned collection encodes the whole changed partition again (`plan_partitioned_source`). Adding one sample to a month rewrites the month.
- The engine has equality and text indexes only. A filter such as `timestamp >= A and timestamp < B` scans the whole collection.
- `PartitionKey` is `Field` or `Prefix`. An ISO timestamp cannot select a month without a stored, redundant `month` field.

The engine already has `append_only` (`crates/proseql-engine/src/descriptor.rs`) and refuses update, delete and upsert for it. The WASM/TypeScript engine appends JSONL for single-file collections only (`packages/engine/src/database.ts`). The native append path, partitioned append and idempotent re-append are missing.

## What Changes

The change has five steps. Each step is opt-in and measured with one benchmark.

1. **Baseline.** Add the `timeseries_bench` example and `just bench-timeseries`. Record today's open time, peak RSS, insert cost, bytes written per insert and one-hour range-query cost at 140k, 1M and 10M synthetic rows in `docs/benchmarks/timeseries.md`.
2. **Native append-only and duplicate IDs.** In native source mode, an `append_only: true` collection on a JSONL/NDJSON `CollectionFile` or `Partitioned` source appends complete lines with `append_data` and does not encode the file again. A new `CollectionDescriptor.duplicate_ids` policy (`"error"` | `"ignore_identical"`) makes an identical re-insert a no-op success in the engine, for native and WASM.
3. **Time-bucket partition keys.** A new `PartitionKey::TimeBucket { field, bucket }` with `TimeBucket::{Year, Month, Day}` derives `YYYY`, `YYYY-MM` or `YYYY-MM-DD` from a UTC `Z` timestamp. The TypeScript shared source config gets the same key.
4. **Ordered index.** A new `CollectionDescriptor.ordered_indexes` lets the planner answer `<`, `<=`, `>`, `>=` and between-style filters, and sorts on that field, without a full scan. Results stay identical to the unindexed path.
5. **Lazy partitions.** A new `NativeSourceRuntimeOptions.lazy_partitions` policy opens a qualifying partitioned source without decoding files, loads only the partitions a filtered query can touch, and evicts with an LRU bound. A native query stats API reports `partitions_loaded` and `index_used`.

## Capabilities

### New Capabilities

- `timeseries-benchmark`: a repeatable native benchmark with a fixed seed, cached synthetic data and one machine-readable line per size.
- `native-append-only`: partitioned and collection-file JSONL append without rewrite, torn-line recovery, and the `duplicate_ids` policy.
- `time-bucket-partitions`: a partition key derived from a UTC timestamp.
- `ordered-index`: a range index used by the query planner.
- `lazy-partitions`: bounded, query-driven partition loading for native partitioned JSONL sources.

### Modified Capabilities

- `CollectionDescriptor` gains `duplicate_ids` and `ordered_indexes`. Both use `#[serde(default, skip_serializing_if = ...)]` so old descriptor JSON parses and serializes byte-identically.
- `PartitionKey` gains the additive `TimeBucket` variant.
- `NativeSourceRuntimeOptions` gains `lazy_partitions` with an empty default. Coach builds it with `..Default::default()`, so this is compatible.
- `docs/native-sources.md` documents the settings, their limits and costs, and the "native only on purpose" parity rows.

## Impact

- **Compatibility.** Every new behaviour is opt-in. No field is added to `DocumentSourceConfig`, `DocumentGraphRootConfig`, `DocumentGraphSourceConfig` or `NativeSourceRuntimeConfig`, because Coach builds them with struct literals. `coach_compatibility` and the byte-preservation tests keep passing.
- **Parity.** `duplicate_ids`, the time-bucket key and the ordered index reach the WASM engine. Partitioned append without rewrite and lazy partitions are native only, on purpose. The legacy TypeScript core rejects `duplicate_ids` (fail closed), accepts the time-bucket key, and accepts but does not plan with ordered indexes.
- **Privacy.** All benchmark and test data is synthetic. No data from `~/.local/share/coach/` enters the repository, logs or history.
- **Acceptance.** `just bench-timeseries` at 10M rows versus 140k rows: lazy open time and RSS ≤ 2×; append median over 1,000 appends ≤ 2×, bytes written equal the line length, earlier file bytes unchanged; one-hour range query with `partitions_loaded = 1`, `index_used = ordered`, time ≤ 2×.
