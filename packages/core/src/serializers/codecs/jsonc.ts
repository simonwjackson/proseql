import { parse } from "jsonc-parser";
import type { FormatCodec, FormatOptions } from "../format-codec.js";

/**
 * Options for the JSONC codec.
 */
export interface JsoncCodecOptions {
	readonly indent?: number;
}

/**
 * Creates a JSONC (JSON with Comments) codec with configurable indentation.
 *
 * JSONC is a superset of JSON that allows line comments (//) and block
 * comments. On read, comments are stripped using jsonc-parser. On write,
 * standard JSON is output (comments are not preserved).
 *
 * This is the same behavior as VS Code's settings.json — comments in
 * hand-edited .jsonc files do not survive a save cycle.
 *
 * @param options - Optional configuration for JSONC serialization
 * @param options.indent - Number of spaces for indentation (default: 2)
 * @returns A FormatCodec for JSONC serialization
 *
 * @example
 * ```typescript
 * const codec = jsoncCodec({ indent: 4 })
 * const layer = makeSerializerLayer([codec])
 * ```
 */
export const jsoncCodec = (options?: JsoncCodecOptions): FormatCodec => {
	const indent = options?.indent ?? 2;

	return {
		name: "jsonc",
		extensions: ["jsonc"],
		encode: (data: unknown, formatOptions?: FormatOptions): string => {
			const actualIndent = formatOptions?.indent ?? indent;
			return JSON.stringify(data, null, actualIndent);
		},
		decode: (raw: string): unknown => {
			// jsonc-parser's parse function handles comments and trailing commas
			// It returns the parsed JavaScript value, stripping comments automatically
			return parse(raw);
		},
	};
};
