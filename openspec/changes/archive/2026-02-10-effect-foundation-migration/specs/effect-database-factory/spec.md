## ADDED Requirements

### Requirement: createDatabase returns an Effect
The `createDatabase` function SHALL return `Effect<Database, DatabaseError, DatabaseEnv>` where `DatabaseEnv` includes required services (StorageAdapter, SerializerRegistry when persistence is configured).

#### Scenario: Create in-memory database
- **WHEN** `createDatabase(config, initialData)` is called without persistence options
- **THEN** it SHALL return `Effect<Database, never, never>` that can be run with `Effect.runSync`

#### Scenario: Create persistent database
- **WHEN** `createDatabase(config, initialData, { persistence: options })` is called
- **THEN** it SHALL return `Effect<Database, StorageError | ValidationError, StorageAdapter | SerializerRegistry | Scope>`

#### Scenario: Provide layers and run
- **WHEN** the database Effect is provided with persistence Layers and run
- **THEN** it SHALL load existing data from files, initialize Refs, set up file watchers, and return the database

### Requirement: Database type preserves collection type inference
The `GenerateDatabase<Config>` type SHALL infer collection types from Effect Schema definitions. Each collection SHALL be typed with its entity type, relationship types, and available methods.

#### Scenario: Query returns schema-inferred type
- **WHEN** a config defines `users: { schema: UserSchema, relationships: {} }`
- **THEN** `db.users.query()` SHALL return entities typed as `Schema.Type<typeof UserSchema>`

#### Scenario: Relationships resolve to correct target types
- **WHEN** a config defines `users: { schema: UserSchema, relationships: { company: { type: "ref", target: "companies" } } }`
- **THEN** populated `company` field SHALL be typed as `Schema.Type<typeof CompanySchema>`

### Requirement: CRUD methods return Effect
All CRUD methods (create, createMany, update, updateMany, delete, deleteMany, upsert, upsertMany) SHALL return `Effect<T, CrudError>` instead of `Promise<Result<T, CrudError>>`.

#### Scenario: Create returns Effect
- **WHEN** `db.users.create({ name: "Alice", age: 30 })` is called
- **THEN** it SHALL return `Effect<User, ValidationError | DuplicateKeyError>`

#### Scenario: Delete returns Effect
- **WHEN** `db.users.delete("abc")` is called
- **THEN** it SHALL return `Effect<User, NotFoundError | ForeignKeyError>`

### Requirement: Relationship CRUD methods return Effect
Relationship-aware methods (createWithRelationships, updateWithRelationships, deleteWithRelationships) SHALL return Effect with appropriate error types.

#### Scenario: Create with relationships
- **WHEN** `db.users.createWithRelationships({ name: "Alice", company: { $connect: { id: "c1" } } })` is called
- **THEN** it SHALL return `Effect<User, ValidationError | ForeignKeyError | NotFoundError>`

### Requirement: Database provides cleanup via Effect scope
When persistence is enabled, database cleanup (stopping file watchers, flushing pending writes) SHALL be handled automatically by Effect's scope system via `acquireRelease`.

#### Scenario: Scoped database lifecycle
- **WHEN** a database is created within `Effect.scoped`
- **THEN** file watchers and pending writes SHALL be cleaned up when the scope closes

### Requirement: Convenience API for non-Effect consumers
The database SHALL provide convenience methods that wrap Effect operations in `Promise`-returning functions for consumers not using Effect directly.

#### Scenario: Promise-based create
- **WHEN** a consumer calls `await db.users.create({ name: "Alice", age: 30 }).runPromise`
- **THEN** the result SHALL be a plain `User` object or a rejected Promise with the error

#### Scenario: Promise-based query
- **WHEN** a consumer calls `await db.users.query({ where: { age: { $gt: 18 } } }).runPromise`
- **THEN** the result SHALL be a plain `User[]` array
