## 1. Build Configuration

- [x] 1.1 Verify `tsconfig.base.json` has `sourceMap: true`; add it if missing. Confirm `declaration`, `declarationMap`, and `composite` are already set.
- [x] 1.2 Verify each package (`core`, `node`, `rest`, `rpc`) has a `tsconfig.json` that extends `tsconfig.base.json` with `rootDir: "src"` and `outDir: "dist"`. Create missing ones for `rest` and `rpc`.
- [x] 1.3 Verify root `tsconfig.json` has project references for all four packages.
- [x] 1.4 Add `dist/` to `.gitignore`.

## 2. Root Build Scripts

- [x] 2.1 Add `"build": "tsc --build"` script to root `package.json`.
- [x] 2.2 Add `"clean": "rm -rf packages/*/dist"` script to root `package.json`.
- [x] 2.3 Add `"build:clean": "bun run clean && bun run build"` script to root `package.json`.
- [x] 2.4 Run `bun run build` and verify it produces `dist/` in all four packages with `.js`, `.d.ts`, `.d.ts.map`, and `.js.map` files.

## 3. Per-Package package.json -- @proseql/core

- [x] 3.1 Change `"main"` from `"src/index.ts"` to `"dist/index.js"`.
- [x] 3.2 Add `"types": "dist/index.d.ts"`.
- [x] 3.3 Add `"exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }`.
- [x] 3.4 Add `"files": ["dist", "LICENSE", "README.md"]`.
- [x] 3.5 Add `"license": "MIT"`.
- [ ] 3.6 Add `"description"` with a concise package description.
- [ ] 3.7 Add `"repository": { "type": "git", "url": "..." , "directory": "packages/core" }`.
- [ ] 3.8 Add `"keywords": ["database", "typescript", "effect", "yaml", "json", "plain-text", "type-safe", "in-memory"]`.
- [ ] 3.9 Add `"engines": { "node": ">=18" }`.
- [ ] 3.10 Add `"sideEffects": false`.
- [ ] 3.11 Add `"build"` and `"clean"` scripts.
- [ ] 3.12 Add `"prepublishOnly": "bun run build && bun test"`.

## 4. Per-Package package.json -- @proseql/node

- [ ] 4.1 Apply the same field changes as core (main, types, exports, files, license, description, repository, keywords, engines, sideEffects, build, clean, prepublishOnly).
- [ ] 4.2 Verify `@proseql/core` dependency uses `"workspace:*"` (already does).
- [ ] 4.3 Add `effect` as a `peerDependency` if not already present (node re-exports core which depends on effect).

## 5. Per-Package package.json -- @proseql/rest

- [ ] 5.1 Apply the same field changes as core.
- [ ] 5.2 Bump version from `0.0.0` to `0.1.0`.
- [ ] 5.3 Verify `peerDependencies` includes `effect`.

## 6. Per-Package package.json -- @proseql/rpc

- [ ] 6.1 Apply the same field changes as core.
- [ ] 6.2 Bump version from `0.0.0` to `0.1.0`.
- [ ] 6.3 Verify `peerDependencies` includes `effect` and `@effect/rpc`.

## 7. LICENSE File

- [ ] 7.1 Create `LICENSE` at repository root with MIT license text.
- [ ] 7.2 Add a build step or script to copy root `LICENSE` into each package directory before publish.
- [ ] 7.3 Add `packages/*/LICENSE` to `.gitignore` so copied LICENSE files are not committed.

## 8. Build Script Verification

- [ ] 8.1 Run `bun run clean` and verify all `dist/` directories are removed.
- [ ] 8.2 Run `bun run build` and verify `dist/` is created in each package.
- [ ] 8.3 Verify `packages/core/dist/index.js` exists and is valid ESM (has `export` statements, no `require`).
- [ ] 8.4 Verify `packages/core/dist/index.d.ts` exists and exports the public API types.
- [ ] 8.5 Verify `.js.map` and `.d.ts.map` files are present alongside their source files.
- [ ] 8.6 Verify cross-package references resolve (e.g., `@proseql/node` dist references `@proseql/core` types correctly).

## 9. Publish Dry Run

- [ ] 9.1 Run `npm pack --dry-run` in each package directory and verify only `dist/`, `LICENSE`, and `README.md` are included.
- [ ] 9.2 Verify `package.json` in the tarball has no `workspace:*` references (use `bun publish --dry-run` or `npm pack` + inspect).
- [ ] 9.3 Verify tarball size is reasonable (no `src/`, `tests/`, `node_modules/`, or `.ts` source files).

## 10. Consumer Verification

- [ ] 10.1 Create a temporary project, install from the packed tarball (`npm install ./proseql-core-0.1.0.tgz`), and verify `import { createEffectDatabase } from "@proseql/core"` resolves.
- [ ] 10.2 Verify TypeScript resolves full type information from the import (run `tsc --noEmit` in the test project).
- [ ] 10.3 Verify deep imports are blocked (`import { ... } from "@proseql/core/operations/crud/create"` fails to resolve).

## 11. Prepublish Safety

- [ ] 11.1 Verify `prepublishOnly` runs build and test: delete `dist/`, run `npm publish --dry-run`, confirm it rebuilds and tests pass.
- [ ] 11.2 Introduce a deliberate type error, run `npm publish --dry-run`, confirm it fails.

## 12. Cleanup

- [ ] 12.1 Run full test suite (`bun test`) to verify no regressions from package.json changes.
- [ ] 12.2 Run type check (`bunx tsc --build`) to verify all packages compile cleanly.
- [ ] 12.3 Run `biome check .` to verify no lint issues in modified files.
