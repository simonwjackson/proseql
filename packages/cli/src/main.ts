#!/usr/bin/env bun
/**
 * ProseQL CLI - Command line interface for proseql databases
 *
 * Entry point: parses top-level flags and dispatches to command handlers.
 */

import { Effect } from "effect"
import type { DatabaseConfig } from "@proseql/core"
import { discoverConfig, ConfigNotFoundError } from "./config/discovery.js"
import {
	loadConfig,
	ConfigLoadError,
	ConfigValidationError,
} from "./config/loader.js"
import { handleInit as handleInitCommand } from "./commands/init.js"
import { handleQuery as handleQueryCommand } from "./commands/query.js"

const VERSION = "0.1.0"

/**
 * Parsed CLI arguments
 */
interface ParsedArgs {
  readonly command: string | undefined
  readonly positionalArgs: readonly string[]
  readonly flags: {
    readonly help: boolean
    readonly version: boolean
    readonly config: string | undefined
    readonly json: boolean
    readonly yaml: boolean
    readonly csv: boolean
    readonly force: boolean
    // Command-specific flags stored here for forwarding
    readonly where: readonly string[]
    readonly select: string | undefined
    readonly sort: string | undefined
    readonly limit: number | undefined
    readonly data: string | undefined
    readonly set: string | undefined
    readonly to: string | undefined
    readonly format: string | undefined
    readonly dryRun: boolean
  }
}

/**
 * Output format type
 */
type OutputFormat = "table" | "json" | "yaml" | "csv"

/**
 * Determine output format from flags
 */
function getOutputFormat(flags: ParsedArgs["flags"]): OutputFormat {
  if (flags.json) return "json"
  if (flags.yaml) return "yaml"
  if (flags.csv) return "csv"
  return "table"
}

/**
 * Parse command line arguments
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  // Skip first two args (bun and script path)
  const args = argv.slice(2)

  const flags: {
    help: boolean
    version: boolean
    config: string | undefined
    json: boolean
    yaml: boolean
    csv: boolean
    force: boolean
    where: string[]
    select: string | undefined
    sort: string | undefined
    limit: number | undefined
    data: string | undefined
    set: string | undefined
    to: string | undefined
    format: string | undefined
    dryRun: boolean
  } = {
    help: false,
    version: false,
    config: undefined,
    json: false,
    yaml: false,
    csv: false,
    force: false,
    where: [],
    select: undefined,
    sort: undefined,
    limit: undefined,
    data: undefined,
    set: undefined,
    to: undefined,
    format: undefined,
    dryRun: false,
  }

  const positionalArgs: string[] = []
  let command: string | undefined = undefined

  let i = 0
  while (i < args.length) {
    const arg = args[i]

    if (arg === "--help" || arg === "-h") {
      flags.help = true
      i++
    } else if (arg === "--version" || arg === "-v") {
      flags.version = true
      i++
    } else if (arg === "--config" || arg === "-c") {
      flags.config = args[i + 1]
      i += 2
    } else if (arg === "--json") {
      flags.json = true
      i++
    } else if (arg === "--yaml") {
      flags.yaml = true
      i++
    } else if (arg === "--csv") {
      flags.csv = true
      i++
    } else if (arg === "--force" || arg === "-f") {
      flags.force = true
      i++
    } else if (arg === "--where" || arg === "-w") {
      flags.where.push(args[i + 1])
      i += 2
    } else if (arg === "--select" || arg === "-s") {
      flags.select = args[i + 1]
      i += 2
    } else if (arg === "--sort") {
      flags.sort = args[i + 1]
      i += 2
    } else if (arg === "--limit" || arg === "-l") {
      const limitValue = parseInt(args[i + 1], 10)
      flags.limit = isNaN(limitValue) ? undefined : limitValue
      i += 2
    } else if (arg === "--data" || arg === "-d") {
      flags.data = args[i + 1]
      i += 2
    } else if (arg === "--set") {
      flags.set = args[i + 1]
      i += 2
    } else if (arg === "--to") {
      flags.to = args[i + 1]
      i += 2
    } else if (arg === "--format") {
      flags.format = args[i + 1]
      i += 2
    } else if (arg === "--dry-run") {
      flags.dryRun = true
      i++
    } else if (arg.startsWith("-")) {
      // Unknown flag - skip (could be command-specific)
      i++
    } else {
      // Positional argument
      if (command === undefined) {
        command = arg
      } else {
        positionalArgs.push(arg)
      }
      i++
    }
  }

  return {
    command,
    positionalArgs,
    flags: {
      ...flags,
      where: flags.where,
    },
  }
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`proseql v${VERSION}

A command-line interface for proseql databases.

USAGE:
  proseql <command> [options]

COMMANDS:
  init                  Initialize a new proseql project
  query <collection>    Query a collection
  collections           List all collections
  describe <collection> Show schema details for a collection
  stats                 Show statistics for all collections
  create <collection>   Create a new entity
  update <collection> <id>  Update an entity
  delete <collection> <id>  Delete an entity
  migrate               Run pending migrations
  convert <collection>  Convert a collection to a different format

GLOBAL OPTIONS:
  -h, --help            Show this help message
  -v, --version         Show version
  -c, --config <path>   Path to config file (default: auto-discover)
  --json                Output as JSON
  --yaml                Output as YAML
  --csv                 Output as CSV

QUERY OPTIONS:
  -w, --where <expr>    Filter expression (e.g., 'year > 1970')
  -s, --select <fields> Comma-separated fields to include
  --sort <field:dir>    Sort by field (asc/desc)
  -l, --limit <n>       Limit number of results

CRUD OPTIONS:
  -d, --data <json>     JSON data for create
  --set <assignments>   Field assignments for update (e.g., 'year=2025,title=New')
  -f, --force           Skip confirmation prompts

INIT OPTIONS:
  --format <fmt>        Data file format (json, yaml, toml)

MIGRATE OPTIONS:
  --dry-run             Show what would be done without executing
  status                Show migration status

CONVERT OPTIONS:
  --to <format>         Target format (json, yaml, toml)

EXAMPLES:
  proseql init
  proseql query books --where 'year > 1970' --limit 10
  proseql query books --json | jq '.[] | .title'
  proseql create books --data '{"title":"New Book","year":2024}'
  proseql update books abc123 --set 'year=2025'
  proseql delete books abc123 --force
  proseql migrate status
  proseql convert books --to yaml
`)
}

/**
 * Print version
 */
function printVersion(): void {
  console.log(`proseql v${VERSION}`)
}

/**
 * Print error and exit
 */
function exitWithError(message: string): never {
  console.error(`Error: ${message}`)
  console.error(`Run 'proseql --help' for usage.`)
  process.exit(1)
}

/**
 * Resolved config result including both the config and its path.
 */
interface ResolvedConfig {
  readonly config: DatabaseConfig
  readonly configPath: string
}

/**
 * Resolve and load the database config.
 * Uses the --config flag if provided, otherwise discovers the config file.
 * Returns both the config and its path (needed for resolving relative file paths).
 */
async function resolveConfig(
  configOverride: string | undefined,
): Promise<ResolvedConfig> {
  const program = Effect.gen(function* () {
    const configPath = yield* discoverConfig(process.cwd(), configOverride)
    const config = yield* loadConfig(configPath)
    return { config, configPath }
  })

  const result = await Effect.runPromise(
    program.pipe(
      Effect.catchTag("ConfigNotFoundError", (error) => {
        exitWithError(error.message)
      }),
      Effect.catchTag("ConfigLoadError", (error) => {
        exitWithError(error.message)
      }),
      Effect.catchTag("ConfigValidationError", (error) => {
        exitWithError(error.message)
      }),
    ),
  )

  return result
}

/**
 * Placeholder for command handlers (to be implemented in separate files)
 */
async function handleInit(args: ParsedArgs): Promise<void> {
  // init does not need config - it creates one
  await handleInitCommand({
    format: args.flags.format,
  })
}

async function handleQuery(
  args: ParsedArgs,
  resolvedConfig: ResolvedConfig,
): Promise<void> {
  const collectionName = args.positionalArgs[0]
  const result = await handleQueryCommand({
    collection: collectionName,
    config: resolvedConfig.config,
    configPath: resolvedConfig.configPath,
    where: args.flags.where,
    select: args.flags.select,
    sort: args.flags.sort,
    limit: args.flags.limit,
  })

  if (!result.success) {
    exitWithError(result.message ?? "Query failed")
  }

  // Output the results (for now, just JSON - formatting will be added in task 4.4)
  console.log(JSON.stringify(result.data, null, 2))
}

async function handleCollections(
  _args: ParsedArgs,
  _resolvedConfig: ResolvedConfig,
): Promise<void> {
  console.log("collections command - not yet implemented")
}

async function handleDescribe(
  _args: ParsedArgs,
  _resolvedConfig: ResolvedConfig,
): Promise<void> {
  console.log("describe command - not yet implemented")
}

async function handleStats(
  _args: ParsedArgs,
  _resolvedConfig: ResolvedConfig,
): Promise<void> {
  console.log("stats command - not yet implemented")
}

async function handleCreate(
  _args: ParsedArgs,
  _resolvedConfig: ResolvedConfig,
): Promise<void> {
  console.log("create command - not yet implemented")
}

async function handleUpdate(
  _args: ParsedArgs,
  _resolvedConfig: ResolvedConfig,
): Promise<void> {
  console.log("update command - not yet implemented")
}

async function handleDelete(
  _args: ParsedArgs,
  _resolvedConfig: ResolvedConfig,
): Promise<void> {
  console.log("delete command - not yet implemented")
}

async function handleMigrate(
  _args: ParsedArgs,
  _resolvedConfig: ResolvedConfig,
): Promise<void> {
  console.log("migrate command - not yet implemented")
}

async function handleConvert(
  _args: ParsedArgs,
  _resolvedConfig: ResolvedConfig,
): Promise<void> {
  console.log("convert command - not yet implemented")
}

/**
 * Commands that do NOT require a loaded config.
 */
const COMMANDS_WITHOUT_CONFIG = new Set(["init"])

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv)

  // Handle global flags first
  if (args.flags.version) {
    printVersion()
    return
  }

  if (args.flags.help || args.command === undefined) {
    printHelp()
    return
  }

  // Resolve config for commands that need it
  const needsConfig = !COMMANDS_WITHOUT_CONFIG.has(args.command)
  const resolvedConfig = needsConfig
    ? await resolveConfig(args.flags.config)
    : undefined

  // Dispatch to command handlers
  switch (args.command) {
    case "init":
      await handleInit(args)
      break

    case "query":
      if (args.positionalArgs.length < 1) {
        exitWithError("query command requires a collection name")
      }
      await handleQuery(args, resolvedConfig!)
      break

    case "collections":
      await handleCollections(args, resolvedConfig!)
      break

    case "describe":
      if (args.positionalArgs.length < 1) {
        exitWithError("describe command requires a collection name")
      }
      await handleDescribe(args, resolvedConfig!)
      break

    case "stats":
      await handleStats(args, resolvedConfig!)
      break

    case "create":
      if (args.positionalArgs.length < 1) {
        exitWithError("create command requires a collection name")
      }
      await handleCreate(args, resolvedConfig!)
      break

    case "update":
      if (args.positionalArgs.length < 2) {
        exitWithError("update command requires a collection name and entity ID")
      }
      await handleUpdate(args, resolvedConfig!)
      break

    case "delete":
      if (args.positionalArgs.length < 2) {
        exitWithError("delete command requires a collection name and entity ID")
      }
      await handleDelete(args, resolvedConfig!)
      break

    case "migrate":
      await handleMigrate(args, resolvedConfig!)
      break

    case "convert":
      if (args.positionalArgs.length < 1) {
        exitWithError("convert command requires a collection name")
      }
      await handleConvert(args, resolvedConfig!)
      break

    default:
      exitWithError(`Unknown command: ${args.command}`)
  }
}

// Export for testing
export { parseArgs, getOutputFormat, printHelp, printVersion, resolveConfig }
export type { ParsedArgs, OutputFormat }

// Run main
main().catch((error) => {
  console.error("Fatal error:", error)
  process.exit(1)
})
