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

// ============================================================================
// Template Compiler
// ============================================================================

/**
 * Compiles a template string into an ordered list of segments.
 * Parses `{fieldName}` placeholders and literal text into segments.
 *
 * @param template - The template string with {fieldName} placeholders
 * @returns A CompiledTemplate with segments and field names
 *
 * @example
 * ```typescript
 * const compiled = compileTemplate('#{id} "{title}" by {author}')
 * // compiled.segments = [
 * //   { type: "literal", text: "#" },
 * //   { type: "field", name: "id" },
 * //   { type: "literal", text: ' "' },
 * //   { type: "field", name: "title" },
 * //   { type: "literal", text: '" by ' },
 * //   { type: "field", name: "author" },
 * // ]
 * // compiled.fields = ["id", "title", "author"]
 * ```
 */
export const compileTemplate = (template: string): CompiledTemplate => {
	const segments: Array<ProseSegment> = [];
	const fields: Array<string> = [];

	let pos = 0;
	let literalStart = 0;
	let lastSegmentWasField = false;

	while (pos < template.length) {
		const char = template[pos];

		if (char === "{") {
			// Emit any accumulated literal text before this field
			if (pos > literalStart) {
				segments.push({ type: "literal", text: template.slice(literalStart, pos) });
				lastSegmentWasField = false;
			}

			// Check for adjacent fields with no literal separator
			if (lastSegmentWasField) {
				throw new Error(
					`Adjacent fields with no literal separator at position ${pos}: fields must be separated by literal text`
				);
			}

			// Find the closing brace
			const closePos = template.indexOf("}", pos + 1);
			if (closePos === -1) {
				throw new Error(
					`Unclosed brace in template at position ${pos}: "${template.slice(pos)}"`
				);
			}

			// Extract the field name
			const fieldName = template.slice(pos + 1, closePos);
			if (fieldName.length === 0) {
				throw new Error(`Empty field name in template at position ${pos}`);
			}

			segments.push({ type: "field", name: fieldName });
			fields.push(fieldName);
			lastSegmentWasField = true;

			// Move past the closing brace
			pos = closePos + 1;
			literalStart = pos;
		} else {
			pos++;
		}
	}

	// Emit any trailing literal text
	if (pos > literalStart) {
		segments.push({ type: "literal", text: template.slice(literalStart, pos) });
	}

	return { segments, fields };
};

/**
 * Compiles an array of overflow template strings into CompiledTemplates.
 * Each overflow template follows the same {fieldName} placeholder syntax as the headline template.
 *
 * @param overflow - Optional array of overflow template strings
 * @returns An array of CompiledTemplate objects, or empty array if no overflow templates
 *
 * @example
 * ```typescript
 * const compiled = compileOverflowTemplates(['tagged {tags}', '~ {description}'])
 * // compiled[0].segments = [
 * //   { type: "literal", text: "tagged " },
 * //   { type: "field", name: "tags" },
 * // ]
 * // compiled[0].fields = ["tags"]
 * // compiled[1].segments = [
 * //   { type: "literal", text: "~ " },
 * //   { type: "field", name: "description" },
 * // ]
 * // compiled[1].fields = ["description"]
 * ```
 */
export const compileOverflowTemplates = (
	overflow: ReadonlyArray<string> | undefined
): ReadonlyArray<CompiledTemplate> => {
	if (!overflow || overflow.length === 0) {
		return [];
	}

	return overflow.map((template, index) => {
		try {
			return compileTemplate(template);
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(
					`Error in overflow template at index ${index}: ${error.message}`
				);
			}
			throw error;
		}
	});
};
