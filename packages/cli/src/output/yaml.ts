/**
 * ProseQL CLI - YAML Output Formatter
 *
 * Formats records as YAML using the same YAML library as @proseql/core.
 */

import YAML from "yaml"

/**
 * Format records as YAML.
 *
 * @param records - Array of records to format
 * @returns YAML string with 2-space indentation
 */
export function formatAsYaml(
	records: ReadonlyArray<Record<string, unknown>>,
): string {
	return YAML.stringify(records, { indent: 2 })
}
