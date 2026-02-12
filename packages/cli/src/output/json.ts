/**
 * ProseQL CLI - JSON Output Formatter
 *
 * Formats records as JSON with 2-space indentation.
 */

/**
 * Format records as pretty-printed JSON.
 *
 * @param records - Array of records to format
 * @returns JSON string with 2-space indentation
 */
export function formatAsJson(
	records: ReadonlyArray<Record<string, unknown>>,
): string {
	return JSON.stringify(records, null, 2)
}
