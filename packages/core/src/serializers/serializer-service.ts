import { Context, Effect } from "effect";
import type {
	SerializationError,
	UnsupportedFormatError,
} from "../errors/storage-errors.js";

// ============================================================================
// SerializerRegistry Effect Service
// ============================================================================

export interface SerializerRegistryShape {
	readonly serialize: (
		data: unknown,
		extension: string,
	) => Effect.Effect<string, SerializationError | UnsupportedFormatError>;
	readonly deserialize: (
		content: string,
		extension: string,
	) => Effect.Effect<unknown, SerializationError | UnsupportedFormatError>;
	/**
	 * Enumerate the file extensions (without leading dots) the active registry
	 * can decode. Includes any plugin-added extensions, reflecting active-registry
	 * semantics. Order is stable: registration order, de-duplicated.
	 */
	readonly supportedExtensions: () => ReadonlyArray<string>;
}

export const SerializerRegistry =
	Context.Service<SerializerRegistryShape>("SerializerRegistry");
export type SerializerRegistry = SerializerRegistryShape;

/**
 * Product-agnostic accessor for the active registry's supported document
 * extensions. Returns extensions only (no basenames or discovery patterns), so
 * consumers can decide which files a document graph may decode without encoding
 * any consumer-specific policy.
 */
export const getSupportedExtensions: Effect.Effect<
	ReadonlyArray<string>,
	never,
	SerializerRegistry
> = Effect.gen(function* () {
	const registry = yield* SerializerRegistry;
	return registry.supportedExtensions();
});
