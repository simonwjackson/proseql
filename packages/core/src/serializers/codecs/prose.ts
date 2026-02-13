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

// ============================================================================
// Value Serialization
// ============================================================================

/**
 * Serializes a value to its prose format string representation.
 *
 * Type mapping:
 * - null/undefined → `~`
 * - boolean → `true` / `false`
 * - number → digit characters (e.g., `42`, `-3.14`)
 * - array → `[a, b, c]` with element quoting for `,` and `]`
 * - string → bare text (quoting for delimiters handled by encodeHeadline)
 *
 * @param value - The value to serialize
 * @returns The serialized string representation
 *
 * @example
 * ```typescript
 * serializeValue(42)           // "42"
 * serializeValue(true)         // "true"
 * serializeValue(null)         // "~"
 * serializeValue("hello")      // "hello"
 * serializeValue(["a", "b"])   // "[a, b]"
 * ```
 */
export const serializeValue = (value: unknown): string => {
	// null or undefined → tilde
	if (value === null || value === undefined) {
		return "~";
	}

	// boolean → true/false
	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}

	// number → digit representation
	if (typeof value === "number") {
		return String(value);
	}

	// array → [element, element, ...]
	if (Array.isArray(value)) {
		const elements = value.map((element) => {
			const serialized = serializeValue(element);
			// Quote elements that contain comma or closing bracket
			if (serialized.includes(",") || serialized.includes("]")) {
				return `"${serialized.replace(/"/g, '\\"')}"`;
			}
			return serialized;
		});
		return `[${elements.join(", ")}]`;
	}

	// string (or anything else) → bare text
	return String(value);
};

/**
 * Deserializes a prose format string back to its typed value.
 * Uses heuristic type detection:
 * - Numbers: matches `/^-?\d+(\.\d+)?$/`
 * - Booleans: exact match `true` or `false`
 * - Null: exact match `~`
 * - Arrays: starts with `[`, ends with `]`
 * - Strings: default (anything not matching above)
 *
 * @param text - The serialized string to deserialize
 * @returns The deserialized value with its inferred type
 *
 * @example
 * ```typescript
 * deserializeValue("42")           // 42 (number)
 * deserializeValue("-3.14")        // -3.14 (number)
 * deserializeValue("true")         // true (boolean)
 * deserializeValue("false")        // false (boolean)
 * deserializeValue("~")            // null
 * deserializeValue("[a, b, c]")    // ["a", "b", "c"] (array)
 * deserializeValue("hello")        // "hello" (string)
 * ```
 */
export const deserializeValue = (text: string): unknown => {
	// null → tilde
	if (text === "~") {
		return null;
	}

	// boolean → true/false exact match
	if (text === "true") {
		return true;
	}
	if (text === "false") {
		return false;
	}

	// number → matches /^-?\d+(\.\d+)?$/
	const numberRegex = /^-?\d+(\.\d+)?$/;
	if (numberRegex.test(text)) {
		return Number(text);
	}

	// array → starts with [, ends with ]
	if (text.startsWith("[") && text.endsWith("]")) {
		// Extract inner content and parse array elements
		// Task 2.4 will implement full element parsing with quoting support
		// For now, do a simple split respecting quoted elements
		const inner = text.slice(1, -1).trim();

		// Handle empty array
		if (inner === "") {
			return [];
		}

		// Parse array elements (basic version, full implementation in task 2.4)
		return parseArrayElements(inner);
	}

	// default → string
	return text;
};

/**
 * Parses array element string into an array of deserialized values.
 * Handles quoted elements that may contain commas or brackets.
 *
 * @param inner - The content between [ and ]
 * @returns Array of deserialized values
 */
const parseArrayElements = (inner: string): unknown[] => {
	const elements: unknown[] = [];
	let pos = 0;
	let elementStart = 0;
	let inQuotes = false;

	while (pos <= inner.length) {
		if (pos === inner.length || (!inQuotes && inner[pos] === ",")) {
			// Extract and trim the element
			const element = inner.slice(elementStart, pos).trim();

			if (element !== "") {
				// Handle quoted elements
				if (element.startsWith('"') && element.endsWith('"')) {
					// Remove quotes and unescape
					const unquoted = element.slice(1, -1).replace(/\\"/g, '"');
					elements.push(deserializeValue(unquoted));
				} else {
					elements.push(deserializeValue(element));
				}
			}

			elementStart = pos + 1;
			pos++;
			continue;
		}

		if (inner[pos] === '"' && (pos === 0 || inner[pos - 1] !== "\\")) {
			// Check if this is at the start of an element (accounting for whitespace)
			const elementSoFar = inner.slice(elementStart, pos).trim();
			if (elementSoFar === "" || inQuotes) {
				inQuotes = !inQuotes;
			}
		}

		pos++;
	}

	return elements;
};
