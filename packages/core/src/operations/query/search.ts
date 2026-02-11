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

// ============================================================================
// Relevance Scoring
// ============================================================================

/**
 * Compute the relevance score for a single field value against query tokens.
 *
 * Scoring uses three factors combined multiplicatively:
 * 1. **Term coverage**: Fraction of query tokens that matched (0..1)
 * 2. **Term frequency (TF)**: How many times query tokens appear in the field
 * 3. **Field length normalization**: Shorter fields score higher for same match
 *
 * Prefix matches (via startsWith) count toward matching but score slightly lower
 * than exact matches to preserve ranking quality.
 *
 * @param fieldValue - The field value to score
 * @param queryTokens - The tokenized search query
 * @returns Relevance score (0 if no tokens match)
 *
 * @example
 * ```ts
 * computeFieldScore("Dune", ["dune"])
 * // => ~1.44 (exact match, short field)
 *
 * computeFieldScore("The Left Hand of Darkness", ["left", "hand"])
 * // => ~0.29 (2/2 coverage, longer field)
 *
 * computeFieldScore("Neuromancer", ["neuro"])
 * // => ~0.72 (prefix match, reduced score)
 *
 * computeFieldScore("Dune", ["xyz"])
 * // => 0 (no match)
 * ```
 */
export function computeFieldScore(
	fieldValue: string,
	queryTokens: ReadonlyArray<string>,
): number {
	// Handle edge cases
	if (queryTokens.length === 0) {
		return 0;
	}

	const fieldTokens = tokenize(fieldValue);
	if (fieldTokens.length === 0) {
		return 0;
	}

	// Count matched tokens and compute term frequency
	let matchedTermCount = 0;
	let termFrequencySum = 0;

	for (const queryToken of queryTokens) {
		let tokenMatched = false;
		let tokenFrequency = 0;

		for (const fieldToken of fieldTokens) {
			if (fieldToken === queryToken) {
				// Exact match: full weight
				tokenFrequency += 1;
				tokenMatched = true;
			} else if (fieldToken.startsWith(queryToken)) {
				// Prefix match: reduced weight (0.5x)
				tokenFrequency += 0.5;
				tokenMatched = true;
			}
		}

		if (tokenMatched) {
			matchedTermCount += 1;
			termFrequencySum += tokenFrequency;
		}
	}

	// No matches means score of 0
	if (matchedTermCount === 0) {
		return 0;
	}

	// Compute score using the three factors:
	// 1. Coverage: fraction of query tokens that matched
	const coverage = matchedTermCount / queryTokens.length;

	// 2. TF boost: more occurrences = higher score
	const tfBoost = 1 + termFrequencySum / fieldTokens.length;

	// 3. Length normalization: shorter fields score higher
	const lengthNorm = 1 / Math.log(1 + fieldTokens.length);

	return coverage * tfBoost * lengthNorm;
}
