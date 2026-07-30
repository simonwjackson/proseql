//! Full-text search tokenization — ports `tokenize` from
//! `packages/core/src/operations/query/search.ts`.
//!
//! # Tokenization rules (TS source)
//! ```ts
//! export function tokenize(text: string): ReadonlyArray<string> {
//!   return text
//!     .toLowerCase()
//!     .split(/\s+/)
//!     .map((t) => t.replace(/^[^\w]+|[^\w]+$/g, ""))
//!     .filter((t) => t.length > 0);
//! }
//! ```
//!
//! - Lowercase
//! - Split on whitespace (`\s+`)
//! - Strip leading/trailing non-word characters (`[^\w]` = `[^a-zA-Z0-9_]`)
//! - Filter empty strings

/// Tokenize `text` into normalized tokens.
///
/// Exactly mirrors `tokenize` from `packages/core/src/operations/query/search.ts`.
pub fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split_whitespace()
        .map(strip_non_word)
        .filter(|t| !t.is_empty())
        .collect()
}

/// Strip leading and trailing non-word characters.
///
/// "Non-word" = not `[a-zA-Z0-9_]` using **ASCII** definitions, mirroring JS
/// regex `\w` which is `[A-Za-z0-9_]` (ASCII-only, no Unicode letters).
/// Rust's `char::is_alphanumeric()` includes Unicode letters (e.g. `é`, `中`)
/// and would diverge from JS `\w` for non-ASCII input.  We use
/// `is_ascii_alphanumeric()` to match JS regex semantics exactly.
fn strip_non_word(s: &str) -> String {
    let start = s
        .char_indices()
        .find(|(_, c)| c.is_ascii_alphanumeric() || *c == '_')
        .map(|(i, _)| i)
        .unwrap_or(s.len());
    let end = s
        .char_indices()
        .rev()
        .find(|(_, c)| c.is_ascii_alphanumeric() || *c == '_')
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    if start >= end {
        String::new()
    } else {
        s[start..end].to_string()
    }
}

// ── Relevance scoring ────────────────────────────────────────────────────────

/// Compute relevance score for a single field against query tokens.
///
/// Ports `computeFieldScore` from
/// `packages/core/src/operations/query/search.ts`.
///
/// Scoring uses three factors:
/// 1. **Coverage** — fraction of query tokens that matched (0..1)
/// 2. **TF boost** — 1 + sum_of_token_freq / field_token_count
/// 3. **Length norm** — 1 / ln(1 + field_token_count)
///
/// Exact match weight = 1.0; prefix match weight = 0.5.
pub fn compute_field_score(field_value: &str, query_tokens: &[String]) -> f64 {
    if query_tokens.is_empty() {
        return 0.0;
    }
    let field_tokens = tokenize(field_value);
    if field_tokens.is_empty() {
        return 0.0;
    }

    let mut matched_term_count: f64 = 0.0;
    let mut term_frequency_sum: f64 = 0.0;

    for qt in query_tokens {
        let mut token_frequency: f64 = 0.0;
        let mut token_matched = false;
        for ft in &field_tokens {
            if ft == qt {
                token_frequency += 1.0;
                token_matched = true;
            } else if ft.starts_with(qt.as_str()) {
                token_frequency += 0.5;
                token_matched = true;
            }
        }
        if token_matched {
            matched_term_count += 1.0;
            term_frequency_sum += token_frequency;
        }
    }

    if matched_term_count == 0.0 {
        return 0.0;
    }

    let coverage = matched_term_count / query_tokens.len() as f64;
    let tf_boost = 1.0 + term_frequency_sum / field_tokens.len() as f64;
    let length_norm = 1.0 / (1.0_f64 + field_tokens.len() as f64).ln();
    coverage * tf_boost * length_norm
}

/// Compute total relevance score for an entity across multiple fields.
///
/// Ports `computeSearchScore` from
/// `packages/core/src/operations/query/search.ts`.
///
/// Sums field scores for all specified string fields; non-string fields score 0.
pub fn compute_search_score(
    entity: &serde_json::Value,
    query_tokens: &[String],
    fields: &[String],
) -> f64 {
    if query_tokens.is_empty() || fields.is_empty() {
        return 0.0;
    }
    let mut total = 0.0;
    for field in fields {
        if let Some(serde_json::Value::String(s)) = entity.get(field.as_str()) {
            total += compute_field_score(s, query_tokens);
        }
    }
    total
}

/// Extract top-level `$search` config from a where clause.
///
/// Only the **top-level** `$search` key triggers relevance scoring — field-level
/// `$search` operators do not.
///
/// Mirrors `extractSearchConfig` from
/// `packages/core/src/operations/query/sort-stream.ts`.
pub fn extract_search_config(where_clause: &Option<serde_json::Value>) -> Option<SearchConfig> {
    let w = where_clause.as_ref()?.as_object()?;
    let sv = w.get("$search")?;
    let obj = sv.as_object()?;
    let query = obj.get("query")?.as_str()?.to_string();
    let fields: Option<Vec<String>> = obj.get("fields").and_then(|f| {
        f.as_array().map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
    });
    Some(SearchConfig { query, fields })
}

/// Search configuration extracted from a where clause.
#[derive(Debug, Clone)]
pub struct SearchConfig {
    pub query: String,
    /// Explicit target fields; `None` = all top-level string fields on the entity.
    pub fields: Option<Vec<String>>,
}

/// Resolve target fields for relevance scoring.
///
/// When `fields` is `Some(...)`, return those; otherwise return all top-level
/// string field names from `entity`.
///
/// TS source (`attachSearchScores` in `sort-stream.ts`):
/// ```ts
/// targetFields = searchConfig.fields ?? Object.keys(item).filter(k => typeof item[k] === 'string');
/// ```
///
/// Note: this is intentionally **flat** (top-level only), unlike
/// `collect_string_paths` which recurses.  Scoring uses shallow fields;
/// matching (filter) uses recursive paths.
pub fn resolve_score_fields(
    entity: &serde_json::Value,
    fields: &Option<Vec<String>>,
) -> Vec<String> {
    if let Some(explicit) = fields {
        explicit.clone()
    } else {
        entity
            .as_object()
            .map(|m| {
                m.iter()
                    .filter(|(_, v)| v.is_string())
                    .map(|(k, _)| k.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
}

// ── Unit tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_tokenization() {
        assert_eq!(tokenize("hello world"), vec!["hello", "world"]);
    }

    #[test]
    fn lowercases() {
        assert_eq!(tokenize("Dune"), vec!["dune"]);
    }

    #[test]
    fn strips_leading_trailing_punctuation() {
        // "Gibson, William" → ["gibson", "william"]
        assert_eq!(tokenize("Gibson, William"), vec!["gibson", "william"]);
    }

    #[test]
    fn handles_multiple_spaces() {
        assert_eq!(tokenize("hello   world"), vec!["hello", "world"]);
    }

    #[test]
    fn empty_string() {
        assert_eq!(tokenize(""), Vec::<String>::new());
    }

    #[test]
    fn whitespace_only() {
        assert_eq!(tokenize("   "), Vec::<String>::new());
    }

    #[test]
    fn punctuation_stripped() {
        // "The Left Hand of Darkness" — no punctuation to strip
        assert_eq!(
            tokenize("The Left Hand of Darkness"),
            vec!["the", "left", "hand", "of", "darkness"]
        );
    }

    #[test]
    fn comma_stripped_at_end_of_token() {
        assert_eq!(tokenize("hello, world!"), vec!["hello", "world"]);
    }

    #[test]
    fn underscore_preserved_as_word_char() {
        assert_eq!(tokenize("some_field"), vec!["some_field"]);
    }

    // ── ASCII \w semantics (non-ASCII boundary behaviour) ─────────────────────
    //
    // JS regex \w = [A-Za-z0-9_].  Non-ASCII letters (e.g. é, 中文) are NOT word
    // characters in JS, so leading/trailing non-ASCII is stripped.
    //
    // In JS:
    //   "\u00e9léphant".replace(/^[^\w]+|[^\w]+$/g, "") === ""
    //   (the entire token is non-ASCII leading/trailing → empty string → filtered)
    //   Actually that's wrong. Let's think again:
    //   "café" in JS: \w strips trailing non-ASCII é? No — \w does not match é,
    //   so [^\w]+ matches é.  So "café".replace(/^[^\w]+|[^\w]+$/g, "") === "caf".
    //   And the full word "éléphant" → [^\w]+ strips leading é, [^\w]+ strips trailing
    //   non-ASCII … but the interior is a mix, so:
    //   "\u00e9l\u00e9phant".replace(/^[^\w]+|[^\w]+$/g, "") === "l\u00e9phant"
    //   (only the leading \u00e9 is stripped; trailing 't' is \w so nothing stripped at end).

    #[test]
    fn non_ascii_at_start_of_token_is_stripped_ascii_semantics() {
        // JS: "\u00e9l\u00e9phant".replace(/^[^\w]+/, "") === "l\u00e9phant"
        // The leading non-ASCII \u00e9 is [^\w] and gets stripped.
        let tokens = tokenize("\u{00e9}l\u{00e9}phant");
        // Leading \u00e9 stripped; result is "l\u{00e9}phant" after lowercasing
        assert_eq!(tokens, vec!["l\u{00e9}phant"]);
    }

    #[test]
    fn non_ascii_trailing_is_stripped_ascii_semantics() {
        // JS: "caf\u00e9".replace(/[^\w]+$/, "") === "caf"
        // Trailing \u00e9 is [^\w] and gets stripped.
        let tokens = tokenize("caf\u{00e9}");
        assert_eq!(tokens, vec!["caf"]);
    }

    #[test]
    fn pure_non_ascii_token_is_stripped_to_empty_then_filtered() {
        // JS: "\u4e2d\u6587" — all CJK, none are ASCII \w, so the whole token
        // is stripped and filtered out (length 0).
        let tokens = tokenize("\u{4e2d}\u{6587}");
        assert_eq!(tokens, Vec::<String>::new());
    }

    #[test]
    fn ascii_word_with_non_ascii_interior_is_preserved() {
        // JS: "na\u00efve" → strip nothing (leading 'n' is \w, trailing 'e' is \w)
        // Interior non-ASCII stays: "na\u00efve"
        let tokens = tokenize("na\u{00ef}ve");
        assert_eq!(tokens, vec!["na\u{00ef}ve"]);
    }
}
