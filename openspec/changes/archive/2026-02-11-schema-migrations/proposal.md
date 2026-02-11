## Why

When a developer changes a schema -- adds a field, renames one, changes a type, restructures a relationship -- every existing data file on disk is immediately out of date. The database reads those files through `loadData`, deserializes them with the JSON/YAML/MsgPack serializer, and hands them straight to in-memory collections with no transformation step in between. There is no version marker in the files, no migration pipeline, and no way to detect the mismatch.

Today the only option is for the user to manually edit every affected file. That defeats the core value proposition: data lives in human-readable plain text files that the user owns. If a schema change can silently corrupt queries, drop fields, or crash on load, the user's files become a liability instead of an asset. A file-based database needs a file-aware migration story.

## What Changes

- Embed a schema version in each persisted data file so the system can detect stale data on load
- Introduce a migration registry where developers declare ordered transform functions that map data from one schema version to the next
- Run pending migrations automatically (or on explicit call) during `loadData` / `createDatabase`, transforming file contents in-place before they enter the in-memory collections
- After migration, write the updated data back to disk so the plain text files stay current and human-readable
- Provide a dry-run mode that reports what migrations would apply without modifying files

## Capabilities

### New Capabilities

- `schema-versioning`: Track a version identifier in each persisted data file so the system knows which schema produced it
- `migration-registry`: Declare ordered, per-collection transform functions that convert data from version N to version N+1 (add field with default, rename field, reshape structure, etc.)
- `auto-migrate-on-load`: When a file's version is behind the current schema, run the migration chain during load and persist the result, keeping the user's plain text files up to date
- `dry-run-migrations`: Preview which files need migration and what transforms would apply, without writing anything to disk
- `migration-validation`: After applying transforms, validate the migrated data against the current Zod schema before accepting it, so bad migrations fail fast

### Modified Capabilities

- `persistence-load` (persistence.ts `loadData`): Insert a version-check and migration step between deserialization and returning data to the caller
- `persistence-save` (persistence.ts `saveData`): Stamp the current schema version into serialized output
- `database-creation` (database.ts `createDatabase`): Accept migration configuration in `DatabaseOptions` and run pending migrations during the async initialization path

## Impact

- **Data files**: Each file gains a lightweight version field (e.g. `_version`). Existing versionless files are treated as version 0 so adoption is non-breaking.
- **Configuration surface**: `DatabaseOptions` and `CollectionConfig` expand to accept a version number and a migration list. All additions are optional; databases without migrations behave exactly as they do today.
- **Load path**: `loadData` gains a conditional branch -- if migrations are configured and the file version is stale, transforms run and the file is rewritten. No change for files already at the current version.
- **Dependencies**: None. Migrations are pure functions over plain objects; no new libraries required.
- **Risk to user data**: Migrations rewrite the user's files. The dry-run capability and post-migration Zod validation exist specifically to mitigate this. A backup-before-migrate strategy should be documented but is not enforced by the library.
