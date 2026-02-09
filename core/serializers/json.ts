import { Effect, Layer } from "effect"
import { SerializationError, UnsupportedFormatError } from "../errors/storage-errors.js"
import { SerializerRegistry, type SerializerRegistryShape } from "./serializer-service.js"
import type { Serializer } from "./types.js"
import { SerializationError as LegacySerializationError } from "./types.js"

// ============================================================================
// JSON serializer options
// ============================================================================

export interface JsonSerializerOptions {
	readonly indent?: number
	readonly replacer?: (key: string, value: unknown) => unknown
	readonly reviver?: (key: string, value: unknown) => unknown
}

// ============================================================================
// Effect-based serialize / deserialize
// ============================================================================

export const serializeJson = (
	data: unknown,
	options: JsonSerializerOptions = {},
): Effect.Effect<string, SerializationError> => {
	const { indent = 2, replacer } = options
	return Effect.try({
		try: () => JSON.stringify(data, replacer ?? undefined, indent),
		catch: (error) =>
			new SerializationError({
				format: "json",
				message: `Failed to serialize data to JSON: ${error instanceof Error ? error.message : "Unknown error"}`,
				cause: error,
			}),
	})
}

export const deserializeJson = (
	content: string,
	options: JsonSerializerOptions = {},
): Effect.Effect<unknown, SerializationError> => {
	const { reviver } = options
	return Effect.try({
		try: () => JSON.parse(content, reviver ?? undefined) as unknown,
		catch: (error) =>
			new SerializationError({
				format: "json",
				message: `Failed to deserialize JSON data: ${error instanceof Error ? error.message : "Unknown error"}`,
				cause: error,
			}),
	})
}

// ============================================================================
// SerializerRegistry implementation for JSON
// ============================================================================

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(["json"])

const makeJsonSerializerRegistry = (
	options: JsonSerializerOptions = {},
): SerializerRegistryShape => ({
	serialize: (data, extension) =>
		SUPPORTED_EXTENSIONS.has(extension)
			? serializeJson(data, options)
			: Effect.fail(
					new UnsupportedFormatError({
						format: extension,
						message: `JSON serializer does not support '.${extension}'`,
					}),
				),

	deserialize: (content, extension) =>
		SUPPORTED_EXTENSIONS.has(extension)
			? deserializeJson(content, options)
			: Effect.fail(
					new UnsupportedFormatError({
						format: extension,
						message: `JSON serializer does not support '.${extension}'`,
					}),
				),
})

// ============================================================================
// Layer construction
// ============================================================================

export const makeJsonSerializerLayer = (
	options?: JsonSerializerOptions,
): Layer.Layer<SerializerRegistry> =>
	Layer.succeed(SerializerRegistry, makeJsonSerializerRegistry(options))

export const JsonSerializerLayer: Layer.Layer<SerializerRegistry> =
	makeJsonSerializerLayer()

// ============================================================================
// Legacy Serializer interface (pre-Effect migration)
// Retained for backward compatibility with existing persistence code.
// Will be removed when persistence tests are migrated (task 12.8).
// ============================================================================

export function createJsonSerializer(
	options: {
		readonly indent?: number
		readonly replacer?: (key: string, value: unknown) => unknown
		readonly reviver?: (key: string, value: unknown) => unknown
	} = {},
): Serializer {
	const { indent = 2, replacer, reviver } = options

	return {
		serialize: (data: unknown): string => {
			try {
				return JSON.stringify(data, replacer ?? undefined, indent)
			} catch (error) {
				throw new LegacySerializationError(
					`Failed to serialize data to JSON: ${error instanceof Error ? error.message : "Unknown error"}`,
					error,
					"serialize",
				)
			}
		},

		deserialize: (raw: string | Buffer): unknown => {
			try {
				const jsonString = typeof raw === "string" ? raw : raw.toString("utf8")
				return JSON.parse(jsonString, reviver ?? undefined)
			} catch (error) {
				throw new LegacySerializationError(
					`Failed to deserialize JSON data: ${error instanceof Error ? error.message : "Unknown error"}`,
					error,
					"deserialize",
				)
			}
		},

		fileExtensions: ["json"] as const,
	}
}

export const defaultJsonSerializer = createJsonSerializer()

export const compactJsonSerializer = createJsonSerializer({ indent: 0 })
