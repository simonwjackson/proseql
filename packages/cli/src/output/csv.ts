/**
 * ProseQL CLI - CSV Output Formatter
 *
 * Formats records as CSV with proper quoting and comma escaping.
 */

/**
 * Escape a value for CSV output.
 * Values containing commas, quotes, or newlines are wrapped in quotes.
 * Quotes within values are doubled.
 *
 * @param value - Value to escape
 * @returns Escaped CSV value
 */
function escapeValue(value: unknown): string {
	if (value === null || value === undefined) {
		return ""
	}

	const str = typeof value === "object" ? JSON.stringify(value) : String(value)

	// Check if the value needs quoting
	if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
		// Double any existing quotes and wrap in quotes
		return `"${str.replace(/"/g, '""')}"`
	}

	return str
}

/**
 * Format records as CSV.
 * Writes header row with all unique field names, then data rows.
 *
 * @param records - Array of records to format
 * @returns CSV string with header and data rows
 */
export function formatAsCsv(
	records: ReadonlyArray<Record<string, unknown>>,
): string {
	if (records.length === 0) {
		return ""
	}

	// Collect all unique field names across all records
	const fieldSet = new Set<string>()
	for (const record of records) {
		for (const key of Object.keys(record)) {
			fieldSet.add(key)
		}
	}
	const fields = Array.from(fieldSet)

	// Build header row
	const headerRow = fields.map(escapeValue).join(",")

	// Build data rows
	const dataRows = records.map((record) =>
		fields.map((field) => escapeValue(record[field])).join(","),
	)

	return [headerRow, ...dataRows].join("\n")
}
