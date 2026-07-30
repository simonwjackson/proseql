//! Cursor-based pagination — ports `applyCursor` from
//! `packages/core/src/operations/query/cursor-stream.ts`.
//!
//! # Cursor semantics
//!
//! The cursor key is a field whose *string representation* (`String(value)`)
//! serves as the opaque cursor value.  The stream is assumed to already be
//! sorted by that key in ascending order.
//!
//! - `after: X`  → items where cursor-value **> X** (forward pagination)
//! - `before: X` → items where cursor-value **< X** (backward pagination)
//! - `after` and `before` are mutually exclusive.
//! - `limit` must be > 0.
//!
//! # hasNextPage / hasPreviousPage algorithm
//!
//! The engine fetches `limit + 1` to detect overflow:
//!
//! **Forward** (`after` or first page):
//! - `hasNextPage = items.len() > limit` (overflow detected)
//! - `hasPreviousPage = after.is_some()` (pages exist before this one)
//! - Extra item is at the end; slice to `[..limit]`.
//!
//! **Backward** (`before`):
//! - Fetch `limit + 1` from the filtered tail.
//! - `hasPreviousPage = items.len() > limit` (overflow detected)
//! - `hasNextPage = true` (items exist after — we are navigating backward)
//! - Extra item is at the start; slice to `[1..]`.
//!
//! # Error conditions (mirrors TS `applyCursor`)
//! - `after` and `before` both set → `ValidationError`
//! - `limit <= 0` → `ValidationError`

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::{EngineError, ValidationError, ValidationIssue};

use super::filter::get_nested_value;
use super::sort::value_to_js_string;

/// Result of cursor pagination.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPageResult {
    pub items: Vec<Value>,
    pub page_info: CursorPageInfo,
}

/// Cursor pagination metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPageInfo {
    /// Cursor of the first item on the page, or `None` if empty.
    pub start_cursor: Option<String>,
    /// Cursor of the last item on the page, or `None` if empty.
    pub end_cursor: Option<String>,
    pub has_next_page: bool,
    pub has_previous_page: bool,
}

/// Configuration for cursor pagination.
#[derive(Debug, Clone)]
pub struct CursorConfig {
    /// The entity field used as the cursor key.
    pub key: String,
    /// Fetch items after this cursor (forward pagination).
    pub after: Option<String>,
    /// Fetch items before this cursor (backward pagination).
    pub before: Option<String>,
    /// Maximum items per page (must be > 0).
    pub limit: usize,
}

/// Apply cursor pagination to a **sorted** (ascending by `config.key`) slice.
///
/// Returns `Err(ValidationError)` for invalid configuration.
pub fn apply_cursor(
    entities: &[Value],
    config: &CursorConfig,
) -> Result<CursorPageResult, EngineError> {
    // ── Validate ──────────────────────────────────────────────────────────────
    if config.after.is_some() && config.before.is_some() {
        return Err(EngineError::Validation(ValidationError {
            message: "Invalid cursor configuration".to_string(),
            issues: vec![ValidationIssue {
                field: "cursor".to_string(),
                message: "after and before are mutually exclusive".to_string(),
                value: None,
                expected: None,
                received: None,
            }],
        }));
    }
    if config.limit == 0 {
        return Err(EngineError::Validation(ValidationError {
            message: "Invalid cursor configuration".to_string(),
            issues: vec![ValidationIssue {
                field: "cursor.limit".to_string(),
                message: "limit must be a positive integer".to_string(),
                value: None,
                expected: None,
                received: None,
            }],
        }));
    }

    let extract_cursor = |entity: &Value| -> String {
        get_nested_value(entity, &config.key)
            .map(value_to_js_string)
            .unwrap_or_default()
    };

    if config.before.is_some() {
        // ── Backward pagination ───────────────────────────────────────────────
        let before = config.before.as_deref().unwrap();

        // Filter: cursor-value < before
        let filtered: Vec<&Value> = entities
            .iter()
            .filter(|e| extract_cursor(e).as_str() < before)
            .collect();

        if filtered.is_empty() {
            return Ok(CursorPageResult {
                items: vec![],
                page_info: CursorPageInfo {
                    start_cursor: None,
                    end_cursor: None,
                    has_next_page: false,
                    has_previous_page: false,
                },
            });
        }

        // Validate key exists
        validate_key_exists(filtered[0], &config.key)?;

        // Take last (limit + 1) items to detect hasPreviousPage
        let take_n = config.limit + 1;
        let taken: Vec<Value> = if filtered.len() > take_n {
            filtered[filtered.len() - take_n..]
                .iter()
                .map(|v| (*v).clone())
                .collect()
        } else {
            filtered.iter().map(|v| (*v).clone()).collect()
        };

        let has_overflow = taken.len() > config.limit;
        let has_previous_page = has_overflow;
        let has_next_page = true; // items exist after (we got here via before)

        let page_items: Vec<Value> = if has_overflow {
            taken[1..].to_vec()
        } else {
            taken
        };

        let start_cursor = page_items.first().map(&extract_cursor);
        let end_cursor = page_items.last().map(&extract_cursor);

        Ok(CursorPageResult {
            items: page_items,
            page_info: CursorPageInfo {
                start_cursor,
                end_cursor,
                has_next_page,
                has_previous_page,
            },
        })
    } else {
        // ── Forward pagination (or first page) ────────────────────────────────
        let after = config.after.as_deref();

        // Filter: cursor-value > after (or all items when after is None)
        let filtered: Vec<&Value> = entities
            .iter()
            .filter(|e| {
                if let Some(a) = after {
                    extract_cursor(e).as_str() > a
                } else {
                    true
                }
            })
            .collect();

        if filtered.is_empty() {
            return Ok(CursorPageResult {
                items: vec![],
                page_info: CursorPageInfo {
                    start_cursor: None,
                    end_cursor: None,
                    has_next_page: false,
                    has_previous_page: false,
                },
            });
        }

        // Validate key exists
        validate_key_exists(filtered[0], &config.key)?;

        // Take first (limit + 1) items to detect hasNextPage
        let take_n = config.limit + 1;
        let taken: Vec<Value> = filtered.iter().take(take_n).map(|v| (*v).clone()).collect();

        let has_overflow = taken.len() > config.limit;
        let has_next_page = has_overflow;
        let has_previous_page = after.is_some();

        let page_items: Vec<Value> = if has_overflow {
            taken[..config.limit].to_vec()
        } else {
            taken
        };

        let start_cursor = page_items.first().map(&extract_cursor);
        let end_cursor = page_items.last().map(&extract_cursor);

        Ok(CursorPageResult {
            items: page_items,
            page_info: CursorPageInfo {
                start_cursor,
                end_cursor,
                has_next_page,
                has_previous_page,
            },
        })
    }
}

/// Validate that `key` exists on `entity`.
fn validate_key_exists(entity: &Value, key: &str) -> Result<(), EngineError> {
    if get_nested_value(entity, key).is_none() {
        return Err(EngineError::Validation(ValidationError {
            message: "Invalid cursor configuration".to_string(),
            issues: vec![ValidationIssue {
                field: "cursor.key".to_string(),
                message: format!("key '{key}' does not exist on entity"),
                value: None,
                expected: None,
                received: None,
            }],
        }));
    }
    Ok(())
}

// ── Unit tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn items(n: usize) -> Vec<Value> {
        (1..=n)
            .map(|i| {
                let id = format!("item-{:03}", i);
                json!({"id": id, "price": i * 10})
            })
            .collect()
    }

    fn cursor(key: &str, limit: usize) -> CursorConfig {
        CursorConfig {
            key: key.to_string(),
            after: None,
            before: None,
            limit,
        }
    }

    // ── First page ─────────────────────────────────────────────────────────────

    #[test]
    fn first_page_returns_first_n_items() {
        let data = items(10);
        let result = apply_cursor(&data, &cursor("id", 3)).unwrap();
        assert_eq!(result.items.len(), 3);
        assert_eq!(result.items[0]["id"], "item-001");
        assert_eq!(result.items[2]["id"], "item-003");
        assert!(result.page_info.has_next_page);
        assert!(!result.page_info.has_previous_page);
        assert_eq!(result.page_info.start_cursor.as_deref(), Some("item-001"));
        assert_eq!(result.page_info.end_cursor.as_deref(), Some("item-003"));
    }

    #[test]
    fn last_page_no_next() {
        let data = items(5);
        // Items 004, 005
        let cfg = CursorConfig {
            key: "id".to_string(),
            after: Some("item-003".to_string()),
            before: None,
            limit: 5,
        };
        let result = apply_cursor(&data, &cfg).unwrap();
        assert_eq!(result.items.len(), 2);
        assert!(!result.page_info.has_next_page);
        assert!(result.page_info.has_previous_page); // after was set
    }

    // ── Second page via after ──────────────────────────────────────────────────

    #[test]
    fn second_page_via_after() {
        let data = items(10);
        let first = apply_cursor(&data, &cursor("id", 3)).unwrap();
        let after = first.page_info.end_cursor.clone().unwrap();

        let second = apply_cursor(
            &data,
            &CursorConfig {
                key: "id".to_string(),
                after: Some(after),
                before: None,
                limit: 3,
            },
        )
        .unwrap();
        assert_eq!(second.items[0]["id"], "item-004");
        assert_eq!(second.items[2]["id"], "item-006");
        assert!(second.page_info.has_previous_page);
        assert!(second.page_info.has_next_page);
    }

    // ── Before (backward) ──────────────────────────────────────────────────────

    #[test]
    fn before_returns_items_before_cursor() {
        let data = items(10);
        let cfg = CursorConfig {
            key: "id".to_string(),
            after: None,
            before: Some("item-006".to_string()),
            limit: 3,
        };
        let result = apply_cursor(&data, &cfg).unwrap();
        // Items 001-005 pass filter; last 3 are 003, 004, 005
        assert_eq!(result.items.len(), 3);
        assert_eq!(result.items[0]["id"], "item-003");
        assert_eq!(result.items[2]["id"], "item-005");
        assert!(result.page_info.has_next_page); // always true for before
        assert!(result.page_info.has_previous_page); // items 001-002 still before
    }

    // ── Empty results ──────────────────────────────────────────────────────────

    #[test]
    fn empty_collection_returns_empty_result() {
        let result = apply_cursor(&[], &cursor("id", 5)).unwrap();
        assert!(result.items.is_empty());
        assert!(!result.page_info.has_next_page);
        assert!(!result.page_info.has_previous_page);
        assert!(result.page_info.start_cursor.is_none());
        assert!(result.page_info.end_cursor.is_none());
    }

    #[test]
    fn after_beyond_all_items_returns_empty() {
        let data = items(5);
        let cfg = CursorConfig {
            key: "id".to_string(),
            after: Some("item-999".to_string()),
            before: None,
            limit: 3,
        };
        let result = apply_cursor(&data, &cfg).unwrap();
        assert!(result.items.is_empty());
    }

    // ── Validation errors ──────────────────────────────────────────────────────

    #[test]
    fn after_and_before_together_is_validation_error() {
        let data = items(5);
        let cfg = CursorConfig {
            key: "id".to_string(),
            after: Some("item-001".to_string()),
            before: Some("item-004".to_string()),
            limit: 2,
        };
        let err = apply_cursor(&data, &cfg).unwrap_err();
        assert_eq!(err.tag(), "ValidationError");
    }

    #[test]
    fn limit_zero_is_validation_error() {
        let data = items(5);
        let cfg = CursorConfig {
            key: "id".to_string(),
            after: None,
            before: None,
            limit: 0,
        };
        let err = apply_cursor(&data, &cfg).unwrap_err();
        assert_eq!(err.tag(), "ValidationError");
    }

    #[test]
    fn missing_cursor_key_is_validation_error() {
        let data = vec![json!({"id": "x"})];
        let cfg = CursorConfig {
            key: "nonexistent".to_string(),
            after: None,
            before: None,
            limit: 3,
        };
        let err = apply_cursor(&data, &cfg).unwrap_err();
        assert_eq!(err.tag(), "ValidationError");
    }

    // ── Exact limit (no overflow) ──────────────────────────────────────────────

    #[test]
    fn exactly_limit_items_no_overflow() {
        let data = items(3);
        let result = apply_cursor(&data, &cursor("id", 3)).unwrap();
        assert_eq!(result.items.len(), 3);
        assert!(!result.page_info.has_next_page);
    }

    // ── JS String(value) cursor keys ───────────────────────────────────────────

    #[test]
    fn array_cursor_key_uses_comma_join_not_object_array() {
        // JS: String([1,2]) === "1,2", NOT "[object Array]"
        // Entities sorted by an array-valued field.
        let data = vec![
            json!({"id": "a", "tags": ["z"]}),
            json!({"id": "b", "tags": ["a"]}),
        ];
        let cfg = CursorConfig {
            key: "tags".to_string(),
            after: None,
            before: None,
            limit: 10,
        };
        let result = apply_cursor(&data, &cfg).unwrap();
        // Cursor is the comma-join of the array
        assert_eq!(result.page_info.start_cursor.as_deref(), Some("z"));
        assert_eq!(result.page_info.end_cursor.as_deref(), Some("a"));
    }

    #[test]
    fn mixed_type_sort_null_slot_in_array_produces_empty_comma_position() {
        // JS: String([1,null,3]) === "1,,3" — null slot → ""
        let e = json!({"id": "x", "arr": [1, null, 3]});
        let cursor_val = crate::query::sort::value_to_js_string(&e["arr"]);
        assert_eq!(cursor_val, "1,,3");
    }
}
