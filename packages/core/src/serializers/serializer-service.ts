import { Context, Effect } from "effect"
import type { SerializationError, UnsupportedFormatError } from "../errors/storage-errors.js"

// ============================================================================
// SerializerRegistry Effect Service
// ============================================================================

export interface SerializerRegistryShape {
	readonly serialize: (
		data: unknown,
		extension: string,
	) => Effect.Effect<string, SerializationError | UnsupportedFormatError>
	readonly deserialize: (
		content: string,
		extension: string,
	) => Effect.Effect<unknown, SerializationError | UnsupportedFormatError>
}

export class SerializerRegistry extends Context.Tag("SerializerRegistry")<
	SerializerRegistry,
	SerializerRegistryShape
>() {}
