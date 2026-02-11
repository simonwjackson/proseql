# Schema Versioning

## Overview

Each persisted data file carries a version number indicating which schema produced it. This lets the system detect stale data on load and determine which migrations need to run.

## File Format

A `_version` field is added at the top level of the serialized file:

```json
{
  "_version": 3,
  "user-1": { "id": "user-1", "name": "Alice", "email": "alice@example.com" },
  "user-2": { "id": "user-2", "name": "Bob", "email": "bob@example.com" }
}
```

```yaml
_version: 3
user-1:
  id: user-1
  name: Alice
  email: alice@example.com
```

- `_version` is a positive integer. It starts at 1 for versioned collections.
- Files without `_version` are treated as version 0 (legacy/pre-migration).
- `_version` is a metadata field — it is not loaded into the in-memory entity map.

## Configuration

`CollectionConfig` gains an optional `version` property:

```typescript
readonly version?: number
```

This declares the current schema version. When persisting, `saveData` stamps this version into the file. When loading, `loadData` compares the file version to this value.

- Omitting `version` means the collection is unversioned (no migration support). Files are loaded as-is, same as today.
- `version: 1` means the collection has versioning enabled. Files at version 0 (or unversioned) are candidates for migration.

## Save Behavior

When `saveData` writes a versioned collection, it includes `_version` in the serialized output:

```typescript
const output = {
  _version: collectionConfig.version,
  ...entityMap
}
```

The `_version` field is injected before serialization, after schema encoding. It does not appear in the entity schema or in-memory data.

## Load Behavior

When `loadData` reads a versioned collection:

1. Deserialize the file.
2. Extract and remove `_version` from the parsed data (default to 0 if absent).
3. Compare file version to `collectionConfig.version`.
4. If versions match: proceed normally (decode entities through schema).
5. If file version is behind: hand off to the migration pipeline (see auto-migrate-on-load spec).
6. If file version is ahead: fail with a `MigrationError` — the file was written by a newer schema version.

## Tests

- Save versioned collection → file contains `_version` field
- Load versioned file at current version → entities loaded, `_version` stripped
- Load file without `_version` → treated as version 0
- Load file with version ahead of config → `MigrationError`
- Unversioned collection (no `version` in config) → `_version` not written or checked
- `_version` is not present in the in-memory entity map
