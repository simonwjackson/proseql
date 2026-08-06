# Publishing the coordinated npm packages

This runbook covers the first coordinated publication of the Rust/WASM package set. It does not change versions, push commits, publish packages, create tags, or create releases by itself.

## What is published

One coordinated version is used for these eight packages:

1. `@proseql/core`
2. `@proseql/engine`
3. `@proseql/node`
4. `@proseql/rest`
5. `@proseql/effect`
6. `@proseql/cli`
7. `@proseql/browser`
8. `@proseql/rpc`

Every package that declares Effect requires exactly `effect@4.0.0-beta.103`. `@proseql/ai` is not in this release. Its source is aligned with beta.103, but the older version already on npm is not compatible with this coordinated package set. Publish AI later under its own version after it has registry-consumer coverage.

## Two separate approvals

Publication has two deliberate human decisions:

1. **Approve pushing the reviewed release commit.** Run the local gates, inspect the version and changelog edits, commit them, and review the exact full commit SHA. Pushing that commit is a separate operator action. The release tooling never pushes it.
2. **Approve npm production publication.** Start the manual `Publish reviewed npm packages` workflow with that full SHA. Its no-secret preflight must pass first. A required reviewer then approves the protected `npm-production` environment before the OIDC publish job runs.

Do not treat approval of the commit as approval to publish. Do not approve `npm-production` before reviewing the preflight artifact, release ID, package version, checksums, and workflow logs.

## Preconditions

Before preparing a release, confirm all of the following:

- You can push the intended reviewed commit, but no tag or GitHub release for the version exists.
- The coordinated version is unused for all eight package names.
- The `@proseql` npm organization exists and npm Trusted Publishing is configured for each package:
  - **Five existing packages** (`core`, `node`, `rest`, `cli`, `rpc`): configure each package on npmjs.com under Settings → Trusted Publisher for workflow `publish.yml`, environment `npm-production`.
  - **Three new packages** (`engine`, `effect`, `browser`): no npm record exists yet. Create each package record through an explicitly reviewed, interactively authenticated first publication, then configure Trusted Publishing before the coordinated release. OIDC cannot create a package whose Trusted Publisher does not exist yet.
- The `npm-production` GitHub environment exists, has required reviewers, restricts deployments to `main`, and contains **no npm secrets** (Trusted Publishing uses OIDC; no `NPM_TOKEN` is stored).
- The GitHub-hosted runner's npm CLI version is ≥11.5.1 and Node version is ≥22.14.0 (the workflow pins Node 24). The optional `npm trust` setup commands require npm ≥11.15.0.
- Release notes state the exact Effect beta, the three first-publish packages, the deferred AI release, and the browser async transaction limitation.
- A named operator owns partial-failure recovery.

## Trusted Publishing setup per package

For each of the five existing packages, run once (requires npm 2FA):

```sh
npm trust github @proseql/<name> \
  --repo simonwjackson/proseql \
  --file publish.yml \
  --env npm-production \
  --allow-publish
```

For the three new packages, create the record first from an exact reviewed tarball via `npm publish --access public` with interactive authentication and 2FA, then run `npm trust github` as above. This bootstrap is an explicit npm-side operation outside the OIDC workflow; do not publish placeholders or unreviewed bytes.

## Prepare and approve the release commit

1. Start from a clean branch and inspect registry availability.
2. Run `just release-prepare patch`, `minor`, or `major` as appropriate. This only edits source files; it does not commit or push.
3. Review all eight package versions, `bun.lock`, the CLI version, and `CHANGELOG.md`. AI must retain its independent package version.
4. Run `just release-check`. It is non-destructive and credential-free.
5. Commit the reviewed version and changelog edits.
6. Run `just release-finalize` from that clean commit. Record:
   - the full `git rev-parse HEAD` SHA;
   - coordinated version;
   - release ID;
   - Effect version `4.0.0-beta.103`;
   - WASM build measurements;
   - prepared tarball names, SHA-256 checksums, and integrity values.
7. Review the prepared artifacts and explicitly approve or reject pushing the commit.
8. If approved, push only that reviewed commit. Do not push a tag.

Any source change after review creates a new commit SHA and requires the local checks and first approval again.

## Run the protected workflow

Open **Actions → Publish reviewed npm packages → Run workflow**. In **Use workflow from**, select the reviewed release ref whose tip is the exact approved commit, then enter that same lowercase, full 40-character SHA. With the GitHub CLI:

```sh
gh workflow run publish.yml \
  --ref main \
  --field commit_sha=<full-40-char-sha>
```

The workflow rejects the run before checkout unless its own `${{ github.sha }}` exactly equals the input SHA, so dispatching the default branch or any other workflow revision cannot authorize the release. The workflow has no push, tag, release, or schedule trigger.

The jobs run in this order:

### 1. No-secret preflight

The workflow checks out the supplied SHA, proves that it is exact and clean, and runs `just release-finalize`, including the full TypeScript, Rust, parity, package, browser, and packed-consumer gates. It creates one retained `prepared-release-<releaseId>` artifact containing:

- the exact eight tarballs;
- `prepared-release.json`, bound to the commit SHA and package integrities;
- `SHA256SUMS` for the manifest, publisher, and every tarball;
- a standalone `publisher.mjs` bundle.

This job has read-only repository permission and no npm credential.

### 2. OIDC publish

Review the preflight artifact and approve `npm-production`. The publish job:

- downloads only the prepared artifact;
- checks `SHA256SUMS`;
- re-inspects every tarball (size, sha256, integrity, embedded `package.json`);
- runs `publisher.mjs --approve-publish` via Node 24 under `actions/setup-node` with `registry-url: https://registry.npmjs.org`;
- npm's OIDC token exchange happens automatically — no `NPM_TOKEN`, no stored npm credential, and no `npm whoami`;
- publishes each tarball sequentially in dependency order directly to `latest`:

  `core → engine → node → rest → effect → cli → browser → rpc`

- waits for each published version and its `latest` tag to become visible before continuing;
- skips packages already published at the coordinated version and already tagged `latest` (idempotent resume);
- fails on any manifest or integrity mismatch without uploading further packages.

This job never checks out source, builds, packs, installs dependencies, or runs package lifecycle scripts. It contains no secrets and no long-lived tokens. Provenance attestations are generated automatically by npm when publishing via trusted publishing from a public repository.

### 3. No-secret registry consumer

A fresh consumer installs the exact coordinated versions from npm with lifecycle scripts disabled. It proves:

- all eight packages are the intended version and tagged `latest`;
- exactly one `effect@4.0.0-beta.103` is installed;
- the CLI executes;
- REST handlers behave correctly;
- Node loads and executes the packaged WASM engine;
- Effect success, typed failure, and stream behavior work;
- a real Chromium page loads browser WASM and persists data;
- serialized RPC normal calls, typed errors, and streams work through public exports.

It also confirms every registry manifest and integrity against the prepared release. Its `consumer-verification.json` is bound to the release ID and the eight integrities. This job has no npm or GitHub write credential.

### 4. GitHub release

Only after the registry consumer succeeds, a job with `contents: write` verifies the consumer artifact against the prepared release, creates `v<version>` and the GitHub release at the exact reviewed commit, and attaches the prepared manifest, checksums, and consumer verification. npm failures therefore cannot leave a successful-looking GitHub release.

## Go / no-go

Approve publication only when all of these are true:

- Local `just release-check` and clean-commit `just release-finalize` passed.
- Remote no-secret preflight passed for the same full SHA.
- All eight versions and first-publish names were available before upload.
- Packed manifests contain concrete coordinated dependency versions, exact beta.103, no `workspace:*`, and no `@effect/rpc`.
- WASM artifacts and browser measurements remain within their existing budgets.
- Tarball SHA-256 values, npm integrity values, package order, release ID, and release notes were reviewed.
- Trusted Publishing is configured for all eight packages and the `npm-production` environment has required reviewers.
- The AI incompatibility and browser limitation are disclosed.

If any item is false or uncertain, choose **No-Go**. Do not approve the environment and do not work around a gate.

## Recovery decision tree

### No npm upload happened

Discard or repair the release preparation. Make a new reviewed commit if source changes. No deprecation is needed, and no tag or GitHub release should exist.

### OIDC authentication or environment approval failed

No approval means the job cannot enter the `npm-production` environment. A Trusted Publishing misconfiguration (wrong workflow file, wrong environment name, wrong repository) shows as an ENEEDAUTH error.

1. Do not rebuild or alter artifacts.
2. Fix the Trusted Publisher configuration on npmjs.com for the failing package.
3. Re-run the failed job in the same workflow run while its prepared artifact is retained.
4. Obtain protected-environment approval again.

### Some packages published and all match

Leave already-published versions at `latest`. Re-run the `oidc-publish` job in the same retained workflow run. The publisher verifies and skips matching packages that are already at `latest`, then resumes at the first missing package. Then run the complete registry consumer.

If a matching version exists but `latest` points elsewhere, the OIDC workflow cannot repair the tag. An authorized operator must inspect the immutable version and run `npm dist-tag add @proseql/<name>@<version> latest` with interactive npm authentication and 2FA. Re-run the workflow only after independently confirming the manifest and integrity match the prepared release.

### An uploaded version differs from the prepared manifest or integrity

Stop. npm versions are immutable; do not overwrite, relabel, or build a replacement under the same version. Deprecate the bad coordinated version with a clear message, prepare a new coordinated version, repeat both approvals, and publish new artifacts. Use npm's narrow early unpublish allowance only after an explicit owner decision and only when npm policy permits it; deprecation plus a new version is the default recovery.

### Registry consumer failed

Do not create a GitHub release. If the failure is registry propagation, use the bounded retry or re-run the no-secret consumer job. If package behavior, dependency resolution, WASM loading, browser behavior, or RPC fails, deprecate any uploaded version and prepare a new coordinated version. A workspace-only fix is not evidence for already-uploaded immutable bytes.

### GitHub release failed after registry consumer

Do not republish npm packages. Verify all eight `latest` tags and integrities again, then re-run only the GitHub release job for the same release ID and commit. Never point the release tag at a different commit.

## Known release limitations

- OIDC cannot mutate dist-tags, so this workflow publishes sequentially to `latest`. During publication, consumers can briefly observe a mixed coordinated version, and the full registry consumer runs after the versions are live. The protected preflight and exact packed-consumer gates are therefore the final pre-publication behavior checks.
- `@proseql/ai` is intentionally deferred. Its older npm release must not be presented as compatible with this beta.103 package set.
- In browsers, transaction-origin tracking does not remain reliable across asynchronous work inside a transaction. Avoid yielding to unrelated asynchronous work inside browser transactions when persistence/watch updates may interleave. This release does not claim to fix that limitation.
- `@proseql/rpc` defines calls and WASM-backed handlers, not a network server or security boundary. Applications choose a transport and must authenticate and authorize requests before they reach mutation handlers.
- npm Trusted Publishing requires GitHub-hosted runners. Self-hosted runners are not supported. The `oidc-publish` job uses `ubuntu-latest` on GitHub-hosted infrastructure.
