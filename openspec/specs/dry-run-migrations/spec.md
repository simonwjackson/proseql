# Dry-Run Migrations

## Overview

Preview which files need migration and what transforms would apply, without writing anything to disk. Useful for verifying migrations before applying them in production.

## API

```typescript
db.$dryRunMigrations(): Effect<DryRunResult, MigrationError>
```

Or as a standalone function:

```typescript
dryRunMigrations(
  config: DatabaseConfig,
  filePaths: Record<string, string>
): Effect<DryRunResult, MigrationError | StorageError, StorageAdapter | SerializerRegistry>
```

### DryRunResult

```typescript
interface DryRunResult {
  readonly collections: ReadonlyArray<{
    readonly name: string
    readonly filePath: string
    readonly currentVersion: number     // version in the file
    readonly targetVersion: number      // version in the config
    readonly migrationsToApply: ReadonlyArray<{
      readonly from: number
      readonly to: number
      readonly description?: string
    }>
    readonly status: "up-to-date" | "needs-migration" | "ahead" | "no-file"
  }>
}
```

## Behavior

1. For each versioned collection with a file path:
   - Read the file and extract `_version`.
   - Compare to config `version`.
   - List which migrations would apply (without running transforms).
   - Report status.
2. No transforms are executed. No files are written.
3. Collections without version config are skipped (not included in result).
4. Collections whose files don't exist are reported as `"no-file"`.

## Tests

- Collection needing migration → listed with correct migration chain
- Collection at current version → status "up-to-date", empty migration list
- Collection with file ahead → status "ahead"
- Collection with no file → status "no-file"
- Unversioned collection → not included in result
- No side effects: file not modified after dry run
