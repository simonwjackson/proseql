/**
 * Types for full-text search functionality.
 *
 * Provides types for search configuration, relevance scoring,
 * and inverted index structures for text search operations.
 */

// ============================================================================
// Search Configuration Types
// ============================================================================

/**
 * Configuration for multi-field search queries.
 * Used with the top-level $search operator in where clauses.
 *
 * @example
 * ```ts
 * // Search across specific fields
 * const config: SearchConfig = {
 *   query: "herbert dune",
 *   fields: ["title", "author"],
 * }
 *
 * // Search across all string fields (fields omitted)
 * const config2: SearchConfig = {
 *   query: "science fiction",
 * }
 * ```
 */
export interface SearchConfig {
	/**
	 * The search query string.
	 * Will be tokenized and matched against field values.
	 */
	readonly query: string;

	/**
	 * Optional list of fields to search.
	 * If omitted, all string fields on the entity are searched.
	 */
	readonly fields?: ReadonlyArray<string>;
}

// ============================================================================
// Search Score Types
// ============================================================================

/**
 * Represents the relevance score for a single entity.
 * Used for ranking search results by relevance.
 */
export interface SearchScore {
	/**
	 * The ID of the entity this score belongs to.
	 */
	readonly entityId: string;

	/**
	 * The computed relevance score.
	 * Higher scores indicate better matches.
	 * Score of 0 indicates no match.
	 */
	readonly score: number;
}

// ============================================================================
// Search Index Types
// ============================================================================

/**
 * Type alias for the inverted index structure used in full-text search.
 *
 * Maps tokens to sets of entity IDs that contain those tokens.
 * This enables fast lookup of candidate entities for a given search term.
 *
 * @example
 * ```ts
 * // Example index structure:
 * // "dune" -> Set(["book-1", "book-7"])
 * // "gibson" -> Set(["book-3"])
 * // "left" -> Set(["book-2"])
 * ```
 */
export type SearchIndexMap = Map<string, Set<string>>;

// ============================================================================
// Stop Words
// ============================================================================

/**
 * Common English stop words that can optionally be filtered from search queries.
 * These words are typically too common to be useful for search relevance.
 *
 * Includes: articles, prepositions, conjunctions, and common verbs.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
	// Articles
	"a",
	"an",
	"the",
	// Prepositions
	"at",
	"by",
	"for",
	"from",
	"in",
	"into",
	"of",
	"off",
	"on",
	"onto",
	"out",
	"over",
	"to",
	"up",
	"with",
	// Conjunctions
	"and",
	"but",
	"or",
	"nor",
	"so",
	"yet",
	// Common verbs
	"am",
	"are",
	"be",
	"been",
	"being",
	"did",
	"do",
	"does",
	"doing",
	"done",
	"had",
	"has",
	"have",
	"having",
	"is",
	"it",
	"its",
	"was",
	"were",
	// Pronouns
	"he",
	"her",
	"him",
	"his",
	"i",
	"me",
	"my",
	"she",
	"that",
	"them",
	"they",
	"this",
	"us",
	"we",
	"what",
	"which",
	"who",
	"you",
	"your",
	// Other common words
	"as",
	"if",
	"not",
	"no",
	"yes",
	"all",
	"any",
	"can",
	"will",
	"just",
	"than",
	"then",
	"too",
	"very",
]);
