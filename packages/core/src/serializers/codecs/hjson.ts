import { parse, stringify } from "hjson"
import type { FormatCodec, FormatOptions } from "../format-codec.js"

/**
 * Options for the Hjson codec.
 */
export interface HjsonCodecOptions {
	readonly indent?: number
}

/**
 * Creates an Hjson (Human JSON) codec with configurable indentation.
 *
 * Hjson is a JSON superset designed for human editing. It allows:
 * - Comments: `//`, block comments, and `#` hash comments
 * - Unquoted keys and string values
 * - Trailing commas
 * - Multiline strings with `'''`
 *
 * On decode: comments are stripped during parsing.
 * On encode: outputs human-friendly Hjson format (not standard JSON).
 *
 * @param options - Optional configuration for Hjson serialization
 * @param options.indent - Number of spaces for indentation (default: 2)
 * @returns A FormatCodec for Hjson serialization
 *
 * @example
 * ```typescript
 * const codec = hjsonCodec({ indent: 4 })
 * const layer = makeSerializerLayer([codec])
 * ```
 *
 * @see https://hjson.github.io for format specification
 */
export const hjsonCodec = (options?: HjsonCodecOptions): FormatCodec => {
	const indent = options?.indent ?? 2

	return {
		name: "hjson",
		extensions: ["hjson"],
		encode: (data: unknown, formatOptions?: FormatOptions): string => {
			const actualIndent = formatOptions?.indent ?? indent
			return stringify(data, { space: actualIndent })
		},
		decode: (raw: string): unknown => {
			return parse(raw)
		},
	}
}
