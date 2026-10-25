# Query-while-scanning: build contract

Binding for every builder in the `query-while-scanning` workflow. Base branch: `qws/base` (skeleton commit on top of `5d1a2aa`). Epic #12; stage issues #14–#19. Evidence: `docs/benchmarks/sqlite-baseline.md`.

## 1. Scope

**In scope: lazy partitioned collections**, that is, sources named in `NativeSourceRuntimeOptions::lazy_partitions`. Today these are already restricted (`configure_lazy`): partitioned JSONL only, `append_only: true`, no `unique_fields`, no relationships in or out, no global hooks. Logbook's `samples` and `raw` collections are lazy. Consequences:

- The write path is **creates only**. Update, delete and upsert are refused with reason `append-only` before any write, today and after. No streaming rewrite is needed.
- `populate` cannot apply (no relationships).
- YAML is never a lazy format.

**Out of scope for this run: eager (non-lazy) collections.** They keep the resident engine `Database`: YAML documents, collection files, relationships, populate, search and computed fields depend on it. Their memory is bounded by their file sizes. The design document (#19) records this as a bound, not a hidden exception. "Remove the resident path" (#19) means: no lazy-collection operation loads partitions into the engine collection, and the code that did so (`lazy_ensure`, `lazy_visit`, residency, eviction, pinning in `lazy.rs`, the lazy branches of `with_scope`/`bounded_fold`/`watch_scoped`/`prepare_creates`) is deleted.

## 2. The switch

`proseql_native::ExecutionModel { Resident, Streaming }`, set by the new additive field `NativeSourceRuntimeOptions::execution_model` (default `Resident`). Both consumers build options with `..Default::default()`, so the field is source-compatible. `LazyPartitionPolicy` gets **no** new fields: Logbook constructs it with a struct literal.

The value is stored per lazy collection (`LazyCollection::execution_model`). Every hook below checks it and returns "not handled" for `Resident`. The integrator flips the default to `Streaming` at cutover and then removes the switch if nothing else needs it.

## 3. Seams and owners

Write only to files you own. A change to a binding signature goes through the parent. "Free" means the owner may change it without asking.

| Seam (binding items) | Owner | Files you own |
|---|---|---|
| `scan::{RowLocation, RawRow, RowSource, SliceLines, unimplemented_seam}` | parent | `proseql-engine/src/scan/mod.rs` above the `executor` marker |
| Executor: decode, filter, select, sort/top-k, limit, cursor, group, aggregate on borrowed rows; per-query arena | `exec` | `proseql-engine/src/scan/` below the marker and new files there; `proseql-native/src/streaming.rs`; additive `pub(crate)` visibility and accessors only in `proseql-engine/src/query/` |
| `readers::{ByteChunks, SliceChunks, HostChunks}`; `StorageHost::{read_range, stat}` defaults | parent | `proseql-storage/src/readers/mod.rs` above the marker |
| Chunked JSONL line framer (`ByteChunks` → `RowSource`), host overrides of `read_range`/`stat`, WASM chunk path, YAML bound | `formats` | `readers/` below the marker and new files there; `proseql-storage/src/fs.rs`; `proseql-wasm/src/**`; `packages/**` for the browser path |
| `generation::{SourceGeneration, GenerationCheck}`; `index::{TimeIndex, SeekRange, IdLocator}` public methods | `index` | `proseql-storage/src/generation.rs`, `proseql-storage/src/index/**`, `proseql-native/src/locate.rs` |
| `write::append::{applies, create, create_many, after_commit, after_rollback}` | `append` | `proseql-native/src/write/append.rs`; in `lazy.rs` only `record_append` and `lazy_ensure_for_record`; in `sources.rs` only append planning |
| `write::watch::{streaming_watch_applies, streaming_watch, streaming_watch_with_callback, refresh_applies, refresh}`; `write::tx::check_before_commit` | `mutate` | `proseql-native/src/write/{watch,tx}.rs`; in `lazy.rs` only `lazy_pin`, `lazy_unpin`, `lazy_refresh`, `lazy_reload_partition`, `lazy_fingerprints`, and additive changes to `LazyFingerprint`, `file_fingerprint`, `disk_differs`; additive constructors in `proseql-engine/src/reactive/` |
| Acceptance harness, consumer override scripts | `harness` | `bench/acceptance/**`, `scripts/consumers/**`, its flake task |
| `execution.rs`, call sites in `lib.rs`/`bounded.rs`, `tests/support/**` | parent, then `integrator` | — |

Tests: each builder adds its own files, named `crates/<crate>/tests/streaming_<seam>.rs` (for example `streaming_exec.rs`), and uses `tests/support/parity.rs` for differential checks. Do not edit another builder's test files.

Shared crates' `Cargo.toml`: adding a dependency to a crate needs the parent's approval (merge conflicts and the no-SIMD rule). Prefer `serde_json` (already present) with borrowed `RawValue`/`&str` deserialization.

## 4. Hook contract

All hooks are already called from the right places (skeleton). Each returns "not handled" today.

- **Reads** — `NativeRuntime::streaming_read(collection, ReadRequest) -> Option<Result<(ReadOutput, BoundedQueryStats)>>` is called first by `query`, `query_with_stats`, `query_cursor`, `aggregate`, `aggregate_grouped` and all `*_bounded` variants. Called without the runtime lock. `ReadOutput` must match the request variant (the call sites `unreachable!` otherwise).
- **ID lookup** — `NativeRuntime::streaming_find_by_id` (no lock held) and `locate::mutation_find_by_id(&mut MutationInner, ..)` (inside a mutation, only after the engine collection missed; rows created in the open mutation are in the engine collection).
- **Creates** — `write::append::applies(&MutationInner, collection)`; then `create`/`create_many` replace `prepare_creates` + engine create. `after_commit(&mut RuntimeState)` runs after a durable commit and is infallible (mark state stale instead of failing). `after_rollback` runs after any rollback, including a failed `check_before_commit` or a failed commit.
- **Watches** — `streaming_watch_applies(collection)`, then `streaming_watch`/`streaming_watch_with_callback` replace `watch_scoped`. `refresh_applies(&RuntimeState)`/`refresh(&mut RuntimeState)` replace `refresh_lazy_locked` for the lazy poller (lock held): detect and invalidate only. `write::watch::capture_commit(&mut RuntimeState)` runs under the lock right after a successful `commit_source_mutation` and **before** `append::after_commit`. `NativeRuntime::refresh_streaming_watches(&self)` runs **without** the lock after every successful source-mode mutation (before host callback replay), after `reload`, after the managed watcher's reload and after each lazy poll that refreshed; it delivers watch results and may call `streaming_read`. Order in `mutate`: `check_before_commit` → `commit_source_mutation` → `capture_commit` → `after_commit` (silent removal: no change events, no delete entries) → unlock → `refresh_streaming_watches` → callback replay. Code running on the poller or watcher threads can build a temporary `NativeRuntime { inner: Arc::clone(&core) }` (no `Drop` side effects).
- **Commit check** — `write::tx::check_before_commit(&RuntimeState)` runs before `commit_source_mutation` (lock held). An error rolls back and is returned unchanged.

Per-collection state lives in `LazyCollection::stream: LazyStreamState { index, append, watch }`. Each field's type is defined and owned in its module (`locate::IndexState`, `write::append::AppendState`, `write::watch::WatchState`). Reloads move it (`lazy_adopt`); owners re-check generations before use. `resident_bytes()` on each feeds the idle-memory evidence.

## 5. Semantics that must not change

From #12, the stage-0 report ("Semantics that make streaming hard") and `docs/native-sources.md`:

- **Order.** Natural order is partition path order, then file order (`RowLocation::ordinal`). Stable ties; ordered-index and equality-index candidate order as today (`candidate_order.rs`); first-encounter group order; IEEE f64 accumulation in the same order as today (no per-partition partial sums).
- **Cursors.** Current cursor encoding and strict after/before comparison; `limit + 1` page flags.
- **Errors.** Same `_tag`s, payloads and timing class. Today a selected partition is decoded and validated before the query runs, so an invalid record in a scanned partition fails the read even if a filter would skip it. Predicate pushdown must keep that: validate every row the scan reads; a seek that skips rows by index is allowed (those rows were never read, as when partition pruning skips files today). Torn final lines follow the append-only rules.
- **Duplicates.** A duplicate ID across partitions is a `SourceConfigError` ("Duplicate partition record '<id>'") today, detected when both are read in one operation. Streaming detects it no later than the first operation that reads both rows or builds the `IdLocator`. Report any timing change as a changed guarantee.
- **`duplicate_ids: ignore_identical`.** Identical re-creates return the stored record and write nothing; equality compares the validated stored record, never only a hash.
- **Writes.** Durability per `appendDurability`: synced appends exactly as today (`append_durable`, torn-suffix truncation, quarantine on write-stage failure). Rollback leaves memory and disk as before.
- **Watches.** Initial result, events after own commits and after external edits found by the poller, last-known-good results after an invalid edit, `lazy_watch_interval`, no event for the runtime's own appends from the poller.
- **Full-scan policy.** `FullScanPolicy::Error` refuses an operation that cannot prune, with reason `lazy-full-scan`, as today. Using an index or the `IdLocator` does not change which operations are refused. `find_by_id` keeps its current policy behaviour.
- **Stats.** `BoundedQueryStats`/`NativeQueryStats` keep their fields. Under `Streaming`: `partitions_read` counts files opened, `partitions_resident` is 0, `index_used`/`candidate_rows` describe what the scan used. Document the meanings.

Any change a caller can see must be marked and justified in the builder's report.

## 6. Recommended designs (owners may improve, with measurements)

- **exec.** Decode each line with `serde_json` into borrowed form, materialise an owned `Value` only for rows that are output or needed by sort/top-k. Push down `where` (ordered range on the time field through `IndexState::time_index(host, path, field)` and `TimeIndex::seek`; `exec` passes the field, `index` may decline fields that are not ordered indexes), `select`, `limit` (top-k heap with ordinal tie-break), group/aggregate folds. Reuse the existing operator code (`query::filter`, `aggregate`) on a per-row `Value` if borrowed evaluation is not ready; measure the difference. Per-query arena; nothing kept after return.
- **index.** `IdLocator` must fit the idle target (≤ SQLite + 20 MiB at 656k rows): for example a sorted `Vec<(u64 hash, u32 file, u32 offset)>` (~16 B/row ≈ 10 MiB) with verification reads, built lazily on first ID use by scanning only the `id` field, extended by `record_appended`. If Logbook IDs embed the time (`<metric>:<atUtc>`-like), consider routing by partition key instead and measure both. `TimeIndex`: one entry every N rows (start with 1,024), built on the first range query of a file, refreshed with `GenerationCheck::Appended`.
- **append.** Check incoming IDs through `IdLocator`, verify candidates by reading the row, then let the engine create the batch in the engine collection as today so validation, defaults, hooks and change events stay identical; the existing commit path appends durably; `after_commit` removes the batch from the engine collection and calls `record_appended`. This also removes the stage-0 raw-shard OOM (no partition is loaded).
- **mutate.** A streaming watch keeps its last delivered result and a compact baseline (generations of covered files). On own commits, apply the committed rows (available in the engine collection until `after_commit` runs; coordinate the order with `append` through the parent). On poll changes, re-run the watch query through `streaming_read`. `check_before_commit` compares the target files' generations with what the runtime last wrote or read.
- **formats.** `LineFramer<C: ByteChunks>` implementing `RowSource` with a reusable line buffer; lines may span chunks; final-line classification as `SliceLines`. `FsStorageHost::read_range` with `pread`/seek; `stat` with len, mtime and an identity (dev/inode/ctime hash). WASM: the executor and framer must build for `wasm32-unknown-unknown`; the browser host supplies chunks (no mmap, no whole-file `readText`).

## 7. Acceptance per seam

Every builder: its focused tests pass on aka, `cargo clippy -D warnings` and `cargo fmt --check` pass on aka, code builds with `RUSTFLAGS='-C target-cpu=x86-64-v2'`, and its differential tests show identical Resident/Streaming results. Remove the `#![allow(dead_code)]` skeleton line from your files once filled.

| Owner | Extra acceptance |
|---|---|
| exec | Differential tests on generated queries (filters on every operator used by Logbook, sorts asc/desc with ties, limits, offsets, cursors both directions, aggregates, groups). Query-lifetime memory check: a ten-month grouped aggregate on the fixture retains < 1 MiB after return. |
| index | Stale, hand-edited, out-of-order, appended-by-another-process and missing files give full-scan answers. `IdLocator` build time and `resident_bytes` measured at 656k rows. |
| append | 1,000 new rows with global duplicate checks without loading partitions; raw 256-shard shape stays far under 1 GiB; crash tests (fault host) during append; `ignore_identical` cases. |
| mutate | All existing lazy watch tests pass under `Streaming` (copy them into your test file with the model switched if needed); external edit, invalid edit (last-known-good), new partition file, removed file; conflict detection test; fault-injection crash tests across the write path. |
| formats | Framer property tests (random chunk sizes give identical rows to `SliceLines`); `FsStorageHost` reads a 100 MiB file with < 1 MiB buffer; `cargo check --target wasm32-unknown-unknown` for engine and storage; `nix run .#parity-gate` and browser smoke tests pass. |
| harness | `bench/acceptance` measures every #12 target for SQLite, Resident and Streaming through the public API, on aka, at `x86-64-v2`; consumer scripts build Coach (`0e3666a`) and Logbook (`9a11d36`) against a given ProseQL path without editing them. |

## 8. Running things

Everything that compiles, runs or tests runs on **aka**, through `scripts/qws/aka-run <your-name> [--x86-64-v2] [--pull] -- <command>`. Use `--pull` for `cargo fmt` so the formatted files come back. On zao: Git, reading and editing only.
