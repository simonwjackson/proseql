import { parse, stringify } from "json5"
import type { FormatCodec, FormatOptions } from "../format-codec.js"

/**
 * Options for the JSON5 codec.
 */
export interface Json5CodecOptions {
	readonly indent?: number
}

/**
 * Creates a JSON5 codec with configurable indentation.
 *
 * JSON5 is a superset of JSON that allows comments, trailing commas,
 * unquoted keys, and other human-friendly syntax on read. On write,
 * output is formatted JSON5.
 *
 * @param options - Optional configuration for JSON5 serialization
 * @param options.indent - Number of spaces for indentation (default: 2)
 * @returns A FormatCodec for JSON5 serialization
 *
 * @example
 * ```typescript
 * const codec = json5Codec({ indent: 4 })
 * const layer = makeSerializerLayer([codec])
 * ```
 */
export const json5Codec = (options?: Json5CodecOptions): FormatCodec => {
	const indent = options?.indent ?? 2

	return {
		name: "json5",
		extensions: ["json5"],
		encode: (data: unknown, formatOptions?: FormatOptions): string => {
			const actualIndent = formatOptions?.indent ?? indent
			return stringify(data, null, actualIndent)
		},
		decode: (raw: string): unknown => {
			return parse(raw)
		},
	}
}
