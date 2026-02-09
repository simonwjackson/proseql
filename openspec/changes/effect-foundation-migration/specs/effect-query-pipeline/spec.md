## ADDED Requirements

### Requirement: Query returns Effect Stream
The `query()` method on each collection SHALL return an `Effect` that produces a `Stream` of matching entities. The Stream SHALL carry a typed error channel for query failures.

#### Scenario: Basic query returns Stream
- **WHEN** `db.users.query({ where: { age: { $gt: 18 } } })` is called
- **THEN** the result SHALL be an Effect producing a Stream of User entities matching the filter

#### Scenario: Collect stream to array
- **WHEN** a query Stream is collected via `Stream.runCollect`
- **THEN** the result SHALL be a `Chunk<User>` containing all matching entities

### Requirement: Filter is a composable Stream stage
Filtering SHALL be implemented as an independent Stream combinator that can be applied to any `Stream<T>`. The combinator SHALL accept the existing `WhereClause` type and support all current operators ($eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $startsWith, $endsWith, $contains, $all, $size, $some, $every, $none, $or, $and, $not).

#### Scenario: Filter stage applied independently
- **WHEN** a filter combinator is applied to a Stream of entities
- **THEN** only entities matching the where clause SHALL pass through

#### Scenario: All existing filter operators work
- **WHEN** a query uses any of the existing filter operators ($eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $startsWith, $endsWith, $contains, $all, $size)
- **THEN** the operator SHALL produce the same results as the current implementation

#### Scenario: Relationship operators work
- **WHEN** a query uses $some, $every, or $none on inverse relationships
- **THEN** the operator SHALL filter based on related entities in the target collection

### Requirement: Population is a composable Stream stage
Relationship population SHALL be an independent Stream combinator. It SHALL accept a `PopulateConfig` and resolve relationships by looking up related entities from the database state.

#### Scenario: Populate ref relationship
- **WHEN** a query includes `populate: { company: true }` for a ref relationship
- **THEN** each entity in the Stream SHALL have its `company` field populated with the related entity

#### Scenario: Populate inverse relationship
- **WHEN** a query includes `populate: { orders: true }` for an inverse relationship
- **THEN** each entity in the Stream SHALL have its `orders` field populated with an array of related entities

#### Scenario: Nested population
- **WHEN** a query includes `populate: { orders: { items: { product: true } } }`
- **THEN** relationships SHALL be resolved recursively to the specified depth

### Requirement: Sort is a composable Stream stage
Sorting SHALL be an independent combinator that collects, sorts, and re-emits the Stream. It SHALL support multi-field sorting with asc/desc order.

#### Scenario: Sort by single field
- **WHEN** a query includes `sort: { name: "asc" }`
- **THEN** results SHALL be ordered alphabetically by name

#### Scenario: Sort by nested populated field
- **WHEN** a query includes `sort: { "company.name": "asc" }` with population
- **THEN** results SHALL be ordered by the populated relationship field

### Requirement: Select is a composable Stream stage
Field selection SHALL be an independent combinator that projects each entity to the selected fields. It SHALL support both object-based (`{ name: true, email: true }`) and array-based (`["name", "email"]`) selection.

#### Scenario: Object-based selection
- **WHEN** a query includes `select: { name: true, email: true }`
- **THEN** each entity in the Stream SHALL contain only the `name` and `email` fields

#### Scenario: Nested selection on populated relationships
- **WHEN** a query includes `select: { name: true, company: { name: true } }`
- **THEN** the entity SHALL have `name` and a `company` object with only `name`

### Requirement: Pagination is a composable Stream stage
Offset/limit pagination SHALL be implemented as Stream combinators (`Stream.drop` for offset, `Stream.take` for limit).

#### Scenario: Offset and limit
- **WHEN** a query includes `offset: 10, limit: 5`
- **THEN** the Stream SHALL skip the first 10 results and emit at most 5

### Requirement: Convenience runPromise method
Each query SHALL provide a `.runPromise` property or method that executes the Stream and returns `Promise<Array<T>>` for consumers not using Effect.

#### Scenario: Non-Effect consumer usage
- **WHEN** a consumer calls `await db.users.query({ where: { age: { $gt: 18 } } }).runPromise`
- **THEN** the result SHALL be a plain JavaScript array of matching users
