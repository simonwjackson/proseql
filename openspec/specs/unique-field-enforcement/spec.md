# Unique Field Enforcement on Create

## Overview

Reject `create` and `createMany` operations that would insert a record whose value on a declared unique field already exists in the collection. Returns a `UniqueConstraintError` identifying the conflicting field, value, and existing entity ID.

## Configuration

`CollectionConfig` gains an optional `uniqueFields` property:

```typescript
readonly uniqueFields?: ReadonlyArray<string | ReadonlyArray<string>>
```

- `string` entries are single-field constraints (e.g., `"email"`)
- `ReadonlyArray<string>` entries are compound constraints (see `compound-unique-constraints` spec)
- Omitting `uniqueFields` or passing `[]` means only `id` uniqueness is enforced (existing behavior)

Example:
```typescript
{
  schema: UserSchema,
  uniqueFields: ["email", "username"],
  relationships: {}
}
```

## Behavior

### create

After schema validation and before insert:

1. Read the current `Ref<ReadonlyMap<string, T>>` snapshot.
2. For each single-field constraint in `uniqueFields`, check if any existing entity (excluding the new entity's ID) has the same value on that field.
3. `null` and `undefined` values are skipped — nulls are not considered duplicates.
4. On first violation, return `UniqueConstraintError` immediately (fail-fast, do not accumulate).

### createMany

Same check per entity, applied sequentially. Additionally, entities within the same `createMany` batch are checked against each other — if entity 3 and entity 7 in the batch share an email, entity 7 fails.

When `skipDuplicates: true` is set on `createMany`, unique-field violations are silently skipped (same as existing ID-duplicate skip behavior). The non-violating entities are inserted.

### update

After schema validation and before applying the update:

1. If the update modifies a unique field's value, check if the new value conflicts with any other existing entity.
2. The entity being updated is excluded from the conflict check (updating a record to its own current value is fine).
3. Same `UniqueConstraintError` on violation.

Updates that don't touch unique fields skip the check entirely.

## Error Shape

Uses the existing `UniqueConstraintError` from `core/errors/crud-errors.ts`:

```typescript
UniqueConstraintError {
  _tag: "UniqueConstraintError"
  collection: string         // e.g., "users"
  constraint: string         // e.g., "unique_email" (auto-generated: "unique_" + field)
  fields: ReadonlyArray<string>  // e.g., ["email"]
  values: Record<string, unknown> // e.g., { email: "alice@example.com" }
  existingId: string         // ID of the conflicting entity
  message: string            // human-readable description
}
```

The `constraint` name is auto-generated as `"unique_" + fields.join("_")`.

## Integration Point

The `checkUniqueConstraints` function already exists in `core/operations/crud/create.ts` but is never called. It needs to:

1. Accept compound constraints (currently only handles single fields)
2. Be called from `create`, `createMany`, and `update` operations
3. Return an `Effect` failing with `UniqueConstraintError` instead of a plain validation result object

The database factory must read `uniqueFields` from collection config and pass it to the CRUD operation factories.

## Tests

- Create with duplicate value on unique field → `UniqueConstraintError`
- Create with unique values → succeeds
- Create with `null`/`undefined` on unique field → succeeds (nulls not unique-checked)
- createMany with inter-batch duplicates → fails on the conflicting entity
- createMany with `skipDuplicates: true` → skips unique violations silently
- Update changing unique field to conflicting value → `UniqueConstraintError`
- Update changing unique field to non-conflicting value → succeeds
- Update not touching unique field → succeeds (no check)
- Collection without `uniqueFields` config → only ID uniqueness (existing behavior)
