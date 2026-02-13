## Why

Every package is published to npm, but only `@proseql/browser` has a README. npm visitors landing on `@proseql/core`, `@proseql/node`, `@proseql/rest`, `@proseql/rpc`, or `@proseql/cli` see nothing — no install instructions, no API overview, no examples. Meanwhile the root README tries to cover everything, mixing core API docs with Node-specific persistence wiring.

Splitting the root README into a lightweight landing page and giving each package its own focused README improves discoverability on npm and keeps content ownership clear.

## What Changes

- **Slim down root `README.md`** to a project overview / landing page: elevator pitch, quick start, package table with links, examples listing.
- **Create `packages/core/README.md`** — the comprehensive API docs (schema, CRUD, querying, operators, aggregation, pagination, search, computed fields, relationships, indexes, hooks, migrations, transactions, unique constraints, plugins, error types, ID generation). This is the bulk of what currently lives in the root README.
- **Create `packages/node/README.md`** — Node-specific persistence: `createNodeDatabase`, `makeNodePersistenceLayer`, manual `Layer.merge`, file format table, prose format, append-only JSONL, debounced writes, `flush()`.
- **Create `packages/rest/README.md`** — REST handler generation: `createRestHandlers`, generated routes, query parameter parsing, error mapping, relationship routes, framework integration examples.
- **Create `packages/rpc/README.md`** — Effect RPC integration: `makeRpcGroup`, `makeRpcHandlers`, payload/error schemas, type-safe client usage.
- **Create `packages/cli/README.md`** — CLI commands: init, query, create, update, delete, describe, collections, stats, convert, migrate.
- **Keep `packages/browser/README.md`** as-is (already complete).

## Capabilities

### New Capabilities

- `package-documentation`: Per-package README files for npm publication, with the root README refactored into a project landing page.

### Modified Capabilities


## Impact

- `README.md` (root) — slimmed to landing page
- `packages/core/README.md` — new file
- `packages/node/README.md` — new file
- `packages/rest/README.md` — new file
- `packages/rpc/README.md` — new file
- `packages/cli/README.md` — new file
- No code changes, no dependency changes, no API changes
