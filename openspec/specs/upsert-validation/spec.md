# Upsert Where-Clause Validation

## Overview

Validate at runtime that an upsert's `where` clause targets a declared unique field (or `id`). Reject upserts that match on non-unique fields, since matching on a non-unique field could find an arbitrary entity and silently corrupt data.

## Behavior

### Validation Rule

When `upsert` or `upsertMany` is called, before looking up the existing entity:

1. Extract the field names from the `where` clause (the keys of the where object).
2. Check if those fields correspond to a declared unique constraint:
   - `{ id: "..." }` — always valid (`id` is implicitly unique)
   - `{ email: "..." }` — valid if `"email"` is in `uniqueFields`
   - `{ userId: "u1", settingKey: "theme" }` — valid if `["userId", "settingKey"]` is a compound entry in `uniqueFields`
   - `{ name: "..." }` — invalid if `"name"` is not in `uniqueFields`
3. The where clause must match **exactly one** declared constraint (single or compound). Extra fields beyond the constraint fields are allowed for additional filtering, but at least one constraint must be fully covered.

### Matching Logic

The where clause fields are checked against each declared constraint:
- For single-field constraint `"email"`: where must include `email`
- For compound constraint `["userId", "settingKey"]`: where must include both `userId` and `settingKey`
- `id` always counts as a valid constraint even if not listed in `uniqueFields`

If no constraint is fully covered by the where clause fields, fail with an error.

### Collections Without uniqueFields

If a collection has no `uniqueFields` declared, upsert only accepts `{ id: "..." }` as the where clause. Any other field produces a validation error. This is stricter than today's behavior (which allows any field) but surfaces bugs.

## Error Shape

Uses `ValidationError` (not `UniqueConstraintError` — this is input validation, not data integrity):

```typescript
ValidationError {
  _tag: "ValidationError"
  message: "Upsert where clause must target a unique field or id"
  issues: [{
    field: "where",
    message: "Field 'name' is not a declared unique field in collection 'users'. Valid unique fields: email, username",
    value: { name: "Alice" }
  }]
}
```

## Impact on Upsert Create Path

When the upsert's where clause passes validation but no matching entity is found (create path):
- The unique field value from the where clause is included in the new entity (existing behavior — `where` fields are merged into create data)
- The new entity is also checked against `checkUniqueConstraints` before insert (handled by the unique-field-enforcement spec)

This means the upsert create path gets double protection: the where clause is validated as targeting a unique field, and the resulting entity is checked for uniqueness violations.

## Tests

- Upsert with `where: { id: "..." }` → always valid, regardless of uniqueFields config
- Upsert with `where: { email: "..." }` when `email` is in uniqueFields → valid
- Upsert with `where: { name: "..." }` when `name` is NOT in uniqueFields → `ValidationError`
- Upsert with compound where matching a compound constraint → valid
- Upsert with partial compound where (only one of two fields) → `ValidationError`
- upsertMany with mixed valid/invalid where clauses → fails on first invalid
- Collection without uniqueFields → only `{ id }` accepted
- Upsert with where clause containing extra fields beyond constraint → valid (constraint is covered)
