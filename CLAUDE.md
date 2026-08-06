# Project: proseql

Type-safe in-memory database that persists to plain text files (JSON/YAML/TOML/etc.), built on Effect.

## Workspace Structure

This is a Bun workspace monorepo with the following packages:

- `@proseql/core` — shared types, schemas, errors, and the legacy TypeScript core
- `@proseql/engine` — Promise-first Rust/WASM database engine
- `@proseql/effect` — Effect adapter over the Rust/WASM engine
- `@proseql/browser` — browser engine entry point and browser storage hosts
- `@proseql/node` — Node.js storage adapter
- `@proseql/rest` — REST API handlers (framework-agnostic)
- `@proseql/rpc` — client-safe Effect 4 RPC definitions, with WASM-backed handlers under `@proseql/rpc/server`

All Effect declarations are pinned to exactly `effect@4.0.0-beta.103`. RPC uses `effect/unstable/rpc`; the obsolete separate `@effect/rpc` package must not be reintroduced.

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
- **Type check:** `just typecheck` or `bun run tsc --build`
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

Available commands in shell: `bun`, `biome`, `just`, `bun2nix`, `git`, `rustc`, `cargo`, `rustfmt`, `clippy`

Build packages: `nix build .#core`, `nix build .#node`, etc.

Run checks: `nix flake check`

---

## Rust Engine Workspace

A Rust workspace lives at `crates/` alongside `packages/`. It is the
implementation layer for the proseQL engine rewrite (see
`work/items/active/01KYR2GFF49SRGMH4Q9MV1F2TS-rust-engine-conversion/plan.md`).

### Layout

```
crates/
├── Cargo.toml                    # workspace root
├── proseql-engine/               # platform-blind core: descriptor, value, errors, validator
├── proseql-formats/              # codec crates (JSON/YAML/TOML/etc.) — added in U5
├── proseql-storage/              # storage-host trait + native fs/notify — added in U5
└── proseql-wasm/                 # wasm-bindgen boundary crate — added in U8
```

### Key design rules for the Rust codebase

**TS types are the contract; Rust implements the semantics.**
The TypeScript type layer in `packages/core/src/types/` is the compile-time
contract for all consumers.  The Rust engine's observable behaviour must match
that contract, as verified by the conformance test corpus (U9 parity gate).
Any divergence is a bug in the Rust implementation, not a re-definition of the
type surface.

- **No platform I/O in `proseql-engine`** — all I/O goes through the
  storage-host trait in `proseql-storage`.  `proseql-engine` must compile on
  any target (Linux, Android arm64, WASM) without changes.
- **Error tags must match TS `_tag` fields exactly** — `EngineError::tag()`
  returns the TS `_tag` string; the binding adapter uses it to reconstruct
  `TaggedError` classes for `Effect.catchTag`.
- **SchemaNode covers only the audited Effect Schema subset** — combinators
  beyond `Struct`, `String`, `Number`, `Boolean`, `Array`, `optional`,
  `optionalWith { default }`, `NullOr`, `NumberFromString`, `Record`, `mutable`,
  `Unknown` are represented as `SchemaNode::Unsupported { reason }` and rejected
  loudly at runtime.
- **`optional` ≠ `null`** — `Schema.optional(T)` expands to `T | undefined`
  (source: `effect/packages/effect/src/Schema.ts`, `optional()` function);
  JSON `null` is NOT equivalent to absent.  The engine rejects `null` for
  `Optional(T)` fields unless `T` itself is `NullOr(...)`.
- **`cause` fields use `Option<serde_json::Value>`** — mirrors TS `cause?: unknown`;
  using `Value` (not `String`) preserves structured error payloads without
  string coercion across the boundary.
- **EngineError serde wire format** — serialized `EngineError` uses `_tag` (not
  `tag`) and camelCase payload field names to match the TS `Data.TaggedError`
  class fields exactly.  `EngineError::tag()` and the `#[serde(rename)]` on
  each variant must stay in sync.
- **Legacy collection persistence fields are NOT in the descriptor** — the TS
  `CollectionConfig` fields `file`, `directory`, `format`, and `path` are
  normalised into `SourceDescriptor` entries by the boundary compiler (U8).
  `CollectionDescriptor` is storage-agnostic; storage is wired at the source
  level.  Native Rust consumers (korrid) configure storage via the storage-host
  trait directly.
- **Value semantics must match JS** — `serde_json::Value` is the canonical
  boundary value type; JS number semantics (IEEE 754 f64) apply throughout.

### Rust build & test commands

```bash
just rust-check    # cargo check
just rust-test     # cargo test (includes conformance fixtures)
just rust-lint     # cargo clippy -D warnings
just rust-format   # cargo fmt
just rust-build    # cargo build --release
```

Or run cargo directly: `cargo test --manifest-path crates/Cargo.toml`
