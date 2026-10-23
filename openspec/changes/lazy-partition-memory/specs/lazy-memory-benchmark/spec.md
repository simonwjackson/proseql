## ADDED Requirements

### Requirement: Permanent synthetic memory and decode benchmark

The repository SHALL preserve a native real-filesystem benchmark with ten UTC monthly JSONL files, 43,000 rows per month, 12 flat fields and 316 bytes per line, using append-only records, an ordered timestamp index, `TimeBucket::Month` and lazy `max_loaded_partitions = 1`. It SHALL not read consumer or personal data.

#### Scenario: Workloads and independent measurements
- **WHEN** BEFORE or AFTER evidence is recorded
- **THEN** fresh processes SHALL measure ascending scopes spanning 1–3 months, a ten-month zero-result scope, ten ascending one-month zero-result queries, and a small eager ID-only collection
- **AND** optimized unprofiled timing/RSS SHALL be separate from checkpoint-only and actual allocation profiling runs
- **AND** the existing time-series benchmark SHALL remain available as an independent control

#### Scenario: Honest phase boundaries
- **WHEN** instrumentation is enabled
- **THEN** read, decode, schema reconstruction, resident construction/index build, query and eviction SHALL emit wall/heap checkpoints
- **AND** nested and inseparable phases SHALL be identified, cumulative high-water checkpoints SHALL not be called local peaks, and allocator sites/live bytes/lifetimes SHALL come from an actual heap profile

#### Scenario: No default runtime instrumentation
- **WHEN** the diagnostic feature is disabled
- **THEN** runtime diagnostic spans SHALL have no observer, clock, I/O or allocator change
- **AND** enabling instrumentation without an observer SHALL not change database semantics

#### Scenario: Minimal red-capable memory feedback
- **WHEN** a fixture exceeds 1024 resident heap bytes per monthly row, or allocated heap peaks above open heap plus two such target-sized partitions plus 50 MiB
- **THEN** the benchmark's explicit `--check` mode SHALL return nonzero and preserve measurements
- **AND** resident and transient threshold comparisons SHALL have independent boundary tests

#### Scenario: Evidence identity
- **WHEN** evidence is committed
- **THEN** it SHALL name the production-source SHA, benchmark commit, machine, toolchain, commands, raw artifact paths and hashes
- **AND** no optimization claim SHALL be inferred solely from RSS or a source-code hypothesis
