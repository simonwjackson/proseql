/**
 * MessagePack serializer implementation for the persistence system.
 * Provides binary serialization with excellent performance and compact output.
 * Supports both .msgpack and .mp file extensions.
 *
 * This implementation provides a mock interface that throws informative errors
 * about missing dependencies. To use MessagePack serialization in production:
 *
 * 1. Install msgpackr: `npm install msgpackr`
 * 2. Replace the mock implementation below with: `import { pack, unpack } from 'msgpackr';`
 * 3. Update the msgpackLibrary to use the actual imported functions
 */

import type { Serializer } from "./types.js";
import { SerializationError } from "./types.js";

/**
 * Interface matching the msgpackr library API
 */
interface MessagePackLibrary {
	encode: (obj: unknown) => Buffer;
	decode: (buffer: Buffer) => unknown;
}

/**
 * Mock MessagePack library that throws informative errors about missing dependencies.
 * Replace this with actual msgpackr import in production.
 */
const msgpackLibrary: MessagePackLibrary = {
	encode: (): never => {
		throw new Error(
			"MessagePack serialization requires the msgpackr library. " +
				"Install it with: npm install msgpackr",
		);
	},
	decode: (): never => {
		throw new Error(
			"MessagePack deserialization requires the msgpackr library. " +
				"Install it with: npm install msgpackr",
		);
	},
};

/**
 * Creates a MessagePack serializer for binary data storage.
 * MessagePack provides excellent performance and smaller file sizes compared to JSON.
 * Supports both .msgpack and .mp file extensions.
 *
 * @returns A MessagePack serializer instance
 */
export function createMessagePackSerializer(): Serializer {
	return {
		serialize: (data: unknown): Buffer => {
			try {
				return msgpackLibrary.encode(data);
			} catch (error) {
				throw new SerializationError(
					`Failed to serialize data to MessagePack: ${error instanceof Error ? error.message : "Unknown error"}`,
					error,
					"serialize",
				);
			}
		},

		deserialize: (raw: string | Buffer): unknown => {
			try {
				// MessagePack requires Buffer input, convert string if needed
				const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "binary");
				return msgpackLibrary.decode(buffer);
			} catch (error) {
				throw new SerializationError(
					`Failed to deserialize MessagePack data: ${error instanceof Error ? error.message : "Unknown error"}`,
					error,
					"deserialize",
				);
			}
		},

		fileExtensions: ["msgpack", "mp"] as const,
	};
}

/**
 * Default MessagePack serializer instance.
 * Provides fast binary serialization for high-performance applications.
 */
export const defaultMessagePackSerializer = createMessagePackSerializer();

/**
 * Type guard to check if data is suitable for MessagePack serialization.
 * MessagePack works best with plain objects, arrays, and primitive values.
 *
 * @param data - The data to check
 * @returns True if the data is suitable for MessagePack serialization
 */
export function isMessagePackCompatible(data: unknown): boolean {
	if (data === null || data === undefined) {
		return true;
	}

	const type = typeof data;
	if (type === "string" || type === "number" || type === "boolean") {
		return true;
	}

	if (Array.isArray(data)) {
		return data.every(isMessagePackCompatible);
	}

	if (type === "object" && data.constructor === Object) {
		return Object.values(data as Record<string, unknown>).every(
			isMessagePackCompatible,
		);
	}

	// Functions, symbols, undefined in objects, etc. are not compatible
	return false;
}

/**
 * Sanitize data for MessagePack serialization by removing incompatible values.
 * This is useful when working with data that might contain functions or other
 * non-serializable values.
 *
 * @param data - The data to sanitize
 * @returns Sanitized data safe for MessagePack serialization
 */
export function sanitizeForMessagePack(data: unknown): unknown {
	if (data === null || data === undefined) {
		return data;
	}

	const type = typeof data;
	if (type === "string" || type === "number" || type === "boolean") {
		return data;
	}

	if (Array.isArray(data)) {
		return data
			.map(sanitizeForMessagePack)
			.filter((item) => item !== undefined);
	}

	if (type === "object" && data.constructor === Object) {
		const sanitized: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(
			data as Record<string, unknown>,
		)) {
			const sanitizedValue = sanitizeForMessagePack(value);
			if (sanitizedValue !== undefined) {
				sanitized[key] = sanitizedValue;
			}
		}
		return sanitized;
	}

	// Return undefined for incompatible types (will be filtered out)
	return undefined;
}
