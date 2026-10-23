# Measurement design, before optimization

## Decision

Use a separate native example, `lazy_memory_bench`, rather than changing the established time-series fixture. Generate bytes in a preparation process. Open an existing real filesystem fixture in a fresh process per mode. Keep the old example as an independent control.

The v1 fixture has exactly 10 UTC months of 43,000 rows and 316 bytes/line, with 12 flat fields. Time slots cover each actual calendar month, including February. All identifiers and fields are synthetic. The eager control opens 10,000 ID-only rows without an ordered index.

`zero` advances through ten one-month native queries, each keeping zero rows. `ascending` advances through 1–3-month ordered query scopes, returning the matching rows. `scan` performs one 10-month scope and keeps zero rows. No DTO, resolution or application aggregation runs. The timed call is `NativeRuntime::query`, not `query_with_stats`; the latter can add planning work. Status validation after each call checks post-trim residency only and does not claim a transient bound.

## Instrumentation

`bench-observe` enables synchronous process-wide begin/end callbacks at existing boundaries. A `Span` closes on normal return or error. With the feature disabled it is a zero-sized inlined no-op, with no observer, clocks, I/O or data changes. Only the benchmark installs an observer. `heap-profile` additionally selects DHAT as the benchmark executable's allocator; runtime libraries do not install an allocator.

Run three separate optimized binaries with the same debug-symbol profile: default, checkpoint-only, and DHAT. Report performance from the default binary. Callback logs and DHAT timings measure their own overhead; do not mix them into baseline results. DHAT retains profiler metadata outside tracked application allocations, so its RSS is not application residency.

Checkpoints capture cumulative allocated bytes, current live bytes, cumulative global heap high-water, current RSS and cumulative RSS high-water. They do not isolate a per-phase local peak or identify ownership. Nested phase wall times are inclusive and cannot be summed. DHAT allocation stacks and per-site live bytes at the global peak (`gb`) and profile end (`eb`) provide actual ownership evidence. Profile end occurs while the last partition or eager collection is still live. Lifetimes of live blocks end at the profile boundary and are right-censored.

Read includes filesystem recovery. ID validation includes a separate decode, cached source text access, ID checking and dropping its temporary values. Storage decode is separate from schema decode/map construction, but schema construction and input destruction are inseparable in that boundary. Resident engine validation, record insertion and ordered-index maintenance are one native boundary; separate attribution must use actual stack sites, not a subtraction invented from wall time. The whole partition boundary includes source snapshots, callbacks and bucket checks. Engine query includes its actual planner. Eviction includes retained-state work and index deletion.

## Next decisions require evidence

Source inspection shows load-all-then-query-then-trim and snapshot copies. It does not quantify their share. Do not replace them until the committed evidence identifies the larger costs and the semantic audit identifies failure, pinning and append-baseline requirements.

A cache bound is not currently a bound on the working set of a multi-month query or pinned watches. Any later implementation must define these separately. Do not chunk aggregates by assuming floating-point SUM/AVG associativity. Keep callback invocation and record/group order equivalent.

## Feedback cost

A 10×1,000-row DHAT run checks resident and transient allocated-byte limits. It is deliberately red on the original implementation if the measured cost exceeds the target. It is not a replacement for the 43k workload, RSS verification, profiles, correctness tests or full final verification. The heap check uses a 50 MiB absolute transient allowance, so small-scale runs mostly detect resident regressions; full-size runs detect the intended transient budget.
