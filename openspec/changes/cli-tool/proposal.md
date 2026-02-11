## Why

Every interaction with a proseql database currently requires writing TypeScript: importing the library, constructing a database instance, calling methods, and running the script. There is no way to quickly inspect data, run a query, or manage migrations from the terminal. This makes proseql awkward for ad-hoc exploration, CI/CD pipelines, shell scripts, and users who want to work with their data files without opening an editor.

Other plain-text-friendly tools (SQLite, jq, yq) succeed partly because they have a CLI that makes the data accessible without a programming environment. proseql stores data in human-readable files but offers no human-friendly command to read them.

## What Changes

Introduce a new `packages/cli/` package (`@proseql/cli`) that provides a `proseql` command. The CLI discovers the project config file, boots the database with the Node adapter, and exposes every major capability as a subcommand: init, query, collections, describe, stats, create, update, delete, migrate, and convert. Output defaults to aligned tables for human reading, with JSON, YAML, and CSV flags for scripting.

## Capabilities

### New Capabilities

- `proseql init`: Scaffold a new project with config file, data directory, and example collection. Supports `--format` to choose the data file format (JSON, YAML, TOML, etc.).
- `proseql query <collection>`: Query a collection with `--where`, `--select`, `--sort`, `--limit`, and output format flags (`--json`, `--yaml`, `--csv`). Default output is an aligned table.
- `proseql collections`: List all configured collections with entity count, file path, and format.
- `proseql describe <collection>`: Display schema fields, types, indexes, relationships, and constraints for a collection.
- `proseql stats`: Show per-collection entity counts, file sizes, and serialization format.
- `proseql create <collection> --data '<json>'`: Insert a new entity and persist.
- `proseql update <collection> <id> --set '<field>=<value>'`: Update an entity by ID and persist.
- `proseql delete <collection> <id>`: Delete an entity by ID and persist. Prompts for confirmation unless `--force` is passed.
- `proseql migrate`: Run all pending migrations. Subcommands: `migrate status` (show migration state), `migrate --dry-run` (preview without executing).
- `proseql convert <collection> --to <format>`: Convert a collection's data file to a different serialization format and update the config.
- Config discovery: Automatically searches for `proseql.config.ts`, `proseql.config.js`, or `proseql.config.json` in the current directory and parent directories. Overridden by `--config <path>`.
- Output formatters: Table (aligned columns, default), JSON, YAML, CSV. Applied uniformly across query and inspection commands.

### Modified Capabilities

- `@proseql/node`: No code changes, but the CLI depends on it for `NodeStorageLayer` and file system access. The Node adapter's public API is consumed as-is.

## Impact

- **No breaking changes.** The CLI is a new package with no modifications to core or node.
- **New package** `@proseql/cli` added to the monorepo at `packages/cli/`. Depends on `@proseql/core` and `@proseql/node`.
- **Binary entry point** `proseql` registered in `package.json` `bin` field, runnable via `bunx @proseql/cli` or global install.
- **Config file loading** requires dynamic import of TypeScript config files, which works natively in Bun but would need a loader in Node. Since this is a CLI tool run by the developer, Bun is an acceptable runtime requirement.
- **Filter parsing** adds a lightweight expression parser to convert CLI strings like `year > 1970` into query `where` clauses. This is new code, not a modification of the core query engine.
- **Destructive operations** (delete, migrate) include confirmation prompts by default to prevent accidental data loss.
