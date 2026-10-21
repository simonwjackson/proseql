## ADDED Requirements

### Requirement: Lazy partition policy

`NativeSourceRuntimeOptions.lazy_partitions` SHALL map a source ID to `LazyPartitionPolicy { max_loaded_partitions, full_scan }` with `FullScanPolicy::{Allow, Error}`. The default SHALL be an empty map. The feature SHALL be native only.

#### Scenario: Qualifying source
- **WHEN** a lazy policy names a `Partitioned` JSONL source whose collection has `append_only: true`, no `unique_fields` and no relationships in or out
- **THEN** open lists partition file names and decodes no file

#### Scenario: Non-qualifying source
- **WHEN** a lazy policy names any other source
- **THEN** open fails with `SourceConfigError`

### Requirement: Query-driven loading

A query or aggregate filtered on the partition field (eq, `$in`, range, or a time range through the bucket) SHALL load only the partitions whose key interval can match. Pruning SHALL be conservative.

#### Scenario: One-hour range on a monthly time bucket
- **WHEN** a query filters `timestamp >= A and timestamp < A+1h` inside one month
- **THEN** the native query stats report `partitions_loaded = 1`

#### Scenario: Unfiltered query with full scans allowed
- **WHEN** a query has no partition filter and `full_scan` is `Allow`
- **THEN** the query loads every partition, returns the same results as an eager runtime, and the bound applies again after the query

#### Scenario: Unfiltered query with full scans refused
- **WHEN** a query has no partition filter and `full_scan` is `Error`
- **THEN** the query fails with a typed error and loads nothing

### Requirement: Bounded memory

The runtime SHALL keep at most `max_loaded_partitions` partitions loaded, except during a full scan and for pinned partitions, and SHALL evict the least recently used partition first.

#### Scenario: Eviction
- **WHEN** a query needs a partition and the bound is reached
- **THEN** the least recently used unpinned partition and its indexes are dropped, and a later query reloads it with the same results

#### Scenario: Watch pinning
- **WHEN** a live watch's filter touches a partition
- **THEN** that partition is not evicted while the watch exists

#### Scenario: Uniqueness limit
- **WHEN** a record is created
- **THEN** the ID uniqueness check covers the target partition; wrong-partition and duplicate checks run when a partition loads

#### Scenario: Append into an unloaded partition
- **WHEN** a record is created whose partition file exists but is not loaded
- **THEN** that partition loads for the ID check, exactly the record's line is appended, and the earlier bytes of the file are unchanged

#### Scenario: Append into a new partition
- **WHEN** a record is created whose partition file does not exist
- **THEN** no partition file is read and the new file holds exactly the record's line

### Requirement: Lazy file watching

The managed watch SHALL compare only the directory listing and the loaded partitions of a lazy source with the disk, and SHALL NOT refresh after the runtime's own appends.

#### Scenario: External file
- **WHEN** a partition file appears while the runtime is open
- **THEN** it is listed without being decoded, and it loads when a live watch's filter covers it
