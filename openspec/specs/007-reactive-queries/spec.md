# Reactive Queries

## Overview

Reactive queries (subscriptions) allow consumers to observe live query results that automatically update when underlying data changes. When a mutation affects entities matching a query's where clause, subscribers receive the updated result set without re-querying. This is the key differentiator for a file-backed database — edits to YAML/JSON files (by humans, scripts, or other tools) can trigger live UI updates.

## Requirements

### Requirement: Watch a query

Collections SHALL provide a `watch()` method that returns a reactive subscription to a query's result set.

#### Scenario: Basic watch
- **WHEN** `db.books.watch({ where: { genre: "sci-fi" } })` is called
- **THEN** it SHALL return a `Subscription<T[]>` that emits the current result set immediately
- **AND** re-emits whenever the result set changes

#### Scenario: Watch with full query config
- **WHEN** `watch()` is called with where, sort, select, populate, limit, offset
- **THEN** the subscription SHALL apply the full query pipeline on each update

### Requirement: Mutation-triggered updates

CRUD mutations SHALL notify relevant subscriptions.

#### Scenario: Create triggers watch
- **GIVEN** a watch on `{ where: { genre: "sci-fi" } }`
- **WHEN** a book with `genre: "sci-fi"` is created
- **THEN** the subscription SHALL emit a new result set including the new book

#### Scenario: Irrelevant mutation does not trigger
- **GIVEN** a watch on `{ where: { genre: "sci-fi" } }`
- **WHEN** a book with `genre: "romance"` is created
- **THEN** the subscription SHALL NOT emit (no change to the result set)

#### Scenario: Update triggers watch
- **GIVEN** a watch on `{ where: { genre: "sci-fi" } }`
- **WHEN** a sci-fi book's title is updated
- **THEN** the subscription SHALL emit with the updated entity

#### Scenario: Entity enters result set
- **GIVEN** a watch on `{ where: { genre: "sci-fi" } }`
- **WHEN** a fantasy book's genre is updated to "sci-fi"
- **THEN** the subscription SHALL emit with the new entity included

#### Scenario: Entity leaves result set
- **GIVEN** a watch on `{ where: { genre: "sci-fi" } }`
- **WHEN** a sci-fi book's genre is updated to "fantasy"
- **THEN** the subscription SHALL emit without that entity

#### Scenario: Delete triggers watch
- **GIVEN** a watch on `{ where: { genre: "sci-fi" } }`
- **WHEN** a sci-fi book is deleted
- **THEN** the subscription SHALL emit without the deleted entity

### Requirement: File change-triggered updates

When the file watcher detects external changes, relevant subscriptions SHALL be notified.

#### Scenario: External file edit
- **GIVEN** a watch on a persistent collection
- **WHEN** the underlying file is edited externally (e.g., by a text editor or git pull)
- **THEN** the file watcher reloads the data
- **AND** all subscriptions on that collection SHALL re-evaluate and emit if results changed

### Requirement: Transaction batch updates

Subscriptions SHALL NOT emit intermediate states during a transaction.

#### Scenario: Transaction batching
- **GIVEN** a watch on books
- **WHEN** a transaction creates 3 books and commits
- **THEN** the subscription SHALL emit exactly once with all 3 books included (not 3 separate emissions)

### Requirement: Subscription lifecycle

Subscriptions SHALL be cancellable and resource-safe.

#### Scenario: Unsubscribe
- **WHEN** a subscription's `unsubscribe()` is called
- **THEN** no further emissions SHALL occur
- **AND** the subscription SHALL be cleaned up from internal tracking

#### Scenario: Effect-based subscription
- **WHEN** a subscription is created within an Effect Scope
- **THEN** the subscription SHALL be automatically cleaned up when the Scope closes

### Requirement: Subscription API

The subscription SHALL support both Effect Stream and callback-based consumption.

#### Scenario: Effect Stream API
- **WHEN** `db.books.watch(config)` is called
- **THEN** it SHALL return an `Effect` producing a `Stream<ReadonlyArray<T>>` that emits result sets

#### Scenario: Callback API
- **WHEN** `db.books.watch(config).subscribe(callback)` is called
- **THEN** the callback SHALL be invoked with each new result set
- **AND** it SHALL return an unsubscribe function

### Requirement: Debounced emission

Rapid mutations SHALL be coalesced to avoid excessive re-computation.

#### Scenario: Mutation burst
- **WHEN** 100 mutations occur within 10ms
- **THEN** the subscription SHALL emit at most once (after debounce settles)
- **AND** the debounce interval SHALL be configurable

### Requirement: Watch single entity

A convenience method SHALL watch a single entity by ID.

#### Scenario: watchById
- **WHEN** `db.books.watchById("1")` is called
- **THEN** it SHALL emit the entity's current state
- **AND** re-emit on updates
- **AND** emit a terminal signal (or null) on deletion

## Out of Scope

- Cross-process reactive queries (e.g., WebSocket broadcast)
- Differential / patch-based emissions (emit full result set, not diffs)
- Query result caching / memoization (evaluate fresh each time)
