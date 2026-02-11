# Lifecycle Hooks — Design

## Architecture

### New Modules

**`core/hooks/hook-runner.ts`** — Core hook execution logic: `runBeforeHooks(hooks, ctx)` chains before-hooks in order, piping each hook's output to the next. `runAfterHooks(hooks, ctx)` runs after-hooks fire-and-forget with error swallowing. `runOnChangeHooks(hooks, ctx)` same as after-hooks.

**`core/types/hook-types.ts`** — All hook-related types: `HookError`, hook function signatures (`BeforeCreateHook`, `AfterUpdateHook`, etc.), context types, `HooksConfig` map type.

### Modified Modules

**`core/types/database-config-types.ts`** — `CollectionConfig` gains `readonly hooks?: HooksConfig<T>`.

**`core/operations/crud/create.ts`**, **`update.ts`**, **`delete.ts`**, **`upsert.ts`** — Each CRUD function gains an optional `hooks` parameter. Before-hooks run after validation/before mutation. After-hooks and onChange run after mutation/before persistence.

**`core/factories/database-effect.ts`** — `buildCollection` reads `hooks` from config and passes them to CRUD factory functions.

## Key Decisions

### Hooks are arrays of functions, not single functions

Multiple hooks per lifecycle point allows composable concerns: one hook for computed fields, another for audit logging, etc. They run in registration order and chain (before-hooks) or run independently (after-hooks).

### Before-hooks chain, after-hooks don't

Before-hooks form a pipeline: each hook receives the output of the previous one. This enables composable transformations (hook1 normalizes email, hook2 generates slug).

After-hooks and onChange run independently. Each receives the same context (the final state), not each other's output. An after-hook failure doesn't affect other after-hooks.

### After-hook errors are swallowed

After-hooks are side-effect-only. The mutation already succeeded. Making after-hook errors fail the operation would create inconsistency: the state is mutated but the caller sees an error. Swallowing errors and letting hooks handle their own error logging is cleaner.

### HookError is a new tagged error

Before-hooks can reject operations by failing with `HookError`. This is a distinct error type from CRUD errors (ValidationError, DuplicateKeyError, etc.) so callers can distinguish "schema validation failed" from "business logic hook rejected".

### Hook execution in CRUD functions, not as external wrappers

Hooks run inside the CRUD function's `Effect.gen` block, not as external wrappers around the whole function. This is necessary because:
- Before-hooks need access to the validated entity (after schema validation).
- After-hooks need access to the previous state (before mutation) for diffing.
- Both states are available inside the function, not from outside.

### Upsert hooks

Upsert triggers the appropriate hooks based on which path it takes:
- Create path: `beforeCreate` → mutation → `afterCreate` → `onChange(type: "create")`
- Update path: `beforeUpdate` → mutation → `afterUpdate` → `onChange(type: "update")`

The hook type matches the actual operation, not the caller's intent.

### Execution order (complete)

```
1. Schema validation
2. Before-hooks (transform/reject)
3. Unique constraint check
4. Foreign key validation
5. State mutation (Ref.update)
6. Index update
7. After-hooks (fire-and-forget)
8. onChange hooks (fire-and-forget)
9. Persistence trigger (afterMutation)
```

### HooksConfig type

```typescript
interface HooksConfig<T> {
  readonly beforeCreate?: ReadonlyArray<BeforeCreateHook<T>>
  readonly afterCreate?: ReadonlyArray<AfterCreateHook<T>>
  readonly beforeUpdate?: ReadonlyArray<BeforeUpdateHook<T>>
  readonly afterUpdate?: ReadonlyArray<AfterUpdateHook<T>>
  readonly beforeDelete?: ReadonlyArray<BeforeDeleteHook<T>>
  readonly afterDelete?: ReadonlyArray<AfterDeleteHook<T>>
  readonly onChange?: ReadonlyArray<OnChangeHook<T>>
}
```

All fields optional. Missing fields = no hooks for that lifecycle point.

## File Layout

```
core/
  hooks/
    hook-runner.ts           (new — runBeforeHooks, runAfterHooks, runOnChangeHooks)
  types/
    hook-types.ts            (new — HookError, hook signatures, contexts, HooksConfig)
    database-config-types.ts (modified — add hooks to CollectionConfig)
  errors/
    crud-errors.ts           (modified — add HookError)
  operations/
    crud/
      create.ts              (modified — integrate before/after/onChange hooks)
      update.ts              (modified — integrate hooks)
      delete.ts              (modified — integrate hooks)
      upsert.ts              (modified — integrate hooks, routing to create/update hooks)
  factories/
    database-effect.ts       (modified — read hooks from config, pass to CRUD factories)
tests/
  lifecycle-hooks.test.ts    (new — full test suite)
```
