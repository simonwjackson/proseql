## ADDED Requirements

### Requirement: Collection state stored in Ref
Each collection's data SHALL be stored in an `Effect.Ref<ReadonlyMap<string, T>>` where `T` is the entity type and the map is keyed by entity ID.

#### Scenario: Initial state from data
- **WHEN** `createDatabase(config, initialData)` is called with initial data `[{ id: "1", name: "Alice" }]`
- **THEN** the Ref SHALL contain a ReadonlyMap with entry `"1" → { id: "1", name: "Alice" }`

#### Scenario: Empty initial state
- **WHEN** `createDatabase(config)` is called without initial data
- **THEN** the Ref SHALL contain an empty ReadonlyMap

### Requirement: CRUD operations update Ref atomically
All CRUD mutations (create, update, delete, upsert) SHALL modify state through `Ref.update` or `Ref.modify`, ensuring atomic read-modify-write semantics.

#### Scenario: Concurrent creates do not lose data
- **WHEN** two create operations run concurrently
- **THEN** both entities SHALL be present in the collection after both complete

#### Scenario: Update reads latest state
- **WHEN** an update operation runs after a create
- **THEN** the update SHALL see the created entity in its read phase

### Requirement: O(1) entity lookup by ID
Entity retrieval by ID SHALL use `ReadonlyMap.get`, providing O(1) lookup time instead of the current O(n) array scan.

#### Scenario: findById performance
- **WHEN** an entity is looked up by ID from a collection of 10,000 entities
- **THEN** the lookup SHALL complete in constant time (not scanning the collection)

### Requirement: Query reads from Ref snapshot
Query operations SHALL read a consistent snapshot from the Ref at query start time. Mutations that occur while a Stream is being consumed SHALL NOT affect the results of that query.

#### Scenario: Snapshot isolation for queries
- **WHEN** a query Stream is being iterated and a new entity is created concurrently
- **THEN** the new entity SHALL NOT appear in the ongoing query results

### Requirement: State provides change notification foundation
The Ref-based state SHALL support observing changes (entity added, updated, deleted) for future lifecycle hooks and event systems. This requirement specifies the state structure, not the hook API.

#### Scenario: State change is detectable
- **WHEN** a CRUD operation modifies the Ref
- **THEN** the new ReadonlyMap reference SHALL differ from the previous reference (referential inequality)
