import type { FormatCodec, FormatOptions } from "../format-codec.js"

/**
 * Options for the JSON codec.
 */
export interface JsonCodecOptions {
	readonly indent?: number
}

/**
 * Creates a JSON codec with configurable indentation.
 *
 * @param options - Optional configuration for JSON serialization
 * @param options.indent - Number of spaces for indentation (default: 2)
 * @returns A FormatCodec for JSON serialization
 *
 * @example
 * ```typescript
 * const codec = jsonCodec({ indent: 4 })
 * const layer = makeSerializerLayer([codec])
 * ```
 */
export const jsonCodec = (options?: JsonCodecOptions): FormatCodec => {
	const indent = options?.indent ?? 2

	return {
		name: "json",
		extensions: ["json"],
		encode: (data: unknown, formatOptions?: FormatOptions): string => {
			const actualIndent = formatOptions?.indent ?? indent
			return JSON.stringify(data, null, actualIndent)
		},
		decode: (raw: string): unknown => {
			return JSON.parse(raw)
		},
	}
}
