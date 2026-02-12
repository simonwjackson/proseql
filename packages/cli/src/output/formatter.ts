/**
 * ProseQL CLI - Output Formatter Dispatcher
 *
 * Accepts a format flag and record array, delegates to the appropriate formatter.
 */

import { formatAsJson } from "./json.js"
import { formatAsYaml } from "./yaml.js"
import { formatAsCsv } from "./csv.js"
import { formatAsTable } from "./table.js"

/**
 * Supported output formats.
 */
export type OutputFormat = "table" | "json" | "yaml" | "csv"

/**
 * Format the given records based on the specified format.
 *
 * @param format - The output format to use
 * @param records - Array of records to format
 * @returns Formatted string output
 */
export function format(
	format: OutputFormat,
	records: ReadonlyArray<Record<string, unknown>>,
): string {
	switch (format) {
		case "json":
			return formatAsJson(records)
		case "yaml":
			return formatAsYaml(records)
		case "csv":
			return formatAsCsv(records)
		case "table":
			return formatAsTable(records)
	}
}
