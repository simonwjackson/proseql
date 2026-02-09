import { pack, unpack } from "msgpackr"
import { Effect, Layer } from "effect"
import { SerializationError, UnsupportedFormatError } from "../errors/storage-errors.js"
import { SerializerRegistry, type SerializerRegistryShape } from "./serializer-service.js"
import type { Serializer } from "./types.js"
import { SerializationError as LegacySerializationError } from "./types.js"

// ============================================================================
// Effect-based serialize / deserialize
// ============================================================================

export const serializeMessagePack = (
	data: unknown,
): Effect.Effect<string, SerializationError> =>
	Effect.try({
		try: () => {
			const buffer: Buffer = pack(data)
			return buffer.toString("base64")
		},
		catch: (error) =>
			new SerializationError({
				format: "msgpack",
				message: `Failed to serialize data to MessagePack: ${error instanceof Error ? error.message : "Unknown error"}`,
				cause: error,
			}),
	})

export const deserializeMessagePack = (
	content: string,
): Effect.Effect<unknown, SerializationError> =>
	Effect.try({
		try: () => {
			const buffer = Buffer.from(content, "base64")
			return unpack(buffer) as unknown
		},
		catch: (error) =>
			new SerializationError({
				format: "msgpack",
				message: `Failed to deserialize MessagePack data: ${error instanceof Error ? error.message : "Unknown error"}`,
				cause: error,
			}),
	})

// ============================================================================
// SerializerRegistry implementation for MessagePack
// ============================================================================

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(["msgpack", "mp"])

const makeMessagePackSerializerRegistry = (): SerializerRegistryShape => ({
	serialize: (data, extension) =>
		SUPPORTED_EXTENSIONS.has(extension)
			? serializeMessagePack(data)
			: Effect.fail(
					new UnsupportedFormatError({
						format: extension,
						message: `MessagePack serializer does not support '.${extension}'`,
					}),
				),

	deserialize: (content, extension) =>
		SUPPORTED_EXTENSIONS.has(extension)
			? deserializeMessagePack(content)
			: Effect.fail(
					new UnsupportedFormatError({
						format: extension,
						message: `MessagePack serializer does not support '.${extension}'`,
					}),
				),
})

// ============================================================================
// Layer construction
// ============================================================================

export const MessagePackSerializerLayer: Layer.Layer<SerializerRegistry> =
	Layer.succeed(SerializerRegistry, makeMessagePackSerializerRegistry())

// ============================================================================
// Legacy Serializer interface (pre-Effect migration)
// Retained for backward compatibility with existing persistence code.
// Will be removed when persistence tests are migrated (task 12.8).
// ============================================================================

export function createMessagePackSerializer(): Serializer {
	return {
		serialize: (data: unknown): Buffer => {
			try {
				return pack(data) as Buffer
			} catch (error) {
				throw new LegacySerializationError(
					`Failed to serialize data to MessagePack: ${error instanceof Error ? error.message : "Unknown error"}`,
					error,
					"serialize",
				)
			}
		},

		deserialize: (raw: string | Buffer): unknown => {
			try {
				const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "binary")
				return unpack(buffer)
			} catch (error) {
				throw new LegacySerializationError(
					`Failed to deserialize MessagePack data: ${error instanceof Error ? error.message : "Unknown error"}`,
					error,
					"deserialize",
				)
			}
		},

		fileExtensions: ["msgpack", "mp"] as const,
	}
}

export const defaultMessagePackSerializer = createMessagePackSerializer()
