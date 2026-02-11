# Full-Text Search

## Overview

A lightweight full-text search capability for querying string fields by natural language terms. Not a replacement for Elasticsearch — this is purpose-built for searching through hundreds to tens of thousands of records in plain text files. Tokenization, term matching, and basic relevance scoring.

## Requirements

### Requirement: $search operator

A `$search` filter operator SHALL perform full-text search on string fields.

#### Scenario: Basic search
- **WHEN** query has `where: { title: { $search: "left hand darkness" } }`
- **THEN** results SHALL include entities where the `title` field contains matching terms
- **AND** "The Left Hand of Darkness" SHALL match

#### Scenario: Case insensitive
- **WHEN** searching for "DUNE"
- **THEN** "Dune" SHALL match (search is case-insensitive by default)

#### Scenario: Partial term matching
- **WHEN** searching for "neuro"
- **THEN** "Neuromancer" SHALL match (prefix matching)

#### Scenario: Multi-term search
- **WHEN** searching for "dark hand"
- **THEN** entities containing both "dark" and "hand" SHALL rank higher than those with only one term

### Requirement: Multi-field search

Search SHALL support querying across multiple fields simultaneously.

#### Scenario: Search across fields
- **WHEN** query has `where: { $search: { query: "herbert dune", fields: ["title", "author"] } }`
- **THEN** results SHALL match against both `title` and `author` fields

#### Scenario: Default all string fields
- **WHEN** `fields` is omitted from `$search`
- **THEN** all string fields on the entity SHALL be searched

### Requirement: Relevance scoring

Search results SHALL be ranked by relevance when no explicit sort is provided.

#### Scenario: Relevance sort
- **WHEN** a `$search` query is executed without a `sort` clause
- **THEN** results SHALL be ordered by relevance score (best match first)

#### Scenario: Explicit sort overrides relevance
- **WHEN** a `$search` query includes `sort: { year: "desc" }`
- **THEN** results SHALL be sorted by year, not relevance

#### Scenario: Score factors
- **THEN** relevance scoring SHALL consider:
  - Term frequency (more occurrences = higher score)
  - Field match (match in shorter fields scores higher)
  - Term coverage (more query terms matched = higher score)

### Requirement: Tokenization

Text SHALL be tokenized into searchable terms.

#### Scenario: Whitespace tokenization
- **GIVEN** "The Left Hand of Darkness"
- **THEN** tokens SHALL be: ["the", "left", "hand", "of", "darkness"]

#### Scenario: Punctuation handling
- **GIVEN** "Gibson, William"
- **THEN** tokens SHALL be: ["gibson", "william"] (punctuation stripped)

#### Scenario: Stop words (optional)
- **THEN** common stop words (the, a, an, of, in, etc.) MAY be excluded from indexing
- **AND** stop word filtering SHALL be configurable (on by default)

### Requirement: Search index

An optional in-memory search index SHALL accelerate full-text queries.

#### Scenario: Indexed search
- **GIVEN** a collection config with `searchIndex: ["title", "author"]`
- **WHEN** a `$search` query targets indexed fields
- **THEN** the search SHALL use the index instead of scanning all entities

#### Scenario: Index maintenance
- **WHEN** a CRUD mutation modifies an indexed field
- **THEN** the search index SHALL be updated automatically

#### Scenario: Unindexed search
- **WHEN** `$search` is used on fields without a search index
- **THEN** the search SHALL fall back to a full scan with on-the-fly tokenization

### Requirement: Combined with other filters

`$search` SHALL compose with other where clause operators.

#### Scenario: Search with filter
- **WHEN** query has `where: { title: { $search: "dark" }, year: { $gt: 1960 } }`
- **THEN** results SHALL match the search AND the year filter

#### Scenario: Search with $and/$or
- **WHEN** `$search` is used inside `$or` or `$and` clauses
- **THEN** it SHALL compose correctly with other conditions

## Types

```typescript
// Field-level search
type FieldSearch = {
  $search: string  // simple search terms
}

// Multi-field search (top-level)
type MultiFieldSearch = {
  $search: {
    query: string
    fields?: ReadonlyArray<string>  // defaults to all string fields
    fuzzy?: boolean                  // allow typo tolerance (default false)
  }
}
```

## Out of Scope

- Stemming / lemmatization (no linguistic analysis)
- Faceted search
- Fuzzy matching with edit distance (could be added later)
- Search highlighting (marking matched terms in results)
- Persistent search index (rebuilt on load from data)
