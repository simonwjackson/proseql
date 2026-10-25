# Index seam: aka evidence

Source: `2cc343303f00211355a135bbc38d7c4fbb8c9c6c`.
The branch includes formats commit `9c866e0f90e4a470bdf3d81f7fc25482b3e97b3d`.
All compilation, tests and measurement ran on aka. No command ran on rakku or yari.

## Reproduce

```sh
bash scripts/qws/aka-run index --x86-64-v2 -- \
  cargo test --release --manifest-path crates/Cargo.toml \
  -p proseql-storage --test streaming_index measure_656k_rows \
  -- --ignored --nocapture
```

The ignored test creates 656,640 synthetic, 11-field records in ten text files.
Each file contains 65,664 rows. Total text size is 208,043,780 bytes.
The fixture is generated immediately before measurement: these are warm-text,
single-trial measurements, not a cold-cache SQLite comparison. The final run
uses the real `FsStorageHost`, not the counted-I/O test wrapper. Temporary text
files are deleted when the test exits. No index or sidecar is written to disk.

## Results

| Operation | Wall time | Resident structure bytes |
| --- | ---: | ---: |
| ID locator build, 656,640 rows | 360.200 ms | 15,762,680 |
| Time index build, one 20,804,378-byte month, stride 1,024 | 89.462 ms | 13,217 |
| ID candidate lookup plus verification read and JSON decode, mean of 1,000 warm hits | 6.499 µs | unchanged |
| Embedded-time routing plus scan of one month | 21.456 ms | 460 bytes for path strings; no membership structure |
| Changed-month generation proof alone | 10.545 ms | unchanged |
| External append refresh, one new row in first month | 22.556 ms | 15,860,984 |

The locator uses 24.005 resident bytes per row, or 15.032 MiB total. Small
post-build appends grow its allocation in 4,096-entry steps, not by doubling
it to 30 MiB. Resident bytes account for structure sizes and allocation
capacities; they are not process RSS or allocator metadata measurements.

Warm ID timing excludes generation checks, directory listing, schema validation
and native runtime locking. The build timing includes checked hashing, scanning
only ID fields, sorting and duplicate verification. Native first-use lookup also
validates covered payloads; its latency is therefore higher than this build
measurement. The native differential tests exercise that complete API path.

Routing can be smaller but is not a valid general substitute. A supplied ID can
contain a time different from the row's `atUtc`. No configured invariant relates
them. Routing alone could miss an ID or a cross-partition duplicate. It was
measured, not adopted.

### Preliminary measurements

The earlier test-only filesystem wrapper measured 457.449 ms for the ID build,
91.712 ms for the time build and 4.406 µs for verified warm hits. With the real
host and the earlier byte-at-a-time prefix hash, the results were 450.373 ms,
95.778 ms and 6.490 µs. The final implementation uses the standard-library
scalar hasher, consistent with the existing native fingerprint implementation.
These runs also differ in framing code; do not interpret the wrapper comparison
as an isolated host-speed measurement.

## Native first-use validation: review follow-up

The review fix prepares the storage decode schema and collection configuration
once per lookup. The validation pass also prepares each normalised file source
once per path, not once per row. Verification prepares it once per candidate.
The row decode, callback and partition checks are unchanged.

```sh
bash scripts/qws/aka-run index --x86-64-v2 -- \
  cargo test --release --manifest-path crates/Cargo.toml \
  -p proseql-native --features bench-observe --test streaming_index \
  first_id_validation_656k_rows -- --ignored --nocapture
```

This public-API test writes the same 656,640 synthetic 11-field rows as the
storage measurement. It uses the six-field parity schema and the real
`FsStorageHost`. Its `streaming_id_validation` span includes the first payload
scan, schema decoding, callback/partition checks and generation checks, but
excludes the ID locator build. The first-lookup measurement includes both.
The observer ignores all other phases; default builds have no observer or
clock. These are single warm-text trials on aka at x86-64-v2, not a SQLite
qualification or an isolated CPU-profile attribution.

| Measurement | Before preparation reuse | After preparation reuse |
| --- | ---: | ---: |
| First-use validation | 2,045.061 ms | 1,807.381 ms |
| Complete first ID lookup | 2,400.666 ms | 2,157.654 ms |
| Mean of 1,000 later ID lookups, all generation checks included | 113.755 µs | 114.311 µs |

Both runs found the requested row and kept the lazy collection's resident
partition list empty. The first-use validation remains the dominant cost;
this change does not claim to meet the first-ID SQLite target. The built-in
path pays this full validation once per source generation; later hits still
validate the returned row. Expected on the Celeron: several times slower. That
is an unmeasured expectation, not a measured multiplier.

The follow-up native differential tests (9 tests), targeted native formatter
check, and clippy with `bench-observe` and `-D warnings` all passed on aka.

## Append-delta correction: 256 touched shards

The synthetic text fixture contains 656,640 ID rows in 256 files. Each file
receives four more rows. File writes and locator construction are outside the
measured interval; the interval contains exactly 256 `record_appended` calls.
All 1,024 new IDs are then located and checked. Both single-trial measurements
ran on aka at x86-64-v2 in release mode, through the real filesystem host.

```sh
bash scripts/qws/aka-run index --x86-64-v2 -- \
  cargo test --release --manifest-path crates/Cargo.toml \
  -p proseql-storage --test streaming_index measure_256_append_calls \
  -- --ignored --nocapture
```

| Measurement | Full-table sort per call | Bounded append delta |
| --- | ---: | ---: |
| 256 calls × 4 rows | 2,718.522 ms | 0.614 ms |
| Resident bytes before calls | 15,817,832 | 15,885,440 |
| Resident bytes after calls | 15,960,936 | 16,028,544 |

The preceding implementation on this branch already reserved bounded growth,
so this comparison does not reproduce the older 31.5 MB doubled table reported
by append. The new implementation removes `shrink_to_fit`, leaves the sorted
base alone during these calls, and searches a small unsorted delta on lookup.
At 4,096 entries and on refresh it sorts only the delta, then linearly merges
it into an exactly reserved base. The additional resident bytes above are the
delta and unknown-ordinal metadata, not another base table. Process RSS and
complete append latency remain the combined acceptance harness's responsibility.

## Custom JSONL codec correction

Custom codecs are supported; they are not rejected at open. Assembly records
the final registry's `borrowed_jsonl_compatible` result in each index state.
Incompatible codecs have no time seek. Their locator decodes each partition
through `decode_append_bytes`, retains only ID hashes and partition locations,
and returns `UNKNOWN_OFFSET`. Changed partitions are re-decoded in full because
an append can change earlier decoded IDs or row cardinality. Each verification
also decodes the candidate partition through the registered codec and schema.

Payload memory is transient and bounded by the largest decoded partition, not
all partitions. This is not the built-in JSONL line-sized bound. A custom
`record_appended` invalidates that partition's membership until codec refresh;
it cannot safely infer decoded IDs from the newly appended text alone.

Both native ID hooks use the shared `IndexState::verify_candidate` helper.
Append must use that helper too; the parent owns its caller update. Never
line-read an `UNKNOWN_OFFSET` candidate. Tests cover a delegating custom codec, a codec that
changes IDs/values/order/cardinality, external append and removal, duplicate
IDs, disabled time seek, and `UNKNOWN_OFFSET` candidates. The append-delta
tests cover lookup before merge, merge order, idempotence across delta/base,
refresh normalization, and bounded resident bytes.

The correction's final checks passed on aka at x86-64-v2: 12 native
integration tests, 15 storage tests, and the native custom-index unit test.
The two storage measurements are ignored in routine runs; the append-delta
measurement was explicitly selected and passed. Targeted native/storage
`cargo fmt --check` and clippy (including `bench-observe`, `-D warnings`)
also passed. The transformed-codec regression first reproduced a missing ID
under Streaming, then passed after partition-level indexing was added.

## Checks and limits

The original index measurement commands ran through `aka-run index --x86-64-v2`:

- `cargo test --manifest-path crates/Cargo.toml -p proseql-storage -p proseql-native --test streaming_index`: 13 storage and 9 native tests passed; the measurement test is ignored in routine runs and passed when explicitly selected.
- `cargo clippy --manifest-path crates/Cargo.toml -p proseql-storage -p proseql-native --lib --test streaming_index -- -D warnings`: passed.
- `cargo fmt --manifest-path crates/Cargo.toml -p proseql-storage -p proseql-native --check`: passed.

The counted-I/O test proves that append refresh hashes the old prefix once and
decodes only the new suffix. A deterministic append during generation checking
must fail with `source-changed`; retry must find both new IDs. A separate test
proves idempotent `record_appended`, including after refresh. Recorded locations
are immediately available with `UNKNOWN_ORDINAL`; refresh replaces it with an
exact ordinal. Callers use locator locations for verification, never ordering.

No end-to-end SQLite speed, peak RSS, open-time or back-to-idle target is
qualified by these numbers. The structure fits a 20 MiB index budget, but total
idle RSS still needs the combined acceptance harness. The first ID read retains
15 MiB of index metadata; this can exceed the post-read retained-memory target
when measured against an unindexed open runtime. First-use reads also pay the
full index build. No target is lowered.

A checked text sidecar or explicit prebuilding can move first-use build work out
of a read, at the cost of sidecar validation or open time. Neither is implemented.
A trusted append token could avoid the 10.545 ms prefix proof, but `FileStat`
has no such token. Compact 16-byte entries with overflow storage could reduce
the 24-byte table; they do not remove build I/O or prefix verification.

## Observable changes and integration notes

- Duplicate IDs can fail earlier: building the locator reads IDs across every
  partition, rather than only those already loaded. This is the timing allowed
  by contract section 5.
- A file change during index construction fails explicitly with
  `OperationError`, reason `source-changed`, instead of publishing mixed-generation
  metadata. This adds a retryable race error, not a snapshot guarantee.
- Hand edits, additions and removals are checked on each lookup. Cached resident
  reads previously depended on the refresh poller to discover external edits.
- `FullScanPolicy::Error` still refuses ID lookup before index use. A locator
  must not be used to bypass this policy.
- Custom JSONL codecs use partition-level verification with `UNKNOWN_OFFSET`.
  No lazy partition is loaded into the resident engine. Positional time seek
  is disabled for these codecs.
- Two method-local dead-code allowances remain on `IndexState::time_index` and
  `id_locator_if_built`, at the parent's request. Remove them when exec and append
  are integrated. The module-wide skeleton allowance was removed.
