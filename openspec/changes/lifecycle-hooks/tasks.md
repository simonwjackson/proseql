## 1. Types

- [x] 1.1 Create `core/types/hook-types.ts` with all context types: `BeforeCreateContext<T>`, `BeforeUpdateContext<T>`, `BeforeDeleteContext<T>`, `AfterCreateContext<T>`, `AfterUpdateContext<T>`, `AfterDeleteContext<T>`, `OnChangeContext<T>` (discriminated union on `type`)
- [x] 1.2 Define hook function signatures: `BeforeCreateHook<T>`, `BeforeUpdateHook<T>`, `BeforeDeleteHook<T>`, `AfterCreateHook<T>`, `AfterUpdateHook<T>`, `AfterDeleteHook<T>`, `OnChangeHook<T>`
- [x] 1.3 Define `HooksConfig<T>` interface with optional arrays for each hook type
- [x] 1.4 Add `HookError` to `core/errors/crud-errors.ts`: `Data.TaggedError("HookError")<{ hook, collection, operation, reason, message }>`
- [x] 1.5 Add `readonly hooks?: HooksConfig<T>` to `CollectionConfig` in `core/types/database-config-types.ts`
- [x] 1.6 Export new types from `core/index.ts`

## 2. Hook Runner

- [x] 2.1 Create `core/hooks/hook-runner.ts` with `runBeforeHooks(hooks, initialCtx)`: chain hooks in order, pipe each hook's output to the next. Return the final transformed data. If any hook fails with `HookError`, short-circuit and propagate.
- [x] 2.2 Implement `runAfterHooks(hooks, ctx)`: run all hooks in order, swallow errors (catch all and discard). Each hook receives the same context.
- [x] 2.3 Implement `runOnChangeHooks(hooks, ctx)`: same as `runAfterHooks` but with `OnChangeContext`.
- [x] 2.4 Handle empty/undefined hook arrays: return data unchanged (before) or no-op (after/onChange).

## 3. CRUD Integration — Create

- [x] 3.1 Add `hooks?: HooksConfig<T>` parameter to `create` in `core/operations/crud/create.ts`. After schema validation, run `beforeCreate` hooks with the validated entity. Use the returned (possibly transformed) entity for the insert.
- [x] 3.2 After state mutation in `create`, run `afterCreate` hooks with the created entity. Then run `onChange` hooks with `type: "create"`.
- [x] 3.3 Add `HookError` to `create`'s error channel.
- [x] 3.4 In `createMany`, run before/after/onChange hooks per entity. Respect `skipDuplicates` for `HookError` (skip the entity).

## 4. CRUD Integration — Update

- [x] 4.1 Add `hooks` parameter to `update` in `core/operations/crud/update.ts`. Before applying updates, capture the existing entity as `previous`. Run `beforeUpdate` hooks with the update payload. Use the returned (possibly transformed) payload.
- [x] 4.2 After state mutation, run `afterUpdate` hooks with `previous` and `current`. Then run `onChange` hooks with `type: "update"`.
- [x] 4.3 Add `HookError` to `update`'s error channel.
- [x] 4.4 In `updateMany`, run hooks per entity.

## 5. CRUD Integration — Delete

- [ ] 5.1 Add `hooks` parameter to `delete` in `core/operations/crud/delete.ts`. Before removing, run `beforeDelete` hooks with the entity about to be deleted.
- [ ] 5.2 After state mutation, run `afterDelete` hooks with the deleted entity. Then run `onChange` hooks with `type: "delete"`.
- [ ] 5.3 Add `HookError` to `delete`'s error channel.
- [ ] 5.4 In `deleteMany`, run hooks per entity.

## 6. CRUD Integration — Upsert

- [ ] 6.1 Add `hooks` parameter to `upsert` in `core/operations/crud/upsert.ts`. On create path: run `beforeCreate`/`afterCreate`/`onChange("create")`. On update path: run `beforeUpdate`/`afterUpdate`/`onChange("update")`.
- [ ] 6.2 In `upsertMany`, same per-entity routing.

## 7. Factory Integration

- [ ] 7.1 In `core/factories/database-effect.ts` `buildCollection`: read `hooks` from collection config, pass to all CRUD factory function calls.
- [ ] 7.2 Default to empty hooks (no-op) when not configured.

## 8. Tests — Before Hooks

- [ ] 8.1 Create `tests/lifecycle-hooks.test.ts` with test helpers: database with hooked collection
- [ ] 8.2 Test beforeCreate transforms data → inserted entity reflects transformation
- [ ] 8.3 Test beforeCreate rejects → create fails with HookError, no state change
- [ ] 8.4 Test multiple beforeCreate hooks chain in order
- [ ] 8.5 Test beforeUpdate modifies update payload
- [ ] 8.6 Test beforeUpdate rejects → update fails, entity unchanged
- [ ] 8.7 Test beforeDelete rejects → delete fails, entity still exists
- [ ] 8.8 Test hook receives correct context (collection, operation, data)

## 9. Tests — After Hooks

- [ ] 9.1 Test afterCreate receives created entity
- [ ] 9.2 Test afterUpdate receives previous and current state
- [ ] 9.3 Test afterDelete receives deleted entity
- [ ] 9.4 Test after-hook error does not fail the CRUD operation
- [ ] 9.5 Test multiple after-hooks run in order
- [ ] 9.6 Test after-hooks run after state mutation is complete

## 10. Tests — onChange

- [ ] 10.1 Test onChange fires on create with `type: "create"`
- [ ] 10.2 Test onChange fires on update with `type: "update"`, previous/current
- [ ] 10.3 Test onChange fires on delete with `type: "delete"`
- [ ] 10.4 Test onChange fires after specific after-hooks
- [ ] 10.5 Test onChange works alongside specific hooks
- [ ] 10.6 Test onChange error does not fail the operation

## 11. Tests — Batch and Upsert

- [ ] 11.1 Test createMany: hooks run per entity
- [ ] 11.2 Test updateMany: hooks run per entity
- [ ] 11.3 Test deleteMany: hooks run per entity
- [ ] 11.4 Test upsert create path: triggers beforeCreate/afterCreate/onChange("create")
- [ ] 11.5 Test upsert update path: triggers beforeUpdate/afterUpdate/onChange("update")

## 12. Cleanup

- [ ] 12.1 Run full test suite (`bun test`) to verify no regressions
- [ ] 12.2 Run type check (`bunx tsc --noEmit`) to verify no type errors
