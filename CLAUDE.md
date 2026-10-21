# Project: proseql

Rust-first type-safe database with plain-text persistence. Rust is the only database engine. The Promise API uses Rust/WASM; the Effect API adapts that engine. Native Rust applications use proseql-native.

## Workspace Structure

This is a Bun workspace monorepo with the following packages:

- `@proseql/core` — shared contracts, schemas, errors, configuration normalization and codecs; no database runtime
- `@proseql/engine` — Promise-first Rust/WASM database engine
- `@proseql/effect` — Effect adapter over the Rust/WASM engine
- `@proseql/browser` — browser engine entry point and browser storage hosts
- `@proseql/node` — Node.js storage adapter
- `@proseql/ai` — AI tool definitions and executor over the Rust-backed Effect API
- `@proseql/cli` — command-line queries and persistence through the Effect API
- `@proseql/rest` — REST API handlers (framework-agnostic)
- `@proseql/rpc` — client-safe Effect 4 RPC definitions, with WASM-backed handlers under `@proseql/rpc/server`

All Effect declarations are pinned to exactly `effect@4.0.0-beta.103`. RPC uses `effect/unstable/rpc`; the obsolete separate `@effect/rpc` package must not be reintroduced.

## IMPORTANT: Effect Reference Codebase

`./effect/` is an old Effect **3.19.16** reference clone. It is not the API used by this project. Read the installed `node_modules/effect/src/` for the pinned **4.0.0-beta.103** before implementing Effect code.

1. Search the real module source in `node_modules/effect/src/` (for example `Effect.ts`, `Schema.ts`, `Stream.ts`, `Scope.ts`, `Context.ts`, `Layer.ts`).
2. Read the actual signatures. Do not guess parameter order, constraints or names.
3. Read the examples in that source and the project's tests. The old clone's tests are not beta.103 examples.
4. Import public APIs from `"effect"`; RPC uses `"effect/unstable/rpc"`.

## Build & Test

Tasks are flake apps defined in `flake.nix` (`taskNames` and `taskRunnerFor`). There is no justfile.
Run a task with `nix run .#<task>`, and pass arguments after `--`. Inside `nix develop`,
`proseql-task <task> [args]` runs the same task without evaluating the flake again.
`nix run .` lists every task.

- **Test all:** `nix run .#test` or `bun test packages/*/tests/`
- **Test core:** `nix run .#test-core` or `bun test packages/core/tests/`
- **Test node:** `nix run .#test-node` or `bun test packages/node/tests/`
- **Type check:** `nix run .#typecheck` or `bun run tsc --build`
- **Lint:** `nix run .#lint` or `biome check .`
- **Format:** `nix run .#format` or `biome format --write .`
- **Clean:** `nix run .#clean`
- **Release gate:** `nix run .#release-check`

To add a task, add a `task_<name>` shell function in `taskRunnerFor` (dashes in the
task name become underscores) and add the name to `taskNames`.

## Important Files

Core package (`packages/core/src/`):
- `index.ts` — shared public contract only
- `types/` — database, query, CRUD, relationship and configuration types
- `storage/source-config.ts` — source types and normalization
- `storage/document-types.ts` — graph diagnostics and provenance contracts
- `storage/storage-service.ts` — storage adapter tag and Shape
- `serializers/` — codecs, serializer registry tag, layers and inference
- `errors/` — exact tagged error classes
- `plugins/` — plugin contracts and pure configuration validation

Runtime packages:
- `packages/engine/src/database.ts` — Promise boundary over Rust/WASM
- `packages/engine/src/host/` — host-side load/save, source assembly and migration orchestration, not a database engine
- `packages/effect/src/database.ts` — Effect and Stream adapter
- `packages/node/src/node-adapter-layer.ts` — thin adapter over the engine's Node storage host

Tests:
- `packages/core/tests/` — shared codecs, configuration and type contracts
- `packages/core/tsconfig.tests.json` — compile-time suites, including the former corpus type-only skips
- `packages/effect/tests/` — runtime behaviour and property tests directly on Rust/WASM
- `packages/engine/tests/` — Promise boundary, projection and host orchestration tests
- `packages/{node,browser,cli,rest,rpc,ai}/tests/` — integration contracts
- `packages/effect/tests/MIGRATED-TESTS.md` — exact test migration and removal ledger; use current runner output for counts
- `nix run .#parity-gate` — shared typecheck, direct Effect tests and all examples; no transformed corpus, xfails or skip list

## Conventions

- Never use `any` in TypeScript
- Import from `"effect"` (single package)
- Use `Effect.gen(function* () { ... })` with `yield*`
- Errors extend `Data.TaggedError("Name")<{ fields }>`
- Schemas use `Schema.Struct({ ... })` not `Schema.Class`
- Rust owns database state. Do not add a TypeScript database engine.
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
`work/items/done/01KYR2GFF49SRGMH4Q9MV1F2TS-rust-engine-conversion/plan.md`).

### Layout

```
crates/
├── Cargo.toml                    # workspace root
├── proseql-engine/               # platform-blind core: descriptor, value, errors, validator
├── proseql-formats/              # codec crates (JSON/YAML/TOML/etc.)
├── proseql-storage/              # storage-host trait + native fs/notify
├── proseql-native/               # native database runtime, source hosts and callback registry
└── proseql-wasm/                 # wasm-bindgen boundary crate
```

### Key design rules for the Rust codebase

**TS types are the contract; Rust implements the semantics.**
The TypeScript type layer in `packages/core/src/types/` is the compile-time
contract for all consumers.  The Rust engine's observable behaviour must match
that contract, as verified by Rust conformance tests and direct engine/Effect tests.
Any divergence is a bug in the Rust implementation, not a re-definition of the
type surface.

- **No platform I/O in `proseql-engine`** — all I/O goes through the
  storage-host trait in `proseql-storage`.  `proseql-engine` must compile on
  any target (Linux, Android arm64, WASM) without changes.
- **Error tags must match TS `_tag` fields exactly** — `EngineError::tag()`
  returns the TS `_tag` string; the binding adapter uses it to reconstruct
  `TaggedError` classes for `Effect.catchTag`.
- **SchemaNode covers only the audited Effect Schema subset** — `Struct`,
  `String`, `Number`, `Boolean`, `Array`, `optional`, `optionalWith { default }`,
  `NullOr`, `NumberFromString`, `Record`, `mutable`, `Unknown`, and schema checks
  (`Schema.check` / filters) via `SchemaNode::Checked` are supported. Combinators
  outside this subset become `SchemaNode::Unsupported { reason }` and fail loudly.
  Built-in check ids are enforced in Rust in native builds (`native-checks`).
  Every check is enforced as a registered JS host predicate in WASM. Unknown
  checks need a registered predicate; otherwise database open fails. `Record`
  keys that fail their key schema are dropped, as Effect drops them.
- **`optional` ≠ `null`** — `Schema.optional(T)` expands to `T | undefined`
  (source: `node_modules/effect/src/Schema.ts`, `optional()` function);
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
nix run .#rust-check    # cargo check
nix run .#rust-test     # cargo test (includes conformance fixtures)
nix run .#rust-lint     # cargo clippy -D warnings
nix run .#rust-format   # cargo fmt
nix run .#rust-build    # cargo build --release
```

Or run cargo directly: `cargo test --manifest-path crates/Cargo.toml`
