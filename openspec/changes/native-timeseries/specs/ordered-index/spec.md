## ADDED Requirements

### Requirement: Ordered index declaration

`CollectionDescriptor.ordered_indexes` SHALL list fields that get an ordered index. It SHALL default to empty and SHALL be omitted from serialized descriptors when empty. TypeScript `packages/engine` SHALL accept `orderedIndexes?: ReadonlyArray<string>`.

#### Scenario: Old descriptor JSON
- **WHEN** a descriptor without `ordered_indexes` is deserialized and serialized again
- **THEN** the JSON is byte-identical

### Requirement: Range planning

The query planner SHALL use an ordered index to narrow candidates for `$gt`, `$gte`, `$lt`, `$lte` and between-style filters on the indexed field, and to order results when sorting on that field. Results SHALL be identical to the unindexed path.

#### Scenario: One-hour range
- **WHEN** a query filters `timestamp >= A and timestamp < A+1h` on an ordered-indexed `timestamp`
- **THEN** only matching candidates are visited and the native query stats report `index_used = ordered`

#### Scenario: Same results without the index
- **WHEN** the same range query runs with and without the ordered index, including mixed value types, missing fields, ties and pagination
- **THEN** both return the same records in the same order

#### Scenario: Maintenance
- **WHEN** records are created, updated, deleted or a transaction rolls back
- **THEN** the ordered index matches the collection state

#### Scenario: Legacy core
- **WHEN** the legacy TypeScript core receives `orderedIndexes`
- **THEN** it accepts the setting, does not use it for planning, and returns the same results
