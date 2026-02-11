# CLI Tool

## Overview

A command-line interface for interacting with proseql databases from the terminal. Initialize projects, query data, run migrations, inspect collections, and manage data files without writing TypeScript. The CLI reads the same plain text files that the library reads — no separate server or daemon.

## Requirements

### Requirement: Initialize a project

The CLI SHALL scaffold a new proseql project with config and data files.

#### Scenario: Init command
- **WHEN** `proseql init` is run in an empty directory
- **THEN** it SHALL create:
  - A `proseql.config.ts` (or `.js`) with an example collection
  - A `data/` directory with an example data file
  - A `.gitignore` entry (if git repo detected)

#### Scenario: Init with format choice
- **WHEN** `proseql init --format yaml` is run
- **THEN** example data files SHALL use YAML format

#### Scenario: Init in existing project
- **WHEN** `proseql init` is run in a directory with existing config
- **THEN** it SHALL warn and abort (no overwrite)

### Requirement: Query data from the command line

The CLI SHALL execute queries against data files and print results.

#### Scenario: Basic query
- **WHEN** `proseql query books` is run
- **THEN** all entities in the books collection SHALL be printed as a table

#### Scenario: Filtered query
- **WHEN** `proseql query books --where 'year > 1970'` is run
- **THEN** only matching entities SHALL be printed

#### Scenario: JSON output
- **WHEN** `proseql query books --json` is run
- **THEN** results SHALL be printed as JSON (for piping to jq, etc.)

#### Scenario: Select fields
- **WHEN** `proseql query books --select title,year` is run
- **THEN** only the specified fields SHALL be shown

#### Scenario: Sort
- **WHEN** `proseql query books --sort year:desc` is run
- **THEN** results SHALL be sorted by year descending

#### Scenario: Limit
- **WHEN** `proseql query books --limit 5` is run
- **THEN** at most 5 results SHALL be shown

### Requirement: Inspect collections

The CLI SHALL provide introspection commands for exploring the database structure.

#### Scenario: List collections
- **WHEN** `proseql collections` is run
- **THEN** all configured collections SHALL be listed with entity count and file path

#### Scenario: Describe collection
- **WHEN** `proseql describe books` is run
- **THEN** the schema fields, types, relationships, indexes, and constraints SHALL be displayed

#### Scenario: Stats
- **WHEN** `proseql stats` is run
- **THEN** per-collection entity counts, file sizes, and format SHALL be displayed

### Requirement: CRUD from CLI

The CLI SHALL support basic create, update, and delete operations.

#### Scenario: Create
- **WHEN** `proseql create books --data '{"title":"New Book","year":2024}'` is run
- **THEN** the entity SHALL be created and the file updated

#### Scenario: Update
- **WHEN** `proseql update books <id> --set 'year=2025'` is run
- **THEN** the entity SHALL be updated and the file saved

#### Scenario: Delete
- **WHEN** `proseql delete books <id>` is run
- **THEN** the entity SHALL be deleted and the file saved

#### Scenario: Delete with confirmation
- **WHEN** delete is run without `--force`
- **THEN** the CLI SHALL prompt for confirmation before deleting

### Requirement: Migration commands

The CLI SHALL provide migration management commands.

#### Scenario: Migration status
- **WHEN** `proseql migrate status` is run
- **THEN** each collection's current file version and config version SHALL be displayed
- **AND** collections needing migration SHALL be highlighted

#### Scenario: Dry run
- **WHEN** `proseql migrate --dry-run` is run
- **THEN** it SHALL show what migrations would run without executing them

#### Scenario: Run migrations
- **WHEN** `proseql migrate` is run
- **THEN** all pending migrations SHALL be executed and files updated

### Requirement: Config file discovery

The CLI SHALL automatically discover the database configuration.

#### Scenario: Config discovery
- **WHEN** any CLI command is run
- **THEN** the CLI SHALL search for `proseql.config.ts`, `proseql.config.js`, or `proseql.config.json` in the current directory and parent directories

#### Scenario: Config flag
- **WHEN** `--config path/to/config.ts` is provided
- **THEN** the specified config SHALL be used instead of auto-discovery

### Requirement: Format conversion

The CLI SHALL convert data files between formats.

#### Scenario: Convert format
- **WHEN** `proseql convert books --to json` is run
- **THEN** `data/books.yaml` SHALL be converted to `data/books.json`
- **AND** the config SHALL be updated to reference the new file

### Requirement: Output formatting

The CLI SHALL support multiple output formats.

#### Scenario: Table output (default)
- **THEN** query results SHALL be displayed as an aligned table by default

#### Scenario: JSON output
- **WHEN** `--json` flag is used
- **THEN** output SHALL be valid JSON

#### Scenario: YAML output
- **WHEN** `--yaml` flag is used
- **THEN** output SHALL be valid YAML

#### Scenario: CSV output
- **WHEN** `--csv` flag is used
- **THEN** output SHALL be valid CSV

## Out of Scope

- Interactive REPL mode (could be added later)
- GUI / TUI (ncurses-style interface)
- Watch mode (live-updating query results)
- Remote database access
