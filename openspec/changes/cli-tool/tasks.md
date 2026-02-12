## 1. Package Scaffolding

- [x] 1.1 Create `packages/cli/package.json` with name `@proseql/cli`, `bin: { proseql: "./src/main.ts" }`, dependencies on `@proseql/core` and `@proseql/node`
- [x] 1.2 Create `packages/cli/tsconfig.json` extending root tsconfig
- [x] 1.3 Add `packages/cli` to the root workspace configuration
- [x] 1.4 Create `packages/cli/src/main.ts` entry point: parse top-level flags (`--config`, `--help`, `--version`, `--json`, `--yaml`, `--csv`), dispatch to command handlers based on first positional argument
- [x] 1.5 Verify `bun run packages/cli/src/main.ts --help` executes without error

## 2. Config Discovery

- [x] 2.1 Create `packages/cli/src/config/discovery.ts`: `discoverConfig(cwd, overridePath?)` walks from `cwd` upward, checking for `proseql.config.ts`, `proseql.config.js`, `proseql.config.json` in order. Returns absolute path or fails with descriptive error.
- [x] 2.2 Create `packages/cli/src/config/loader.ts`: `loadConfig(configPath)` dynamic-imports `.ts`/`.js` files, JSON-parses `.json` files. Returns typed `DatabaseConfig`. Fails with clear error on invalid config.
- [x] 2.3 Wire discovery and loading into `main.ts`: resolve config before dispatching to any command that needs it (all except `init` and `--help`/`--version`).

## 3. Init Command

- [x] 3.1 Create `packages/cli/src/commands/init.ts`: check for existing config in cwd, abort with warning if found
- [x] 3.2 Scaffold `proseql.config.ts` with an example collection definition
- [x] 3.3 Create `data/` directory with an example data file in the chosen format (default JSON, override with `--format`)
- [x] 3.4 Detect `.git` directory and append data directory to `.gitignore` if appropriate
- [x] 3.5 Print summary of created files to stdout

## 4. Query Command

- [x] 4.1 Create `packages/cli/src/parsers/filter-parser.ts`: parse `--where` strings like `year > 1970` into proseql `where` clause objects. Support operators `=`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `startsWith`, `endsWith`. Auto-detect value types (number, boolean, string).
- [x] 4.2 Create `packages/cli/src/commands/query.ts`: boot database from config, resolve collection by name, execute `findMany` with parsed `where`, `select`, `orderBy`, and `limit` options
- [x] 4.3 Parse `--select` as comma-separated field list, `--sort` as `field:asc` or `field:desc`, `--limit` as integer
- [x] 4.4 Pipe query results to the output formatter with the active format flag

## 5. Inspect Commands

- [x] 5.1 Create `packages/cli/src/commands/collections.ts`: boot database, list all collection names with entity count, file path, and serialization format. Output as table (or chosen format).
- [x] 5.2 Create `packages/cli/src/commands/describe.ts`: boot database, read the schema for the named collection, display field names, types, optional/required, indexes, relationships, and constraints
- [x] 5.3 Create `packages/cli/src/commands/stats.ts`: boot database, report per-collection entity count, file size on disk, and serialization format

## 6. CRUD Commands

- [x] 6.1 Create `packages/cli/src/commands/create.ts`: parse `--data` as JSON string, call `create` on the collection, print the created entity
- [x] 6.2 Create `packages/cli/src/parsers/set-parser.ts`: parse `--set` assignment strings like `year=2025,title=New Title` into partial update objects with auto-detected value types
- [x] 6.3 Create `packages/cli/src/commands/update.ts`: resolve collection and entity ID from positional args, parse `--set` into update payload, call `update`, print the updated entity
- [x] 6.4 Create `packages/cli/src/prompt.ts`: confirmation prompt reading `y/n` from stdin. Skip when `--force` is passed or stdin is not a TTY.
- [ ] 6.5 Create `packages/cli/src/commands/delete.ts`: resolve collection and entity ID, prompt for confirmation (unless `--force`), call `delete`, print confirmation message

## 7. Migration Commands

- [ ] 7.1 Create `packages/cli/src/commands/migrate.ts`: detect subcommand (`status`, or root `migrate`)
- [ ] 7.2 Implement `migrate status`: boot database, display each collection's current file version vs config version, highlight collections needing migration
- [ ] 7.3 Implement `migrate --dry-run`: show what migrations would run without executing them
- [ ] 7.4 Implement `migrate` (run): prompt for confirmation (unless `--force`), execute all pending migrations, report results

## 8. Convert Command

- [ ] 8.1 Create `packages/cli/src/commands/convert.ts`: resolve collection, read current data file, serialize in the target format using core serializers
- [ ] 8.2 Write the new data file with the correct extension, remove the old file
- [ ] 8.3 Update the config file to reference the new file path/format
- [ ] 8.4 Print summary of conversion (old format, new format, file paths)

## 9. Output Formatters

- [ ] 9.1 Create `packages/cli/src/output/formatter.ts`: dispatcher that accepts format flag and record array, delegates to the appropriate formatter
- [ ] 9.2 Create `packages/cli/src/output/table.ts`: calculate column widths from headers and data, print aligned columns. Truncate values exceeding terminal width.
- [ ] 9.3 Create `packages/cli/src/output/json.ts`: `JSON.stringify` with 2-space indent
- [ ] 9.4 Create `packages/cli/src/output/yaml.ts`: serialize using the YAML codec from `@proseql/core`
- [ ] 9.5 Create `packages/cli/src/output/csv.ts`: write header row then data rows with proper quoting and comma escaping

## 10. Tests

- [ ] 10.1 Create `packages/cli/tests/config-discovery.test.ts`: test upward search finds config, test override path, test missing config error
- [ ] 10.2 Create `packages/cli/tests/filter-parser.test.ts`: test all operators, type coercion (numbers, booleans, strings), malformed input errors
- [ ] 10.3 Create `packages/cli/tests/set-parser.test.ts`: test key=value parsing, multiple assignments, type coercion, edge cases (values containing `=`)
- [ ] 10.4 Create `packages/cli/tests/output-formatters.test.ts`: test table alignment, JSON validity, YAML validity, CSV quoting/escaping
- [ ] 10.5 Create `packages/cli/tests/commands/init.test.ts`: test scaffolding creates expected files, test `--format` flag, test abort on existing config
- [ ] 10.6 Create `packages/cli/tests/commands/query.test.ts`: test basic query, filtered query, select/sort/limit, output format flags
- [ ] 10.7 Create `packages/cli/tests/commands/crud.test.ts`: test create with `--data`, update with `--set`, delete with `--force`, delete confirmation prompt
- [ ] 10.8 Create `packages/cli/tests/commands/migrate.test.ts`: test status display, dry-run output, migration execution
- [ ] 10.9 Create `packages/cli/tests/commands/convert.test.ts`: test format conversion writes correct file, updates config, removes old file
- [ ] 10.10 Create `packages/cli/tests/commands/inspect.test.ts`: test collections listing, describe output, stats output

## 11. Cleanup

- [ ] 11.1 Run full test suite (`bun test`) to verify no regressions across all packages
- [ ] 11.2 Run type check (`bunx tsc --build`) to verify no type errors
- [ ] 11.3 Run lint (`biome check .`) and fix any issues
- [ ] 11.4 Verify `proseql --help` prints usage information for all commands
