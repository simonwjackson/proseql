# CI Pipeline — Design

## Architecture

### New Files

**`.github/workflows/ci.yml`** — Main CI workflow. Triggers on push to `main` and pull requests targeting `main`. Defines three jobs: `test` (matrix across Bun versions), `typecheck`, and `lint`. Each job checks out the repo, sets up Bun with caching, installs dependencies, and runs its respective command. The `test` job uses a matrix strategy for Bun versions. All jobs run in parallel.

**`.github/workflows/publish.yml`** — Publish workflow. Triggers on tags matching `v*`. Runs the full check suite (test, typecheck, lint) as prerequisite jobs, then a `publish` job that depends on all three passing. The publish job runs `bun publish` for each workspace package using the `NPM_TOKEN` secret.

### Modified Files

None. This change adds new files only.

## Key Decisions

### Two separate workflow files, not one

The CI workflow and the publish workflow have different triggers (`push`/`pull_request` vs `tags`) and different job graphs (publish has a gated final step). Keeping them separate avoids complex conditional logic and makes each workflow's purpose immediately clear.

### Bun version matrix, not Node version matrix

The spec mentions Node.js version matrix testing, but proseql is a Bun-native project: the test runner is `bun test`, the package manager is `bun`, and the lockfile is `bun.lock`. Matrix testing across Bun versions (latest and one prior stable) is more relevant than Node versions. If Node compatibility becomes a goal, a Node matrix can be added later.

### Parallel jobs, not sequential steps

Test, typecheck, and lint run as separate parallel jobs rather than sequential steps in a single job. This gives faster feedback (a lint failure shows immediately, without waiting for tests) and clearer GitHub status checks (each job appears as a separate required check).

### Caching via setup-bun built-in cache

The `oven-sh/setup-bun` action supports a built-in cache option that caches `~/.bun/install/cache` keyed on `bun.lock`. This avoids manual cache configuration with `actions/cache` and stays in sync with Bun's caching behavior.

### Publish uses bun publish, not npm publish

Since the project uses Bun as its package manager and build tool, `bun publish` is the natural choice. It handles workspace packages and respects `bun.lock` for reproducible installs before publishing.

### Publish job requires all checks to pass

The publish job uses `needs: [test, typecheck, lint]` so that any check failure prevents publishing. This ensures only validated code reaches npm.

### NPM_TOKEN as repository secret

The publish workflow references `${{ secrets.NPM_TOKEN }}`. This must be configured in the GitHub repository settings. The workflow does not handle token rotation or multi-registry publishing.

## File Layout

```
.github/
  workflows/
    ci.yml       (new — test/typecheck/lint on push and PR)
    publish.yml  (new — publish to npm on v* tags)
```
