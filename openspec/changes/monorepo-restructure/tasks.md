## 1. Workspace Root Setup

- [ ] 1.1 Replace root `package.json` with workspace root: `"private": true`, `"workspaces": ["packages/*"]`, move `devDependencies` (`@types/bun`, `vitest`) to root, add `"scripts": { "postinstall": "bun2nix -o bun.nix" }`
- [ ] 1.2 Create `tsconfig.base.json` at root with shared compiler options: `target: "ES2022"`, `module: "esnext"`, `moduleResolution: "bundler"`, `strict: true`, `declaration: true`, `declarationMap: true`, `composite: true`, `skipLibCheck: true`. Add `paths` mapping `@proseql/core` → `./packages/core/src/index.ts`
- [ ] 1.3 Delete old `tsconfig.json` and `tsconfig.test.json` (replaced by base + per-package configs)

## 2. Package: @proseql/core

- [ ] 2.1 Create `packages/core/` directory structure: `src/`, `tests/`
- [ ] 2.2 Move all files from `core/` to `packages/core/src/` EXCEPT `storage/node-adapter-layer.ts`
- [ ] 2.3 Update `packages/core/src/index.ts`: remove exports for `NodeStorageLayer`, `makeNodeStorageLayer`, `NodeAdapterConfig`
- [ ] 2.4 Create `packages/core/package.json`: name `@proseql/core`, version `0.1.0`, type `module`, main `src/index.ts`, dependencies: `effect`, `yaml`, `json5`, `jsonc-parser`, `smol-toml`, `@toon-format/toon`, `hjson`
- [ ] 2.5 Create `packages/core/tsconfig.json`: extends `../../tsconfig.base.json`, rootDir `src`, outDir `dist`, include `["src"]`, no references
- [ ] 2.6 Move all test files from `tests/` to `packages/core/tests/` EXCEPT the Node-adapter-specific test (the `makeNodeStorageLayer` test in `storage-services.test.ts`)
- [ ] 2.7 Update all import paths in `packages/core/tests/*.test.ts`: change `../core/` to `../src/`
- [ ] 2.8 Split `tests/storage-services.test.ts`: keep the in-memory adapter tests in `packages/core/tests/storage-services.test.ts`, extract the Node adapter test to `packages/node/tests/`
- [ ] 2.9 Move `tests/crud/` subdirectory to `packages/core/tests/crud/`, update imports within

## 3. Package: @proseql/node

- [ ] 3.1 Create `packages/node/` directory structure: `src/`, `tests/`
- [ ] 3.2 Move `core/storage/node-adapter-layer.ts` to `packages/node/src/node-adapter-layer.ts`
- [ ] 3.3 Update imports in `node-adapter-layer.ts`: change `./storage-service.js` to `@proseql/core` (import `StorageAdapter`), change `../errors/storage-errors.js` to `@proseql/core` (import `StorageError`)
- [ ] 3.4 Create `packages/node/src/index.ts`: `export * from "@proseql/core"` plus `export { NodeStorageLayer, makeNodeStorageLayer } from "./node-adapter-layer.js"` and `export type { NodeAdapterConfig } from "./node-adapter-layer.js"`
- [ ] 3.5 Create `packages/node/package.json`: name `@proseql/node`, version `0.1.0`, type `module`, main `src/index.ts`, dependencies: `{ "@proseql/core": "workspace:*" }`
- [ ] 3.6 Create `packages/node/tsconfig.json`: extends `../../tsconfig.base.json`, rootDir `src`, outDir `dist`, references `[{ "path": "../core" }]`
- [ ] 3.7 Create `packages/node/tests/node-storage.test.ts` with the Node adapter test extracted from `storage-services.test.ts`, update imports to use `../src/node-adapter-layer.js` and `@proseql/core`

## 4. Package: @proseql/rest

- [ ] 4.1 Create `packages/rest/` directory structure: `src/`, `tests/`
- [ ] 4.2 Copy `../proseql-rest/src/index.ts` to `packages/rest/src/index.ts`
- [ ] 4.3 Create `packages/rest/package.json`: name `@proseql/rest`, version `0.0.0`, type `module`, main `src/index.ts`, dependencies: `{ "@proseql/core": "workspace:*" }`, peerDependencies: `{ "effect": "^3.15.0" }`
- [ ] 4.4 Create `packages/rest/tsconfig.json`: extends `../../tsconfig.base.json`, rootDir `src`, outDir `dist`, references `[{ "path": "../core" }]`

## 5. Package: @proseql/rpc

- [ ] 5.1 Create `packages/rpc/` directory structure: `src/`, `tests/`
- [ ] 5.2 Copy `../proseql-rpc/src/index.ts` to `packages/rpc/src/index.ts`
- [ ] 5.3 Create `packages/rpc/package.json`: name `@proseql/rpc`, version `0.0.0`, type `module`, main `src/index.ts`, dependencies: `{ "@proseql/core": "workspace:*", "@effect/rpc": "^0.51.0" }`, peerDependencies: `{ "effect": "^3.15.0" }`
- [ ] 5.4 Create `packages/rpc/tsconfig.json`: extends `../../tsconfig.base.json`, rootDir `src`, outDir `dist`, references `[{ "path": "../core" }]`

## 6. Build Infrastructure

- [ ] 6.1 Update `bunfig.toml`: remove the old `root = "./tests"` (tests now live inside packages)
- [ ] 6.2 Update `justfile`: replace recipes with workspace-aware versions — `test` runs `bun test packages/*/tests/`, `test-core` runs core only, `test-node` runs node only, `typecheck` runs `bunx tsc --build`, `lint`/`format`/`clean` updated for new paths
- [ ] 6.3 Update `biome.json` if needed: ensure it covers `packages/*/src/` and `packages/*/tests/`
- [ ] 6.4 Update `.gitignore`: add `packages/*/dist/`, `bun.nix`, `packages/*/.tsbuildinfo`

## 7. Nix Flake

- [ ] 7.1 Create `flake.nix`: inputs (`nixpkgs`, `systems`, `bun2nix`), devShell with `bun`, `biome`, `just`, `bun2nix`, `git`
- [ ] 7.2 Add `packages` output to `flake.nix`: `core`, `node`, `rest`, `rpc` — each calls its `default.nix` with `mkBunDerivation`
- [ ] 7.3 Add `checks` output to `flake.nix`: runs tests and typecheck
- [ ] 7.4 Create `packages/core/default.nix`: `mkBunDerivation` with `pname = "proseql-core"`, workspace-aware src
- [ ] 7.5 Create `packages/node/default.nix`: `mkBunDerivation` with `pname = "proseql-node"`
- [ ] 7.6 Create `packages/rest/default.nix`: `mkBunDerivation` with `pname = "proseql-rest"`
- [ ] 7.7 Create `packages/rpc/default.nix`: `mkBunDerivation` with `pname = "proseql-rpc"`
- [ ] 7.8 Delete old `shell.nix` (replaced by `flake.nix` devShell)
- [ ] 7.9 Run `bun install` and verify `bun.nix` is generated by postinstall hook

## 8. Cleanup & References

- [ ] 8.1 Delete old `core/` directory (all content moved to packages)
- [ ] 8.2 Delete old `tests/` directory (all content moved to packages)
- [ ] 8.3 Update `examples/*.ts` imports: change `../core/...` to `@proseql/core` or `@proseql/node`
- [ ] 8.4 Update `CLAUDE.md`: change `core/` references to `packages/core/src/`, update test commands, add workspace context

## 9. Verification

- [ ] 9.1 Run `bun install` at workspace root — verify all packages link correctly, `node_modules/@proseql/core` etc. resolve
- [ ] 9.2 Run `bun test packages/core/tests/` — verify all core tests pass (should be ~1590 tests)
- [ ] 9.3 Run `bun test packages/node/tests/` — verify node adapter tests pass
- [ ] 9.4 Run `bun test` (all packages) — verify total test count matches 1591
- [ ] 9.5 Run `bunx tsc --build` — verify all packages typecheck cleanly
- [ ] 9.6 Run `nix develop` — verify dev shell has bun, biome, just, bun2nix
- [ ] 9.7 Run `nix build .#core` — verify hermetic build succeeds
- [ ] 9.8 Run `nix flake check` — verify CI-equivalent passes
