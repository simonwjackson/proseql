# Migration Registry

## Overview

Developers declare ordered transform functions that convert data from one schema version to the next. Each migration is a pure function that operates on the raw deserialized data (plain objects) before schema decoding.

## Configuration

`CollectionConfig` gains an optional `migrations` property:

```typescript
readonly migrations?: ReadonlyArray<Migration>
```

```typescript
interface Migration {
  readonly from: number              // source version
  readonly to: number                // target version (must be from + 1)
  readonly transform: (
    data: Record<string, unknown>    // entity map: { id: entity, ... }
  ) => Record<string, unknown>       // transformed entity map
  readonly description?: string      // human-readable description of what changes
}
```

- Migrations are ordered: `from` must be sequential starting from 0 or 1. Each migration increments version by 1.
- The `transform` function receives the entire entity map (all entities keyed by ID) and returns the transformed map. This allows cross-entity transformations (e.g., computing a field from other entities).
- Transforms operate on raw deserialized objects, not schema-decoded entities. This is necessary because the old data doesn't conform to the new schema.
- `description` is for human consumption in dry-run output.

## Example

```typescript
{
  schema: UserSchemaV3,
  version: 3,
  migrations: [
    {
      from: 0, to: 1,
      description: "Add email field with default",
      transform: (data) => {
        for (const entity of Object.values(data)) {
          (entity as Record<string, unknown>).email = (entity as Record<string, unknown>).email ?? ""
        }
        return data
      }
    },
    {
      from: 1, to: 2,
      description: "Rename 'name' to 'fullName'",
      transform: (data) => {
        for (const entity of Object.values(data)) {
          const e = entity as Record<string, unknown>
          e.fullName = e.name
          delete e.name
        }
        return data
      }
    },
    {
      from: 2, to: 3,
      description: "Add 'role' field with default 'user'",
      transform: (data) => {
        for (const entity of Object.values(data)) {
          (entity as Record<string, unknown>).role = "user"
        }
        return data
      }
    },
  ]
}
```

## Validation

At database creation, the migration registry is validated:

- Migrations must form a contiguous chain (no gaps in `from`/`to`).
- The last migration's `to` must equal the collection's `version`.
- No duplicate `from` values.
- `to` must always be `from + 1`.

Validation failures produce a `MigrationError` at startup, not at load time.

## Tests

- Valid migration chain accepted
- Gap in chain (0→1, 2→3, missing 1→2) → error at startup
- Last migration `to` doesn't match version → error
- Duplicate `from` → error
- `to !== from + 1` → error
- Empty migrations array with version > 0 → error (no path from 0 to current)
- Collection with version: 0 and no migrations → valid (no migrations needed)
