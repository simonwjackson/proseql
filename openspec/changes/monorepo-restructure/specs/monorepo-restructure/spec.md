## ADDED Requirements

### Requirement: Workspace monorepo with scoped packages

The repository SHALL be structured as a Bun workspace monorepo with scoped `@proseql/*` npm packages.

#### Scenario: Workspace root
- **THEN** root `package.json` SHALL have `"private": true` and `"workspaces": ["packages/*"]`
- **AND** `bun install` SHALL link all workspace packages in `node_modules/@proseql/`

#### Scenario: Package list
- **THEN** the following packages SHALL exist:
  - `@proseql/core` — runtime-agnostic database engine
  - `@proseql/node` — Node.js filesystem storage adapter
  - `@proseql/rest` — REST API generation (stub)
  - `@proseql/rpc` — Effect RPC layer (stub)

### Requirement: Runtime-agnostic core

`@proseql/core` SHALL contain zero Node.js-specific imports.

#### Scenario: No Node imports in core
- **THEN** no file in `packages/core/src/` SHALL import from `fs`, `path`, `crypto`, or any `node:*` module

#### Scenario: Core exports
- **THEN** `@proseql/core` SHALL export everything the current `core/index.ts` exports EXCEPT `NodeStorageLayer`, `makeNodeStorageLayer`, and `NodeAdapterConfig`

### Requirement: Node adapter as separate package

`@proseql/node` SHALL re-export core and add the Node.js filesystem adapter.

#### Scenario: Node re-exports core
- **WHEN** a consumer imports from `@proseql/node`
- **THEN** all `@proseql/core` exports SHALL be available
- **AND** `NodeStorageLayer`, `makeNodeStorageLayer`, `NodeAdapterConfig` SHALL be additionally available

#### Scenario: Workspace dependency
- **THEN** `@proseql/node` SHALL depend on `@proseql/core` via `"workspace:*"`

### Requirement: Nix flake with bun2nix

A `flake.nix` SHALL provide reproducible development and build environments.

#### Scenario: Dev shell
- **WHEN** `nix develop` is run
- **THEN** `bun`, `biome`, `just`, `bun2nix`, and `git` SHALL be available

#### Scenario: Per-package Nix build
- **WHEN** `nix build .#core` is run
- **THEN** `@proseql/core` SHALL be built hermetically using bun2nix

#### Scenario: Nix checks
- **WHEN** `nix flake check` is run
- **THEN** tests and type checking SHALL run for all packages

### Requirement: TypeScript project references

Each package SHALL have its own `tsconfig.json` extending a shared base.

#### Scenario: Shared config
- **THEN** `tsconfig.base.json` SHALL exist at the root with shared compiler options
- **AND** each `packages/*/tsconfig.json` SHALL extend it

#### Scenario: Cross-package typecheck
- **WHEN** `bunx tsc --build` is run at the root
- **THEN** all packages SHALL typecheck, respecting project references

### Requirement: All existing tests pass

The restructure SHALL not break any existing tests.

#### Scenario: Test count preserved
- **WHEN** `bun test` is run across all packages
- **THEN** all 1591 existing tests SHALL pass
