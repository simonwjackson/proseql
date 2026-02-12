import type { FormatCodec } from "../format-codec.js";

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
