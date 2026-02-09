/**
 * JSON serializer implementation for the persistence system.
 * Provides JSON serialization with proper formatting and error handling.
 */

import type { Serializer } from "./types.js";
import { SerializationError } from "./types.js";

/**
 * Creates a JSON serializer with configurable formatting options.
 *
 * @param options - Configuration options for JSON serialization
 * @returns A JSON serializer instance
 */
export function createJsonSerializer(
	options: {
		/**
		 * Number of spaces to use for indentation (default: 2)
		 * Set to 0 for compact output
		 */
		readonly indent?: number;

		/**
		 * Custom replacer function for JSON.stringify
		 */
		readonly replacer?: (key: string, value: unknown) => unknown;

		/**
		 * Custom reviver function for JSON.parse
		 */
		readonly reviver?: (key: string, value: unknown) => unknown;
	} = {},
): Serializer {
	const { indent = 2, replacer, reviver } = options;

	return {
		serialize: (data: unknown): string => {
			try {
				return JSON.stringify(data, replacer ?? undefined, indent);
			} catch (error) {
				throw new SerializationError(
					`Failed to serialize data to JSON: ${error instanceof Error ? error.message : "Unknown error"}`,
					error,
					"serialize",
				);
			}
		},

		deserialize: (raw: string | Buffer): unknown => {
			try {
				const jsonString = typeof raw === "string" ? raw : raw.toString("utf8");
				return JSON.parse(jsonString, reviver ?? undefined);
			} catch (error) {
				throw new SerializationError(
					`Failed to deserialize JSON data: ${error instanceof Error ? error.message : "Unknown error"}`,
					error,
					"deserialize",
				);
			}
		},

		fileExtensions: ["json"] as const,
	};
}

/**
 * Default JSON serializer instance with standard formatting (2-space indentation).
 * This is the most commonly used configuration.
 */
export const defaultJsonSerializer = createJsonSerializer();

/**
 * Compact JSON serializer instance with no formatting (for minimal file size).
 * Useful for production environments where file size matters.
 */
export const compactJsonSerializer = createJsonSerializer({ indent: 0 });
