# Durable source sessions

## Added requirement: explicit source lifetime

A native source-session owner MUST retain configuration and registered services only while idle. Creating the owner MUST validate configuration without decoding source rows. Opening a session MUST use the existing strict source loader. Source load failures MUST be returned by session open, not hidden behind an empty collection.

The owner MUST serialize sessions. A reentrant session on the owning thread MUST fail explicitly instead of deadlocking. Session state MUST NOT survive a completed session. Cleanup MUST run on successful return, caller errors, loader errors, and panic unwinding. A failed operation's original error MUST take priority over an additional close error.

A session MUST expose the existing native query, aggregate, cursor, guarded mutation, reload, and watch interfaces without reimplementing database semantics. Ending a session MUST release engine rows, primary and secondary indexes, source records, source text, and retained internal snapshots. A retained clone of an ended runtime MUST be closed and MUST NOT retain its source rows. Caller-owned outputs and delivered watch values are separate owners.

A session boundary explicitly means reopening durable sources. The existing long-lived runtime MUST retain its current cached-state and last-known-good contracts. A session MUST preserve last-known-good and watch semantics while it is active. Closed sessions MUST NOT pretend to provide live subscriptions or a last-known-good snapshot for a later session. Documentation MUST state this adoption cost.

### Scenario: eager and lazy sources

Given synthetic collection-file JSONL, YAML documents, eager YAML partitions, monthly lazy samples, and 256 raw shards, when a session reads and returns no caller-owned rows, the actual tracked payload allocations MUST return to zero. Repeat the operation and verify the durable results again. Partition counters alone are insufficient evidence.

### Scenario: returned results

When a caller retains returned rows, tracked allocations MUST show those rows as live. Dropping them after session close MUST release them. Do not count caller-owned results as an internal idle cache or omit them from peak memory.

### Scenario: writes and failure

A session MUST durably commit valid writes before returning success. Reopening MUST reproduce them. Duplicate creation, malformed source input, failed mutations, and unwind cleanup MUST leave no internal retained payloads. Failed writes MUST preserve existing rollback and quarantine behavior. YAML rewrite safety and original source bytes remain covered by existing conformance tests.

## Added requirement: measured idle budget

On the synthetic qualification fixtures, live requested idle heap MUST be no more than the empty configured owner plus 64 KiB. Tenfold cold-history growth with the same active working set MUST add no more than 64 KiB of live requested idle heap. Attribute configuration and registered-service costs separately from data.

The unprofiled qualification target is current RSS within empty-process RSS plus 8 MiB after 30 seconds, with the original pre-scan RSS plus 50 MiB target reported separately. Current RSS, maximum RSS, live requested heap, and allocator-owned memory MUST be measured separately. Any supported allocator reclamation policy MUST be explicit, capability-checked, and measured for cost. A trim call does not prove absence of live rows.

The original handoff's active-row and timing targets MUST remain visible. Closing a session MUST NOT be reported as achieving compact loaded rows. No target can be silently weakened.

## Added requirement: zero lazy partition cache

Eligible lazy JSONL sources MUST accept `max_loaded_partitions = 0`. Existing positive policies MUST retain their behavior. Bounded reads MUST use transient blocks and leave no unpinned rows resident. Legacy query, aggregate, cursor, and mutation operations MUST trim to zero after completion and error cleanup. Exact cross-partition duplicate checks and full-scan permission MUST remain unchanged.

Active watches MAY pin their required partitions and snapshots. Dropping a watch MUST release its pins and make its payloads reclaimable without another user query. A watch dropped during an active operation MUST not deadlock or lose its release request.

## Compatibility and exclusions

Persisted source record formats MUST remain byte-compatible. Rust MUST remain the only database engine. Existing NativeRuntime defaults, Promise/Effect interfaces, and TypeScript/WASM semantics MUST remain unchanged. Consumer builds MUST use source overrides without modifying real consumer manifests or pins. Non-persistent in-memory databases are outside the durable zero-cache guarantee. A custom host or callback that itself retains data MUST be reported as separately owned memory, not hidden inside a zero-cache claim.
