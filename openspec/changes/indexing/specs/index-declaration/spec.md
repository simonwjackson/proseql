# Index Declaration

## Overview

Collections declare indexed fields in their config. Indexes are purely in-memory structures — no persistence changes. Omitting the `indexes` config preserves current full-scan behavior.

## Configuration

`CollectionConfig` gains an optional `indexes` property:

```typescript
readonly indexes?: ReadonlyArray<string | ReadonlyArray<string>>
```

- `string` entries are single-field indexes (e.g., `"email"`)
- `ReadonlyArray<string>` entries are compound indexes (see compound-indexes spec)
- Omitting `indexes` or passing `[]` means no indexes (full-scan for all queries)

Example:
```typescript
{
  schema: UserSchema,
  indexes: ["email", "slug"],
  relationships: {}
}
```

## Index Data Structure

Each single-field index is a `Map<unknown, Set<string>>`:
- Key: the field value (e.g., `"alice@example.com"`)
- Value: `Set` of entity IDs that have that value

Each index is stored in a `Ref` for atomic updates:

```typescript
type IndexMap = Map<unknown, Set<string>>
type IndexRef = Ref<IndexMap>
```

The full index state for a collection is:

```typescript
type CollectionIndexes = Map<string, IndexRef>
// key is the normalized index key (field name for single, joined for compound)
```

## Initialization

At database creation (or data load), indexes are built by scanning the initial data:

```typescript
for (const entity of initialData) {
  const value = entity[field]
  if (value !== undefined && value !== null) {
    index.get(value)?.add(entity.id) ?? index.set(value, new Set([entity.id]))
  }
}
```

`null` and `undefined` values are not indexed — they don't participate in equality lookups.

## Tests

- Collection with `indexes: ["email"]` builds index from initial data
- Index maps field values to correct entity IDs
- Multiple entities with the same field value are all in the index Set
- Null/undefined values are not indexed
- Collection without `indexes` config has no indexes (empty map)
- Index is a `Ref` that can be read atomically
