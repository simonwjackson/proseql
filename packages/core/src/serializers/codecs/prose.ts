import type { FormatCodec, FormatOptions } from "../format-codec.js";

// ============================================================================
// Types
// ============================================================================

/**
 * A segment in a compiled prose template.
 * Either a literal text segment or a field placeholder.
 */
export type ProseSegment =
	| { readonly type: "literal"; readonly text: string }
	| { readonly type: "field"; readonly name: string };

/**
 * A compiled template ready for encoding/decoding.
 * Contains the ordered list of segments and extracted field names.
 */
export interface CompiledTemplate {
	readonly segments: ReadonlyArray<ProseSegment>;
	readonly fields: ReadonlyArray<string>;
}

/**
 * Options for creating a prose codec.
 */
export interface ProseCodecOptions {
	/** The headline template with {fieldName} placeholders */
	readonly template: string;
	/** Optional overflow templates for additional fields on indented lines */
	readonly overflow?: ReadonlyArray<string>;
}
