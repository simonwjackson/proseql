import type { FormatCodec } from "../format-codec.js";

/**
 * Result of parsing a single JSONL line.
 */
export interface ParsedLine {
	/** 1-based line number in the source file */
	readonly lineNumber: number;
	/** The raw text of the line */
	readonly rawLine: string;
	/** The parsed JSON value (undefined if parse failed) */
	readonly parsed: unknown;
	/** JSON parse error message, if parsing failed */
	readonly parseError?: string;
}

/**
 * Parse a raw JSONL string line-by-line, returning per-line results
 * with 1-based line numbers and individual parse errors.
 *
 * Empty/whitespace-only lines are skipped.
 */
export const jsonlDecodeLines = (raw: string): ReadonlyArray<ParsedLine> => {
	const allLines = raw.split("\n");
	const results: Array<ParsedLine> = [];
	for (let i = 0; i < allLines.length; i++) {
		const line = allLines[i];
		if (line.trim() === "") continue;
		try {
			results.push({
				lineNumber: i + 1,
				rawLine: line,
				parsed: JSON.parse(line),
			});
		} catch (err) {
			results.push({
				lineNumber: i + 1,
				rawLine: line,
				parsed: undefined,
				parseError: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return results;
};

/**
 * Creates a JSONL (JSON Lines / Newline Delimited JSON) codec.
 *
 * Each element of the array is serialized as a single JSON line.
 * On decode, each non-empty line is parsed as a JSON value.
 *
 * @returns A FormatCodec for JSONL serialization
 *
 * @example
 * ```typescript
 * const codec = jsonlCodec()
 * const layer = makeSerializerLayer([codec])
 * ```
 */
export const jsonlCodec = (): FormatCodec => {
	return {
		name: "jsonl",
		extensions: ["jsonl", "ndjson"],
		encode: (data: unknown): string => {
			if (!Array.isArray(data)) {
				return JSON.stringify(data);
			}
			return data.map((item) => JSON.stringify(item)).join("\n");
		},
		decode: (raw: string): unknown => {
			const lines = raw.split("\n").filter((line) => line.trim() !== "");
			return lines.map((line) => JSON.parse(line));
		},
	};
};
