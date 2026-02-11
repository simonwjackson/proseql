# Project: proseql

Type-safe in-memory database that persists to plain text files (JSON/YAML/TOML/etc.), built on Effect.

## Workspace Structure

This is a Bun workspace monorepo with the following packages:

- `@proseql/core` — runtime-agnostic database core (no Node imports)
- `@proseql/node` — Node.js adapter, re-exports core + `NodeStorageLayer`
- `@proseql/rest` — REST API handlers (framework-agnostic)
- `@proseql/rpc` — Effect RPC integration

```
packages/
├── core/      @proseql/core
├── node/      @proseql/node (depends on core)
├── rest/      @proseql/rest (depends on core)
└── rpc/       @proseql/rpc  (depends on core + @effect/rpc)
```

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

Commands via justfile:

- **Test all:** `just test` or `bun test packages/*/tests/`
- **Test core:** `just test-core` or `bun test packages/core/tests/`
- **Test node:** `just test-node` or `bun test packages/node/tests/`
- **Type check:** `just typecheck` or `bunx tsc --build`
- **Lint:** `just lint` or `biome check .`
- **Format:** `just format` or `biome format --write .`
- **Clean:** `just clean`

## Important Files

Core package (`packages/core/src/`):
- `index.ts` — main exports
- `factories/database.ts` — database factory
- `types/types.ts` — type system
- `types/database-config-types.ts` — config types
- `operations/` — query and CRUD operations
- `storage/` — persistence layer (adapters, storage service)
- `serializers/` — JSON/YAML/TOML/JSON5/JSONC/Hjson/TOON codecs
- `errors/` — tagged error types
- `indexes/` — index management
- `migrations/` — schema migration system
- `transactions/` — transaction support
- `hooks/` — lifecycle hooks

Node package (`packages/node/src/`):
- `index.ts` — re-exports core + Node-specific exports
- `node-adapter-layer.ts` — Node.js file system adapter

Tests:
- `packages/core/tests/` — core tests (~1590 tests)
- `packages/node/tests/` — Node adapter tests

## Conventions

- Never use `any` in TypeScript
- Import from `"effect"` (single package)
- Use `Effect.gen(function* () { ... })` with `yield*`
- Errors extend `Data.TaggedError("Name")<{ fields }>`
- Schemas use `Schema.Struct({ ... })` not `Schema.Class`
- State uses `Ref<ReadonlyMap<string, T>>`
- All fields are `readonly`

## Nix Development

Enter dev shell: `nix develop`

Available commands in shell: `bun`, `biome`, `just`, `bun2nix`, `git`

Build packages: `nix build .#core`, `nix build .#node`, etc.

Run checks: `nix flake check`
