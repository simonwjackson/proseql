# Property-Based Testing

## Overview

Property-based (fuzz) testing to complement the existing example-based test suite. Schema validation, query filtering, index maintenance, and CRUD operations are ideal candidates — they have invariants that should hold for any input, not just hand-picked examples. Property-based tests can surface edge cases that 1591 hand-written tests miss.

## Requirements

### Requirement: Schema round-trip property

Any value that passes Schema validation SHALL survive encode → decode without data loss.

#### Scenario: Round-trip invariant
- **GIVEN** an arbitrary value generated from a Schema's type
- **WHEN** the value is encoded then decoded
- **THEN** the result SHALL be deeply equal to the original

#### Scenario: Schema rejection
- **GIVEN** an arbitrary value NOT matching a Schema
- **WHEN** decode is attempted
- **THEN** it SHALL fail with ValidationError (never silently corrupt)

### Requirement: Filter consistency property

Filter results SHALL always be a subset of the full collection, and every included entity SHALL satisfy the where clause.

#### Scenario: Filter subset invariant
- **GIVEN** an arbitrary collection of entities and an arbitrary where clause
- **WHEN** a filter query is executed
- **THEN** every returned entity SHALL satisfy the where clause when checked manually
- **AND** no entity excluded from results SHALL satisfy the where clause

#### Scenario: Empty where returns all
- **GIVEN** any collection
- **WHEN** query is called with no where clause
- **THEN** all entities SHALL be returned

### Requirement: Sort ordering property

Sorted results SHALL always satisfy the ordering invariant.

#### Scenario: Sort invariant
- **GIVEN** an arbitrary collection and sort configuration
- **WHEN** a sort query is executed
- **THEN** for every adjacent pair (a, b) in results, `a[sortKey] <= b[sortKey]` (for asc) or `a[sortKey] >= b[sortKey]` (for desc)

#### Scenario: Sort stability
- **GIVEN** entities with duplicate sort key values
- **WHEN** sorted
- **THEN** the relative order of equal elements SHALL be consistent across runs

### Requirement: Index consistency property

Indexes SHALL always agree with the underlying data.

#### Scenario: Index matches full scan
- **GIVEN** an arbitrary sequence of create, update, delete operations on an indexed collection
- **WHEN** a query is run on an indexed field
- **THEN** the index-accelerated result SHALL be identical to a full-scan result

#### Scenario: Index entries match data
- **GIVEN** any state of a collection with indexes
- **THEN** every entity in the collection SHALL appear in exactly the correct index buckets
- **AND** no index bucket SHALL contain IDs of non-existent entities

### Requirement: CRUD invariants

CRUD operations SHALL maintain collection integrity under arbitrary operation sequences.

#### Scenario: Create-then-findById
- **GIVEN** an arbitrary valid entity
- **WHEN** created then retrieved by ID
- **THEN** the retrieved entity SHALL match the created one

#### Scenario: Delete removes completely
- **GIVEN** an entity exists in the collection
- **WHEN** deleted
- **THEN** findById SHALL fail with NotFoundError
- **AND** query SHALL not include the entity

#### Scenario: Unique constraint under concurrent creates
- **GIVEN** a unique constraint on a field
- **WHEN** multiple entities with the same unique value are created
- **THEN** exactly one SHALL succeed and the rest SHALL fail with UniqueConstraintError

### Requirement: Transaction atomicity property

Transactions SHALL be all-or-nothing under arbitrary failure points.

#### Scenario: Rollback restores state
- **GIVEN** an arbitrary sequence of mutations inside a transaction
- **WHEN** the transaction fails at any point
- **THEN** all collection states SHALL be identical to pre-transaction state

### Requirement: Generator infrastructure

Arbitrary value generators SHALL be provided for core types.

#### Scenario: Entity generator
- **THEN** a generator SHALL produce arbitrary entities conforming to a given Schema

#### Scenario: Where clause generator
- **THEN** a generator SHALL produce arbitrary valid where clauses for a given entity shape

#### Scenario: Operation sequence generator
- **THEN** a generator SHALL produce arbitrary sequences of CRUD operations

## Framework

Tests SHOULD use `fast-check` or equivalent property-based testing library compatible with the existing `bun test` / `vitest` setup.

## Out of Scope

- Shrinking / minimization (handled by the framework automatically)
- Performance property tests (covered by benchmarks spec)
- Persistence round-trip properties (would require filesystem mocking at scale)
