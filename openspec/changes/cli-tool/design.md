# CLI Tool — Design

## Architecture

### New Modules

**`cli/src/main.ts`** — Entry point. Parses top-level arguments (`--config`, `--help`, `--version`), resolves the config file, and dispatches to the appropriate command handler.

**`cli/src/config/discovery.ts`** — Config file discovery: walks from `cwd` upward looking for `proseql.config.ts`, `proseql.config.js`, or `proseql.config.json`. Returns the resolved path or fails with a descriptive error. Accepts an override path via `--config`.

**`cli/src/config/loader.ts`** — Config file loading: dynamic-imports `.ts`/`.js` configs (Bun handles TS natively) and JSON-parses `.json` configs. Returns a typed `DatabaseConfig`.

**`cli/src/commands/init.ts`** — `proseql init` command. Scaffolds config file, data directory, and example collection. Accepts `--format` flag for data file format. Detects existing config and aborts with a warning.

**`cli/src/commands/query.ts`** — `proseql query <collection>` command. Boots the database, executes a `findMany` with parsed `where`, `select`, `orderBy`, and `limit` options, and pipes results to the output formatter.

**`cli/src/commands/collections.ts`** — `proseql collections` command. Lists all collections from the config with entity counts and file paths.

**`cli/src/commands/describe.ts`** — `proseql describe <collection>` command. Reads the schema definition and displays field names, types, indexes, relationships, and constraints.

**`cli/src/commands/stats.ts`** — `proseql stats` command. Reads each collection's file to report entity counts, file sizes, and serialization format.

**`cli/src/commands/create.ts`** — `proseql create <collection> --data '<json>'` command. Parses the JSON data, calls `create` on the collection, and reports the created entity.

**`cli/src/commands/update.ts`** — `proseql update <collection> <id> --set '<assignments>'` command. Parses `key=value` pairs from `--set`, calls `update`, and reports the result.

**`cli/src/commands/delete.ts`** — `proseql delete <collection> <id>` command. Prompts for confirmation (unless `--force`), calls `delete`, and reports the result.

**`cli/src/commands/migrate.ts`** — `proseql migrate` command with `status` and `--dry-run` subcommands. Boots the database, inspects migration state, and optionally executes pending migrations.

**`cli/src/commands/convert.ts`** — `proseql convert <collection> --to <format>` command. Reads the collection data, serializes in the target format, writes the new file, and updates the config.

**`cli/src/parsers/filter-parser.ts`** — Parses CLI filter strings (e.g., `year > 1970`, `status = active`) into proseql `where` clause objects. Supports operators: `=`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `startsWith`, `endsWith`. Compound filters joined with commas or repeated `--where` flags.

**`cli/src/parsers/set-parser.ts`** — Parses `--set` assignment strings (e.g., `year=2025,title=New Title`) into partial update objects.

**`cli/src/output/formatter.ts`** — Output formatting dispatcher. Accepts a format flag (table, json, yaml, csv) and an array of records. Delegates to the appropriate formatter.

**`cli/src/output/table.ts`** — Table formatter. Calculates column widths from data, prints aligned headers and rows. Truncates long values.

**`cli/src/output/json.ts`** — JSON formatter. `JSON.stringify` with 2-space indent.

**`cli/src/output/yaml.ts`** — YAML formatter. Uses the same YAML serializer from `@proseql/core`.

**`cli/src/output/csv.ts`** — CSV formatter. Writes header row then data rows with proper quoting/escaping.

**`cli/src/prompt.ts`** — Confirmation prompt for destructive operations. Reads stdin for `y/n`. Skipped when `--force` is passed or when stdin is not a TTY (non-interactive mode).

### Modified Modules

**`package.json` (root)** — Add `packages/cli` to the workspace list.

## Key Decisions

### New `packages/cli/` package, not embedded in core or node

The CLI is a consumer of the library, not part of it. Keeping it in its own package avoids adding CLI dependencies (arg parsing, terminal formatting) to the core library. It also allows the CLI to depend on both `@proseql/core` and `@proseql/node` without creating circular dependencies.

### Lightweight arg parsing, not a framework

The CLI uses manual argument parsing with `process.argv` (or Bun's `Bun.argv`) rather than a heavy framework like commander or yargs. The command structure is flat enough (one level of subcommands, a handful of flags per command) that a lightweight approach keeps dependencies minimal. A small `parseArgs` utility handles flag extraction and validation. If complexity grows, this can be replaced later.

### Config discovery walks upward from cwd

Following the convention of tools like `tsconfig.json`, `package.json`, and `.eslintrc`, the CLI searches for config files starting from the current working directory and walking up to the filesystem root. This lets users run commands from subdirectories of their project. The `--config` flag short-circuits discovery entirely.

### Filter expressions are parsed from simple strings, not a query language

The `--where` flag accepts expressions like `year > 1970` or `status = active`, not a full query language. This keeps the parser trivial (split on operator, cast values) and covers the common case. Complex queries that need `AND`/`OR`/nested logic should use the TypeScript API directly. Multiple `--where` flags are combined with AND.

### Output format flags are global, not per-command

`--json`, `--yaml`, `--csv` flags work on any command that produces output. This is more ergonomic than per-command formatting options and enables consistent piping behavior. Table is always the default for terminal output.

### Confirmation prompts for destructive operations

`delete` and `migrate` (when actually running migrations) prompt for confirmation unless `--force` is passed. When stdin is not a TTY (piped input, CI), the prompt is skipped and the command proceeds as if `--force` was given, matching common CLI conventions.

### Bun is the required runtime

The CLI uses `#!/usr/bin/env bun` as its shebang. This sidesteps the problem of loading TypeScript config files (Bun handles `.ts` imports natively) and aligns with the project's existing Bun-based tooling. Node users can still use the library packages directly.

## File Layout

```
cli/
  package.json               (new — @proseql/cli, bin: { proseql: ./src/main.ts })
  tsconfig.json              (new — extends root tsconfig)
  src/
    main.ts                  (new — entry point, arg dispatch)
    config/
      discovery.ts           (new — config file search)
      loader.ts              (new — config file import/parse)
    commands/
      init.ts                (new — project scaffolding)
      query.ts               (new — query execution)
      collections.ts         (new — list collections)
      describe.ts            (new — schema introspection)
      stats.ts               (new — collection statistics)
      create.ts              (new — create entity)
      update.ts              (new — update entity)
      delete.ts              (new — delete entity)
      migrate.ts             (new — migration management)
      convert.ts             (new — format conversion)
    parsers/
      filter-parser.ts       (new — --where string to query clause)
      set-parser.ts          (new — --set string to update object)
    output/
      formatter.ts           (new — format dispatcher)
      table.ts               (new — aligned table output)
      json.ts                (new — JSON output)
      yaml.ts                (new — YAML output)
      csv.ts                 (new — CSV output)
    prompt.ts                (new — y/n confirmation prompt)
  tests/
    config-discovery.test.ts (new — config search tests)
    filter-parser.test.ts    (new — filter parsing tests)
    set-parser.test.ts       (new — set parsing tests)
    output-formatters.test.ts(new — formatter tests)
    commands/
      init.test.ts           (new — init command tests)
      query.test.ts          (new — query command tests)
      crud.test.ts           (new — create/update/delete tests)
      migrate.test.ts        (new — migrate command tests)
      convert.test.ts        (new — convert command tests)
      inspect.test.ts        (new — collections/describe/stats tests)
```
