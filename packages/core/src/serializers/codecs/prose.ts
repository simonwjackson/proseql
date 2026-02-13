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
// Overflow Decoder
// ============================================================================

/**
 * Result of decoding overflow lines for a record.
 */
export interface DecodeOverflowResult {
	/** The decoded field values from overflow lines */
	readonly fields: Record<string, unknown>;
	/** Number of lines consumed (including continuation lines) */
	readonly linesConsumed: number;
}

/**
 * Measures the indentation level of a line (number of leading spaces/tabs).
 *
 * @param line - The line to measure
 * @returns The number of leading whitespace characters
 */
const measureIndent = (line: string): number => {
	let indent = 0;
	for (const char of line) {
		if (char === " " || char === "\t") {
			indent++;
		} else {
			break;
		}
	}
	return indent;
};

/**
 * Decodes overflow lines for a record using the configured overflow templates.
 * Collects indented lines belonging to the record, tries each overflow template
 * in order, skips on non-match, and captures field values on match.
 *
 * For each indented line:
 * 1. Try matching against each overflow template (in order)
 * 2. If a template matches, capture the field values and move to next line
 * 3. If no template matches, check if it's a continuation line (deeper indentation)
 * 4. Continuation lines are appended to the previous field's value with newline
 *
 * @param lines - Array of indented lines (already collected for this record)
 * @param overflowTemplates - Array of compiled overflow templates
 * @param baseIndent - The expected indentation level for overflow lines (default: 2)
 * @returns The decoded field values and number of lines consumed
 *
 * @example
 * ```typescript
 * const templates = compileOverflowTemplates(['tagged {tags}', '~ {description}'])
 * const lines = ['  tagged [sci-fi]', '  ~ A classic novel']
 * const result = decodeOverflowLines(lines, templates)
 * // → { fields: { tags: ['sci-fi'], description: 'A classic novel' }, linesConsumed: 2 }
 * ```
 */
export const decodeOverflowLines = (
	lines: ReadonlyArray<string>,
	overflowTemplates: ReadonlyArray<CompiledTemplate>,
	baseIndent = 2
): DecodeOverflowResult => {
	const fields: Record<string, unknown> = {};
	let lineIndex = 0;
	let lastMatchedField: string | null = null;

	while (lineIndex < lines.length) {
		const line = lines[lineIndex];
		const indent = measureIndent(line);

		// Check if line is indented enough to be part of this record's overflow
		if (indent < baseIndent) {
			// Line is not indented enough, stop processing
			break;
		}

		// Check if this is a continuation line (deeper indentation than base)
		if (indent > baseIndent && lastMatchedField !== null) {
			// Continuation line - append to the last matched field
			const existingValue = fields[lastMatchedField];
			const continuationContent = line.slice(indent); // Strip all leading whitespace

			if (typeof existingValue === "string") {
				fields[lastMatchedField] = existingValue + "\n" + continuationContent;
			} else {
				// Shouldn't happen in well-formed input, but handle it
				fields[lastMatchedField] = String(existingValue) + "\n" + continuationContent;
			}

			lineIndex++;
			continue;
		}

		// Strip the base indentation to get the content
		const content = line.slice(baseIndent);

		// Try each overflow template in order
		let matched = false;
		for (const template of overflowTemplates) {
			const decoded = decodeHeadline(content, template);

			if (decoded !== null) {
				// Template matched - merge the decoded fields
				for (const [fieldName, value] of Object.entries(decoded)) {
					fields[fieldName] = value;

					// Track the last matched field for continuation lines
					// (typically the last field in the template, often the only one)
					lastMatchedField = fieldName;
				}

				matched = true;
				break;
			}
		}

		if (!matched) {
			// No template matched - this could be:
			// 1. A malformed overflow line (skip it)
			// 2. Or we're past the record's overflow section
			// For robustness, we skip and continue trying
			// If it's deeply indented, it might be a continuation without a prior match
			if (indent > baseIndent && lastMatchedField !== null) {
				// Treat as continuation anyway
				const existingValue = fields[lastMatchedField];
				const continuationContent = line.slice(indent);

				if (typeof existingValue === "string") {
					fields[lastMatchedField] = existingValue + "\n" + continuationContent;
				}
			}
			// If no match and no prior field, we just skip this line
		}

		lineIndex++;
	}

	return {
		fields,
		linesConsumed: lineIndex,
	};
};

// ============================================================================
// Directive Scanner
// ============================================================================

/**
 * Result of scanning for the @prose directive in a document.
 */
export interface ScanDirectiveResult {
	/** Index of the last line before the directive (or -1 if no preamble) */
	readonly preambleEnd: number;
	/** Index of the line containing the @prose directive */
	readonly directiveStart: number;
}

/**
 * Scans a document for the @prose directive.
 * The directive is a line starting with `@prose ` (note the trailing space).
 *
 * Rules:
 * - Exactly one @prose directive must exist in the file
 * - If no directive is found, throws an error
 * - If multiple directives are found, throws an error
 * - All lines before the directive are preamble
 *
 * @param lines - Array of lines from the document
 * @returns The position information for preamble and directive
 * @throws Error if no directive found or multiple directives found
 *
 * @example
 * ```typescript
 * const lines = ['# My Books', '', '@prose #{id} {title}', '#1 Dune']
 * const result = scanDirective(lines)
 * // → { preambleEnd: 1, directiveStart: 2 }
 *
 * const linesNoPreable = ['@prose #{id} {title}', '#1 Dune']
 * const result2 = scanDirective(linesNoPreable)
 * // → { preambleEnd: -1, directiveStart: 0 }
 * ```
 */
export const scanDirective = (lines: ReadonlyArray<string>): ScanDirectiveResult => {
	let directiveIndex: number | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Check if this line starts with "@prose "
		if (line.startsWith("@prose ")) {
			if (directiveIndex !== null) {
				// Multiple directives found
				throw new Error(
					`Multiple @prose directives found: first at line ${directiveIndex + 1}, second at line ${i + 1}. Only one directive per file is allowed.`
				);
			}
			directiveIndex = i;
		}
	}

	if (directiveIndex === null) {
		throw new Error(
			"No @prose directive found. The file must contain a line starting with '@prose ' to define the record template."
		);
	}

	return {
		preambleEnd: directiveIndex > 0 ? directiveIndex - 1 : -1,
		directiveStart: directiveIndex,
	};
};

// ============================================================================
// Directive Block Parser
// ============================================================================

/**
 * Result of parsing a directive block.
 */
export interface DirectiveBlock {
	/** The headline template (content after @prose) */
	readonly headlineTemplate: string;
	/** Overflow templates (indented lines immediately after @prose) */
	readonly overflowTemplates: ReadonlyArray<string>;
	/** Index of the first line after the directive block (body start) */
	readonly bodyStart: number;
}

/**
 * Parses a directive block from the document.
 * Extracts the headline template from the @prose line and collects
 * any indented overflow templates that immediately follow.
 *
 * The directive block structure:
 * ```
 * @prose #{id} "{title}" by {author}   ← headline template
 *   tagged {tags}                       ← overflow template 1
 *   ~ {description}                     ← overflow template 2
 *                                       ← blank line or non-indented = end of block
 * ```
 *
 * Overflow templates are lines that:
 * - Immediately follow the @prose line (no blank lines between)
 * - Are indented (start with whitespace)
 *
 * @param lines - Array of lines from the document
 * @param directiveStart - Index of the @prose directive line
 * @returns The parsed directive block with template strings and body start index
 *
 * @example
 * ```typescript
 * const lines = [
 *   '@prose #{id} "{title}"',
 *   '  tagged {tags}',
 *   '  ~ {description}',
 *   '',
 *   '#1 "Dune"',
 * ]
 * const result = parseDirectiveBlock(lines, 0)
 * // → {
 * //   headlineTemplate: '#{id} "{title}"',
 * //   overflowTemplates: ['tagged {tags}', '~ {description}'],
 * //   bodyStart: 3
 * // }
 * ```
 */
export const parseDirectiveBlock = (
	lines: ReadonlyArray<string>,
	directiveStart: number
): DirectiveBlock => {
	const directiveLine = lines[directiveStart];

	// Extract headline template: everything after "@prose "
	const headlineTemplate = directiveLine.slice("@prose ".length);

	// Collect overflow templates: indented lines immediately following
	const overflowTemplates: string[] = [];
	let lineIndex = directiveStart + 1;

	while (lineIndex < lines.length) {
		const line = lines[lineIndex];

		// Check if line is indented (starts with whitespace)
		if (line.length > 0 && (line[0] === " " || line[0] === "\t")) {
			// This is an overflow template - strip leading whitespace
			const templateContent = line.trimStart();
			overflowTemplates.push(templateContent);
			lineIndex++;
		} else {
			// Not indented or empty line - end of directive block
			break;
		}
	}

	return {
		headlineTemplate,
		overflowTemplates,
		bodyStart: lineIndex,
	};
};

// ============================================================================
// Body Parser
// ============================================================================

/**
 * Represents a parsed entry from the body section of a prose document.
 * Can be either a record (matched the headline template) or pass-through text.
 */
export type ProseEntry =
	| {
			readonly type: "record";
			/** The decoded headline fields */
			readonly fields: Record<string, unknown>;
			/** The raw headline line */
			readonly headline: string;
			/** Indented overflow lines belonging to this record */
			readonly overflowLines: ReadonlyArray<string>;
	  }
	| {
			readonly type: "passthrough";
			/** Raw text lines that didn't match the template */
			readonly lines: ReadonlyArray<string>;
	  };

/**
 * Result of parsing the body section of a prose document.
 */
export interface ParseBodyResult {
	/** The parsed entries (interleaved records and pass-through text) */
	readonly entries: ReadonlyArray<ProseEntry>;
}

/**
 * Parses the body section of a prose document.
 * Iterates lines after the directive block and classifies each as:
 * - Record headline (matches the compiled template)
 * - Indented overflow/continuation (part of the current record)
 * - Pass-through text (doesn't match, preserved verbatim)
 *
 * @param lines - Array of lines from the document
 * @param bodyStart - Index of the first line of the body (after directive block)
 * @param headlineTemplate - The compiled headline template
 * @returns The parsed body with interleaved records and pass-through text
 *
 * @example
 * ```typescript
 * const lines = [
 *   '@prose #{id} "{title}"',
 *   '',
 *   '## Science Fiction',
 *   '#1 "Dune"',
 *   '  tagged [classic]',
 *   '#2 "Neuromancer"',
 *   '',
 *   '## Fantasy',
 *   '#3 "The Hobbit"',
 * ]
 * const template = compileTemplate('#{id} "{title}"')
 * const result = parseBody(lines, 1, template)
 * // → {
 * //   entries: [
 * //     { type: "passthrough", lines: ["", "## Science Fiction"] },
 * //     { type: "record", fields: { id: "1", title: "Dune" }, headline: '#1 "Dune"', overflowLines: ["  tagged [classic]"] },
 * //     { type: "record", fields: { id: "2", title: "Neuromancer" }, headline: '#2 "Neuromancer"', overflowLines: [] },
 * //     { type: "passthrough", lines: ["", "## Fantasy"] },
 * //     { type: "record", fields: { id: "3", title: "The Hobbit" }, headline: '#3 "The Hobbit"', overflowLines: [] },
 * //   ]
 * // }
 * ```
 */
export const parseBody = (
	lines: ReadonlyArray<string>,
	bodyStart: number,
	headlineTemplate: CompiledTemplate
): ParseBodyResult => {
	const entries: ProseEntry[] = [];
	let lineIndex = bodyStart;
	let currentPassthrough: string[] = [];

	// Helper to flush accumulated pass-through lines into an entry
	const flushPassthrough = (): void => {
		if (currentPassthrough.length > 0) {
			entries.push({
				type: "passthrough",
				lines: [...currentPassthrough],
			});
			currentPassthrough = [];
		}
	};

	while (lineIndex < lines.length) {
		const line = lines[lineIndex];

		// Check if this line is indented (starts with whitespace)
		if (line.length > 0 && (line[0] === " " || line[0] === "\t")) {
			// Indented line — belongs to the previous record's overflow
			// If we have a current record (last entry is a record), add to its overflow
			// Otherwise, treat as pass-through (malformed input)
			const lastEntry = entries[entries.length - 1];
			if (lastEntry && lastEntry.type === "record") {
				// Add to the record's overflow lines (we need to mutate, so cast)
				(lastEntry.overflowLines as string[]).push(line);
			} else {
				// No record to attach to — treat as pass-through
				currentPassthrough.push(line);
			}
			lineIndex++;
			continue;
		}

		// Not indented — try to match against the headline template
		const decoded = decodeHeadline(line, headlineTemplate);

		if (decoded !== null) {
			// Line matches the template — it's a record headline
			// First, flush any accumulated pass-through
			flushPassthrough();

			// Create a new record entry
			entries.push({
				type: "record",
				fields: decoded,
				headline: line,
				overflowLines: [],
			});
			lineIndex++;
		} else {
			// Line doesn't match — it's pass-through text
			currentPassthrough.push(line);
			lineIndex++;
		}
	}

	// Flush any remaining pass-through lines
	flushPassthrough();

	return { entries };
};

// ============================================================================
// Prose Codec Factory
// ============================================================================

/**
 * Internal compiled state for a prose codec instance.
 * Created once at construction time and reused for all encode/decode calls.
 */
interface CompiledProseCodec {
	readonly headlineTemplate: CompiledTemplate;
	readonly overflowTemplates: ReadonlyArray<CompiledTemplate>;
	readonly rawHeadlineTemplate: string;
	readonly rawOverflowTemplates: ReadonlyArray<string>;
}

/**
 * Compiles prose codec options into internal state.
 * Called once at codec construction time.
 *
 * @param options - The prose codec options
 * @returns The compiled codec state
 */
const compileProseCodecOptions = (options: ProseCodecOptions): CompiledProseCodec => {
	const headlineTemplate = compileTemplate(options.template);
	const overflowTemplates = compileOverflowTemplates(options.overflow);

	return {
		headlineTemplate,
		overflowTemplates,
		rawHeadlineTemplate: options.template,
		rawOverflowTemplates: options.overflow ?? [],
	};
};

/**
 * Creates a prose format codec for human-readable, template-driven serialization.
 *
 * The prose format uses a `@prose` directive to define a sentence-like pattern
 * mapping field names to positions within literal delimiter text. Records follow
 * this pattern, producing human-readable lines.
 *
 * Templates use `{fieldName}` placeholders mixed with literal text:
 * ```
 * @prose #{id} "{title}" by {authorId} ({year}) — {genre}
 *   tagged {tags}
 *   ~ {description}
 * ```
 *
 * The codec compiles templates at construction time and returns a standard
 * FormatCodec with encode/decode functions.
 *
 * @param options - Codec configuration with headline and overflow templates
 * @param options.template - The headline template with {fieldName} placeholders
 * @param options.overflow - Optional array of overflow templates for additional fields
 * @returns A FormatCodec for prose serialization
 *
 * @example
 * ```typescript
 * const codec = proseCodec({
 *   template: '#{id} "{title}" by {author}',
 *   overflow: ['tagged {tags}', '~ {description}'],
 * })
 *
 * const layer = makeSerializerLayer([codec])
 *
 * // Encoded output:
 * // @prose #{id} "{title}" by {author}
 * //   tagged {tags}
 * //   ~ {description}
 * //
 * // #1 "Dune" by Frank Herbert
 * //   tagged [sci-fi, classic]
 * //   ~ A masterpiece of science fiction
 * ```
 */
export const proseCodec = (options: ProseCodecOptions): FormatCodec => {
	// Compile templates at construction time
	const compiled = compileProseCodecOptions(options);

	return {
		name: "prose",
		extensions: ["prose"],

		encode: (data: unknown, _formatOptions?: FormatOptions): string => {
			if (!Array.isArray(data)) {
				throw new Error(
					"Prose codec expects an array of records to encode"
				);
			}

			const lines: string[] = [];

			// Write the @prose directive
			lines.push(`@prose ${compiled.rawHeadlineTemplate}`);

			// Write overflow template declarations (indented)
			for (const overflowTemplate of compiled.rawOverflowTemplates) {
				lines.push(`  ${overflowTemplate}`);
			}

			// Blank line to separate directive block from body
			lines.push("");

			// Encode each record
			for (const record of data as ReadonlyArray<Record<string, unknown>>) {
				// Encode headline
				const headline = encodeHeadline(record, compiled.headlineTemplate);
				lines.push(headline);

				// Encode overflow lines
				const overflowLines = encodeOverflowLines(record, compiled.overflowTemplates);
				lines.push(...overflowLines);
			}

			return lines.join("\n");
		},

		decode: (raw: string): unknown => {
			// Task 8.3 will implement the full decode logic
			// For now, parse the structure and return records
			const lines = raw.split("\n");

			// Scan for the directive
			const scanResult = scanDirective(lines);

			// Parse the directive block
			const directiveBlock = parseDirectiveBlock(lines, scanResult.directiveStart);

			// Compile the file's headline template for parsing
			// Note: We use the file's template for decoding, ensuring self-describing files work
			const fileHeadlineTemplate = compileTemplate(directiveBlock.headlineTemplate);
			const fileOverflowTemplates = compileOverflowTemplates(directiveBlock.overflowTemplates);

			// Parse the body
			const bodyResult = parseBody(lines, directiveBlock.bodyStart, fileHeadlineTemplate);

			// Extract records from entries, decoding overflow fields
			const records: Array<Record<string, unknown>> = [];

			for (const entry of bodyResult.entries) {
				if (entry.type === "record") {
					// Start with headline fields
					const record: Record<string, unknown> = { ...entry.fields };

					// Decode overflow lines to get additional fields
					if (entry.overflowLines.length > 0) {
						const overflowResult = decodeOverflowLines(
							entry.overflowLines,
							fileOverflowTemplates
						);

						// Merge overflow fields into the record
						for (const [fieldName, value] of Object.entries(overflowResult.fields)) {
							record[fieldName] = value;
						}
					}

					records.push(record);
				}
				// Pass-through entries are skipped (v1: not preserved through re-encode)
			}

			return records;
		},
	};
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
