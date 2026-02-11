## ADDED Requirements

### Requirement: Errors extend Data.TaggedError
All database errors SHALL extend `Data.TaggedError` from the `effect` package. Each error type SHALL have a unique `_tag` discriminant for pattern matching.

#### Scenario: Error type definition
- **WHEN** a `NotFoundError` is created
- **THEN** it SHALL have `_tag: "NotFoundError"` and be an instance of `Data.TaggedError`

#### Scenario: Pattern matching on errors
- **WHEN** an operation fails with a typed error
- **THEN** consumers SHALL be able to use `Effect.catchTag("NotFoundError", handler)` to handle specific error types

### Requirement: CRUD errors replace hand-rolled Result type
CRUD operations SHALL return `Effect<T, CrudError>` instead of `Promise<Result<T, CrudError>>`. The error channel SHALL carry the specific error types possible for each operation.

#### Scenario: Create operation errors
- **WHEN** a create operation fails due to schema validation
- **THEN** the Effect SHALL fail with `ValidationError`

#### Scenario: Create operation duplicate key
- **WHEN** a create operation fails due to duplicate ID
- **THEN** the Effect SHALL fail with `DuplicateKeyError`

#### Scenario: Delete operation not found
- **WHEN** a delete operation targets a non-existent ID
- **THEN** the Effect SHALL fail with `NotFoundError`

#### Scenario: Update operation foreign key violation
- **WHEN** an update sets a foreign key to a non-existent target
- **THEN** the Effect SHALL fail with `ForeignKeyError`

### Requirement: Query path has typed errors
Query operations SHALL carry typed errors for failure conditions that currently degrade silently. This includes dangling references during population and missing collection targets.

#### Scenario: Dangling reference during population
- **WHEN** a populated entity references a non-existent target (foreign key points to deleted record)
- **THEN** the query SHALL produce a `DanglingReferenceError` in the error channel (or populate as `undefined` in lenient mode)

#### Scenario: Missing collection in population target
- **WHEN** a populate config references a relationship whose target collection does not exist
- **THEN** the query SHALL fail with `CollectionNotFoundError`

### Requirement: Error types preserve current error information
Each migrated error type SHALL carry at least the same information as the current `crud-errors.ts` types: entity name, ID, field, value, message, and timestamp.

#### Scenario: NotFoundError carries entity details
- **WHEN** a `NotFoundError` is created for entity "users" with ID "abc"
- **THEN** it SHALL have `collection: "users"`, `id: "abc"`, and a human-readable `message`

#### Scenario: ForeignKeyError carries constraint details
- **WHEN** a `ForeignKeyError` is created
- **THEN** it SHALL have `field`, `value`, `targetCollection`, and `message` properties

### Requirement: Storage errors are typed
Storage operations (read, write, watch) SHALL fail with typed `StorageError` extending `Data.TaggedError`, replacing the current class-based `StorageError`.

#### Scenario: File read failure
- **WHEN** a file cannot be read
- **THEN** the operation SHALL fail with `StorageError` containing `path`, `operation: "read"`, and the underlying cause

#### Scenario: Serialization failure
- **WHEN** data cannot be serialized to the target format
- **THEN** the operation SHALL fail with `SerializationError` containing the format and underlying cause
