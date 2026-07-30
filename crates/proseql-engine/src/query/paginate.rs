//! Offset/limit pagination.
//!
//! Ports the `offset`/`limit` behaviour from `paginateStream.ts`:
//! - `offset` skips the first N entities.
//! - `limit` caps the result set to N entities.
//! - Both are optional; when absent the full slice is returned.

use serde_json::Value;

/// Apply offset/limit to a slice of entities (non-consuming).
///
/// Returns the paginated sub-slice.
pub fn paginate(entities: &[Value], offset: Option<usize>, limit: Option<usize>) -> Vec<Value> {
    let start = offset.unwrap_or(0);
    let sliced = if start >= entities.len() {
        &entities[entities.len()..]
    } else {
        &entities[start..]
    };
    match limit {
        Some(n) => sliced.iter().take(n).cloned().collect(),
        None => sliced.to_vec(),
    }
}

// ── Unit tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn items(n: usize) -> Vec<Value> {
        (0..n).map(|i| json!({"id": i})).collect()
    }

    #[test]
    fn no_offset_no_limit_returns_all() {
        let data = items(5);
        assert_eq!(paginate(&data, None, None).len(), 5);
    }

    #[test]
    fn limit_caps_results() {
        let data = items(10);
        assert_eq!(paginate(&data, None, Some(3)).len(), 3);
    }

    #[test]
    fn offset_skips_first_n() {
        let data = items(5); // 0,1,2,3,4
        let result = paginate(&data, Some(2), None);
        assert_eq!(result.len(), 3);
        assert_eq!(result[0]["id"], 2);
    }

    #[test]
    fn offset_and_limit_combined() {
        let data = items(10);
        let result = paginate(&data, Some(3), Some(4));
        assert_eq!(result.len(), 4);
        assert_eq!(result[0]["id"], 3);
        assert_eq!(result[3]["id"], 6);
    }

    #[test]
    fn offset_beyond_end_returns_empty() {
        let data = items(5);
        assert!(paginate(&data, Some(10), None).is_empty());
    }

    #[test]
    fn limit_zero_returns_empty() {
        let data = items(5);
        assert!(paginate(&data, None, Some(0)).is_empty());
    }
}
