// ============================================================================
// FormatCodec — Minimal plugin point for serialization formats
// ============================================================================

/**
 * Options for encoding data.
 */
export interface FormatOptions {
	readonly indent?: number
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
	readonly name: string
	readonly extensions: ReadonlyArray<string>
	readonly encode: (data: unknown, options?: FormatOptions) => string
	readonly decode: (raw: string) => unknown
}
