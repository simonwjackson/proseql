## 1. CI Workflow — Setup

- [x] 1.1 Create `.github/workflows/ci.yml` with trigger configuration: `on: push: branches: [main]` and `on: pull_request: branches: [main]`
- [x] 1.2 Define `test` job: runs-on `ubuntu-latest`, strategy matrix with Bun versions (`latest`, `1.2`), steps: checkout, setup-bun (with cache enabled), `bun install`, `bun test`
- [x] 1.3 Define `typecheck` job: runs-on `ubuntu-latest`, steps: checkout, setup-bun (with cache enabled), `bun install`, `bunx tsc --build`
- [x] 1.4 Define `lint` job: runs-on `ubuntu-latest`, steps: checkout, setup-bun (with cache enabled), `bun install`, `biome check .`

## 2. Publish Workflow

- [x] 2.1 Create `.github/workflows/publish.yml` with trigger configuration: `on: push: tags: ['v*']`
- [x] 2.2 Define `test`, `typecheck`, and `lint` jobs identical to the CI workflow (or use a reusable workflow reference)
- [x] 2.3 Define `publish` job with `needs: [test, typecheck, lint]`, runs-on `ubuntu-latest`, steps: checkout, setup-bun (with cache enabled), `bun install`, publish each workspace package
- [x] 2.4 Configure `NPM_TOKEN` environment variable from `${{ secrets.NPM_TOKEN }}` for the publish step

## 3. Caching

- [x] 3.1 Verify `setup-bun` cache option is configured in all jobs, using `bun.lock` as cache key
- [x] 3.2 Test that a second workflow run (same lockfile) hits the cache and skips full install

## 4. Verification

- [ ] 4.1 Push a test branch and open a PR to confirm CI workflow triggers and all three jobs (test, typecheck, lint) run and pass
- [ ] 4.2 Verify that each job appears as a separate status check on the PR
- [ ] 4.3 Configure branch protection on `main` to require the CI status checks
- [ ] 4.4 Test publish workflow by pushing a `v0.0.0-test` tag (or dry-run) to confirm the publish job gates on check jobs
- [ ] 4.5 Verify `NPM_TOKEN` secret is set in repository settings

## 5. Cleanup

- [ ] 5.1 Remove any test tags or test branches created during verification
- [ ] 5.2 Run full test suite locally (`bun test`) to confirm no regressions
- [ ] 5.3 Run type check locally (`bunx tsc --build`) to confirm no type errors
