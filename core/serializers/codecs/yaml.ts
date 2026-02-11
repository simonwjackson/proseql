import YAML from "yaml"
import type { FormatCodec, FormatOptions } from "../format-codec.js"

/**
 * Options for the YAML codec.
 */
export interface YamlCodecOptions {
	readonly indent?: number
	readonly lineWidth?: number
}

/**
 * Creates a YAML codec with configurable indentation and line width.
 *
 * @param options - Optional configuration for YAML serialization
 * @param options.indent - Number of spaces for indentation (default: 2)
 * @param options.lineWidth - Maximum line width before wrapping (default: 80)
 * @returns A FormatCodec for YAML serialization
 *
 * @example
 * ```typescript
 * const codec = yamlCodec({ indent: 4, lineWidth: 120 })
 * const layer = makeSerializerLayer([codec])
 * ```
 */
export const yamlCodec = (options?: YamlCodecOptions): FormatCodec => {
	const indent = options?.indent ?? 2
	const lineWidth = options?.lineWidth ?? 80

	return {
		name: "yaml",
		extensions: ["yaml", "yml"],
		encode: (data: unknown, formatOptions?: FormatOptions): string => {
			const actualIndent = formatOptions?.indent ?? indent
			return YAML.stringify(data, { indent: actualIndent, lineWidth })
		},
		decode: (raw: string): unknown => {
			return YAML.parse(raw)
		},
	}
}
