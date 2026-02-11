# Compound Unique Constraints

## Overview

Support uniqueness constraints that span multiple fields. A compound constraint like `["userId", "settingKey"]` means the *combination* of those field values must be unique — individual field values can repeat freely.

## Configuration

Compound constraints are tuple entries in the `uniqueFields` array:

```typescript
uniqueFields: ["email", ["userId", "settingKey"]]
```

- `"email"` — single-field constraint (covered by unique-field-enforcement spec)
- `["userId", "settingKey"]` — compound constraint: no two entities may share the same `(userId, settingKey)` pair

The type is already defined in the unique-field-enforcement spec:
```typescript
readonly uniqueFields?: ReadonlyArray<string | ReadonlyArray<string>>
```

## Behavior

### Matching Logic

For a compound constraint `["userId", "settingKey"]`, two entities conflict when **all** fields in the tuple match:

```
entity.userId === existing.userId AND entity.settingKey === existing.settingKey
```

If any field in the tuple differs, no conflict.

### Null Handling

If **any** field in the compound tuple is `null` or `undefined` on the entity being checked, the constraint is skipped for that entity. Partial nulls do not conflict.

### Conflict Detection

Same as single-field enforcement:
1. Scan existing entities in the `ReadonlyMap`.
2. For each compound constraint, check if all fields match between the new entity and any existing entity (excluding same ID).
3. Fail-fast on first violation.

### createMany Batch Awareness

Entities within the same `createMany` batch are checked against each other for compound constraints, same as single-field constraints. The accumulated "seen" set must track tuples, not single values.

## Error Shape

```typescript
UniqueConstraintError {
  _tag: "UniqueConstraintError"
  collection: "settings"
  constraint: "unique_userId_settingKey"
  fields: ["userId", "settingKey"]
  values: { userId: "u1", settingKey: "theme" }
  existingId: "s42"
  message: "Unique constraint violated: userId, settingKey must be unique in settings"
}
```

- `constraint` name: `"unique_" + fields.join("_")`
- `fields` contains all fields in the compound tuple
- `values` contains the conflicting values for all fields

## Implementation Considerations

The existing `checkUniqueConstraints` function only handles single fields (iterates `uniqueFields` as strings). It needs to:

1. Distinguish between `string` entries (single) and `string[]` entries (compound)
2. For compound entries, build a composite key from all field values for comparison
3. The comparison function for compounds: check all fields match on the candidate entity

A unified approach: normalize all constraints to arrays. `"email"` becomes `["email"]`. Then a single code path handles both — check if all fields in the array match.

## Tests

- Compound constraint with duplicate tuple → `UniqueConstraintError`
- Compound constraint with partial overlap (one field matches, other differs) → succeeds
- Compound constraint with null in any field → skipped, succeeds
- Mixed single + compound constraints on same collection → both enforced
- createMany batch with compound duplicates → fails on the duplicate
- Update changing one field of compound to create conflict → `UniqueConstraintError`
- Constraint name in error reflects all field names
