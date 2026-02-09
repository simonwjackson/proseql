import YAML from "yaml"
import { Effect, Layer } from "effect"
import { SerializationError, UnsupportedFormatError } from "../errors/storage-errors.js"
import { SerializerRegistry, type SerializerRegistryShape } from "./serializer-service.js"
import type { Serializer } from "./types.js"
import { SerializationError as LegacySerializationError } from "./types.js"

// ============================================================================
// YAML serializer options
// ============================================================================

export interface YamlSerializerOptions {
	readonly indent?: number
	readonly lineWidth?: number
}

// ============================================================================
// Effect-based serialize / deserialize
// ============================================================================

export const serializeYaml = (
	data: unknown,
	options: YamlSerializerOptions = {},
): Effect.Effect<string, SerializationError> => {
	const { indent = 2, lineWidth = 80 } = options
	return Effect.try({
		try: () => YAML.stringify(data, { indent, lineWidth }),
		catch: (error) =>
			new SerializationError({
				format: "yaml",
				message: `Failed to serialize data to YAML: ${error instanceof Error ? error.message : "Unknown error"}`,
				cause: error,
			}),
	})
}

export const deserializeYaml = (
	content: string,
	_options: YamlSerializerOptions = {},
): Effect.Effect<unknown, SerializationError> =>
	Effect.try({
		try: () => YAML.parse(content) as unknown,
		catch: (error) =>
			new SerializationError({
				format: "yaml",
				message: `Failed to deserialize YAML data: ${error instanceof Error ? error.message : "Unknown error"}`,
				cause: error,
			}),
	})

// ============================================================================
// SerializerRegistry implementation for YAML
// ============================================================================

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(["yaml", "yml"])

const makeYamlSerializerRegistry = (
	options: YamlSerializerOptions = {},
): SerializerRegistryShape => ({
	serialize: (data, extension) =>
		SUPPORTED_EXTENSIONS.has(extension)
			? serializeYaml(data, options)
			: Effect.fail(
					new UnsupportedFormatError({
						format: extension,
						message: `YAML serializer does not support '.${extension}'`,
					}),
				),

	deserialize: (content, extension) =>
		SUPPORTED_EXTENSIONS.has(extension)
			? deserializeYaml(content, options)
			: Effect.fail(
					new UnsupportedFormatError({
						format: extension,
						message: `YAML serializer does not support '.${extension}'`,
					}),
				),
})

// ============================================================================
// Layer construction
// ============================================================================

export const makeYamlSerializerLayer = (
	options?: YamlSerializerOptions,
): Layer.Layer<SerializerRegistry> =>
	Layer.succeed(SerializerRegistry, makeYamlSerializerRegistry(options))

export const YamlSerializerLayer: Layer.Layer<SerializerRegistry> =
	makeYamlSerializerLayer()

// ============================================================================
// Legacy Serializer interface (pre-Effect migration)
// Retained for backward compatibility with existing persistence code.
// Will be removed when persistence tests are migrated (task 12.8).
// ============================================================================

export function createYamlSerializer(
	options: {
		readonly indent?: number
		readonly lineWidth?: number
	} = {},
): Serializer {
	const { indent = 2, lineWidth = 80 } = options

	return {
		serialize: (data: unknown): string => {
			try {
				return YAML.stringify(data, { indent, lineWidth })
			} catch (error) {
				throw new LegacySerializationError(
					`Failed to serialize data to YAML: ${error instanceof Error ? error.message : "Unknown error"}`,
					error,
					"serialize",
				)
			}
		},

		deserialize: (raw: string | Buffer): unknown => {
			try {
				const yamlString = typeof raw === "string" ? raw : raw.toString("utf8")
				return YAML.parse(yamlString)
			} catch (error) {
				throw new LegacySerializationError(
					`Failed to deserialize YAML data: ${error instanceof Error ? error.message : "Unknown error"}`,
					error,
					"deserialize",
				)
			}
		},

		fileExtensions: ["yaml", "yml"] as const,
	}
}

export const defaultYamlSerializer = createYamlSerializer()

export const compactYamlSerializer = createYamlSerializer({
	indent: 1,
	lineWidth: 120,
})

export const prettyYamlSerializer = createYamlSerializer({
	indent: 4,
	lineWidth: 100,
})
