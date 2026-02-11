## 1. Configuration

- [x] 1.1 Add `readonly uniqueFields?: ReadonlyArray<string | ReadonlyArray<string>>` to `CollectionConfig` in `core/types/database-config-types.ts`
- [x] 1.2 Export `uniqueFields` type from `core/types/index.ts` if a separate type alias is needed

## 2. Unique Check Module

- [x] 2.1 Create `core/operations/crud/unique-check.ts` with `normalizeConstraints(uniqueFields)` — converts `["email", ["userId", "settingKey"]]` to `[["email"], ["userId", "settingKey"]]`
- [x] 2.2 Implement `checkUniqueConstraints(entity, existingMap, constraints, collectionName)` returning `Effect<void, UniqueConstraintError>`. For each normalized constraint, check if all fields match any existing entity (excluding same ID). Skip null/undefined values. Fail-fast on first violation.
- [x] 2.3 Implement `checkBatchUniqueConstraints(entities, existingMap, constraints, collectionName)` — same as above but also checks entities within the batch against each other
- [x] 2.4 Implement `validateUpsertWhere(where, constraints, collectionName)` returning `Effect<void, ValidationError>`. Verify the where clause keys fully cover at least one declared constraint or `id`. Produce a `ValidationError` listing valid unique fields on failure.
- [x] 2.5 Delete the old `checkUniqueConstraints` helper from `core/operations/crud/create.ts` (lines 259-279)

## 3. Wire Into CRUD Operations

- [x] 3.1 Add `uniqueFields: ReadonlyArray<ReadonlyArray<string>>` parameter to `create` and `createMany` in `core/operations/crud/create.ts`. Call `checkUniqueConstraints` after schema validation, before Ref.update. Add `UniqueConstraintError` to the error channel.
- [x] 3.2 In `createMany`, respect `skipDuplicates` for unique violations: catch `UniqueConstraintError`, add to skipped list, continue with remaining entities
- [x] 3.3 Add `uniqueFields` parameter to `update` and `updateMany` in `core/operations/crud/update.ts`. Before checking, determine if the update touches any unique field (intersect update keys with constraint fields). If so, call `checkUniqueConstraints` on the post-update entity. Add `UniqueConstraintError` to the error channel.
- [x] 3.4 Add `uniqueFields` parameter to `upsert` and `upsertMany` in `core/operations/crud/upsert.ts`. At the top of each function, call `validateUpsertWhere`. On the create path, call `checkUniqueConstraints`. Add `UniqueConstraintError` to the error channel.

## 4. Factory Integration

- [x] 4.1 In `core/factories/database-effect.ts` `buildCollection`: read `uniqueFields` from collection config, normalize via `normalizeConstraints`, pass to all CRUD factory function calls (create, createMany, update, updateMany, upsert, upsertMany)
- [x] 4.2 Default to `[]` when `uniqueFields` is not configured (preserves existing behavior)

## 5. Tests — Unique Enforcement

- [x] 5.1 Create `tests/unique-constraints.test.ts` with test helpers: create a database with a collection configured with `uniqueFields: ["email", "username"]`
- [x] 5.2 Test create: duplicate email → `UniqueConstraintError` with correct fields/values/existingId
- [x] 5.3 Test create: unique values → succeeds
- [x] 5.4 Test create: null/undefined on unique field → succeeds (nulls not checked)
- [x] 5.5 Test createMany: inter-batch duplicates → fails on conflicting entity
- [x] 5.6 Test createMany with `skipDuplicates: true` → skips unique violations, inserts non-violating
- [x] 5.7 Test update: change unique field to conflicting value → `UniqueConstraintError`
- [x] 5.8 Test update: change unique field to non-conflicting value → succeeds
- [x] 5.9 Test update: change non-unique field → succeeds without check
- [x] 5.10 Test collection without uniqueFields → only ID uniqueness enforced

## 6. Tests — Compound Constraints

- [x] 6.1 Create test database with `uniqueFields: [["userId", "settingKey"]]`
- [x] 6.2 Test create: duplicate compound tuple → `UniqueConstraintError`
- [x] 6.3 Test create: partial overlap (one field matches, other differs) → succeeds
- [x] 6.4 Test create: null in one compound field → skipped, succeeds
- [x] 6.5 Test mixed single + compound constraints on same collection → both enforced
- [x] 6.6 Test error shape: constraint name, fields array, and values reflect compound key

## 7. Tests — Upsert Validation

- [x] 7.1 Create `tests/upsert-validation.test.ts` with test helpers
- [x] 7.2 Test upsert `where: { id }` → always valid
- [x] 7.3 Test upsert `where: { email }` when email is unique → valid
- [x] 7.4 Test upsert `where: { name }` when name is NOT unique → `ValidationError`
- [x] 7.5 Test upsert with compound where matching compound constraint → valid
- [x] 7.6 Test upsert with partial compound where → `ValidationError`
- [x] 7.7 Test collection without uniqueFields → only `{ id }` accepted
- [x] 7.8 Test upsert where with extra fields beyond constraint → valid
- [ ] 7.9 Test upsertMany with invalid where → fails on first invalid

## 8. Cleanup

- [ ] 8.1 Remove unused `ExtractUniqueFields` type from `core/types/crud-types.ts` if no longer needed (replaced by runtime config)
- [ ] 8.2 Run full test suite (`bun test`) to verify no regressions
- [ ] 8.3 Run type check (`bunx tsc --noEmit`) to verify no type errors
