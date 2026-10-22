import YAML from "yaml";
import type { FormatCodec, FormatOptions } from "../format-codec.js";

/**
 * Options for the YAML codec.
 */
export interface YamlCodecOptions {
	readonly indent?: number;
	readonly lineWidth?: number;
}

// A line that ends a block scalar header (`|`, `>-`, `|2-`, ...).
const BLOCK_SCALAR_HEADER = /[|>][1-9+-]*$/m;

const sameData = (left: unknown, right: unknown): boolean => {
	if (left === right) return true;
	if (typeof left === "number" && typeof right === "number") {
		return Number.isNaN(left) && Number.isNaN(right);
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => sameData(value, right[index]))
		);
	}
	if (
		typeof left !== "object" ||
		typeof right !== "object" ||
		left === null ||
		right === null
	) {
		return false;
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord);
	return (
		leftKeys.length === Object.keys(rightRecord).length &&
		leftKeys.every(
			(key) =>
				Object.hasOwn(rightRecord, key) &&
				sameData(leftRecord[key], rightRecord[key]),
		)
	);
};

/**
 * Creates a YAML codec with configurable indentation and line width.
 *
 * The `yaml` package can write block scalars that read back as another
 * string: a wrong indentation indicator (`|2-`) at indent 4 when a line
 * starts with spaces, and a folded scalar with an extra leading line break
 * at narrow widths. When the output has a block scalar, the codec decodes it
 * and, if it does not read back, writes quoted, unfolded scalars instead.
 * Output without block scalars is not checked and does not change.
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
	const indent = options?.indent ?? 2;
	const lineWidth = options?.lineWidth ?? 80;

	return {
		name: "yaml",
		extensions: ["yaml", "yml"],
		encode: (data: unknown, formatOptions?: FormatOptions): string => {
			const actualIndent = formatOptions?.indent ?? indent;
			const text = YAML.stringify(data, { indent: actualIndent, lineWidth });
			if (!BLOCK_SCALAR_HEADER.test(text) || sameData(YAML.parse(text), data)) {
				return text;
			}
			const quoted = YAML.stringify(data, {
				indent: actualIndent,
				lineWidth: 0,
				blockQuote: false,
			});
			// Data that no YAML text reproduces exactly (for example a Date)
			// keeps the original output.
			return sameData(YAML.parse(quoted), data) ? quoted : text;
		},
		decode: (raw: string): unknown => {
			return YAML.parse(raw);
		},
	};
};
