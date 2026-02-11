## Why

There is no CI configuration in the repository. Every check -- tests, type checking, linting -- runs only when a developer remembers to run it locally. Pull requests merge without automated validation. Tagged releases require manual npm publishing. This means broken code can land on `main`, regressions go undetected until someone manually re-runs the suite, and publishing is error-prone and inconsistent.

GitHub Actions is already available (the project is hosted on GitHub) and the tooling is standardized: `bun test`, `bunx tsc --build`, `biome check .`. The only missing piece is the workflow configuration that wires these commands into the PR and push lifecycle.

## What Changes

Add GitHub Actions workflow files that automate testing, type checking, linting, and npm publishing. A CI workflow runs on every push and pull request to `main`, executing all checks across a matrix of Bun versions. A separate publish workflow triggers on `v*` tags, runs the full check suite, and publishes all workspace packages to npm. Dependency caching uses `bun.lock` as the cache key to keep builds fast.

## Capabilities

### New Capabilities

- **PR and push checks**: Every pull request and push to `main` triggers `bun test`, `bunx tsc --build`, and `biome check .`. All three must pass before a PR can merge.
- **Bun version matrix**: Tests run across multiple Bun versions (latest and one prior stable) to catch version-specific regressions.
- **Dependency caching**: Bun's install cache (`~/.bun/install/cache`) is cached using `bun.lock` as the key, reducing install times on subsequent runs.
- **Automated npm publish on tag**: Pushing a `v*` tag (e.g., `v0.1.0`) triggers a publish workflow that runs all checks first, then publishes to npm using an `NPM_TOKEN` repository secret.
- **Publish gating**: The publish step is conditional on all check jobs passing. If tests, typecheck, or lint fail, publishing does not execute.

### Modified Capabilities

None. This change is purely additive -- new workflow files in `.github/workflows/`. No existing source code is modified.

## Impact

- **No breaking changes.** No source code is modified. The change adds configuration files only.
- **Repository settings required**: Branch protection rules should be configured on `main` to require the CI status checks to pass before merging. The `NPM_TOKEN` secret must be added to the repository settings for publishing to work.
- **Developer workflow**: Contributors will see check results on their PRs automatically. Failed checks block merging, catching issues before they reach `main`.
- **Build time**: Initial runs will be slower (no cache), but subsequent runs benefit from dependency caching. The matrix adds parallel jobs rather than sequential overhead.
