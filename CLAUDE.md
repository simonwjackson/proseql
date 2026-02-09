# Project: plan-text-db

Type-safe in-memory database that persists to plain text files (JSON/YAML), being migrated to Effect.

## IMPORTANT: Effect Reference Codebase

A local clone of the Effect library lives at `./effect/`. **You MUST explore this codebase before implementing any task.** Do not rely on your training data for Effect APIs — the library evolves rapidly and your knowledge may be stale.

Before writing any Effect code:

1. **Search the real source** in `./effect/packages/effect/src/` for the modules you plan to use (e.g., `Schema.ts`, `Stream.ts`, `Ref.ts`, `Data.ts`, `Context.ts`, `Layer.ts`)
2. **Read the actual type signatures** — do not guess parameter order, generic constraints, or method names
3. **Check `./effect/packages/effect/test/`** for usage examples of the APIs you need
4. **Verify imports** — everything should import from `"effect"` (single package in Effect 3.x)

Key source paths:
- `./effect/packages/effect/src/` — core module source (Schema, Stream, Ref, Data, Effect, Layer, Context, etc.)
- `./effect/packages/effect/test/` — test files with real usage patterns
- `./effect/packages/effect/src/internal/` — internal implementations (useful for understanding behavior)

## Build & Test

- **Test:** `bun test`
- **Type check:** `bunx tsc --noEmit`

## Conventions

- Never use `any` in TypeScript
- Import from `"effect"` (single package)
- Use `Effect.gen(function* () { ... })` with `yield*`
- Errors extend `Data.TaggedError("Name")<{ fields }>`
- Schemas use `Schema.Struct({ ... })` not `Schema.Class`
- State uses `Ref<ReadonlyMap<string, T>>`
- All fields are `readonly`
