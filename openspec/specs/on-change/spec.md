# onChange Hook

## Overview

A catch-all listener that fires after any mutation (create, update, delete) on a collection. It provides a single registration point for generic cross-cutting concerns like event sourcing, reactive UI updates, and logging without registering individual before/after hooks for each operation type.

## Configuration

```typescript
hooks: {
  onChange: [fn1, fn2],
}
```

`onChange` can be used alongside specific before/after hooks.

## Hook Signature

```typescript
type OnChangeHook<T> = (
  ctx: OnChangeContext<T>
) => Effect<void, never>
```

```typescript
type OnChangeContext<T> =
  | {
      readonly type: "create"
      readonly collection: string
      readonly entity: T
    }
  | {
      readonly type: "update"
      readonly collection: string
      readonly id: string
      readonly previous: T
      readonly current: T
    }
  | {
      readonly type: "delete"
      readonly collection: string
      readonly id: string
      readonly entity: T
    }
```

The context is a discriminated union on `type`. The hook can switch on `type` to handle each operation differently or handle them uniformly.

## Execution Order

1. Before-hooks run.
2. State mutation executes.
3. Specific after-hooks run (afterCreate/afterUpdate/afterDelete).
4. **onChange hooks run** (after specific after-hooks).
5. Persistence hooks run.

This ordering ensures that specific hooks complete before generic listeners fire, and that persistence is always last.

## Error Handling

Same as after-hooks: errors are swallowed. The mutation already succeeded.

## Batch Operations

`onChange` fires once per entity in a batch, not once per batch. Each entity gets its own context with the correct `type`.

## Tests

- onChange fires on create with correct context
- onChange fires on update with previous/current
- onChange fires on delete with deleted entity
- onChange fires after specific after-hooks
- Multiple onChange hooks run in order
- onChange error does not fail the operation
- onChange works alongside specific hooks (both fire)
- Batch operation: onChange fires per entity
