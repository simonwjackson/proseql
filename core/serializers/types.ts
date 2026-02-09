/**
 * Core serializer type definition for the persistence system.
 * Provides a pluggable interface for different data formats.
 */

/**
 * Generic serializer interface that can handle any data type.
 * Serializers must be able to convert data to/from string or Buffer format.
 *
 * @template T - The type of data being serialized
 */
export type Serializer<T = unknown> = {
	/**
	 * Convert data to a serialized format (string or Buffer)
	 *
	 * @param data - The data to serialize
	 * @returns Serialized data as string or Buffer
	 */
	serialize: (data: T) => string | Buffer;

	/**
	 * Convert serialized data back to its original format
	 *
	 * @param raw - The serialized data (string or Buffer)
	 * @returns The deserialized data
	 */
	deserialize: (raw: string | Buffer) => T;

	/**
	 * Array of file extensions (without dots) that this serializer supports.
	 * Used for automatic serializer selection based on file extension.
	 *
	 * Examples: ['json'], ['yaml', 'yml'], ['msgpack', 'mp']
	 */
	fileExtensions: readonly string[];
};

/**
 * Registry of available serializers mapped by their supported file extensions.
 * This allows automatic serializer selection based on file path.
 */
export type SerializerRegistry = {
	readonly [extension: string]: Serializer;
};

/**
 * Error thrown when serialization/deserialization fails
 */
export class SerializationError extends Error {
	constructor(
		message: string,
		public readonly cause?: unknown,
		public readonly operation?: "serialize" | "deserialize",
	) {
		super(message);
		this.name = "SerializationError";
	}
}

/**
 * Error thrown when no serializer is found for a given file extension
 */
export class UnsupportedFormatError extends Error {
	constructor(
		public readonly extension: string,
		public readonly availableExtensions: readonly string[],
	) {
		super(
			`No serializer found for extension '.${extension}'. Available: ${availableExtensions.map((ext) => `.${ext}`).join(", ")}`,
		);
		this.name = "UnsupportedFormatError";
	}
}
