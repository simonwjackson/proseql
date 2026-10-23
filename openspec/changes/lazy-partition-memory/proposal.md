# Measure and bound lazy partition loading

## Why

The synthetic consumer handoff reports excessive transient memory and slow monthly JSONL loading at runtime source `61a128b5a53c9721f01301990745745c79c139a4`. Its RSS figures do not identify allocation ownership. First preserve a native benchmark and actual allocation profiles; use that evidence to choose changes.

## What changes

- Add a permanent, synthetic, filesystem-backed benchmark with 10 monthly partitions, 43,000 flat 316-byte rows per month, UTC month buckets, append-only writes, an ordered timestamp index and lazy residency 1.
- Preserve independent optimized unprofiled, checkpoint-only and DHAT runs. Include ascending 1–3-month queries, zero-result controls, a 10-month zero-result scope, eager ID-only records and the existing time-series benchmark.
- Add opt-in diagnostic boundaries. Default builds have no observer or clocks. Do not change runtime semantics in the measurement commit.
- Next, use measured facts to bound transient loading, reduce resident allocations and remove repeated decode work without changing persistence, checks or query results. Keep runtime and WASM parity where engine code changes.

## Scope and cost

Targets remain ≤1024 resident heap bytes/row, peak RSS ≤open RSS + twice one month's resident size +50 MiB, and ≤0.5 s/month on this i9-class host. Allocated heap and RSS are distinct; allocator retention is not proved by a difference alone. Multi-month query output and pinned watches require an explicit bound and must not be silently discarded. The profiling feature adds synchronous callback and allocator overhead; its timings are not baseline timings.

No real health data or consumer files enter the fixture. No consumer repository changes. Work item: [#11](https://github.com/simonwjackson/proseql/issues/11). Issue #1 covers a different time-series acceptance target. Bounded reads are opt-in methods, not a silent replacement of the earlier full-scope/watch contract.
