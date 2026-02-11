## Why

proseql cannot be installed from npm. There is no build step, no compiled output, no type declarations, no `exports` field, no LICENSE file, and no package metadata beyond a name. Consumers cannot `npm install proseql` and get a working import with TypeScript types. The monorepo has four packages (`@proseql/core`, `@proseql/node`, `@proseql/rest`, `@proseql/rpc`) that all point `main` at raw TypeScript source (`src/index.ts`), which only works inside the Bun workspace. None of them produce distributable artifacts.

Effect is ESM-only, which means proseql must also be ESM-only -- there is no CJS path. The tsconfig already has `declaration: true` and `outDir: "dist"` configured but no build script invokes it, no `dist/` exists, and no `package.json` references compiled output.

## What Changes

Add a complete build-and-publish pipeline. Each package under `packages/` gets a build step that produces `dist/` containing `.js`, `.d.ts`, `.d.ts.map`, and `.js.map` files. Each package's `package.json` gains proper `exports`, `types`, `files`, and npm metadata fields. A root-level `LICENSE` file is added. A `prepublishOnly` script gates publishing behind a successful build and test run. Workspace dependency references (`workspace:*`) are resolved to real version ranges before publish.

## Capabilities

### New Capabilities

- **Per-package build**: Each package (`core`, `node`, `rest`, `rpc`) has a `build` script that compiles TypeScript source to ESM JavaScript with declarations and source maps in its own `dist/` directory.
- **Root build orchestration**: A root-level `build` script runs `tsc --build` using the existing project references in `tsconfig.json`, building all packages in dependency order.
- **Package exports field**: Each package's `package.json` declares an `exports` map with `import` and `types` conditions pointing to `dist/` artifacts. Deep imports are blocked.
- **Package metadata**: Each package includes `version`, `description`, `license`, `repository`, `keywords`, `engines`, and `files` fields. Version starts at `0.1.0` across all packages.
- **LICENSE file**: MIT license at the repository root, referenced in every package's `files` array.
- **Prepublish safety**: `prepublishOnly` script in each package runs build and test before `npm publish` proceeds.
- **Clean script**: A `clean` script removes all `dist/` directories to allow fresh rebuilds.

### Modified Capabilities

- **package.json (root)**: Gains `build`, `build:clean`, and `clean` scripts. Retains `private: true` (root is not published).
- **package.json (each package)**: `main` changes from `src/index.ts` to `dist/index.js`. Gains `types`, `exports`, `files`, `license`, `repository`, `keywords`, `engines`, `prepublishOnly`, `build`, and `clean` fields.
- **tsconfig.base.json**: May gain `sourceMap: true` and `declarationMap: true` if not already present, to ensure source maps are produced.
- **.gitignore**: Adds `dist/` so compiled output is not committed.

## Impact

- **No breaking changes for development.** `bun test` and `bun run` continue to work with raw TypeScript source via Bun's built-in TS support. The `dist/` output is only needed for publishing.
- **New build step required before publishing.** `npm publish` will fail if the build has not run, which is enforced by `prepublishOnly`.
- **All four packages become publishable.** Each can be independently published to npm with proper types and ESM output.
- **Workspace protocol resolution.** `workspace:*` dependencies must be replaced with concrete version ranges before publish. Bun's `bun publish` (or `npm publish` with workspace tooling) handles this automatically.
- **CI integration point.** The build and publish scripts provide hooks for a future CI pipeline to automate releases.
