You are implementing the Effect foundation migration for an in-memory TypeScript database library.

## Context

This project is at `/snowscape/code/sandbox/headless-test/packages/shared/db/v2`. It is a type-safe, in-memory database that persists to plain text files (JSON/YAML). You are migrating the foundation from Zod + AsyncIterable + hand-rolled Result types to Effect (Schema, Stream, typed errors, Ref, Service/Layer).

## Your Task

1. Read `openspec/changes/effect-foundation-migration/tasks.md` to see all tasks and their status
2. Find the FIRST unchecked task (`- [ ]`) whose group dependencies are satisfied (all tasks in prior groups are checked)
3. Read the relevant spec and design files for context:
   - `openspec/changes/effect-foundation-migration/design.md` for architectural decisions
   - `openspec/changes/effect-foundation-migration/specs/` for requirements
4. Study the existing code before implementing. Use parallel subagents to read multiple files. Do NOT assume functionality is missing — check first
5. Implement ONLY that single task
6. Run tests to verify: `bun test`
7. If tests pass, mark the task as done by changing `- [ ]` to `- [x]` in tasks.md
8. Commit the changes with a descriptive message
9. If tests fail, fix the issue and re-run. Do NOT move to the next task until tests pass

## Rules

- NEVER use the `any` keyword in TypeScript
- Import everything from `"effect"` (single package in Effect 3.x)
- Use `Effect.gen(function* () { ... })` with `yield*` for sequential effectful code
- Use `.pipe()` for functional composition
- Errors extend `Data.TaggedError("ErrorName")<{ fields }>`
- Schemas use `Schema.Struct({ ... })` not `Schema.Class`
- State uses `Ref<ReadonlyMap<string, T>>` keyed by entity ID
- Query pipeline uses `Stream` composition: filter → populate → sort → paginate → select
- CRUD methods return `Effect<T, E>` not `Promise<Result<T, E>>`
- Services use `Context.Tag` + `Layer` for dependency injection
- All fields are `readonly` by default (Effect convention)
- Write tests alongside implementation. Use `Effect.runPromise` and `Stream.runCollect` in tests

## Important Files

- `core/index.ts` — main exports
- `core/factories/database.ts` — database factory (will be rewritten)
- `core/types/types.ts` — type system (792 lines of conditional types)
- `core/types/database-config-types.ts` — config types
- `core/operations/` — query and CRUD operations
- `core/storage/` — persistence layer
- `core/serializers/` — JSON/YAML/MessagePack
- `tests/` — test suite

## Completion

ONLY WORK ON A SINGLE TASK. After completing one task, updating tasks.md, and committing — stop. The loop will restart you for the next task.
