# After Hooks (afterCreate, afterUpdate, afterDelete)

## Overview

After-hooks run after the mutation is successfully applied to state. They are used for side effects: audit logging, cache invalidation, notifications, sync triggers. After-hooks cannot modify the mutation result or roll it back.

## Configuration

```typescript
hooks: {
  afterCreate: [fn1],
  afterUpdate: [fn1, fn2],
  afterDelete: [fn1],
}
```

Same registration pattern as before-hooks.

## Hook Signatures

### afterCreate

```typescript
type AfterCreateHook<T> = (
  ctx: AfterCreateContext<T>
) => Effect<void, never>
```

```typescript
interface AfterCreateContext<T> {
  readonly operation: "create"
  readonly collection: string
  readonly entity: T              // the created entity (as stored)
}
```

### afterUpdate

```typescript
type AfterUpdateHook<T> = (
  ctx: AfterUpdateContext<T>
) => Effect<void, never>
```

```typescript
interface AfterUpdateContext<T> {
  readonly operation: "update"
  readonly collection: string
  readonly id: string
  readonly previous: T            // entity state before update
  readonly current: T             // entity state after update
  readonly update: UpdateWithOperators<T>  // the update that was applied
}
```

Providing both `previous` and `current` enables diffing without the hook needing to compute it.

### afterDelete

```typescript
type AfterDeleteHook<T> = (
  ctx: AfterDeleteContext<T>
) => Effect<void, never>
```

```typescript
interface AfterDeleteContext<T> {
  readonly operation: "delete"
  readonly collection: string
  readonly id: string
  readonly entity: T              // the entity that was deleted
}
```

## Execution Order

1. The state mutation completes successfully.
2. After-hooks run in registration order.
3. After-hooks run fire-and-forget: errors are logged but do not fail the operation or roll back the mutation.
4. The CRUD operation returns the result to the caller.
5. After-hooks and persistence hooks both run post-mutation. After-hooks run first, then persistence.

## Error Handling

After-hook errors are swallowed — they do not propagate to the caller. The mutation already succeeded and cannot be undone by a failed after-hook. The error channel is `never`.

If after-hook error visibility is needed (debugging, monitoring), the hook itself should handle its own error logging.

## Batch Operations

For batch operations, after-hooks run once per entity (not once per batch), same as before-hooks. Each entity gets its own context.

## Tests

- afterCreate receives the created entity → correct context
- afterUpdate receives previous and current state → enables diffing
- afterDelete receives the deleted entity → correct context
- After-hook error does not fail the CRUD operation
- Multiple after-hooks run in order
- After-hooks run after state mutation (entity exists/is updated/is deleted when hook runs)
- No hooks configured → existing behavior unchanged
- Batch operation: per-entity after-hook execution
