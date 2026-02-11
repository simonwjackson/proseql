# Build & Publish -- Design

## Architecture

### New Files

**`LICENSE`** (root) -- MIT license text with current year and author.

**`scripts/build.sh`** (optional) -- If a multi-step build is needed beyond `tsc --build` (e.g., post-processing), this script orchestrates it. May not be needed if `tsc --build` alone suffices.

### Modified Files

**`package.json`** (root) -- Add `build`, `clean`, and `build:clean` scripts. `build` runs `tsc --build`. `clean` removes all `packages/*/dist/` directories. `build:clean` runs clean then build.

**`packages/core/package.json`** -- Replace `"main": "src/index.ts"` with proper publish fields: `main`, `types`, `exports`, `files`, `license`, `description`, `repository`, `keywords`, `engines`, `prepublishOnly`, `build`, `clean`.

**`packages/node/package.json`** -- Same treatment as core. Depends on `@proseql/core`.

**`packages/rest/package.json`** -- Same treatment. Version bumped from `0.0.0` to `0.1.0`.

**`packages/rpc/package.json`** -- Same treatment. Version bumped from `0.0.0` to `0.1.0`.

**`tsconfig.base.json`** -- Add `sourceMap: true` if missing. Verify `declaration`, `declarationMap`, and `composite` are set (they already are).

**`.gitignore`** -- Add `dist/` entry to exclude build output from version control.

## Key Decisions

### ESM-only, no CJS

Effect is ESM-only. Producing CJS output would require a separate bundling step and dual-package hazard mitigation. Since proseql's primary dependency is ESM-only, all consumers must already support ESM. No CJS output is produced. Every `package.json` has `"type": "module"` (already the case).

### tsc --build for both declarations and JavaScript

Use `tsc --build` with the existing project references to compile all packages in dependency order. This produces `.js`, `.d.ts`, `.d.ts.map`, and `.js.map` files in each package's `dist/`. No separate bundler (bun build, esbuild, rollup) is needed because:
- The output is a library, not an application -- consumers bundle it themselves.
- Tree-shaking is the consumer's responsibility.
- `tsc --build` respects project references and produces correct cross-package declaration paths.

### Per-package dist/ directories

Each package compiles to its own `dist/` directory (`packages/core/dist/`, `packages/node/dist/`, etc.). This matches the existing `tsconfig.json` setup (`outDir: "dist"`, `rootDir: "src"`). Each package is independently publishable.

### Exports field structure

Each package uses a minimal exports map:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

Only the top-level entry point is public. Deep imports (`@proseql/core/operations/crud/create`) are intentionally blocked. Internal modules are implementation details.

### Version strategy: start at 0.1.0

All packages start at `0.1.0`. The `0.x` range signals pre-1.0 instability per semver. `core` and `node` are already at `0.1.0`; `rest` and `rpc` are bumped from `0.0.0`. All four packages use the same version to simplify coordination.

### files whitelist

Each package's `files` array restricts what npm packs:

```json
{
  "files": ["dist", "LICENSE", "README.md"]
}
```

This excludes `src/`, `tests/`, `tsconfig.json`, and other development files from the published tarball. The `LICENSE` file is copied or symlinked from root at publish time (or each package includes its own copy).

### prepublishOnly script

Each package has:

```json
{
  "prepublishOnly": "bun run build && bun test"
}
```

This ensures no broken package is published. The build must succeed and all tests must pass. This runs automatically before `npm publish` or `bun publish`.

### Workspace dependency resolution

Bun workspace dependencies use `"workspace:*"` protocol. When publishing, these must be replaced with real version ranges (e.g., `"^0.1.0"`). `bun publish` handles this automatically. If using `npm publish`, the workspace protocol must be resolved manually or via a prepublish script.

### LICENSE in each package

npm requires the LICENSE file to be included in the tarball. Since the `files` field restricts what's included, each package either:
1. Copies the root LICENSE into its directory before publish, or
2. Includes `"../../LICENSE"` in its `files` array (npm resolves relative to package root, so this won't work).

The simplest approach: copy the root LICENSE into each package directory as part of the build script, and `.gitignore` the copies.

## File Layout

```
(root)
  package.json               (modified -- add build/clean scripts)
  tsconfig.json              (unchanged -- already has project references)
  tsconfig.base.json         (modified -- add sourceMap if missing)
  LICENSE                    (new -- MIT license)
  .gitignore                 (modified -- add dist/)
  packages/
    core/
      package.json           (modified -- exports, types, files, metadata, prepublishOnly)
      tsconfig.json          (unchanged -- already has rootDir/outDir)
      dist/                  (generated -- .js, .d.ts, .d.ts.map, .js.map)
        index.js
        index.d.ts
        index.js.map
        index.d.ts.map
        factories/
        operations/
        ...
    node/
      package.json           (modified -- same treatment)
      tsconfig.json          (may need creation if missing build config)
      dist/                  (generated)
    rest/
      package.json           (modified -- same treatment, version bump)
      tsconfig.json          (may need creation if missing build config)
      dist/                  (generated)
    rpc/
      package.json           (modified -- same treatment, version bump)
      tsconfig.json          (may need creation if missing build config)
      dist/                  (generated)
```
