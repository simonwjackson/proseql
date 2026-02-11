# Schema Migrations — Design

## Architecture

### New Modules

**`core/migrations/migration-runner.ts`** — Core migration logic: `runMigrations(data, fileVersion, targetVersion, migrations)` applies the transform chain. `dryRunMigrations(config)` previews what would happen. Validates the migration registry at startup.

**`core/migrations/migration-types.ts`** — `Migration`, `MigrationError`, `DryRunResult` types.

### Modified Modules

**`core/types/database-config-types.ts`** — `CollectionConfig` gains `readonly version?: number` and `readonly migrations?: ReadonlyArray<Migration>`.

**`core/storage/persistence-effect.ts`** — `loadData` gains a migration step: after deserialization, extract `_version`, compare to config version, run migrations if needed, persist migrated data. `saveData` stamps `_version` into output.

**`core/errors/crud-errors.ts`** (or a new `core/errors/migration-errors.ts`) — `MigrationError` tagged error.

**`core/factories/database-effect.ts`** — At database creation, validate migration registries for all versioned collections. Wire `$dryRunMigrations` onto the database object.

## Key Decisions

### Migrations operate on raw objects, not schema-decoded entities

Migration transforms receive `Record<string, unknown>` (the raw deserialized data). This is necessary because:
1. The old data doesn't conform to the new schema — decoding would fail.
2. Migrations need to restructure data freely (rename, reshape, add fields).
3. Schema validation happens once, after all transforms complete.

### `_version` lives at the file level, not per-entity

Version is a file-level metadata field, not per-entity. This is simpler and matches the data model: one file = one collection = one schema = one version. Per-entity versioning would enable mixed-version collections, but that complexity isn't justified for a file-backed database.

### Migrations are pure synchronous functions

Transform functions are plain `(data) => data` — not Effects. This keeps migrations simple, testable, and composable. If a transform needs async I/O, that's a sign it shouldn't be a migration (it's a data pipeline).

Transform exceptions are caught and wrapped in `MigrationError`.

### Atomic write-back: migrate then persist

The migration pipeline:
1. Deserialize raw file
2. Run all transforms (pure functions, no disk I/O)
3. Validate against current schema
4. Only if everything passes: write back to disk

If any step fails, the original file is untouched. This prevents partial migrations.

### Registry validation at startup

Migration chains are validated when `createDatabase` is called, not at load time. This catches configuration errors (gaps, duplicates, mismatched versions) early, before any data is loaded.

### saveData injects `_version` before serialization

`saveData` wraps the entity map:
```typescript
const output = version !== undefined
  ? { _version: version, ...entityMap }
  : entityMap
```

The `_version` key is reserved and cannot be used as an entity ID. This is an acceptable constraint — entity IDs starting with `_` are unusual.

### loadData strips `_version` from the entity map

On load, `_version` is extracted and removed before entity decoding:
```typescript
const fileVersion = parsed._version ?? 0
delete parsed._version
// proceed with entity decoding on remaining keys
```

### MigrationError is a separate tagged error

```typescript
class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly collection: string
  readonly fromVersion: number
  readonly toVersion: number
  readonly step: number
  readonly reason: string
  readonly message: string
}>
```

`step: -1` means post-migration validation failure. `step >= 0` means the transform at that index failed.

## File Layout

```
core/
  migrations/
    migration-runner.ts      (new — runMigrations, dryRunMigrations, validateRegistry)
    migration-types.ts       (new — Migration, MigrationError, DryRunResult)
  types/
    database-config-types.ts (modified — version, migrations in CollectionConfig)
  storage/
    persistence-effect.ts    (modified — version extraction/injection, migration step in loadData)
  errors/
    migration-errors.ts      (new — MigrationError)
  factories/
    database-effect.ts       (modified — validate registries at startup, wire $dryRunMigrations)
tests/
  schema-migrations.test.ts  (new — full test suite)
```
