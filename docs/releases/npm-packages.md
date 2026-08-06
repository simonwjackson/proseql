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
2. **Approve npm production publication.** Start the manual `Publish reviewed npm packages` workflow with that full SHA. Its no-secret preflight must pass first. A required reviewer then approves the protected `npm-production` environment before the candidate upload receives an npm credential.

Do not treat approval of the commit as approval to publish. Do not approve `npm-production` before reviewing the preflight artifact, release ID, package version, checksums, and workflow logs.

## Preconditions

Before preparing a release, confirm all of the following:

- You can push the intended reviewed commit, but no tag or GitHub release for the version exists.
- The coordinated version is unused for all eight package names.
- The `@proseql` npm organization exists. The publication identity can publish public scoped packages and can create the four first-publish records: engine, effect, browser, and RPC.
- The `npm-production` GitHub environment exists, has required reviewers, restricts deployments appropriately, and contains only the approved short-lived `NPM_TOKEN` secret.
- The credential satisfies the npm organization's current two-factor policy. Confirm `npm whoami`, organization membership, package-name availability, and 2FA policy before approval. Only the first real upload can fully prove permission to create a new package record.
- The Nix shell provides the pinned Rust target, `wasm-bindgen`, `wasm-opt`, Bun, Node, and Chromium toolchain used by the release gates.
- Release notes state the exact Effect beta, the four first-publish packages, the deferred AI release, and the browser async transaction limitation.
- A named operator owns partial-failure recovery and can update or revoke the credential without exposing it in logs.

Never put an npm token in source, workflow input, an artifact, or a command-line argument.

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

Open **Actions → Publish reviewed npm packages → Run workflow** and enter the lowercase, full 40-character reviewed commit SHA. The workflow has no push, tag, release, or schedule trigger.

The jobs run in this order:

### 1. No-secret preflight

The workflow checks out the supplied SHA, proves that it is exact and clean, and runs `just release-finalize`, including the full TypeScript, Rust, parity, package, browser, and packed-consumer gates. It creates one retained `prepared-release-<releaseId>` artifact containing:

- the exact eight tarballs;
- `prepared-release.json`, bound to the commit SHA and package integrities;
- `SHA256SUMS` for the manifest, publisher, and every tarball;
- a standalone `publisher.mjs` bundle.

This job has read-only repository permission and no npm credential.

### 2. Candidate upload

Review the preflight and approve `npm-production`. The credential-bearing job downloads only the prepared artifact, checks `SHA256SUMS`, re-inspects the tarballs, authenticates, and uploads sequentially in dependency order:

`core → engine → node → rest → effect → cli → browser → rpc`

Uploads use the temporary tag `proseql-candidate-<version-with-dashes>`. The publisher waits for each manifest, integrity, and candidate tag to become visible before continuing. It stops at the first failure. It never checks out source, builds, packs, installs dependencies, or runs package lifecycle scripts.

### 3. No-secret registry consumer

A fresh consumer installs the exact coordinated versions from npm with lifecycle scripts disabled. It proves:

- all eight packages are the intended version;
- exactly one `effect@4.0.0-beta.103` is installed;
- the CLI executes;
- REST handlers behave correctly;
- Node loads and executes the packaged WASM engine;
- Effect success, typed failure, and stream behavior work;
- a real Chromium page loads browser WASM and persists data;
- serialized RPC normal calls, typed errors, and streams work through public exports.

It also confirms every candidate tag, registry manifest, and integrity against the prepared release. Its `consumer-verification.json` is bound to the release ID and the eight integrities. This job has no npm or GitHub write credential.

### 4. Protected promotion

The promotion job downloads the prepared release and consumer verification artifacts, rechecks checksums, and requires the protected npm environment. It moves `latest` in reverse dependency order:

`rpc → browser → cli → effect → rest → node → engine → core`

Only after every `latest` tag verifies does it remove all temporary candidate tags. An interruption is resumable: already-correct tags are verified and skipped.

### 5. GitHub release

Only after promotion succeeds, a job with `contents: write` creates `v<version>` and the GitHub release at the exact reviewed commit. It attaches the prepared manifest and checksums. npm failures therefore cannot leave a successful-looking GitHub release.

## Go / no-go

Approve publication only when all of these are true:

- Local `just release-check` and clean-commit `just release-finalize` passed.
- Remote no-secret preflight passed for the same full SHA.
- All eight versions and first-publish names were available before upload.
- Packed manifests contain concrete coordinated dependency versions, exact beta.103, no `workspace:*`, and no `@effect/rpc`.
- WASM artifacts and browser measurements remain within their existing budgets.
- Tarball SHA-256 values, npm integrity values, package order, release ID, and release notes were reviewed.
- The protected environment, reviewer, npm identity, scope access, and 2FA policy are correct.
- The AI incompatibility and browser limitation are disclosed.

If any item is false or uncertain, choose **No-Go**. Do not approve the environment and do not work around a gate.

## Recovery decision tree

### No npm upload happened

Discard or repair the release preparation. Make a new reviewed commit if source changes. No deprecation is needed, and no tag or GitHub release should exist.

### Credential or environment approval failed

No approval means the job cannot receive the secret. A missing, expired, rejected, or under-privileged credential must stop at `npm whoami` or the first denied operation.

1. Do not rebuild or alter artifacts.
2. Repair or replace the secret in `npm-production`; revoke the rejected credential when appropriate.
3. Re-run the failed job in the same workflow run while its prepared artifact is retained.
4. Obtain protected-environment approval again.

Never pass a replacement token through a workflow input or log. If the prepared artifact has expired, prepare a new coordinated version rather than attempting an unaudited local upload.

### Some candidate versions uploaded and all match

Leave `latest` unchanged. In the same retained workflow run, re-run the failed candidate job. The publisher verifies and skips matching uploaded packages, restores a missing candidate tag only when the immutable version matches, and resumes at the first missing package. Then run the complete registry consumer before promotion.

### An uploaded version differs from the prepared manifest or integrity

Stop. npm versions are immutable; do not overwrite, relabel, or build a replacement under the same version. Deprecate the bad coordinated version with a clear message, leave dependent publication stopped, prepare a new coordinated version, repeat both approvals, and publish new artifacts. Use npm's narrow early unpublish allowance only after an explicit owner decision and only when npm policy permits it; deprecation plus a new version is the default recovery.

### Promotion stopped partway

Do not upload new tarballs. Re-run the failed promotion job with the same prepared and consumer-verification artifacts and a fresh environment approval. It verifies existing `latest` tags, resumes the remaining reverse-order updates, and keeps candidate tags until all eight final tags verify. If registry state no longer matches, stop and investigate rather than forcing tags.

### Registry consumer failed

Do not promote. If the failure is registry propagation, use the bounded retry or re-run the no-secret consumer job. If package behavior, dependency resolution, WASM loading, browser behavior, or RPC fails, deprecate any uploaded candidate version and prepare a new coordinated version. A workspace-only fix is not evidence for already-uploaded immutable bytes.

### GitHub release failed after npm promotion

Do not republish npm packages. Verify all eight `latest` tags and integrities again, then re-run only the GitHub release job for the same release ID and commit. Never point the release tag at a different commit.

## After the first publication

The first upload uses a short-lived credential because npm trusted publishing cannot be configured for package records that do not yet exist. After all new package records exist:

1. configure npm trusted publishing for each package and this exact workflow/repository;
2. update and review the workflow to request only the required OIDC permission;
3. remove and revoke `NPM_TOKEN` from `npm-production`;
4. keep manual dispatch, exact-SHA binding, no-secret preflight, and protected human approval;
5. prove the credential-free trusted-publishing path in a later reviewed release.

Do not enable trusted publishing casually by broadening repository, branch, workflow, or environment trust.

## Known release limitations

- `@proseql/ai` is intentionally deferred. Its older npm release must not be presented as compatible with this beta.103 package set.
- In browsers, transaction-origin tracking does not remain reliable across asynchronous work inside a transaction. Avoid yielding to unrelated asynchronous work inside browser transactions when persistence/watch updates may interleave. This release does not claim to fix that limitation.
- `@proseql/rpc` defines calls and WASM-backed handlers, not a network server or security boundary. Applications choose a transport and must authenticate and authorize requests before they reach mutation handlers.
