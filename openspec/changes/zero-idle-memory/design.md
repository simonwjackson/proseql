# Explicit source sessions and zero partition retention

## Evidence before implementation

The measurement commit is `7e44d91`. It changes the benchmark, tests, and planning documents, not runtime behavior. The baseline Rust and official TypeScript tasks both pass; logs are under `/home/simonwjackson/.local/share/forgerie/artifacts/proseql-zero-idle-20261024/`.

The real-filesystem 10-month, zero-result, consumer-shaped feedback scan exits 1 because 1,000 decoded rows remain after return. The meter reports 2,344,410 live requested bytes above open, or 2,344.41 B per retained row. Its allocator reports both live and free arena space; this is not an allocator-only symptom. The fixture has 11 fields, 84-character IDs, 48-character raw IDs, and averages 361.5 JSONL bytes per line in this 1,000-row/month sample. The reported production average of 334 B is not forced into these synthetic bytes.

The separate eager ID-only control retains 9,176,650 requested bytes above its pre-open sample for 10,000 rows, or 917.665 B/row. Empty source runtimes request about 13.8 KiB at the opened checkpoint and have about 6.2–6.5 MB RSS in these unprofiled small-fixture runs. Thus neither retained monthly rows nor eager IDs are part of an intrinsic hundreds-of-megabytes process baseline. These measurements do not attribute the production server's allocations.

## Lifecycle contract

Add an explicit durable source-session owner that keeps configuration, callbacks, codecs, and serialization policy between calls, but no loaded runtime. Its session operation constructs the existing source runtime, invokes the caller, closes the runtime, and drops its data before returning. Serialize sessions through the owner, preserving the existing single-owner write rule. Close also releases a closed runtime's data even if a caller retains a clone. Successful source writes are already durable; a failed caller operation keeps its original error while cleanup still runs. Panic unwinding must also run cleanup.

A session is equivalent to explicitly opening and closing a native source runtime. It is not a transparent replacement for a permanently open runtime. Source edits become visible at the next session. Last-known-good state and live watches retain their existing semantics within a session, not across closed sessions. Consumers must put a coherent operation inside one session; do not split an operation that depends on a stable snapshot across sessions. Watch subscriptions need an active runtime session to receive future changes. Caller-owned returned values remain additional memory.

This additive interface avoids changing existing runtime reads, caching defaults, external-edit visibility, or error semantics. A transparent policy that evicted eager state while preserving a cached last-known-good snapshot across arbitrary external edits would need another backing snapshot on disk. That separate disk-cache subsystem is not introduced here. The explicit access contract is a provisional architectural choice recorded in the session decision log; it must be reported as an adoption requirement, not automatic benefit.

All existing durable source loaders remain usable within a session, including collection files, YAML documents, eager partitions, and lazy JSONL partitions. In-memory-only databases are not supported by this source-session interface. Unbounded eager loads remain an active-memory cost and are not described as bounded scans.

## Partition cache and active ownership

Permit `max_loaded_partitions = 0` for the existing eligible append-only JSONL lazy sources. Bounded reads visit transient blocks without selecting a final retained block. Legacy query and mutation paths must trim to zero after the operation, including errors. Active watch pins remain distinct. Dropping the last watch must make its retained data reclaimable without requiring another user query.

Do not turn zero cache into silent full-scan permission, disable exact duplicate detection, weaken write conflicts, or change any query ordering. Positive cache policies remain unchanged.

## Memory budgets

For the synthetic zero-session fixtures, target live requested idle heap no more than the empty configured session owner's live heap plus 64 KiB. Increasing cold history tenfold, with the same source configuration and active working set, must not add more than 64 KiB of live requested idle heap. This is a retained-data bound, not a per-row compactness claim.

Target unprofiled current RSS after 30 seconds at no more than empty-process RSS plus 8 MiB on the qualification host, as a stricter fixture-level goal. Preserve the original scan-return allowance of pre-scan RSS plus 50 MiB as a separate check. Measure RSS independently from the meter. If glibc retains freed pages, provide a clearly named opt-in supported trim policy, capability-check unsupported platforms, and measure its cost. Do not install a global allocator or silently promise the same RSS return with arbitrary custom allocators.

The owner's retained costs are configuration and registered services, not row IDs, row values, indexes, loaded documents, source text, or watcher snapshots. Larger application configuration or callback closures can exceed the fixture budget and must not be attributed to row storage.

## Original handoff targets remain open

Keep the 500 B/loaded consumer row, 300 B/eager ID-only row, bounded peak formula, monthly-load timing, index attribution, native/WASM parity, and consumer compatibility requirements visible. Closing a session does not compact rows while it is active. Report an active-memory target miss and its measured floor separately from zero idle retention. Do not claim completion of the compact-resident-rows handoff if those targets remain unmet.

## Verification status

The full baseline suites and seven fixture/allocator tests pass. The zero-cache conformance test is deliberately red at the existing minimum-one validation. The memory feedback command also fails on actual retained engine rows after a completed scan. The `contract-profile` matrix covers both row shapes and ID-only records at two sizes with 30-second unprofiled idle checks. `contract-sources-retry3` covers collection-file JSONL, writable block YAML documents, 256 raw shards, eager YAML partitions, post-append idle, diagnostic trimming, and tenfold cold-history growth with fixed active rows. Its manifest proves no runtime-source difference from the baseline. DHAT origins are recorded separately.

The earlier source-control attempts are invalid fixture trials, not runtime failures. YAML documents require ID-keyed collection maps and independently writable block sections; YAML collection-file partitions require keyed maps rather than array input. The corrected seven-test fixture check now opens, queries, writes, and rereads every source kind before any long measurement. Keep every failed log. The unprofiled append creates one row; the subsequent meter process reuses that resulting fixture and checks an identical duplicate. Therefore their append timings are not comparable. Final qualification must use independently prepared identical starting bytes.

| Baseline control | Rows retained | Unprofiled idle RSS after 30 s | RSS after diagnostic trim | Meter live requested heap after operation |
|---|---:|---:|---:|---:|
| Collection-file JSONL, 10,000 starting rows | 10,001 | 91,258,880 B | 63,807,488 B | 46,442,206 B |
| Writable YAML documents, 10,000 starting rows | 10,001 | 337,870,848 B | 108,851,200 B | 79,042,196 B |
| Eager YAML partitions, 10,000 starting rows | 10,001 | 179,093,504 B | 87,846,912 B | 47,346,199 B |
| 256 lazy raw shards, 10,000 starting rows | 31 | 8,220,672 B | 8,122,368 B | 165,115 B |
| Ten monthly files, active month fixed at 1,000 rows | 1,000 | 13,250,560 B | 12,304,384 B | 2,365,887 B |
| Hundred monthly files, same active month | 1,000 | 13,336,576 B | 12,394,496 B | 2,387,569 B |

The cold-history live-heap difference is 21,682 B in the existing cache policy. The session-owner target is stricter: no row payload and at most 64 KiB growth. The allocator intervention releases unused pages while substantial live state remains. Neither allocator retention alone nor retained rows alone explains all observed memory.

The small consumer scan DHAT end-live origin buckets include 1,357,000 B storage-schema records, 238,000 B strings originally allocated by JSONL parsing, 288,816 B collection identity/capacity, 189,765 B ordered index, 151,672 B other query-index metadata, and 8,352 B append baselines. For its 1,000 retained rows those index/identity origins cost 288.816, 189.765, and 151.672 B/row respectively. These are allocation-origin buckets, not exclusive timing phases; moved values keep their original allocation site. Raw JSON and classifier outputs remain in the artifact directory. Large-fixture qualification and proof of cleanup after caller errors/unwind belong to implementation verification.
