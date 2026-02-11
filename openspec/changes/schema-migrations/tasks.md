## 1. Types and Configuration

- [x] 1.1 Create `core/migrations/migration-types.ts` with `Migration` interface (`from`, `to`, `transform`, `description?`) and `DryRunResult` type
- [x] 1.2 Create `core/errors/migration-errors.ts` with `MigrationError` tagged error (`collection`, `fromVersion`, `toVersion`, `step`, `reason`, `message`)
- [x] 1.3 Add `readonly version?: number` and `readonly migrations?: ReadonlyArray<Migration>` to `CollectionConfig` in `core/types/database-config-types.ts`
- [x] 1.4 Export new types from `core/index.ts`

## 2. Migration Registry Validation

- [x] 2.1 Create `core/migrations/migration-runner.ts` with `validateMigrationRegistry(collectionName, version, migrations)` returning `Effect<void, MigrationError>`. Check: contiguous chain, no gaps, no duplicates, last `to` matches version, `to === from + 1`.
- [x] 2.2 Handle edge cases: version 0 with no migrations (valid), version > 0 with empty migrations (invalid), no version config (skip validation).

## 3. Migration Execution

- [x] 3.1 Implement `runMigrations(data, fileVersion, targetVersion, migrations, collectionName)` returning `Effect<Record<string, unknown>, MigrationError>`. Filter to applicable migrations (`from >= fileVersion`), run transforms in order, catch exceptions and wrap in `MigrationError`.
- [x] 3.2 Handle the transform chain: pipe output of each transform to input of next. Track which step is executing for error reporting.
- [x] 3.3 Handle version 0 (no `_version` in file) as the starting point.

## 4. Persistence Integration — saveData

- [x] 4.1 Modify `saveData` in `core/storage/persistence-effect.ts`: accept optional `version` parameter. When provided, inject `_version` field into the serialized output before the entity map.
- [x] 4.2 Modify `saveCollectionsToFile`: stamp `_version` per-collection section if versioned.
- [x] 4.3 Ensure `_version` appears first in the output object for readability in YAML/JSON files.

## 5. Persistence Integration — loadData

- [x] 5.1 Modify `loadData` in `core/storage/persistence-effect.ts`: accept optional `version` and `migrations` parameters. After deserialization, extract `_version` from parsed data (default 0 if absent), remove it from the entity map.
- [x] 5.2 If file version < config version and migrations are provided: run `runMigrations`, then decode the migrated data through schema, then write back to disk via `saveData` with new version. Return the decoded data.
- [x] 5.3 If file version > config version: fail with `MigrationError` (data from future version).
- [x] 5.4 If file version === config version: proceed normally (no migration needed).
- [x] 5.5 Modify `loadCollectionsFromFile`: apply per-collection migration independently.

## 6. Post-Migration Validation

- [x] 6.1 After running all transforms, decode each entity through `Schema.decodeUnknown(currentSchema)`. On failure, produce `MigrationError` with `step: -1` and the parse error details.
- [x] 6.2 Ensure original file is untouched if validation fails (write-back only happens after successful decode).

## 7. Factory Integration

- [x] 7.1 In `core/factories/database-effect.ts` `createEffectDatabase`: validate migration registries for all versioned collections at startup via `validateMigrationRegistry`. Fail early if any registry is invalid.
- [x] 7.2 Pass `version` and `migrations` from collection config to `loadData` calls during database initialization.
- [x] 7.3 Wire `$dryRunMigrations()` method onto the database object.

## 8. Dry-Run Migrations

- [x] 8.1 Implement `dryRunMigrations(config, stateRefs)` in `core/migrations/migration-runner.ts`: for each versioned collection with a file, read the file, extract `_version`, determine which migrations would apply, report status. No transforms executed, no files written.
- [x] 8.2 Return `DryRunResult` with per-collection status: "up-to-date", "needs-migration", "ahead", or "no-file".

## 9. Tests — Schema Versioning

- [x] 9.1 Create `tests/schema-migrations.test.ts` with test helpers: in-memory storage adapter, sample schemas at multiple versions
- [x] 9.2 Test save versioned collection → file contains `_version`
- [x] 9.3 Test load file at current version → entities loaded, `_version` stripped
- [x] 9.4 Test load file without `_version` → treated as version 0
- [x] 9.5 Test load file with version ahead → `MigrationError`
- [x] 9.6 Test unversioned collection → `_version` not written or checked

## 10. Tests — Migration Registry Validation

- [x] 10.1 Test valid contiguous chain → accepted
- [x] 10.2 Test gap in chain → error
- [x] 10.3 Test last `to` doesn't match version → error
- [x] 10.4 Test duplicate `from` → error
- [x] 10.5 Test `to !== from + 1` → error
- [x] 10.6 Test empty migrations with version > 0 → error

## 11. Tests — Auto-Migrate on Load

- [x] 11.1 Test file at version 0, config at version 3 → all migrations run, data correct
- [x] 11.2 Test file at version 2, config at version 3 → only migration 2→3 runs
- [x] 11.3 Test migrated data written back to file with new `_version`
- [x] 11.4 Test file at current version → no migrations, normal load
- [x] 11.5 Test failed transform → original file untouched, `MigrationError`
- [x] 11.6 Test post-migration validation failure → original file untouched, `MigrationError` with `step: -1`

## 12. Tests — Dry Run

- [ ] 12.1 Test collection needing migration → listed with correct chain
- [ ] 12.2 Test collection at current version → "up-to-date"
- [ ] 12.3 Test collection with no file → "no-file"
- [ ] 12.4 Test no files modified after dry run

## 13. Cleanup

- [ ] 13.1 Run full test suite (`bun test`) to verify no regressions
- [ ] 13.2 Run type check (`bunx tsc --noEmit`) to verify no type errors
