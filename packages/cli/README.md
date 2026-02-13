# @proseql/cli

Command-line interface for ProseQL databases. Query, create, update, and manage your plain text database files from the terminal.

## Install

```sh
# Run directly with npx
npx @proseql/cli --help

# Or install globally
npm install -g @proseql/cli
```

## Quick Start

```sh
# Initialize a new project
proseql init

# Query a collection
proseql query books --where 'year > 1970' --limit 10

# Create an entity
proseql create books --data '{"title":"Dune","author":"Frank Herbert","year":1965}'

# Update an entity
proseql update books abc123 --set 'year=2025,title=New Title'

# Delete an entity
proseql delete books abc123 --force
```

## Commands

### `init`

Scaffold a new ProseQL project with config and data files.

```sh
proseql init
proseql init --format yaml
proseql init --format toml
```

Creates:
- `proseql.config.ts` with an example `notes` collection
- `data/notes.{json,yaml,toml}` with sample data
- Updates `.gitignore` to exclude the data directory (if in a git repo)

| Option | Description |
|--------|-------------|
| `--format <fmt>` | Data file format: `json` (default), `yaml`, `toml` |

### `query`

Query a collection with filters, sorting, and pagination.

```sh
proseql query <collection> [options]

# Examples
proseql query books
proseql query books --where 'year > 1970'
proseql query books --where 'genre = sci-fi' --where 'year < 2000'
proseql query books --select 'title,author' --sort 'year:desc' --limit 5
proseql query books --json | jq '.[] | .title'
```

| Option | Description |
|--------|-------------|
| `-w, --where <expr>` | Filter expression (can be repeated) |
| `-s, --select <fields>` | Comma-separated fields to include |
| `--sort <field:dir>` | Sort by field (`asc` or `desc`) |
| `-l, --limit <n>` | Limit number of results |

Filter expressions use the format `field operator value`:
- `year > 1970`
- `genre = sci-fi`
- `title != "Old Title"`
- `rating >= 4.5`

### `create`

Create a new entity in a collection.

```sh
proseql create <collection> --data '<json>'

# Examples
proseql create books --data '{"title":"Neuromancer","author":"William Gibson","year":1984}'
proseql create notes --data '{"title":"Meeting notes","content":"..."}'
```

| Option | Description |
|--------|-------------|
| `-d, --data <json>` | JSON object containing the entity data (required) |

The created entity is printed to stdout. An ID is auto-generated if not provided.

### `update`

Update an existing entity by ID.

```sh
proseql update <collection> <id> --set '<assignments>'

# Examples
proseql update books abc123 --set 'year=2025'
proseql update books abc123 --set 'year=2025,title=Updated Title'
proseql update notes xyz --set 'content=New content here'
```

| Option | Description |
|--------|-------------|
| `--set <assignments>` | Comma-separated field assignments (required) |

Values are automatically coerced: numbers become numbers, `true`/`false` become booleans.

### `delete`

Delete an entity by ID.

```sh
proseql delete <collection> <id> [options]

# Examples
proseql delete books abc123
proseql delete books abc123 --force
```

| Option | Description |
|--------|-------------|
| `-f, --force` | Skip confirmation prompt |

Without `--force`, you'll be prompted to confirm the deletion.

### `collections`

List all collections with entity counts and file paths.

```sh
proseql collections

# Output:
# name     count  file              format
# books    42     data/books.yaml   yaml
# authors  12     data/authors.json json
```

### `describe`

Show schema details for a collection.

```sh
proseql describe <collection>

# Examples
proseql describe books
proseql describe books --json
```

Displays:
- Field names, types, and required/optional status
- Indexed fields
- Unique constraints
- Relationships
- Search index configuration
- Schema version (if versioned)
- Append-only mode (if enabled)

### `stats`

Show statistics for all collections.

```sh
proseql stats

# Output:
# name     count  file              format  size
# books    42     data/books.yaml   yaml    12.5 KB
# authors  12     data/authors.json json    2.1 KB
```

Includes entity counts, file paths, formats, and file sizes on disk.

### `migrate`

Run schema migrations.

```sh
# Show migration status
proseql migrate status

# Preview what would run (dry run)
proseql migrate --dry-run

# Execute pending migrations
proseql migrate
proseql migrate --force  # skip confirmation
```

| Option | Description |
|--------|-------------|
| `--dry-run` | Show what would be done without executing |
| `-f, --force` | Skip confirmation prompt |

Migration status shows:
- Current file version vs target version
- Collections that need migration
- Number of migrations to apply

### `convert`

Convert a collection's data file to a different format.

```sh
proseql convert <collection> --to <format>

# Examples
proseql convert books --to yaml
proseql convert notes --to json
proseql convert config --to toml
```

| Option | Description |
|--------|-------------|
| `--to <format>` | Target format (required) |

Supported formats: `json`, `yaml`, `toml`, `json5`, `jsonc`, `hjson`, `toon`

The command:
1. Reads the current data file
2. Re-serializes in the target format
3. Writes the new file with the correct extension
4. Removes the old file
5. Updates the config file to reference the new path

## Global Options

| Option | Description |
|--------|-------------|
| `-h, --help` | Show help message |
| `-v, --version` | Show version |
| `-c, --config <path>` | Path to config file (default: auto-discover) |
| `--json` | Output as JSON |
| `--yaml` | Output as YAML |
| `--csv` | Output as CSV |

## Output Formats

All commands that return data support multiple output formats:

```sh
# Default: table format (human-readable)
proseql query books

# JSON (pipe to jq, etc.)
proseql query books --json

# YAML
proseql query books --yaml

# CSV (for spreadsheets)
proseql query books --csv
```

Table is the default. JSON is useful for scripting and piping to other tools.

## Config Discovery

The CLI automatically discovers your config file by searching upward from the current directory:

1. `proseql.config.ts`
2. `proseql.config.js`
3. `proseql.config.json`

The first file found is used. Override with `--config`:

```sh
proseql query books --config ./path/to/proseql.config.ts
```

## Examples

### Querying with filters and piping to jq

```sh
# Get all sci-fi books as JSON
proseql query books --where 'genre = sci-fi' --json

# Pipe to jq for further processing
proseql query books --json | jq '.[] | {title, year}'

# Count results
proseql query books --where 'year > 2000' --json | jq length
```

### Batch operations with shell scripts

```sh
# Export all collections to JSON
for collection in $(proseql collections --json | jq -r '.[].name'); do
  proseql query "$collection" --json > "export-$collection.json"
done
```

### Migration workflow

```sh
# Check what needs migrating
proseql migrate status

# Preview the changes
proseql migrate --dry-run

# Apply migrations
proseql migrate --force
```

### Format conversion

```sh
# Convert from JSON to YAML for better readability
proseql convert books --to yaml

# Convert to TOML for config-like data
proseql convert settings --to toml
```

## License

MIT
