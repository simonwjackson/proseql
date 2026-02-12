/**
 * ProseQL CLI - Table Output Formatter
 *
 * Formats records as an aligned ASCII table.
 * Calculates column widths from headers and data, truncates values exceeding terminal width.
 */

/**
 * Default maximum width for a single column before truncation.
 */
const DEFAULT_MAX_COLUMN_WIDTH = 40

/**
 * Get the display width of a value (handling null, undefined, objects).
 *
 * @param value - Value to measure
 * @returns String representation of the value
 */
function stringify(value: unknown): string {
	if (value === null) {
		return "null"
	}
	if (value === undefined) {
		return ""
	}
	if (typeof value === "object") {
		return JSON.stringify(value)
	}
	return String(value)
}

/**
 * Truncate a string to a maximum length, adding ellipsis if needed.
 *
 * @param str - String to truncate
 * @param maxLen - Maximum length
 * @returns Truncated string with ellipsis if truncated
 */
function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) {
		return str
	}
	if (maxLen <= 3) {
		return str.slice(0, maxLen)
	}
	return `${str.slice(0, maxLen - 3)}...`
}

/**
 * Pad a string to a given length with spaces (left-align).
 *
 * @param str - String to pad
 * @param len - Target length
 * @returns Padded string
 */
function padRight(str: string, len: number): string {
	if (str.length >= len) {
		return str
	}
	return str + " ".repeat(len - str.length)
}

/**
 * Format records as an aligned ASCII table.
 *
 * @param records - Array of records to format
 * @param options - Optional configuration
 * @param options.maxColumnWidth - Maximum width for any column (default: 40)
 * @returns Formatted table string
 */
export function formatAsTable(
	records: ReadonlyArray<Record<string, unknown>>,
	options?: { readonly maxColumnWidth?: number },
): string {
	if (records.length === 0) {
		return "(no results)"
	}

	const maxColumnWidth = options?.maxColumnWidth ?? DEFAULT_MAX_COLUMN_WIDTH

	// Collect all unique field names across all records
	const fieldSet = new Set<string>()
	for (const record of records) {
		for (const key of Object.keys(record)) {
			fieldSet.add(key)
		}
	}
	const fields = Array.from(fieldSet)

	// Calculate column widths (min of actual content width and max column width)
	const columnWidths = new Map<string, number>()
	for (const field of fields) {
		// Start with header width
		let maxWidth = field.length

		// Check all data values
		for (const record of records) {
			const value = stringify(record[field])
			maxWidth = Math.max(maxWidth, value.length)
		}

		// Clamp to max column width
		columnWidths.set(field, Math.min(maxWidth, maxColumnWidth))
	}

	// Build header row
	const headerRow = fields
		.map((field) => padRight(truncate(field, columnWidths.get(field)!), columnWidths.get(field)!))
		.join("  ")

	// Build separator row
	const separatorRow = fields
		.map((field) => "-".repeat(columnWidths.get(field)!))
		.join("  ")

	// Build data rows
	const dataRows = records.map((record) =>
		fields
			.map((field) => {
				const value = stringify(record[field])
				const width = columnWidths.get(field)!
				return padRight(truncate(value, width), width)
			})
			.join("  "),
	)

	return [headerRow, separatorRow, ...dataRows].join("\n")
}
