# Unique Constraints — Design

## Architecture

### Constraint Normalization

All constraints are normalized to arrays internally. A `uniqueFields` config of `["email", ["userId", "settingKey"]]` normalizes to:

```typescript
[["email"], ["userId", "settingKey"]]
```

This lets a single code path handle both single and compound constraints. The normalization happens once when the database factory reads config, not on every check.

### Modified Modules

**`core/types/database-config-types.ts`** — `CollectionConfig` gains `readonly uniqueFields?: ReadonlyArray<string | ReadonlyArray<string>>`. No new module needed — this is a one-line addition.

**`core/operations/crud/unique-check.ts`** (new) — Extracted from the existing `checkUniqueConstraints` in `create.ts`. Rewritten to:
- Accept normalized constraints (`ReadonlyArray<ReadonlyArray<string>>`)
- Handle compound constraints (all fields must match)
- Return `Effect<void, UniqueConstraintError>` instead of a plain result object
- Exported for use by create, createMany, update, and upsert

**`core/operations/crud/create.ts`** — `create` and `createMany` call the new `checkUniqueConstraints` Effect after schema validation, before state mutation. The old `checkUniqueConstraints` function at the bottom of this file is deleted (replaced by `unique-check.ts`).

**`core/operations/crud/update.ts`** — `update` and `updateMany` call `checkUniqueConstraints` when the update touches a unique field. Detecting "touches a unique field" means checking if any update key (or $set key) overlaps with any constraint's fields.

**`core/operations/crud/upsert.ts`** — `upsert` and `upsertMany` gain a validation step at the top: validate that the where clause covers at least one declared constraint. On the create path, `checkUniqueConstraints` is also called.

**`core/factories/database-effect.ts`** — `buildCollection` reads `uniqueFields` from config, normalizes it, and passes it to `create`, `createMany`, `update`, `updateMany`, `upsert`, `upsertMany` factory functions. All these factories gain a `uniqueFields` parameter.

## Key Decisions

### Separate `unique-check.ts` module

The check logic is shared by create, update, and upsert. Keeping it in `create.ts` would create a circular-ish import or odd dependency. A dedicated module in `core/operations/crud/unique-check.ts` is cleaner.

### checkUniqueConstraints returns Effect, not a result object

The existing function returns `{ valid, field?, value?, existingId? }` — the caller must manually check `.valid` and construct the error. Converting to `Effect<void, UniqueConstraintError>` makes it composable with `yield*` in Effect.gen and eliminates a class of "forgot to check the result" bugs.

### Upsert validation uses ValidationError, not UniqueConstraintError

The where-clause validation is an input validation problem ("you passed an invalid where clause"), not a data integrity problem ("your data conflicts with existing data"). Using `ValidationError` keeps error semantics clean.

### Factory passes normalized constraints

The factory normalizes `uniqueFields` once and passes `ReadonlyArray<ReadonlyArray<string>>` to all CRUD functions. This avoids repeated normalization on every operation and simplifies the check function's signature.

### Update only checks when unique fields are touched

If an update sets `{ name: "Alice" }` and the unique fields are `["email"]`, no unique check is needed. The update function inspects which fields are being modified and skips the check when there's no overlap. This avoids unnecessary scans.

### Upsert where-clause matching allows extra fields

A where clause `{ email: "alice@example.com", role: "admin" }` is valid if `"email"` is a unique field — the extra `role` field acts as additional filtering. The validation only requires that at least one complete constraint is covered by the where keys.

## CRUD Function Signature Changes

Current:
```typescript
export const create = <T extends HasId, I = T>(
  collectionName: string,
  schema: Schema.Schema<T, I>,
  relationships: Record<string, RelationshipConfig>,
  ref: Ref.Ref<ReadonlyMap<string, T>>,
  stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
) => ...
```

New (same pattern for create, createMany, update, updateMany, upsert, upsertMany):
```typescript
export const create = <T extends HasId, I = T>(
  collectionName: string,
  schema: Schema.Schema<T, I>,
  relationships: Record<string, RelationshipConfig>,
  ref: Ref.Ref<ReadonlyMap<string, T>>,
  stateRefs: Record<string, Ref.Ref<ReadonlyMap<string, HasId>>>,
  uniqueFields: ReadonlyArray<ReadonlyArray<string>>,
) => ...
```

The `uniqueFields` parameter defaults to `[]` when not configured, preserving backward compatibility.

## Error Type Changes

`create` and `createMany` gain `UniqueConstraintError` in their error channel:
```typescript
Effect<T, ValidationError | DuplicateKeyError | ForeignKeyError | UniqueConstraintError>
```

`update` and `updateMany` gain `UniqueConstraintError`:
```typescript
Effect<T, ValidationError | ForeignKeyError | UniqueConstraintError>
```

`upsert` and `upsertMany` gain both `UniqueConstraintError` (create path) and the new where-clause `ValidationError` (already in the type):
```typescript
Effect<UpsertResult<T>, ValidationError | ForeignKeyError | UniqueConstraintError>
```

## File Layout

```
core/
  types/
    database-config-types.ts   (modified — add uniqueFields to CollectionConfig)
  operations/
    crud/
      unique-check.ts          (new — checkUniqueConstraints Effect + validateUpsertWhere)
      create.ts                (modified — call checkUniqueConstraints, remove old helper)
      update.ts                (modified — call checkUniqueConstraints when unique fields touched)
      upsert.ts                (modified — validate where clause, call checkUniqueConstraints on create path)
  factories/
    database-effect.ts         (modified — read uniqueFields, normalize, pass to CRUD factories)
tests/
  unique-constraints.test.ts   (new — enforcement tests)
  upsert-validation.test.ts    (new — where-clause validation tests)
```
