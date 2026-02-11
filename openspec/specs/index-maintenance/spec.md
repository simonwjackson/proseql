# Automatic Index Maintenance

## Overview

Indexes are kept in sync with the collection data by hooking into CRUD mutation methods. Every create, update, upsert, and delete operation updates the affected indexes atomically alongside the Ref state mutation.

## Behavior

### Create

When an entity is created:
1. For each indexed field, read the entity's value for that field.
2. If the value is not null/undefined, add the entity's ID to the index entry for that value.

### Update

When an entity is updated:
1. For each indexed field that the update touches:
   - Read the old value from the pre-update entity.
   - Read the new value from the post-update entity.
   - If the value changed: remove the entity's ID from the old value's Set, add it to the new value's Set.
2. Indexed fields not touched by the update are left alone.

### Delete

When an entity is deleted:
1. For each indexed field, read the entity's value for that field.
2. Remove the entity's ID from the index entry for that value.
3. If the Set becomes empty after removal, delete the map entry to avoid memory leaks.

### Upsert

Upsert follows the create or update path depending on whether the entity exists:
- Create path: same as Create above.
- Update path: same as Update above.

### Batch Operations (createMany, updateMany, deleteMany, upsertMany)

Each entity in the batch applies the corresponding single-entity index update. The index Ref is updated once per batch (collect all changes, apply atomically) rather than once per entity.

## Atomicity

Index updates happen inside the same `Ref.update` call as the data mutation, or in a coordinated pair of `Ref.update` calls (data Ref + index Ref) within the same Effect.gen block. This ensures the index and data are always consistent — there's no window where the index reflects stale data.

## Integration Point

CRUD functions in `core/operations/crud/` need access to the collection's `CollectionIndexes`. The database factory passes indexes to CRUD factory functions alongside the existing parameters (schema, relationships, ref, stateRefs).

## Tests

- Create entity → index entry added for each indexed field
- Update entity changing indexed field → old entry removed, new entry added
- Update entity not changing indexed field → index unchanged
- Delete entity → index entries removed, empty Sets cleaned up
- createMany → all entities indexed in one atomic update
- Upsert (create path) → index entry added
- Upsert (update path) → index entry updated
- Index and data stay consistent after a sequence of mixed CRUD operations
