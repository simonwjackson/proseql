/**
 * Standalone utility for reading and decoding a single document from a file.
 *
 * Unlike collection-level loading, this function has no `{ id: string }` constraint —
 * it works with any Schema. Useful for one-off config reads, CLI tools, etc.
 */

import { Effect, Schema } from "effect";
import { ValidationError } from "../errors/crud-errors.js";
import {
	type SerializationError,
	StorageError,
	type UnsupportedFormatError,
} from "../errors/storage-errors.js";
import { SerializerRegistry } from "../serializers/serializer-service.js";
import { getFileExtension } from "../utils/path.js";
import { StorageAdapter } from "./storage-service.js";

/**
 * Options for readDocument.
 */
export interface ReadDocumentOptions {
	/**
	 * Explicit serialization format override.
	 * When provided, this format is used instead of inferring from the file extension.
	 */
	readonly format?: string;
}

/**
 * Read a file, deserialize it, and decode through a Schema.
 *
 * Flow:
 * 1. Resolve format (option or file extension)
 * 2. Read raw content via StorageAdapter
 * 3. Deserialize via SerializerRegistry
 * 4. Decode through Schema.decodeUnknown
 *
 * @param filePath - Path to the file to read
 * @param schema - Effect Schema to decode the document through
 * @param options - Optional configuration (format override)
 */
export const readDocument = <A, I, R>(
	filePath: string,
	schema: Schema.Schema<A, I, R>,
	options?: ReadDocumentOptions,
): Effect.Effect<
	A,
	StorageError | SerializationError | UnsupportedFormatError | ValidationError,
	StorageAdapter | SerializerRegistry | R
> =>
	Effect.gen(function* () {
		const storage = yield* StorageAdapter;
		const serializer = yield* SerializerRegistry;

		// Resolve format
		const ext = options?.format ?? getFileExtension(filePath);
		if (ext === "") {
			return yield* Effect.fail(
				new StorageError({
					path: filePath,
					operation: "read",
					message: `Cannot determine file format: no extension in '${filePath}'`,
				}),
			);
		}

		// Read and deserialize
		const raw = yield* storage.read(filePath);
		const parsed = yield* serializer.deserialize(raw, ext);

		// Decode through schema
		const decode = Schema.decodeUnknown(schema);
		const decoded = yield* decode(parsed).pipe(
			Effect.mapError(
				(parseError) =>
					new ValidationError({
						message: `Failed to decode document '${filePath}': ${parseError.message}`,
						issues: [
							{
								field: filePath,
								message: parseError.message,
							},
						],
					}),
			),
		);

		return decoded;
	});
