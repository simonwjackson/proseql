# Query while scanning: append round 5

**The no-prefix-read shortcut is blocked by the existing edit-detection contract.** The implementation retains the post-sync prefix hash. It streams baseline construction, reuses the exact verified suffix for locator bookkeeping, and avoids redundant mkdir calls. Samples improve about 6–7%; raw latency is nearly unchanged. The samples ≤3× SQLite round-5 subgoal and all original ≤1× targets still miss.

## Source and method

Baseline: `517bdea`. Runtime: `5af914eedca5a942ea33853c7c5051eca27cc42c`. This is the append builder alone, without the parallel index-load or validated-skip changes. [Numeric evidence](query-while-scanning-append-round5.json) contains the individual trials, phase/allocation probes, syscall counts, load samples and binary/source hashes.

All compilation, tests and measurements ran on aka through `scripts/qws/aka-run append-lite --x86-64-v2`. The 656,640-row synthetic shapes have ten sample months or 256 raw shards. Every append uses a fresh copy and persists exactly 1,000 new rows through the public API. A separate process primes and closes indexes for that exact destination before the timed fresh process starts. Warm mode warms file pages, not runtime membership. Cold mode syncs/evicts only owned pages. SQLite stays NORMAL/WAL; synced native text has a different power-loss contract.

Accepted timing blocks use three repetitions per shape/backend/cache cell, rotating backend order, and include the unchanged SQLite controls. Timing excludes open. Independent allocator/phase probes append two distinct batches on one owner. They do not qualify cold/warm timing. Separate `strace -c` processes compare repeat(2) minus repeat(1), isolating one additional batch. Those traced wall times do not qualify latency. Instructions come from the acceptance harness's `perf_event_open` counter.

After the parent introduced shared-host coordination, accepted measurements ran under `flock -x /home/simonwjackson/work/qws5-aka.lock`; builds/tests used `flock -s`. Measurements wait for one-minute load ≤1 inside the lock, sample it every five seconds, and reject a block above 2. Earlier unlocked exploration and the intermediate single-pass newline-count implementation are not accepted final evidence. Every measured/preparation process uses `systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout`. No memory limit, target or durability rule changed.

## Why token equality is insufficient

A trusted token and length matching the previous own append rule out edits only up to the next descriptor's `before` observation. An external same-length prefix edit **during the new append**, before post-sync read-back, changes ctime/token, but our own writes change it too. The final token cannot distinguish the two. Suffix read-back plus a stable token during that read-back can therefore bless stale prefix membership. A finished saved hash does not prove that the current bytes still have that hash.

The existing AppendSync regression covers this race. The added `previous_own_append_identity_does_not_bless_a_prefix_edit_during_the_next_append` regression repeats it after a successful own append. Both still require prefix hashing. The parent confirmed that no stronger host evidence is approved.

One runtime must own writable paths, but checks do not enforce ownership. The existing residual window remains an edit **after the final fresh generation check and before derived metadata publication**. The next operation checks generations again. Removing the prefix read would widen that window to the write itself. Unblocking it requires OS-enforced exclusive write ownership that every writer honours, or filesystem per-range change information. Neither is added. See the [design ruling](../design/query-while-scanning.md#round-5-append-evidence-limit).

## Implemented work and costs

- `StorageHost::visit_bytes` is additive, with a safe default over `read_bytes`. Fs uses one descriptor and a reusable 64 KiB buffer. Visitor errors stop the visit unchanged. It supplies no generation evidence. `ReadSnapshot` deliberately keeps the default so captured load bytes remain authoritative. `NativeRuntime::mutate` passes `state.host` directly to `LazyAccess` (`lib.rs`), so append preparation reaches the bounded Fs implementation.
- Baselines retain resumable `DefaultHasher` state, two conflict tails and the final physical line, not the whole partition. Healthy files need no physical-line count. Torn files make a second bounded pass to count only the original covered bytes, with matching length/hash/metadata checks. Their diagnostics, truncation and separator handling remain identical. The trade-off is extra I/O for torn files; a changed file fails through the existing conflict path.
- Successful `append_durable_with_identity` evidence still reads/hashes the kept prefix and verifies the exact suffix after sync. Bookkeeping can parse its retained verified suffix bytes instead of reopening/rereading the suffix. It still freshly checks the path generation before index publication. Missing/rejected evidence keeps the old proof and real text read. The retained suffix costs one batch-sized string copy.
- Append target opening creates missing parent directories only on demand. Existing targets avoid a mkdir syscall; the existing extensionless-path behavior is preserved. File/directory sync, recovery, rollback and quarantine remain unchanged.
- Staged-ID deduplication uses sets instead of repeated linear searches. It preserves result/staging order but adds small batch-local hash tables.

No caller-visible ordering, duplicate/equality, validation/error, watch or durability guarantee changes. Disposable indexes remain caches. There is no new dependency, SIMD implementation, lock or source of truth.

## Fresh-runtime results

Cold / warm median milliseconds. There are 48 accepted timing trials across baseline and final, with 24 native appends and 24 SQLite controls. All complete answers match, including across sources; all 48 writes independently persist exactly 1,000 new rows. Maximum sampled one-minute load is 0.7159 before / 0.8145 final. No block exceeds 2.

| Shape | SQLite final | Before | Final | Final / SQLite | Verdict |
|---|---:|---:|---:|---:|---|
| samples | 11.334 / 7.979 | 94.752 / 74.162 | 88.846 / 69.093 | 7.84× / 8.66× | miss ≤3× and ≤1× |
| raw | 11.571 / 7.932 | 534.920 / 329.871 | 523.538 / 328.653 | 45.24× / 41.43× | miss ≤1× |

Raw improves 2.1% cold and 0.4% warm in these medians. Three repetitions do not establish a meaningful warm-raw speed improvement. No target is lowered or called an equal-durability comparison.

Warm instruction medians cover the entire fresh append, including saved-locator loading. Normalizing by target files or new rows is an amortized description of these fixed shapes, not a marginal per-file/row scaling law.

| Shape | Instructions before → final | Final per target file | Final per new row |
|---|---:|---:|---:|
| samples, one target | 743,594,695 → 730,931,177 | 730,931,177 | 730,931 |
| raw, 256 targets | 1,908,555,296 → 1,904,325,658 | 7,438,772 | 1,904,326 |

## Allocation and phase profiles

Independent single warm-text probes, not three-trial latency cells. Batch 1 starts a fresh owner with saved sidecars; batch 2 uses that same owner. Phases nest: do not add prefix proof to commit again, or locator finish to membership.

| Shape / phase, ms | Before batch 1 / 2 | Final batch 1 / 2 |
|---|---:|---:|
| samples total | 72.532 / 24.909 | 70.047 / 25.433 |
| samples preparation | 16.197 / 0.343 | 10.563 / 0.355 |
| samples membership | 28.763 / 1.008 | 29.901 / 0.970 |
| samples prefix proof | 8.932 / 8.974 | 9.872 / 9.960 |
| samples bookkeeping | 1.451 / 1.401 | 1.361 / 1.700 |
| raw total | 330.188 / 198.667 | 328.845 / 194.163 |
| raw preparation | 98.604 / 1.644 | 101.579 / 1.395 |
| raw membership | 29.003 / 2.382 | 29.560 / 2.218 |
| raw prefix proof | 98.574 / 97.918 | 97.706 / 99.256 |
| raw bookkeeping | 5.028 / 4.665 | 2.988 / 2.943 |

Final raw preparation and prefix proof average 0.397 / 0.382 ms per touched file on batch 1, or 101.579 / 97.706 µs per new row. Whole batch 1 averages 1.285 ms per file / 328.845 µs per new row. Raw preparation does **not** improve in this probe; chunked reading trades allocation traffic for more reads. The requested prefix shortcut remains blocked, and its proof is 29.7% of the fresh raw probe and 51.1% of the later batch. Samples spend 14.1% / 39.2% in prefix proof. These measured phase shares are not physical lower bounds.

| Requested heap | Samples before → final | Raw before → final |
|---|---:|---:|
| Batch 1 allocated traffic, B | 153,460,336 → 129,255,732 | 383,411,816 → 137,902,459 |
| Batch 2 allocated traffic, B | 32,606,937 → 32,625,652 | 37,656,687 → 37,007,315 |
| Batch 1 peak live, B | 28,245,965 → 26,803,013 | 27,476,573 → 27,475,997 |
| Batch 1 end live, B | 14,238,695 → 14,238,695 | 16,906,591 → 16,906,591 |

Raw first-batch allocation traffic falls by 245,509,357 B (64.0%), but its requested peak barely changes. Final raw traffic amortizes to 538,681 B per file / 137,902 B per new row. Samples fall 15.8%, to 129,256 B per new row. Traffic counts full realloc destination sizes, not only copies or retained memory. Small batch-2 sample traffic rises by 18,715 B because the new local sets/suffix copy are not free. These changes do not solve retained RSS: final first-batch peak RSS is about 36.4 / 36.7 MiB samples/raw, not an idle-memory qualification.

## Syscalls per additional batch

`strace -c`, repeat(2) minus repeat(1), each from a fresh identical fixture. Sample suffixes span six chunks; raw suffixes need one chunk per shard. File-count normalization includes fixed per-operation setup calls.

| Syscall | samples before → final | raw before → final | raw per file before → final |
|---|---:|---:|---:|
| statx | 95 → 82 | 6,916 → 6,148 | 27.016 → 24.016 |
| openat / close, each | 11 → 5 | 771 → 515 | 3.012 → 2.012 |
| read | 397 → 391 | 4,616 → 4,360 | 18.031 → 17.031 |
| lseek | 9 → 3 | 1,024 → 768 | 4 → 3 |
| mkdir | 1 → 0 | 256 → 0 | 1 → 0 |
| fdatasync | 1 → 1 | 256 → 256 | 1 → 1 |

The remaining two raw opens per file are tail-conflict checking and durable append. Recovery and fresh generation checks remain. Raw still synchronizes all 256 targets. Fresh baseline streaming adds chunk-read syscalls on the first batch; this table deliberately isolates the later batch, not that first preparation cost. Complete first-batch and repeat syscall counts are in the numeric evidence.

## Every miss: observed floor, reason, next step

Floors are the fastest final timing trial, not physical lower bounds. The original ≤1× target remains binding; ≤3× is only this round's requested samples subgoal.

| Miss | Final floor / SQLite median, ms | Reason | Next step and cost |
|---|---:|---|---|
| samples cold | 84.529 / 11.334 (3× bar 34.002) | Fresh global locator reconstruction, first resumable baseline hash, checked post-sync prefix read | Combine the separate index-load work, then measure a serializable baseline-hash state. A finished hash cannot resume DefaultHasher; a new state format needs version/invalidation/race tests. |
| samples warm | 67.492 / 7.979 (3× bar 23.937) | Warm pages do not prebuild runtime state; the live-owner probe still pays about 10 ms prefix proof and 25.4 ms total | Profile the remaining row/engine work after index-load integration. Removing prefix proof additionally needs the stronger ownership/range evidence above; it is not approved. |
| raw cold | 520.659 / 11.571 | Same first-use work plus 256 baseline reads and synchronized targets | Baseline-state work first; consider prepared per-file handles to share tail/open/generation work. This adds descriptor ownership and must preserve all-before-write conflicts and fault timing. |
| raw warm | 324.625 / 7.932 | Prefix proof about 98–99 ms, first baselines about 102 ms, and 256 durable targets | Fewer target files requires a separate consumer layout/migration decision. No such change is made. Retaining current layout still needs baseline-state/prepared-handle work; synchronization is not removed. |

## Checks and limits

Verified on aka with native x86-64-v2:

- Storage package tests: **194 passed / 0 failed / 4 ignored**, including host visitation, persistence, recovery and filesystem durability. Crash parents explicitly run their subprocess children.
- Final native library and `streaming_append`, `streaming_write_locator`, `streaming_write_append_identity`, `streaming_watch`, `append_runtime`, `streaming_persist`, `streaming_persist_errors`: **74 passed / 0 failed / 5 ignored**, run with `--test-threads=1`. Crash parents explicitly run their ignored children. Tests cover prefix/suffix edits, prior-own-append evidence, torn UTF-8 and chunk splits, duplicates, fault rollback and quarantine.
- Native/storage all-target/all-feature cargo check and clippy `-D warnings`: passed. Scoped fmt: passed. Python helper Ruff check/format: passed. Release acceptance/profile builds, all 48 accepted timing public-path trials, and all four SQLite/native × samples/raw global-conflict controls: passed. All 195 recorded Rust source/manifest hashes still match the measured source.

Two early validation commands stopped at the known virtual-workspace fmt invocation error (#9); package-scoped fmt corrected them. One earlier parallel native run failed the watcher-suppression assertion in `filesystem_listing_excludes_sidecars_and_watcher_does_not_report_them`. The final complete focused sequential run passed. Its cause was not isolated; the watch implementation is unchanged. This is a follow-up, not a waived test.

No full workspace/release suite, WASM build, consumer deployment, real data, rakku/yari access, push or GitHub action ran. The parent must verify the combined builders, including the browser gzip budget after the additive host method. Owned fixture/SQLite/temp data and standalone binary copies were removed after the final duplicate controls. `APPEND_LITE_DATA_REMOVED True` verified absence. Small logs and Cargo caches remain under `/home/simonwjackson/work/qws-append-lite-results` and the worker target directory on aka.
