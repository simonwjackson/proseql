# Design and measurement boundary

The contracts are GitHub #12 and #13, read in full including comments, and the 2026-10-24 source brief in Logbook. Base engine SHA: `61c4322e87df90c76daa4a4798556a55c7214151`. Machine overrides in #13 and the assignment take priority over the older brief.

## Stage 0

Keep a standalone benchmark crate under `bench/stage0`, outside the production Cargo workspace. It links the unmodified native runtime by path and rusqlite with bundled SQLite. A shared deterministic generator writes both month-partitioned samples and hash-sharded raw records. SQLite imports those exact JSONL records; all implementations return canonical counts, checksums and daily sums for comparison. Unit/integration checks must exercise actual storage, not mocked readers.

The scanner reuses a line buffer, borrows JSON string fields, skips unneeded fields through serde, pushes down time/metric predicates, folds daily sums, and uses sparse time-to-byte offsets. This is a restricted workload implementation, not a second production engine. It does not establish semantic parity for arbitrary predicates, schema transformations or callbacks. Sparse sidecars are disposable benchmark artifacts validated against file metadata; production invalidation needs a stronger, explicitly reviewed contract.

Use separate timing/RSS and counting-allocator builds. SQLite's own allocator statistics cover C allocations, which Rust's global allocator cannot see. Keep them separate rather than pretend the Rust counter measures SQLite's entire heap. Cache residency is measured for fixture files, not system-wide Cached or cgroup memory, and must not be added to RSS as if both were disjoint.

Cold runs request eviction only of owned fixture files with `posix_fadvise(DONTNEED)` after syncing. Record actual resident pages before/after so incomplete eviction is visible. Warm runs prime the same operation in the same process; explicitly distinguish this from merely warming disk pages. Append trials start from independent identical bytes. No cache drops, sudo, consumer data or production services.

## Candidate architecture (subject to evidence and user approval)

A shared scalar query executor accepts borrowed rows from format-specific readers and owns only selected outputs and aggregate state. JSONL readers seek through sparse positional indexes, while browser hosts supply byte chunks without mmap. YAML retains document-level parsing and write-safety boundaries until a compatible incremental reader is proven. Unsupported streaming plans retain a bounded compatible fallback during migration, never a silent behavior change.

Index validity, source fingerprints and generation IDs belong to the source host. Writes publish source bytes and derived metadata consistently. Exact duplicate checks verify source records after compact membership probes. Watches keep event/snapshot ownership explicit. Do not infer absence from a Bloom filter positive, change stable tie order, regroup f64 sums or weaken rollback to meet a benchmark.

Level 2 is conditional on measured level-1 misses and a separate user decision on the README wording. The final report records proposed wording, costs, stages and updated effort. No production implementation is authorized by this document.
