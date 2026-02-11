/**
 * Full-text search operations: tokenization, matching, and relevance scoring.
 *
 * Provides pure functions for text search functionality including
 * tokenization, stop word filtering, and relevance-based ranking.
 */

import { STOP_WORDS } from "../../types/search-types.js";

// ============================================================================
// Tokenization
// ============================================================================

/**
 * Tokenize text into normalized tokens.
 *
 * Splits on whitespace, strips leading/trailing punctuation characters,
 * lowercases all tokens, and filters out empty strings.
 *
 * @param text - The text to tokenize
 * @returns Array of normalized tokens
 *
 * @example
 * ```ts
 * tokenize("Gibson, William")
 * // => ["gibson", "william"]
 *
 * tokenize("The Left Hand of Darkness")
 * // => ["the", "left", "hand", "of", "darkness"]
 *
 * tokenize("  ")
 * // => []
 *
 * tokenize("")
 * // => []
 * ```
 */
export function tokenize(text: string): ReadonlyArray<string> {
	return text
		.toLowerCase()
		.split(/\s+/)
		.map((t) => t.replace(/^[^\w]+|[^\w]+$/g, ""))
		.filter((t) => t.length > 0);
}

/**
 * Tokenize text with optional stop word filtering.
 *
 * Calls `tokenize` then optionally filters out common stop words
 * (articles, prepositions, conjunctions, etc.) that typically don't
 * contribute to search relevance.
 *
 * @param text - The text to tokenize
 * @param removeStopWords - Whether to filter out stop words
 * @returns Array of normalized tokens, optionally without stop words
 *
 * @example
 * ```ts
 * tokenizeWithStopWords("The Left Hand of Darkness", false)
 * // => ["the", "left", "hand", "of", "darkness"]
 *
 * tokenizeWithStopWords("The Left Hand of Darkness", true)
 * // => ["left", "hand", "darkness"]
 * ```
 */
export function tokenizeWithStopWords(
	text: string,
	removeStopWords: boolean,
): ReadonlyArray<string> {
	const tokens = tokenize(text);
	if (!removeStopWords) {
		return tokens;
	}
	return tokens.filter((token) => !STOP_WORDS.has(token));
}
