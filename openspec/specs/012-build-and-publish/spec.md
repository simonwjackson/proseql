# Build & Publish

## Overview

proseql must be installable via `npm install proseql` with working TypeScript types, ESM output, and proper package metadata. Currently the package is at v0.0.0 with no build step, no type declarations, no exports field, and no LICENSE.

## Requirements

### Requirement: ESM build output

The package SHALL produce ESM-only output in a `dist/` directory via a build step. All source files in `core/` SHALL be compiled to JavaScript with source maps.

#### Scenario: Build produces dist/
- **WHEN** `npm run build` is executed
- **THEN** `dist/` SHALL contain compiled `.js` files mirroring the `core/` structure
- **AND** each `.js` file SHALL have a corresponding `.js.map` source map

#### Scenario: No CommonJS output
- **GIVEN** proseql targets modern consumers and depends on Effect (ESM-only)
- **THEN** no CommonJS (`.cjs`) output SHALL be produced
- **AND** `package.json` SHALL specify `"type": "module"`

### Requirement: TypeScript declaration files

The build SHALL generate `.d.ts` declaration files for all exported types.

#### Scenario: Declaration files exist
- **WHEN** the build completes
- **THEN** `dist/` SHALL contain `.d.ts` files for every `.js` file
- **AND** the `types` field in package.json SHALL point to `dist/index.d.ts`

#### Scenario: Types resolve for consumers
- **WHEN** a consumer imports `import { createEffectDatabase } from "proseql"`
- **THEN** TypeScript SHALL resolve full type information including generics, conditional types, and inferred entity types

### Requirement: Package.json exports field

The `exports` field SHALL define the package's public API entry points.

#### Scenario: Main entry point
- **WHEN** a consumer imports `from "proseql"`
- **THEN** it SHALL resolve to `dist/index.js` (import) and `dist/index.d.ts` (types)

#### Scenario: No deep imports
- **WHEN** a consumer attempts `from "proseql/core/state/collection-state"`
- **THEN** it SHALL fail to resolve — only the top-level entry point is public

### Requirement: Package metadata

The package SHALL include all standard npm metadata fields.

#### Scenario: Required fields
- **THEN** `package.json` SHALL include:
  - `name`: "proseql"
  - `version`: semver (starting at 0.1.0 or 1.0.0)
  - `description`: current description
  - `license`: "MIT"
  - `repository`: GitHub URL
  - `keywords`: ["database", "typescript", "effect", "yaml", "json", "plain-text", "type-safe"]
  - `engines`: `{ "node": ">=18" }`
  - `files`: ["dist", "LICENSE", "README.md"]

### Requirement: LICENSE file

A LICENSE file SHALL exist at the repository root.

#### Scenario: MIT license
- **THEN** the root SHALL contain a `LICENSE` file with the MIT license text

### Requirement: Prepublish safety

Publishing SHALL be gated behind a successful build and test run.

#### Scenario: Prepublish script
- **WHEN** `npm publish` is executed
- **THEN** the `prepublishOnly` script SHALL run `npm run build && npm test`
- **AND** publishing SHALL fail if either step fails

## Out of Scope

- Monorepo / multiple package publishing
- CDN distribution (unpkg, jsdelivr)
- Changelog generation (covered by separate spec)
