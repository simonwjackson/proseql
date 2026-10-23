## 1. Track A — Permanent benchmark and allocation evidence

- [x] 1.1 Preserve the synthetic 10×43k monthly JSONL workload and small eager ID-record control as a separate native example; add opt-in nested read/decode/schema/resident-construction-and-index/query/eviction checkpoints with zero default instrumentation cost; validate generated flat 12-field 316-byte UTC rows and independent resident/transient failure thresholds; run optimized unprofiled, checkpoint-only and DHAT profiles through real filesystem sources at lazy max=1, ascending 1–3-month windows and zero-result controls, plus the original time-series workload; save raw artifacts outside Git with hashes, source identity, machine/toolchain, commands, measured phase boundaries, allocation sites/live bytes/lifetimes and ranked falsifiable hypotheses in committed evidence; label inseparable phases and overhead, and leave all runtime behavior unchanged. Evidence: measured benchmark `941978d`, `docs/benchmarks/lazy-memory.md` and `lazy-memory-before-manifest.json`; all four new workload assertions passed, feedback is intentionally red, and original 140k/10M completed while 1M aborted under the unchanged shared-host memory guard (quiet-host repeat pending).

## 2. Track B — Bounded native residency (blocked by Track A) (parallel with Track C + D)

- [x] 2.1 Use measured overlap and the semantic audit to specify and implement a bounded native partition-loading protocol, including multi-month scopes, pinning, error and last-known-good behavior, dirty append baselines and source snapshots; prove its actual live-record/transient bound with a red-capable allocator/residency test and query-result parity rather than status-after-trim alone, preserving append-only writes, ordered query order, duplicate diagnostics, wrong-bucket checks and watch/reload behavior; document unavoidable pinned/query-output costs and exact limits in `docs/native-sources.md`, and rerun focused benchmark modes against the preserved BEFORE data.

## 3. Track C — Decode once and move validated records (blocked by Track A) (parallel with Track B + D)

- [x] 3.1 Use the measured decode/schema allocation sites to remove redundant JSONL parse and owned-value reconstruction only where equivalent validation can be proved; keep strict parsing, duplicate and missing-ID errors, torn/unterminated-line recovery, migrations, callback schemas, defaults, unknown fields, NumberFromString, derived IDs and partition validation equivalent; add focused native/storage and cross-runtime conformance cases where shared engine behavior changes, preserve on-disk bytes and YAML write safety, and report actual per-row decode cost and phase boundaries without assigning nested costs twice.

## 4. Track D — Reduce resident row allocations (blocked by Track A) (parallel with Track B + C)

- [x] 4.1 Rank the measured resident record, key, identity and index allocations; implement the narrowest compatible reduction toward ≤1024 resident bytes/flat row, preserving inspectable fields and the canonical boundary value contract rather than opaque payloads or a second database representation; prove query, ordered-index, mutation, rollback and subscription semantics in engine conformance and native/WASM parity tests, measure eager ID-only and monthly row controls independently, and document the achieved floor and remaining costs without quietly lowering targets.

## 5. Track E — Combined verification and consumer handoff (blocked by Track A + B + C + D)

- [ ] 5.1 On the combined source run all Rust and TypeScript suites, typecheck, lint and formatting, native/WASM parity checks and synthetic Coach compatibility (never the script's default real-data copy), build the pinned consumer using a target override without editing Coach, rerun the original benchmark and all new optimized unprofiled/profiled workloads at the measured hardware shape, compare BEFORE/AFTER allocation profiles and per-phase timing/RSS/resident/transient costs against unchanged targets, test the minimal memory feedback command both green and deliberately red, document remaining limits and publication/deployment availability, and publish the exact tested source SHA, benchmark SHA, evidence manifest and consumer pin/configuration guidance; coordinator owns this full verification, not Track A.

## Implementation evidence and remaining coordinator gate

Tracks B/C/D: measured runtime/example `11174f90488bad79e0f39cd7a76af28b9a097406`;
see `docs/benchmarks/lazy-memory.md` and `lazy-memory-after-manifest.json`.
Canonical monthly residency is 2105.1 requested B/row, not the 1024 target.
Full-zero scan RSS meets the formula with the measured retained-heap reference;
zero-sequence and all-match ascending RSS miss it. The stricter target-sized
formula misses in all three modes. Five actual fresh-runtime single-file 43k
loads exceed 500 ms. The report preserves the initial scan wall regression and
adds repeat wall/CPU ranges. The retained public canonical payload floor is
1651 B; a compact structured/borrowed API is a separate compatibility redesign,
not proven impossible. Phase-local requested heap is measured; local RSS peaks
remain unmeasured. Existing time-series controls all complete with append and
ordered-index assertions intact. Focused checks pass. Track E stays unchecked:
the coordinator owns the one combined full suite, final SHA and synthetic
consumer build. No consumer pin, disk layout or service changed in this child.
