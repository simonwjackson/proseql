# Auto-Migrate on Load

## Overview

When a file's version is behind the current schema version, the migration chain runs automatically during `loadData`. After migration, the updated data is persisted back to disk so the plain text files stay current and human-readable.

## Behavior

### Migration Pipeline

During `loadData` for a versioned collection with a stale file:

1. Deserialize the file to raw objects.
2. Extract `_version` (default 0 if absent).
3. Determine the migration path: find all migrations where `from >= fileVersion` and `to <= configVersion`, ordered by `from`.
4. Run each migration's `transform` function in order, piping the output of one to the input of the next.
5. After all transforms complete, decode the resulting data through the current schema (see migration-validation spec).
6. Write the migrated data back to disk with the new `_version` (via `saveData`).
7. Return the decoded data to the caller.

### Atomic Write-Back

The write-back happens only after all migrations succeed and validation passes. If any migration or the post-migration validation fails, the original file is untouched.

### Multi-Collection Files

For files containing multiple collections (via `loadCollectionsFromFile`), migrations run per-collection. Each collection's section of the file is migrated independently using its own migration chain. The file is rewritten with all collections at their current versions.

### No-Op for Current Version

If the file version equals the config version, no migrations run. The load path is identical to today's behavior.

### First-Time Versioning

When a previously unversioned collection gains `version: 1` with a migration from 0→1, existing files (with no `_version`) are treated as version 0 and migrated. This is the adoption path for existing databases.

## Error Handling

```typescript
class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly collection: string
  readonly fromVersion: number
  readonly toVersion: number
  readonly step: number          // which migration in the chain failed (0-indexed)
  readonly reason: string
  readonly message: string
}>
```

Migration failures produce `MigrationError`. The original file is not modified. The caller can catch this and decide whether to abort or proceed with manual intervention.

## Tests

- File at version 0, config at version 3 → all 3 migrations run in order
- File at version 2, config at version 3 → only migration 2→3 runs
- File at current version → no migrations, normal load
- Migrated data written back to file with new `_version`
- Failed migration → original file untouched, `MigrationError` raised
- Multi-collection file → each collection migrated independently
- Previously unversioned file → treated as version 0, migration runs
