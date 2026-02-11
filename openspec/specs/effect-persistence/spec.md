## ADDED Requirements

### Requirement: StorageAdapter is an Effect Service
The `StorageAdapter` SHALL be defined as an Effect Service using `Context.Tag`. All storage operations (read, write, exists, watch, ensureDir) SHALL return `Effect` values with typed errors.

#### Scenario: Read file via service
- **WHEN** `StorageAdapter.read("/data/users.json")` is called
- **THEN** it SHALL return `Effect<string, StorageError>` that resolves to the file contents

#### Scenario: Write file via service
- **WHEN** `StorageAdapter.write("/data/users.json", data)` is called
- **THEN** it SHALL return `Effect<void, StorageError>` that completes when the write is finished

#### Scenario: Swap adapter for testing
- **WHEN** an in-memory StorageAdapter Layer is provided instead of the filesystem Layer
- **THEN** all persistence operations SHALL use the in-memory adapter without code changes

### Requirement: SerializerRegistry is an Effect Service
The `SerializerRegistry` SHALL be an Effect Service that maps file extensions to serialize/deserialize functions. Serialization operations SHALL return `Effect` values.

#### Scenario: Serialize to JSON
- **WHEN** data is serialized for a `.json` file
- **THEN** the registry SHALL use the JSON serializer and return `Effect<string, SerializationError>`

#### Scenario: Deserialize from YAML
- **WHEN** a `.yaml` file is loaded
- **THEN** the registry SHALL use the YAML serializer to parse the content

#### Scenario: Unsupported format
- **WHEN** a file with an unsupported extension is encountered
- **THEN** the operation SHALL fail with `UnsupportedFormatError`

### Requirement: Node.js filesystem adapter provided as Layer
A default `NodeStorageLayer` SHALL be provided that implements the StorageAdapter service using Node.js `fs` APIs with atomic writes and retry logic.

#### Scenario: Atomic write
- **WHEN** data is written to a file
- **THEN** the adapter SHALL write to a temporary file first, then rename atomically

#### Scenario: Retry on transient failure
- **WHEN** a write fails due to a transient filesystem error
- **THEN** the adapter SHALL retry using Effect Schedule with exponential backoff

### Requirement: Persistence save uses Effect Schedule for debounce
Write operations triggered by CRUD mutations SHALL be debounced using `Effect.schedule` with a configurable delay (default 100ms). Multiple rapid mutations SHALL coalesce into a single file write.

#### Scenario: Rapid mutations coalesce writes
- **WHEN** 10 create operations occur within 50ms
- **THEN** only one file write SHALL occur after the debounce period

#### Scenario: Custom debounce delay
- **WHEN** the database is configured with `writeDebounce: 500`
- **THEN** writes SHALL be debounced with a 500ms delay

### Requirement: File watching uses managed Effect resources
File watchers SHALL be created using `Effect.acquireRelease` to ensure cleanup on database shutdown. The watcher lifecycle SHALL be managed by Effect's scope system.

#### Scenario: File watcher started on database creation
- **WHEN** a database is created with `watchFiles: true`
- **THEN** file watchers SHALL be started for each configured file path

#### Scenario: File watcher cleaned up on scope close
- **WHEN** the database's Effect scope is closed
- **THEN** all file watchers SHALL be stopped automatically

#### Scenario: External file change reloads data
- **WHEN** an external process modifies a watched file
- **THEN** the affected collections' Refs SHALL be updated with the new data

### Requirement: Load data decodes through Effect Schema
Loading data from files SHALL decode through the collection's Effect Schema, validating all loaded data. Invalid data SHALL produce typed errors.

#### Scenario: Valid file data loaded
- **WHEN** a JSON file contains valid data matching the schema
- **THEN** all entities SHALL be decoded and stored in the collection Ref

#### Scenario: Invalid file data rejected
- **WHEN** a file contains data that fails schema validation
- **THEN** the load operation SHALL fail with a `ValidationError` containing decode issues

### Requirement: Save data encodes through Effect Schema
Saving data to files SHALL encode through the collection's Effect Schema, ensuring the on-disk format matches the Encoded type.

#### Scenario: Data encoded for file storage
- **WHEN** collection data is saved to a JSON file
- **THEN** each entity SHALL be encoded through the schema before serialization
