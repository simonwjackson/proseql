# CI Pipeline

## Overview

Automated CI via GitHub Actions to run tests, type checking, and optionally publish to npm on tagged releases. Currently there is no CI configuration.

## Requirements

### Requirement: Test and typecheck on every push

Every push and pull request to `main` SHALL trigger automated testing and type checking.

#### Scenario: PR check
- **WHEN** a pull request is opened or updated against `main`
- **THEN** CI SHALL run `bun test` and `bunx tsc --noEmit`
- **AND** both checks SHALL pass before merging is allowed

#### Scenario: Push to main
- **WHEN** a commit is pushed directly to `main`
- **THEN** the same test and typecheck jobs SHALL run

### Requirement: Matrix testing

Tests SHALL run on multiple Node.js versions to ensure compatibility.

#### Scenario: Node version matrix
- **THEN** CI SHALL test on Node.js 18, 20, and 22 (LTS versions)
- **AND** the Bun runtime SHALL also be tested

### Requirement: Publish on tagged release

When a version tag is pushed, CI SHALL publish to npm automatically.

#### Scenario: Version tag triggers publish
- **WHEN** a tag matching `v*` (e.g., `v0.1.0`) is pushed
- **THEN** CI SHALL build, test, typecheck, and publish to npm
- **AND** publishing SHALL use an `NPM_TOKEN` secret

#### Scenario: Publish fails on test failure
- **WHEN** tests or typecheck fail during the publish workflow
- **THEN** the npm publish step SHALL NOT execute

### Requirement: Cache dependencies

CI SHALL cache package manager artifacts to speed up builds.

#### Scenario: Bun cache
- **THEN** the `bun.lock` file SHALL be used as the cache key for `~/.bun/install/cache`

## Out of Scope

- Release automation (auto-tagging, changelog generation)
- Deployment previews
- Code coverage uploading (covered by coverage-reporting spec)
