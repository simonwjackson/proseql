import { Effect, Layer } from "effect";
import {
	SerializationError,
	UnsupportedFormatError,
} from "../errors/storage-errors.js";
import {
	SerializerRegistry,
	type SerializerRegistryShape,
} from "./serializer-service.js";

// ============================================================================
// FormatCodec — Minimal plugin point for serialization formats
// ============================================================================

/**
 * Options for encoding data.
 */
export interface FormatOptions {
	readonly indent?: number;
}

/**
 * A FormatCodec defines a serialization format with:
 * - A human-readable name (e.g., "json", "yaml", "toml")
 * - Supported file extensions without dots (e.g., ["yaml", "yml"])
 * - Synchronous encode/decode functions that throw on failure
 *
 * The compositor (makeSerializerLayer) wraps these in Effect.try
 * with proper error tagging.
 */
export interface FormatCodec {
	readonly name: string;
	readonly extensions: ReadonlyArray<string>;
	readonly encode: (data: unknown, options?: FormatOptions) => string;
	readonly decode: (raw: string) => unknown;
}

// ============================================================================
// makeSerializerLayer — Compositor for building SerializerRegistry from codecs
// ============================================================================

/**
 * Creates a SerializerRegistry Layer from an array of FormatCodec instances.
 *
 * The compositor:
 * 1. Builds an extension → codec lookup map (O(1) dispatch)
 * 2. Wraps encode/decode in Effect.try with SerializationError
 * 3. Produces UnsupportedFormatError for unknown extensions
 * 4. Logs console.warn on duplicate extensions (last wins)
 *
 * @param codecs - Base codecs to register
 * @param pluginCodecs - Optional plugin codecs to append after base codecs (can override base codecs for the same extension)
 */
export const makeSerializerLayer = (
	codecs: ReadonlyArray<FormatCodec>,
	pluginCodecs?: ReadonlyArray<FormatCodec>,
): Layer.Layer<SerializerRegistry> => {
	// Merge base codecs with plugin codecs (plugin codecs come last, can override)
	const allCodecs = pluginCodecs
		? [...codecs, ...pluginCodecs]
		: codecs;

	// Build extension → codec lookup map
	const extensionMap = new Map<string, FormatCodec>();
	for (const codec of allCodecs) {
		for (const ext of codec.extensions) {
			if (extensionMap.has(ext)) {
				const existing = extensionMap.get(ext);
				console.warn(
					`Duplicate extension '.${ext}': '${existing?.name}' overwritten by '${codec.name}'`,
				);
			}
			extensionMap.set(ext, codec);
		}
	}

	// Collect all supported extensions for error messages
	const supportedExtensions = Array.from(extensionMap.keys())
		.map((ext) => `.${ext}`)
		.join(", ");

	const registry: SerializerRegistryShape = {
		serialize: (data, extension) => {
			const codec = extensionMap.get(extension);
			if (!codec) {
				return Effect.fail(
					new UnsupportedFormatError({
						format: extension,
						message:
							supportedExtensions.length > 0
								? `Unsupported format '.${extension}'. Available formats: ${supportedExtensions}`
								: `Unsupported format '.${extension}'. No formats registered.`,
					}),
				);
			}

			return Effect.try({
				try: () => codec.encode(data),
				catch: (error) =>
					new SerializationError({
						format: codec.name,
						message: `Failed to serialize data to ${codec.name}: ${error instanceof Error ? error.message : "Unknown error"}`,
						cause: error,
					}),
			});
		},

		deserialize: (content, extension) => {
			const codec = extensionMap.get(extension);
			if (!codec) {
				return Effect.fail(
					new UnsupportedFormatError({
						format: extension,
						message:
							supportedExtensions.length > 0
								? `Unsupported format '.${extension}'. Available formats: ${supportedExtensions}`
								: `Unsupported format '.${extension}'. No formats registered.`,
					}),
				);
			}

			return Effect.try({
				try: () => codec.decode(content),
				catch: (error) =>
					new SerializationError({
						format: codec.name,
						message: `Failed to deserialize ${codec.name} data: ${error instanceof Error ? error.message : "Unknown error"}`,
						cause: error,
					}),
			});
		},
	};

	return Layer.succeed(SerializerRegistry, registry);
};
