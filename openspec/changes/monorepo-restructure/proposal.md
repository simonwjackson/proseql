## Why

proseql is a single package that bundles the runtime-agnostic database engine with the Node.js filesystem adapter. This has two problems:

1. **Browser-hostile**: `core/storage/node-adapter-layer.ts` imports `fs`, `path`, `crypto` at the top level. Any bundler targeting the browser will choke on these imports, even if the consumer only uses the in-memory database. The Node adapter can't be tree-shaken because it's exported from the barrel `core/index.ts`.

2. **Ecosystem-blocked**: We have two scaffolded packages (`proseql-rest`, `proseql-rpc`) living as separate repos with separate lockfiles, no shared tooling, and a peer dependency on a `proseql` package that doesn't exist on npm yet. Future packages (browser adapters, sync, CLI) will face the same coordination problem.

A monorepo with scoped packages solves both: `@proseql/core` stays runtime-agnostic, `@proseql/node` adds the Node adapter, and future packages compose via workspace dependencies.

## What Changes

Restructure the repository into a Bun workspace monorepo with Nix flake integration (bun2nix). The database engine code moves into `packages/core/`, the Node adapter moves into `packages/node/`, and the two external stubs are absorbed as `packages/rest/` and `packages/rpc/`.

### Capabilities

#### New Capabilities

- **Workspace monorepo**: Bun workspaces linking `@proseql/core`, `@proseql/node`, `@proseql/rest`, `@proseql/rpc` with shared dependency resolution
- **Nix hermetic builds**: `flake.nix` with bun2nix providing `nix develop` (dev shell), `nix build .#core` (per-package build), `nix flake check` (CI-equivalent)
- **Runtime-agnostic core**: `@proseql/core` has zero Node.js imports, safe to bundle for any runtime

#### Modified Capabilities

- **Node adapter**: Extracted from core into `@proseql/node`, which re-exports all of core plus `NodeStorageLayer`
- **Test infrastructure**: Tests move into their respective packages, `justfile` gains per-package and cross-package test recipes
- **TypeScript config**: Shared `tsconfig.base.json` with per-package project references and composite builds

## Impact

- **File moves**: `core/` → `packages/core/src/`, `tests/` → `packages/core/tests/` + `packages/node/tests/`
- **Import paths**: All test imports updated from `../core/...` to `../src/...` (or package names)
- **New files**: `flake.nix`, `bun.nix`, per-package `package.json`, `tsconfig.json`, `default.nix`
- **Deleted files**: Old `core/` directory, old `tests/` directory, old `shell.nix` (replaced by flake)
- **External repos absorbed**: `../proseql-rest/` → `packages/rest/`, `../proseql-rpc/` → `packages/rpc/`
- **Zero test regressions**: All 1591 tests must pass after restructure
