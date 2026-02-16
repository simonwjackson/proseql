/**
 * @proseql/cli - Programmatic API
 *
 * Re-exports the CLI's public API for programmatic use.
 */

export type { OutputFormat, ParsedArgs } from "./main.js";
export { getOutputFormat, parseArgs, resolveConfig } from "./main.js";
