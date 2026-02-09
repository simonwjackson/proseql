/**
 * YAML serializer implementation for the persistence system.
 * Provides YAML serialization with support for both .yaml and .yml extensions.
 *
 * This implementation provides a mock interface that throws informative errors
 * about missing dependencies. To use YAML serialization in production:
 *
 * 1. Install js-yaml: `npm install js-yaml @types/js-yaml`
 * 2. Replace the mock implementation below with: `import * as yaml from 'js-yaml';`
 * 3. Update the yamlLibrary to use the actual imported library
 */

import type { Serializer } from "./types.js";
import { SerializationError } from "./types.js";

/**
 * Interface matching the js-yaml library API
 */
interface YamlLibrary {
	dump: (
		obj: unknown,
		options?: { indent?: number; lineWidth?: number },
	) => string;
	load: (str: string) => unknown;
}

/**
 * Mock YAML library that throws informative errors about missing dependencies.
 * Replace this with actual js-yaml import in production.
 */
const yamlLibrary: YamlLibrary = {
	dump: (): never => {
		throw new Error(
			"YAML serialization requires the js-yaml library. " +
				"Install it with: npm install js-yaml @types/js-yaml",
		);
	},
	load: (): never => {
		throw new Error(
			"YAML deserialization requires the js-yaml library. " +
				"Install it with: npm install js-yaml @types/js-yaml",
		);
	},
};

/**
 * Creates a YAML serializer with configurable formatting options.
 * Supports both .yaml and .yml file extensions.
 *
 * @param options - Configuration options for YAML serialization
 * @returns A YAML serializer instance
 */
export function createYamlSerializer(
	options: {
		/**
		 * Number of spaces to use for indentation (default: 2)
		 */
		readonly indent?: number;

		/**
		 * Maximum line width before wrapping (default: 80)
		 */
		readonly lineWidth?: number;
	} = {},
): Serializer {
	const { indent = 2, lineWidth = 80 } = options;

	return {
		serialize: (data: unknown): string => {
			try {
				return yamlLibrary.dump(data, { indent, lineWidth });
			} catch (error) {
				throw new SerializationError(
					`Failed to serialize data to YAML: ${error instanceof Error ? error.message : "Unknown error"}`,
					error,
					"serialize",
				);
			}
		},

		deserialize: (raw: string | Buffer): unknown => {
			try {
				const yamlString = typeof raw === "string" ? raw : raw.toString("utf8");
				return yamlLibrary.load(yamlString);
			} catch (error) {
				throw new SerializationError(
					`Failed to deserialize YAML data: ${error instanceof Error ? error.message : "Unknown error"}`,
					error,
					"deserialize",
				);
			}
		},

		fileExtensions: ["yaml", "yml"] as const,
	};
}

/**
 * Default YAML serializer instance with standard formatting.
 * Supports both .yaml and .yml extensions.
 */
export const defaultYamlSerializer = createYamlSerializer();

/**
 * Compact YAML serializer instance with minimal formatting.
 * Useful when file size is a concern.
 */
export const compactYamlSerializer = createYamlSerializer({
	indent: 1,
	lineWidth: 120,
});

/**
 * Pretty YAML serializer instance with generous formatting.
 * Useful for human-readable configuration files.
 */
export const prettyYamlSerializer = createYamlSerializer({
	indent: 4,
	lineWidth: 100,
});
