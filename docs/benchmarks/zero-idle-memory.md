# Zero-idle source memory

The existing native runtime keeps an active cache. `NativeSourceSessions` adds explicit source lifetimes. It retains configuration and services between operations, not a loaded database. See [native source sessions](../native-sources.md#source-sessions-with-no-idle-row-cache) for adoption and costs.

## Reproduce

Use a clean owned worktree and a fresh artifact directory. Do not delete unrelated files to make the checkout clean.

```sh
EXPECTED_SOURCE_SHA=$(git rev-parse HEAD) ./scripts/profile-lazy-memory.sh build /var/tmp/proseql-idle-evidence
./scripts/profile-lazy-memory.sh idle-feedback /var/tmp/proseql-idle-evidence
./scripts/profile-lazy-memory.sh idle /var/tmp/proseql-idle-evidence
```

`idle-feedback` uses the existing meter executable and real synthetic files. It checks the 64 KiB post-session live-heap allowance across monthly JSONL, collection-file JSONL, writable YAML documents, 256 shards, and eager YAML partitions. It does not qualify process RSS or loaded-row compactness.

`idle` separates unprofiled RSS from allocation-meter heap measurements. It tests both fixtures, large eager IDs, append cleanup, matching output, and tenfold cold-history growth with fixed active rows. Each role starts from independently prepared, byte-identical files. Read-only cases must preserve every input byte. Append cases must change only the expected source file. Primary runs check immediate and 30-second current RSS against empty-process RSS plus 8 MiB and pre-scan RSS plus 50 MiB. Meter runs check idle live heap against owner initialization plus 64 KiB. Unknown metrics and profiled RSS cannot pass those checks. The manifest keeps original compact-peak target misses separate from idle-contract results.

The build saves source SHA, dirty status, patch, and binary hashes. Full idle qualification refuses dirty or mismatched source. `python3 scripts/profile-idle-memory.py --self-test` checks threshold boundaries and invalid-metric rejection. Default timing and RSS must not run beside builds or suites.

## Direct benchmark options

These extend `lazy_memory_bench`; the legacy modes and fixture remain available.

| Option | Meaning |
|---|---|
| `--fixture legacy` | Original 12-field, 316-byte JSONL rows. |
| `--fixture consumer` | Eleven named consumer fields, 84-character IDs, 48-character raw IDs, two metrics, offset timestamps, null end, and numeric value. |
| `--source-kind month\|file\|documents\|sharded\|yaml-partitions` | Exercise the corresponding real storage source. Shards add a `shard` field. |
| `--mode empty` | Empty source control. A session owner does not load source rows. |
| `--mode cold` | One fresh October query, with no November neighbor. Check one physical read. |
| `--cache-partitions 0` | No retained unpinned lazy rows. Does not evict eager collections. |
| `--sessions` | Reopen and close a source session per benchmark operation. |
| `--reclaim-idle` | Explicit Linux GNU trim policy at session end. Matching-output runs also call the supported caller hook after dropping results. |
| `--idle-check` | Check actual engine rows for an ordinary runtime, or the 64 KiB measured idle allowance for sessions. Session checks require a meter or active DHAT profile. |
| `--idle-seconds 30` | Record current RSS immediately and after 30 seconds. |
| `--append-one` | Commit one synthetic record before the idle endpoint. |
| `--history-copies 9` | Add 90 older monthly files without changing the ten active months or their rows. |

The consumer list has 11 fields. The workflow's earlier claim of 12 was a counting error. This synthetic fixture averages 361.5 JSONL B/row at 1,000 rows/month. It preserves the specified lengths and types instead of forcing the external report's 334-byte average. The original 500 B loaded-row target remains unchanged.

Session initialization is not an eager open: it defers source I/O to session open. Session query wall time includes reopening, querying, close, and selected allocator reclamation. `LM_CALLER_RECLAIM` records the separate explicit hook after caller-owned results drop. A session cannot reclaim results while the caller still owns them. Do not compare initialization time alone or call lower idle heap a faster load.

## Measured baseline

Local baseline runtime sources match tested pin `9a11d3665bcc881c568ee1d77d81596543c6ac07`. Raw evidence is under `/home/simonwjackson/.local/share/forgerie/artifacts/proseql-zero-idle-20261024/` in `contract-profile` and `contract-sources-retry3`. The manifests retain instrumentation patches and executable hashes. Earlier failed fixture trials remain preserved and are not runtime failures.

| Synthetic control | Retained rows after operation | Unprofiled RSS after 30 s | After diagnostic trim | Meter live requested heap |
|---|---:|---:|---:|---:|
| Collection-file JSONL, 10,000 starting rows | 10,001 | 91,258,880 B | 63,807,488 B | 46,442,206 B |
| Writable YAML documents, 10,000 starting rows | 10,001 | 337,870,848 B | 108,851,200 B | 79,042,196 B |
| Eager YAML partitions, 10,000 starting rows | 10,001 | 179,093,504 B | 87,846,912 B | 47,346,199 B |
| Lazy monthly scan, 1,000 rows/month | 1,000 | 11,141,120 B | Not intervened | 2,365,867 B |

The append control's meter process reused the first process's resulting file and retried the identical append. Their append timings are not comparable. Final qualification uses separate identical starting files.

The small consumer scan DHAT profile attributes 288.816 B/retained row to collection identity/capacity, 189.765 B to the ordered index, and 151.672 B to other query-index metadata. These are disjoint allocation-origin buckets, not isolated phase timings. The raw profile and classifier outputs remain available. A 10,000-row eager ID control measured 917.665 requested B/row. Empty native controls used about 13.8 KiB of requested heap and 6.2–6.5 MB unprofiled RSS.

## Implementation observations and remaining targets

Early meter-only smoke runs across all five source kinds returned to about 3,215 live requested bytes above owner initialization. Their RSS is instrumented and is not acceptance evidence. Actual 8,192-byte payload counters also cover returned outputs, repeated reads, writes, errors, poisoned and quarantined sessions, watch release under contention, and concurrent source sessions.

A failed 1,024-create callback batch freed its records but retained a 303,104-byte event-vector capacity. The regression now measures total live bytes as well as payload allocations. Failed batches replace that vector instead of keeping its capacity.

Closing a session does not compact active records. The canonical `(String, Value)` pairs alone cost 1,056 B for 11 fields on this native build, before strings, maps, and indexes. The original 500 B consumer-row and 300 B eager-ID targets are not achieved by lifecycle cleanup. `--layout-only --fixture consumer` and the retained-runtime meter control report active representation costs separately. Idle summaries deliberately leave loaded-row density null.

The alternative for lower active memory is a compact record store with borrowed field access and compatible owned materialization. It requires engine/query/mutation/watch and WASM parity work. Large owned output also needs its own memory allowance or streaming interface. No such representation or output-contract change is included here.

## Qualified measurements and blocked release

The implementation at `23c0f2dd5111d80f6b5139a92b94d121f8102832` passed the complete idle matrix. Evidence is in `build-memory-23c0f2d/idle/manifest.json` under the artifact root above. Each role used separate, byte-identical synthetic files. No builds or suites ran beside these measurements.

All nonempty meter cases ended 3,215 requested bytes above owner initialization. Final requested heap ranged from 9,722 to 14,598 B. The tenfold cold-history comparison added zero idle bytes. These are idle-owner costs, not loaded-row density.

| Source or workload | Unprofiled open RSS | Immediate idle RSS | RSS after 30 s | Peak RSS | Final requested heap in separate meter process |
|---|---:|---:|---:|---:|---:|
| Collection-file JSONL, read and append | 6,029,312 B | 7,299,072 B | 7,368,704 B | 119,263,232 B | 11,902 B |
| Writable YAML documents, read and append | 7,155,712 B | 8,626,176 B | 8,634,368 B | 346,529,792 B | 11,981 B |
| Eager YAML partitions, read and append | 5,931,008 B | 7,712,768 B | 7,716,864 B | 179,412,992 B | 11,817 B |
| Legacy 430,000-row scan | 5,984,256 B | 7,192,576 B | 7,258,112 B | 161,206,272 B | 13,538 B |
| Consumer 653,480-row scan | 6,115,328 B | 7,229,440 B | 7,303,168 B | 326,209,536 B | 13,454 B |
| Consumer matching-output sequence | 6,172,672 B | 7,245,824 B | 7,311,360 B | 785,596,416 B | 13,465 B |
| Eager 139,420 IDs | 5,955,584 B | 7,069,696 B | 7,135,232 B | 359,804,928 B | 9,722 B |

The empty configured owner used 6,176,768 B after 30 seconds. Every primary case met both RSS limits. Matching-output cases explicitly dropped each output and called `release_unused_memory()`. The largest unprofiled consumer output-reclaim call took 38.57 ms. The session cannot reclaim caller-owned rows while they remain live.

Allocator-owned address space and resident pages are different. The consumer scan ended with 217,628,672 allocator-owned bytes, counting arenas plus mmap allocations. Requested live heap was 13,454 B in the separate meter run. Current unprofiled RSS was 7,303,168 B. glibc can discard physical pages while retaining allocator address space. Do not report arena bytes as current RSS.

### Active records and index origins

`active-controls-build-final-code-retry1` compares the unmodified `9a11d36` runtime with this implementation. Both use the same added cold-query benchmark code. The baseline omits only the unsupported session module. Its manifest proves that runtime source directories did not change. Five alternating unprofiled trials query October first and report one partition read. Allocation runs are separate.

| Control | Baseline requested B per loaded row | Candidate requested B per loaded row | Original target |
|---|---:|---:|---:|
| Legacy 12-field, 43,000 rows | 2,105.11 | 2,105.11 | Keep the original fixture visible. |
| Consumer 11-field, 65,348 rows | 2,327.57 | 2,327.57 | At most 500 B. Not achieved. |
| Eager ID-only, 139,420 rows | 943.02 | 943.02 | At most 300 B. Not achieved. |

The large consumer DHAT control attributes 284.58 B/row to collection identity and capacity, 189.61 B/row to ordered indexes, and 150.19 B/row to other query-index metadata. Baseline and candidate values are identical. The identity bucket is not an isolated primary-index measurement. The disjoint classifier retains unclassified sites. No index compaction is included.

| Cold load control | Baseline median | Candidate median | Strict no-slower result |
|---|---:|---:|---|
| Legacy, 43,000 rows | 424.42 ms | 434.39 ms | Missed by 2.35%. |
| Consumer, 65,348 rows | 714.25 ms | 708.98 ms | Met in these five trials. |

These trials do not establish statistical significance. They measure a cold engine over prepared files, not a cold OS page cache. Session wall time also includes reopening, closing and reclamation. For example, the unprofiled consumer ten-month scan took 7,496.98 ms at this source.

Both scans met the peak formula using their measured resident-row sizes. The legacy bound was 239,452,638 B. The consumer bound was 362,748,214 B. They missed the tighter bounds that assume 500 B rows, respectively 101,413,056 B and 123,892,128 B. Do not call the measured-row bound a compact-row result.

A cold-query diagnostic initially recorded the first resident sample only when the month was January. The retained-row controls used the actual final engine row count instead. The benchmark now selects the first query by ordinal, including an October cold query. Failed measurement-driver trials remain preserved.

### Verification and adoption status

At `23c0f2d`, the full Rust run passed 1,182 tests with two ignored tests. Static checks, WASM, typecheck and lint passed. Disposable Logbook and Coach checkouts built and passed 205 and 27 tests. Logbook used `a61a45c8dc4abdc91df7cfdd694e81ccf45089df`. Coach used `06719890e27212cf61fa77987dc4432cd68f1dd4`. Their real manifests and pins did not change.

Combined release acceptance is blocked. The last TypeScript run had 3,992 passes, two skips and 102 failures. Parity examples and real-browser startup also failed. Fresh Node and Bun processes reproduced file-watch creation failures. Node reported `ENOSPC`. Bun reported `EINVAL`. The host watch limit was 524,288. A Forgerie Node process reported 524,142 watch entries. No limit or service was changed. Earlier complete passing gates at `96fe022` do not qualify a later source.

Contract and standards passes were performed separately by the implementation author. They were not independent reviews. Supplementary lifecycle tests still use private synchronization and cleanup assertions. The main payload regressions use public methods and real files.

This change is idle-lifetime support, not completion of the original compact-record handoff. Logbook needs explicit coherent session boundaries to benefit. A dependency pin alone does not release its eager state. Sessions reread durable sources and do not retain last-known-good state across boundaries. Keep a session open for related operations and active watches. Returning large owned output still raises peak memory.

Final receipts must name the exact checked-out source. Do not land while mandatory gates fail. No production data, consumer pin change, push, publication, deployment, or service restart is part of this work.
