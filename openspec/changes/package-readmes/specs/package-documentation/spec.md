## ADDED Requirements

### Requirement: Root README is a landing page

The root `README.md` SHALL contain only: project name, badges, one-paragraph description, a quick-start code example, a package table linking to each package README, and an examples listing. It SHALL NOT contain full API documentation.

#### Scenario: GitHub visitor sees overview
- **WHEN** a visitor opens the repository root on GitHub
- **THEN** they see a concise project overview with links to each package's README

#### Scenario: Quick start is self-contained
- **WHEN** a visitor reads the root README quick-start section
- **THEN** they can install `@proseql/core` and run a minimal in-memory example without clicking through to other docs

### Requirement: Core package has comprehensive API README

`packages/core/README.md` SHALL document all runtime-agnostic features: schema definition, CRUD operations, query operators, aggregation, pagination, full-text search, computed fields, relationships, indexing, lifecycle hooks, schema migrations, transactions, unique constraints, plugin system, error types, and ID generation.

#### Scenario: npm visitor sees full API docs
- **WHEN** a user visits `@proseql/core` on npmjs.com
- **THEN** the README displays complete API documentation with code examples for each feature

#### Scenario: In-memory usage is clear
- **WHEN** a user reads the core README
- **THEN** all examples use `createEffectDatabase` (in-memory) with no Node.js or browser imports

### Requirement: Node package has persistence-focused README

`packages/node/README.md` SHALL document Node.js file persistence: `createNodeDatabase`, `makeNodePersistenceLayer`, manual layer wiring, the file format table, prose format specifics, append-only JSONL, debounced writes, and `flush()`.

#### Scenario: npm visitor sees Node-specific docs
- **WHEN** a user visits `@proseql/node` on npmjs.com
- **THEN** the README covers file persistence setup, format options, and links to `@proseql/core` for the full query/mutation API

#### Scenario: Three persistence approaches documented
- **WHEN** a user reads the Node README
- **THEN** they find examples for zero-config (`createNodeDatabase`), explicit layer (`makeNodePersistenceLayer`), and manual wiring (`Layer.merge`)

### Requirement: REST package has handler generation README

`packages/rest/README.md` SHALL document `createRestHandlers`, generated route patterns, query parameter parsing, error mapping, and relationship routes.

#### Scenario: npm visitor sees REST API docs
- **WHEN** a user visits `@proseql/rest` on npmjs.com
- **THEN** the README shows how to generate REST handlers and integrate them with an HTTP framework

#### Scenario: Route table is documented
- **WHEN** a user reads the REST README
- **THEN** they see a table of generated routes (GET/POST/PUT/DELETE) for each collection

### Requirement: RPC package has Effect RPC README

`packages/rpc/README.md` SHALL document `makeRpcGroup`, `makeRpcHandlers`, type-safe client usage, error schemas, and payload schemas.

#### Scenario: npm visitor sees RPC docs
- **WHEN** a user visits `@proseql/rpc` on npmjs.com
- **THEN** the README shows how to derive an RPC group from a database config and create handlers

### Requirement: CLI package has command reference README

`packages/cli/README.md` SHALL document installation, all commands (init, query, create, update, delete, describe, collections, stats, convert, migrate), and output format options.

#### Scenario: npm visitor sees CLI docs
- **WHEN** a user visits `@proseql/cli` on npmjs.com
- **THEN** the README lists all available commands with usage examples

### Requirement: Browser package README unchanged

`packages/browser/README.md` SHALL remain unchanged. It already meets the documentation standard.

#### Scenario: Browser README preserved
- **WHEN** the change is applied
- **THEN** `packages/browser/README.md` has zero modifications

### Requirement: All package READMEs follow consistent structure

Every package README SHALL follow the structure: package name + description, install, quick start, API sections, license.

#### Scenario: Consistent structure across packages
- **WHEN** a user reads any two package READMEs
- **THEN** both follow the same top-level section structure
