# Computed / Virtual Fields

## Overview

Computed fields are derived values calculated on-the-fly from an entity's stored fields. They appear in query results but are never written to disk. Use cases: display names, age calculations, boolean flags, formatted values, derived status fields.

## Requirements

### Requirement: Declare computed fields in config

Collections SHALL accept a `computed` configuration mapping field names to derivation functions.

#### Scenario: Simple computed field
- **GIVEN** a config:
  ```ts
  books: {
    schema: BookSchema,
    computed: {
      displayName: (book) => `${book.title} (${book.year})`,
    },
    relationships: {},
  }
  ```
- **THEN** query results SHALL include `displayName` on each entity

#### Scenario: Boolean computed field
- **GIVEN** `computed: { isClassic: (book) => book.year < 1980 }`
- **THEN** `isClassic` SHALL be a boolean field in query results

### Requirement: Computed fields in query results

Computed fields SHALL appear in query results alongside stored fields.

#### Scenario: Default inclusion
- **WHEN** a query is executed with no select clause
- **THEN** all stored fields AND all computed fields SHALL be present in results

#### Scenario: Select includes computed
- **WHEN** a query specifies `select: { title: true, displayName: true }`
- **THEN** only `title` and the computed `displayName` SHALL be present

#### Scenario: Select excludes computed
- **WHEN** a query specifies `select: { title: true }` (omitting computed fields)
- **THEN** computed fields SHALL NOT be present (not computed unnecessarily)

### Requirement: Computed fields are read-only

Computed fields SHALL NOT be writable through CRUD operations.

#### Scenario: Create ignores computed
- **WHEN** a create input includes a computed field name
- **THEN** the provided value SHALL be ignored (the computed function determines the value)

#### Scenario: Update ignores computed
- **WHEN** an update includes a computed field name
- **THEN** the provided value SHALL be ignored

### Requirement: Computed fields are not persisted

Computed fields SHALL never appear in serialized file output.

#### Scenario: Save excludes computed
- **WHEN** a collection with computed fields is saved to disk
- **THEN** the file SHALL contain only stored (schema) fields, not computed fields

### Requirement: Computed fields in filtering

Computed fields SHALL be usable in where clauses.

#### Scenario: Filter by computed field
- **GIVEN** `computed: { isClassic: (book) => book.year < 1980 }`
- **WHEN** query has `where: { isClassic: true }`
- **THEN** only books where the computed `isClassic` returns true SHALL be returned

#### Scenario: Computed filter operators
- **GIVEN** a computed string field `displayName`
- **WHEN** query has `where: { displayName: { $contains: "Dune" } }`
- **THEN** standard filter operators SHALL work on computed values

### Requirement: Computed fields in sorting

Computed fields SHALL be usable in sort configurations.

#### Scenario: Sort by computed field
- **GIVEN** `computed: { displayName: (book) => \`${book.title} (${book.year})\` }`
- **WHEN** query has `sort: { displayName: "asc" }`
- **THEN** results SHALL be sorted by the computed display name

### Requirement: Computed fields with populated data

Computed functions SHALL have access to populated relationship data when population is configured.

#### Scenario: Computed from populated data
- **GIVEN** `computed: { authorName: (book) => book.author?.name ?? "Unknown" }`
- **WHEN** query has `populate: { author: true }`
- **THEN** `authorName` SHALL be derived from the populated author entity

#### Scenario: Computed without population
- **GIVEN** the same computed field but no populate in query
- **THEN** `authorName` SHALL handle the missing population gracefully (e.g., "Unknown")

### Requirement: Type safety

Computed field types SHALL be inferred from the return type of the derivation function.

#### Scenario: Type inference
- **GIVEN** `computed: { isClassic: (book: Book) => book.year < 1980 }`
- **THEN** the type of `isClassic` in query results SHALL be `boolean`
- **AND** TypeScript SHALL enforce this in select, where, and sort configurations

## Out of Scope

- Async computed fields (all computations are synchronous)
- Computed fields that depend on other computed fields (no DAG resolution)
- Memoization / caching of computed values
- Indexed computed fields
