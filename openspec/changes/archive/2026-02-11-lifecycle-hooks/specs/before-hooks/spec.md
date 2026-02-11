# Before Hooks (beforeCreate, beforeUpdate, beforeDelete)

## Overview

Before-hooks intercept CRUD operations before the mutation is applied. They can transform data (create/update) or reject the operation entirely by failing with an error. Before-hooks run after schema validation but before state mutation.

## Configuration

Hooks are registered per collection in the database config:

```typescript
{
  schema: UserSchema,
  relationships: {},
  hooks: {
    beforeCreate: [fn1, fn2],
    beforeUpdate: [fn1],
    beforeDelete: [fn1],
  }
}
```

Each hook type accepts an array of functions. Multiple hooks run in registration order. The `hooks` property is optional — omitting it preserves current behavior.

## Hook Signatures

### beforeCreate

```typescript
type BeforeCreateHook<T> = (
  ctx: BeforeCreateContext<T>
) => Effect<T, HookError>
```

```typescript
interface BeforeCreateContext<T> {
  readonly operation: "create"
  readonly collection: string
  readonly data: T                    // the validated entity about to be inserted
}
```

The hook returns the (possibly transformed) entity. Returning a modified entity replaces the data that gets inserted. Failing with `HookError` aborts the create.

### beforeUpdate

```typescript
type BeforeUpdateHook<T> = (
  ctx: BeforeUpdateContext<T>
) => Effect<UpdateWithOperators<T>, HookError>
```

```typescript
interface BeforeUpdateContext<T> {
  readonly operation: "update"
  readonly collection: string
  readonly id: string
  readonly existing: T                // current entity state
  readonly update: UpdateWithOperators<T>  // the update payload
}
```

The hook returns the (possibly transformed) update payload. It can modify, add, or remove update operators. Failing aborts the update.

### beforeDelete

```typescript
type BeforeDeleteHook<T> = (
  ctx: BeforeDeleteContext<T>
) => Effect<void, HookError>
```

```typescript
interface BeforeDeleteContext<T> {
  readonly operation: "delete"
  readonly collection: string
  readonly id: string
  readonly entity: T                  // the entity about to be deleted
}
```

The hook returns void (no data transformation for delete). Failing aborts the delete.

## Execution Order

1. Schema validation runs (existing behavior).
2. Before-hooks run in registration order (first registered → first executed).
3. Each hook receives the output of the previous hook (chaining). For `beforeCreate`, hook2 sees the entity returned by hook1.
4. If any hook fails, the operation short-circuits. No mutation occurs. The error propagates to the caller.
5. After all before-hooks succeed, the state mutation proceeds.

## HookError

```typescript
class HookError extends Data.TaggedError("HookError")<{
  readonly hook: string          // hook identifier (e.g., "beforeCreate[0]")
  readonly collection: string
  readonly operation: "create" | "update" | "delete"
  readonly reason: string
  readonly message: string
}>
```

Before-hooks can fail with `HookError` to abort the operation. The `reason` field provides a human-readable explanation of why the hook rejected the operation.

## Batch Operations

For `createMany`, `updateMany`, `deleteMany`: before-hooks run per entity, not per batch. Each entity passes through the hook chain independently. If a hook rejects one entity in a `createMany` with `skipDuplicates`, that entity is skipped (same as validation failure behavior).

## Tests

- beforeCreate transforms data → inserted entity reflects transformation
- beforeCreate rejects → create fails with HookError, no state change
- Multiple beforeCreate hooks chain → each sees previous output
- beforeUpdate modifies update payload → applied update reflects changes
- beforeUpdate rejects → update fails, entity unchanged
- beforeDelete rejects → delete fails, entity still exists
- Hook receives correct context (collection name, operation, existing data)
- No hooks configured → existing behavior unchanged
- Batch operation: per-entity hook execution
