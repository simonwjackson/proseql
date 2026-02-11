import * as TOML from "smol-toml";
import type { FormatCodec } from "../format-codec.js";

/**
 * Recursively strips null and undefined values from an object for TOML compatibility.
 *
 * TOML has no null type, so null values must be removed before serialization.
 * - null values → key omitted
 * - undefined values → key omitted
 * - Nested objects → recursed
 * - Arrays → null/undefined elements removed
 * - All other values → preserved
 */
const stripNulls = (data: unknown): unknown => {
	if (data === null || data === undefined) {
		return undefined;
	}

	if (Array.isArray(data)) {
		return data
			.filter((item) => item !== null && item !== undefined)
			.map(stripNulls);
	}

	if (typeof data === "object" && data !== null) {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(data)) {
			const stripped = stripNulls(value);
			if (stripped !== undefined) {
				result[key] = stripped;
			}
		}
		return result;
	}

	return data;
};

/**
 * Creates a TOML codec.
 *
 * TOML has no null type, so null values are recursively stripped on encode.
 * Missing keys naturally become undefined on decode.
 *
 * @returns A FormatCodec for TOML serialization
 *
 * @example
 * ```typescript
 * const codec = tomlCodec()
 * const layer = makeSerializerLayer([codec])
 * ```
 *
 * @remarks
 * - Null/undefined values are stripped on encode (TOML has no null)
 * - TOML dates are returned as Date objects by smol-toml
 * - TOML arrays must be homogeneous; mixed-type arrays will throw on encode
 * - Schemas with required nullable fields (NullOr) won't round-trip through TOML
 */
export const tomlCodec = (): FormatCodec => {
	return {
		name: "toml",
		extensions: ["toml"],
		encode: (data: unknown): string => {
			const stripped = stripNulls(data);
			return TOML.stringify(stripped as Record<string, unknown>);
		},
		decode: (raw: string): unknown => {
			return TOML.parse(raw);
		},
	};
};
