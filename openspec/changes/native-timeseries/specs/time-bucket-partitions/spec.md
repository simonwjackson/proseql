## ADDED Requirements

### Requirement: Time-bucket partition key

`PartitionKey::TimeBucket { field, bucket }` with `TimeBucket::{Year, Month, Day}` SHALL derive the partition key `YYYY`, `YYYY-MM` or `YYYY-MM-DD` from a UTC timestamp string that matches `YYYY-MM-DDTHH:MM:SS(.f+)?Z`. The TypeScript shared source config SHALL accept `{ kind: "timeBucket", field, bucket: "year" | "month" | "day" }`.

#### Scenario: Monthly bucket
- **WHEN** a record with `timestamp: "2026-04-01T08:15:00.123Z"` is created in a source partitioned by `TimeBucket { field: "timestamp", bucket: Month }`
- **THEN** the record is stored in `<root>/2026-04.<format>` without a redundant `month` field

#### Scenario: Rejected timestamp on write
- **WHEN** the field is missing, not a string, has an offset other than `Z`, or does not match the pattern
- **THEN** the write fails with `SourceConfigError` before any file changes

#### Scenario: Rejected timestamp or wrong partition on load
- **WHEN** a partition file holds a record with an invalid timestamp or a record whose bucket is not the file key
- **THEN** open fails with `SourceConfigError` naming the file

#### Scenario: Parity
- **WHEN** native, WASM and legacy core runtimes store the same records with the same time-bucket key
- **THEN** they place every record in the same file
