import { encode, decode } from "@toon-format/toon"
import type { FormatCodec, FormatOptions } from "../format-codec.js"

/**
 * Creates a TOON (Token-Oriented Object Notation) codec.
 *
 * TOON is a compact, human-readable encoding of JSON designed for LLM prompts.
 * It provides lossless round-trip conversion with significant token reduction
 * for uniform arrays of objects.
 *
 * @returns A FormatCodec for TOON serialization
 *
 * @example
 * ```typescript
 * const codec = toonCodec()
 * const layer = makeSerializerLayer([codec])
 * ```
 *
 * @see https://toonformat.dev for format specification
 */
export const toonCodec = (): FormatCodec => {
	return {
		name: "toon",
		extensions: ["toon"],
		encode: (data: unknown, _formatOptions?: FormatOptions): string => {
			// TOON encode returns a string representation
			// The FormatOptions (indent) is not applicable to TOON format
			return encode(data)
		},
		decode: (raw: string): unknown => {
			return decode(raw)
		},
	}
}
