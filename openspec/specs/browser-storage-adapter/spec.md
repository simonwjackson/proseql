# Browser Storage Adapter

## Overview

A storage adapter that enables proseql to run in browser environments, persisting data to localStorage, sessionStorage, or IndexedDB. The in-memory database and query engine are runtime-agnostic, but persistence currently requires Node.js filesystem APIs. A browser adapter unlocks local-first web applications.

## Requirements

### Requirement: LocalStorage adapter

A storage adapter SHALL persist collection data to the browser's `localStorage` API.

#### Scenario: Save to localStorage
- **WHEN** a CRUD mutation triggers persistence
- **THEN** the serialized collection data SHALL be written to `localStorage` under a configurable key
- **AND** the data format SHALL be determined by the collection's configured codec (JSON, etc.)

#### Scenario: Load from localStorage
- **WHEN** a persistent database is created in the browser
- **THEN** existing data SHALL be loaded from `localStorage` using the configured key

#### Scenario: Storage quota exceeded
- **WHEN** a write exceeds the localStorage quota (~5MB typical)
- **THEN** a `StorageError` SHALL be raised with a descriptive message

### Requirement: SessionStorage adapter

A storage adapter SHALL persist to `sessionStorage` for ephemeral per-tab data.

#### Scenario: Session-scoped persistence
- **WHEN** configured with sessionStorage
- **THEN** data SHALL persist within the browser tab session
- **AND** data SHALL NOT be available in other tabs or after tab close

### Requirement: IndexedDB adapter

A storage adapter SHALL persist to IndexedDB for larger datasets that exceed localStorage limits.

#### Scenario: Save to IndexedDB
- **WHEN** a CRUD mutation triggers persistence
- **THEN** data SHALL be written to an IndexedDB object store

#### Scenario: Async I/O
- **GIVEN** IndexedDB is asynchronous
- **THEN** all I/O operations SHALL return Effect values (not blocking)

#### Scenario: Large dataset support
- **WHEN** a collection exceeds 5MB
- **THEN** IndexedDB SHALL handle it without quota errors (up to browser limits)

### Requirement: StorageAdapter interface compliance

All browser adapters SHALL implement the existing `StorageAdapterShape` interface.

#### Scenario: Interface compatibility
- **THEN** browser adapters SHALL provide: `exists`, `read`, `write`, `ensureDir` (no-op in browser), `watch` (where supported)

#### Scenario: Layer composition
- **WHEN** a browser adapter is provided as a Layer
- **THEN** `createPersistentEffectDatabase` SHALL work identically to the Node adapter

### Requirement: File path mapping

Browser adapters SHALL map file paths from collection config to storage keys.

#### Scenario: Path to key mapping
- **GIVEN** a collection config with `file: "./data/books.yaml"`
- **WHEN** using a browser adapter
- **THEN** the storage key SHALL be derived from the path (e.g., `proseql:data/books.yaml`)
- **AND** the key prefix SHALL be configurable

### Requirement: Cross-tab synchronization (localStorage only)

The localStorage adapter SHALL detect changes made by other tabs.

#### Scenario: Storage event listener
- **WHEN** another tab writes to the same localStorage key
- **THEN** the `storage` event SHALL trigger a reload of the affected collection

### Requirement: Format restrictions

Browser adapters SHALL document which serialization formats are available.

#### Scenario: No TOML in browser
- **GIVEN** `smol-toml` may not be browser-compatible
- **THEN** the browser adapter documentation SHALL specify which codecs are available
- **AND** attempting to use an unavailable codec SHALL fail with `UnsupportedFormatError`

## Out of Scope

- Service Worker persistence
- OPFS (Origin Private File System) — potential future adapter
- Offline sync / conflict resolution
- Encryption at rest (covered by separate concern)
