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

Final unprofiled qualification, exact consumer pin, timing cost, and combined suite results remain pending. Do not treat the early smoke run as production acceptance. No production data, consumer pin change, push, publication, or service restart is part of these measurements.
