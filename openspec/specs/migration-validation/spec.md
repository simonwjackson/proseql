# Migration Validation

## Overview

After applying migration transforms, the resulting data is validated against the current Effect Schema before being accepted into the in-memory collection. This ensures that bad migrations fail fast with a clear error rather than silently corrupting the database.

## Behavior

### Post-Migration Decode

After all migration transforms complete, the migrated entity map goes through the same `Schema.decodeUnknown` pipeline as normal data loading:

```
raw data → migration transforms → Schema.decodeUnknown(currentSchema) → validated entities
```

If any entity fails to decode, the migration is considered failed. The original file is not modified. A `MigrationError` is raised with details about which entity failed and the parse error.

### Error Reporting

When post-migration validation fails:

```typescript
MigrationError {
  collection: "users"
  fromVersion: 0
  toVersion: 3
  step: -1                    // -1 indicates validation failure, not a transform step
  reason: "Post-migration validation failed for entity 'user-1': missing required field 'role'"
  message: "Migration from version 0 to 3 completed but data failed schema validation"
}
```

The `step: -1` convention distinguishes validation failures from transform failures.

### Pre-Migration Validation (None)

Migrations do NOT validate against old schemas. The old schema may not exist in the codebase anymore. Migrations receive raw deserialized data and must handle whatever shape they find.

### Transform Error Handling

If a transform function throws an exception (not an Effect failure — transforms are plain functions), the error is caught and wrapped in `MigrationError`:

```typescript
MigrationError {
  collection: "users"
  fromVersion: 1
  toVersion: 2
  step: 1
  reason: "Transform threw: Cannot read property 'name' of undefined"
  message: "Migration step 1→2 failed"
}
```

## Tests

- Correct migration + valid data → passes validation, entities loaded
- Correct migration + invalid data (missing required field) → `MigrationError` at validation step
- Transform function throws → `MigrationError` with caught error
- Original file untouched after validation failure
- Error includes entity ID and parse error details
