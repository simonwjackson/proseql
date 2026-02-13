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
			// Quote elements that contain comma, closing bracket, or double quote
			if (
				serialized.includes(",") ||
				serialized.includes("]") ||
				serialized.includes('"')
			) {
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

// ============================================================================
// Headline Encoder
// ============================================================================

/**
 * Quotes a value for embedding in a headline.
 * Wraps the value in double quotes and escapes any inner double quotes.
 *
 * @param value - The serialized value to quote
 * @returns The quoted value with escaped inner quotes
 */
const quoteValue = (value: string): string => {
	return `"${value.replace(/"/g, '\\"')}"`;
};

/**
 * Encodes a record into a headline string using a compiled template.
 * Substitutes field values into the template, emitting literals verbatim.
 * For non-last fields, if the serialized value contains the next literal
 * delimiter, the value is quoted to prevent parsing ambiguity.
 *
 * @param record - The record object with field values
 * @param template - The compiled template with segments and fields
 * @returns The encoded headline string
 *
 * @example
 * ```typescript
 * const template = compileTemplate('#{id} "{title}" by {author}')
 * const record = { id: "1", title: "Dune", author: "Frank Herbert" }
 * encodeHeadline(record, template)
 * // → '#1 "Dune" by Frank Herbert'
 *
 * // When value contains the next delimiter:
 * const record2 = { id: "1", title: 'Say "hello"', author: "Test" }
 * encodeHeadline(record2, template)
 * // → '#1 "Say \"hello\"" by Test'
 * ```
 */
export const encodeHeadline = (
	record: Record<string, unknown>,
	template: CompiledTemplate
): string => {
	let result = "";
	const { segments } = template;

	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];

		if (segment.type === "literal") {
			result += segment.text;
		} else {
			// Field segment - serialize the value
			const value = record[segment.name];
			const serialized = serializeValue(value);

			// Find the next literal after this field (if any)
			const nextLiteral = findNextLiteral(segments, i);

			// If this is not the last field (has a subsequent literal delimiter)
			// and the serialized value contains that delimiter, quote it
			if (nextLiteral !== null && serialized.includes(nextLiteral)) {
				result += quoteValue(serialized);
			} else {
				result += serialized;
			}
		}
	}

	return result;
};

/**
 * Finds the next literal text after a given segment index.
 * Returns null if there is no subsequent literal (meaning this is the last field).
 *
 * @param segments - The template segments
 * @param currentIndex - The current segment index
 * @returns The next literal text, or null if none exists
 */
const findNextLiteral = (
	segments: ReadonlyArray<ProseSegment>,
	currentIndex: number
): string | null => {
	for (let i = currentIndex + 1; i < segments.length; i++) {
		if (segments[i].type === "literal") {
			return (segments[i] as { readonly type: "literal"; readonly text: string }).text;
		}
	}
	return null;
};

// ============================================================================
// Headline Decoder
// ============================================================================

/**
 * Decodes a headline string back to a record using a compiled template.
 * Performs a left-to-right scan matching literals and capturing field text between them.
 * Returns null if the line doesn't match the template structure.
 *
 * @param line - The headline string to decode
 * @param template - The compiled template with segments and fields
 * @returns The decoded record object, or null if the line doesn't match
 *
 * @example
 * ```typescript
 * const template = compileTemplate('#{id} "{title}" by {author}')
 * decodeHeadline('#1 "Dune" by Frank Herbert', template)
 * // → { id: "1", title: "Dune", author: "Frank Herbert" }
 *
 * decodeHeadline('This does not match', template)
 * // → null
 * ```
 */
export const decodeHeadline = (
	line: string,
	template: CompiledTemplate
): Record<string, unknown> | null => {
	const { segments } = template;
	const result: Record<string, unknown> = {};
	let pos = 0;

	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];

		if (segment.type === "literal") {
			// Check if the literal matches at the current position
			if (!line.startsWith(segment.text, pos)) {
				return null; // No match
			}
			pos += segment.text.length;
		} else {
			// Field segment - capture text until the next literal (or end of line)
			const nextLiteralText = findNextLiteralText(segments, i);

			let fieldValue: string;

			if (nextLiteralText === null) {
				// This is the last field - greedy capture to end of line
				fieldValue = line.slice(pos);
				pos = line.length;
			} else {
				// Find the next literal delimiter, respecting quoted values
				const captureResult = captureFieldValue(line, pos, nextLiteralText);

				if (captureResult === null) {
					return null; // Delimiter not found, no match
				}

				fieldValue = captureResult.value;
				pos = captureResult.endPos;
			}

			// Deserialize the captured field value
			result[segment.name] = deserializeFieldValue(fieldValue);
		}
	}

	// Ensure we consumed the entire line
	if (pos !== line.length) {
		return null;
	}

	return result;
};

/**
 * Finds the text of the next literal segment after a given index.
 * Returns null if there is no subsequent literal.
 */
const findNextLiteralText = (
	segments: ReadonlyArray<ProseSegment>,
	currentIndex: number
): string | null => {
	for (let i = currentIndex + 1; i < segments.length; i++) {
		if (segments[i].type === "literal") {
			return (segments[i] as { readonly type: "literal"; readonly text: string }).text;
		}
	}
	return null;
};

/**
 * Captures a field value from the line, handling quoted values.
 * If the value starts with a quote, scans for the closing quote (respecting `\"` escapes).
 * Otherwise, scans for the next occurrence of the delimiter.
 *
 * The endPos returned is the position where the delimiter starts (not after it),
 * so the calling loop can process the literal segment normally.
 *
 * @param line - The full line being parsed
 * @param startPos - The starting position for capture
 * @param delimiter - The literal delimiter to find
 * @returns The captured value and position where delimiter starts, or null if not found
 */
const captureFieldValue = (
	line: string,
	startPos: number,
	delimiter: string
): { value: string; endPos: number } | null => {
	// Check if the field value is quoted
	if (line[startPos] === '"') {
		// Quoted value - scan for closing quote respecting escapes
		const quoteResult = scanQuotedValue(line, startPos);
		if (quoteResult === null) {
			return null; // Unclosed quote
		}

		// After the quoted value, expect the delimiter
		if (!line.startsWith(delimiter, quoteResult.endPos)) {
			return null; // Delimiter not found after quoted value
		}

		return {
			value: quoteResult.value,
			endPos: quoteResult.endPos, // Position after closing quote, before delimiter
		};
	}

	// Unquoted value - find the next occurrence of the delimiter
	const delimiterPos = line.indexOf(delimiter, startPos);
	if (delimiterPos === -1) {
		return null; // Delimiter not found
	}

	return {
		value: line.slice(startPos, delimiterPos),
		endPos: delimiterPos, // Position where delimiter starts, not ends
	};
};

/**
 * Scans a quoted value starting at the given position.
 * Handles escaped quotes (\" inside the quoted string).
 *
 * @param line - The line being parsed
 * @param startPos - The position of the opening quote
 * @returns The unquoted, unescaped value and the position after the closing quote
 */
const scanQuotedValue = (
	line: string,
	startPos: number
): { value: string; endPos: number } | null => {
	// Skip the opening quote
	let pos = startPos + 1;
	let value = "";

	while (pos < line.length) {
		const char = line[pos];

		if (char === "\\") {
			// Escape sequence - check the next character
			if (pos + 1 < line.length) {
				const nextChar = line[pos + 1];
				if (nextChar === '"') {
					// Escaped quote - add the quote to value
					value += '"';
					pos += 2;
					continue;
				}
			}
			// Not an escape sequence, just a backslash
			value += char;
			pos++;
		} else if (char === '"') {
			// Closing quote found
			return { value, endPos: pos + 1 };
		} else {
			value += char;
			pos++;
		}
	}

	// Unclosed quote
	return null;
};

/**
 * Deserializes a field value captured from a headline.
 * This is the same as deserializeValue but handles already-unquoted values.
 *
 * @param fieldValue - The raw field value string
 * @returns The deserialized value
 */
const deserializeFieldValue = (fieldValue: string): unknown => {
	return deserializeValue(fieldValue);
};

// ============================================================================
// Overflow Encoder
// ============================================================================

/**
 * Default indentation for overflow lines.
 */
const OVERFLOW_INDENT = "  ";

/**
 * Deeper indentation for continuation lines (multi-line values).
 */
const CONTINUATION_INDENT = "    ";

/**
 * Checks if any field value in a record contains newlines for the given fields.
 *
 * @param record - The record to check
 * @param fields - The field names to check
 * @returns The first field name with a multi-line value, or null if none
 */
const findMultiLineField = (
	record: Record<string, unknown>,
	fields: ReadonlyArray<string>
): string | null => {
	for (const fieldName of fields) {
		const value = record[fieldName];
		if (typeof value === "string" && value.includes("\n")) {
			return fieldName;
		}
	}
	return null;
};

/**
 * Encodes a record with multi-line field handling.
 * If the field value contains newlines, the first line goes on the template line
 * and subsequent lines become continuation lines with deeper indentation.
 *
 * @param record - The record object with field values
 * @param template - The compiled template
 * @param multiLineField - The field name that contains multi-line content
 * @returns Array of line strings: first line is the overflow line, rest are continuation lines
 */
const encodeMultiLineOverflow = (
	record: Record<string, unknown>,
	template: CompiledTemplate,
	multiLineField: string
): string[] => {
	const value = record[multiLineField];
	if (typeof value !== "string") {
		// Should not happen, but handle gracefully
		return [OVERFLOW_INDENT + encodeHeadline(record, template)];
	}

	const valueLines = value.split("\n");
	const firstLineValue = valueLines[0];

	// Create a modified record with only the first line of the multi-line value
	const modifiedRecord = {
		...record,
		[multiLineField]: firstLineValue,
	};

	const lines: string[] = [];

	// First line: the overflow template with first line of value
	lines.push(OVERFLOW_INDENT + encodeHeadline(modifiedRecord, template));

	// Continuation lines: deeper indented
	for (let i = 1; i < valueLines.length; i++) {
		lines.push(CONTINUATION_INDENT + valueLines[i]);
	}

	return lines;
};

/**
 * Encodes overflow fields for a record as indented lines.
 * For each overflow template, if the record has a non-null/non-undefined value
 * for the field in that template, emits an indented line using the template.
 * Overflow fields with null or undefined values are omitted.
 *
 * For multi-line string values (containing newlines), the first line is encoded
 * on the template line, and subsequent lines are emitted as continuation lines
 * with deeper indentation.
 *
 * @param record - The record object with field values
 * @param overflowTemplates - Array of compiled overflow templates
 * @returns Array of indented overflow line strings
 *
 * @example
 * ```typescript
 * const templates = compileOverflowTemplates(['tagged {tags}', '~ {description}'])
 * const record = { id: "1", title: "Dune", tags: ["classic"], description: null }
 * encodeOverflowLines(record, templates)
 * // → ['  tagged [classic]']
 * // Note: description is null, so its overflow line is omitted
 *
 * // Multi-line value:
 * const record2 = { id: "1", description: "Line one\nLine two" }
 * encodeOverflowLines(record2, compileOverflowTemplates(['~ {description}']))
 * // → ['  ~ Line one', '    Line two']
 * ```
 */
export const encodeOverflowLines = (
	record: Record<string, unknown>,
	overflowTemplates: ReadonlyArray<CompiledTemplate>
): ReadonlyArray<string> => {
	const lines: string[] = [];

	for (const template of overflowTemplates) {
		// Check if any field in this template has a non-null value
		// Overflow templates typically have a single field, but we support multiple
		const hasNonNullValue = template.fields.some((fieldName) => {
			const value = record[fieldName];
			return value !== null && value !== undefined;
		});

		if (hasNonNullValue) {
			// Check for multi-line field values
			const multiLineField = findMultiLineField(record, template.fields);

			if (multiLineField !== null) {
				// Handle multi-line value with continuation lines
				const overflowLines = encodeMultiLineOverflow(
					record,
					template,
					multiLineField
				);
				lines.push(...overflowLines);
			} else {
				// Single-line value: encode normally
				const overflowLine = encodeHeadline(record, template);
				lines.push(OVERFLOW_INDENT + overflowLine);
			}
		}
	}

	return lines;
};

// ============================================================================
// Array Parsing Helpers
// ============================================================================

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
