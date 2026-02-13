# Advanced Features Example

Demonstrates seven advanced proseql features in a single file: ID generation, indexing (including nested fields), unique constraints (single and compound), transactions with rollback, chained schema migrations, the plugin system, and foreign key enforcement.

## What This Example Covers

### 1. ID Generation

Built-in ID generators available out of the box:

- `generateUUID` -- Standard UUID v4
- `generateNanoId` -- Compact, URL-safe NanoID
- `generateULID` -- Sortable, timestamp-prefixed ULID
- `generateTimestampId` -- Millisecond-precision timestamp ID
- `generatePrefixedId` -- Prefixed with a collection name (e.g. `book_abc123`)
- `generateTypedId` -- Type-safe prefixed ID

### 2. Indexing

Declare indexes on collection config for fast lookups:

- **Single field** -- e.g. `"genre"` for O(1) equality queries.
- **Nested field** -- e.g. `"metadata.rating"` for querying nested object properties.
- **Compound** -- e.g. `["genre", "year"]` for multi-field equality queries.

### 3. Unique Constraints

Enforce uniqueness at the collection level:

- **Single field** -- e.g. `uniqueFields: ["isbn"]` rejects duplicate ISBN values.
- **Compound** -- e.g. `uniqueFields: [["userId", "bookId"]]` ensures at most one review per user per book.

Violations raise `UniqueConstraintError`.

### 4. Transactions

Atomic, all-or-nothing operations across multiple collections:

- `db.$transaction(ctx => ...)` executes inside an isolated context.
- On success, all writes commit.
- On failure, all writes roll back automatically.

### 5. Schema Migrations

Version your schemas and define chained migration transforms:

- Migrations are defined as an array of `{ from, to, transform }` steps.
- Multiple migration steps can be chained (e.g. v0 -> v1 -> v2) to incrementally add fields.
- Each transform receives a raw record and returns the migrated shape.

### 6. Plugin System

Extend proseql at runtime with custom operators and ID generators:

- **Custom operators** -- e.g. `$regex` for pattern matching in queries.
- **Custom ID generators** -- e.g. a counter-based generator for deterministic testing.

Plugins are passed via the `plugins` option to `createEffectDatabase`.

### 7. Foreign Key Enforcement

Define `ref` relationships with a `foreignKey` field to enforce referential integrity:

- Creating a record with a valid foreign key succeeds.
- Creating a record with a nonexistent foreign key raises `ForeignKeyError`.

## Running

```bash
bun run index.ts
```

## Dependencies

- `@proseql/core`
- `effect`
