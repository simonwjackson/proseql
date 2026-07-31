//! Computed field materialization — ports `resolveComputedFields` from
//! `packages/core/src/operations/query/resolve-computed.ts`.
//!
//! # Pipeline placement (mirrors TS)
//!
//! Computed fields are applied to entities **before** filtering, sorting, and
//! selection.  This matches the TS `resolveComputedStream(config)` being applied
//! as the first transformation on the entity stream:
//!
//! ```text
//! entities → resolveComputed → filter → sort → paginate/cursor → select
//! ```
//!
//! This means:
//! - You can **filter on computed field values** (e.g., `{ isClassic: true }`).
//! - You can **sort on computed field values** (e.g., `sort: { displayName: "asc" }`).
//! - Computed fields appear in output unless a `select` clause excludes them.
//!
//! # Loud failures
//!
//! A missing callback for a declared `ComputedFieldDescriptor` is an
//! `OperationError` — the host must register all declared callbacks before
//! running queries.  This matches the pattern established in U2 for
//! `OptionalWithDefault` callbacks.

use std::sync::Arc;

use serde_json::Value;

use crate::callbacks::CallbackRegistry;
use crate::descriptor::ComputedFieldDescriptor;
use crate::errors::{EngineError, OperationError};

/// Materialise all declared computed fields on a single entity.
///
/// Calls each registered `ComputedCallback` with the entity (pre-computed
/// fields only) and merges the results into a new object.
///
/// Returns `Err(OperationError)` if any declared callback is not registered.
///
/// Mirrors `resolveComputedFields(entity, config)` from
/// `packages/core/src/operations/query/resolve-computed.ts`.
pub fn resolve_computed(
    entity: &Value,
    descriptors: &[ComputedFieldDescriptor],
    registry: &CallbackRegistry,
) -> Result<Value, EngineError> {
    if descriptors.is_empty() {
        return Ok(entity.clone());
    }

    let mut obj = match entity.as_object() {
        Some(m) => m.clone(),
        None => return Ok(entity.clone()),
    };

    for desc in descriptors {
        match registry.invoke_computed(&desc.callback_id, entity) {
            Some(v) => {
                obj.insert(desc.name.clone(), v);
            }
            None => {
                return Err(EngineError::Operation(OperationError {
                    operation: "query".to_string(),
                    reason: format!(
                        "computed callback '{}' is not registered for field '{}'",
                        desc.callback_id, desc.name
                    ),
                    message: format!(
                        "Computed field '{}' in collection requires callback '{}' which is not \
                         registered.  Register it via CallbackRegistry before running queries.",
                        desc.name, desc.callback_id
                    ),
                }))
            }
        }
    }

    Ok(Value::Object(obj))
}

/// Materialise computed fields on a vector of entities.
///
/// Fails fast on the first missing callback.
pub fn resolve_computed_for_all(
    entities: &[Value],
    descriptors: &[ComputedFieldDescriptor],
    registry: &Arc<CallbackRegistry>,
) -> Result<Vec<Value>, EngineError> {
    if descriptors.is_empty() {
        return Ok(entities.to_vec());
    }
    entities
        .iter()
        .map(|e| resolve_computed(e, descriptors, registry))
        .collect()
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::descriptor::ComputedFieldDescriptor;

    fn make_registry(
        id: &str,
        f: impl Fn(&Value) -> Value + Send + Sync + 'static,
    ) -> CallbackRegistry {
        let mut reg = CallbackRegistry::new();
        reg.register_computed(id, Box::new(f));
        reg
    }

    #[test]
    fn no_descriptors_returns_entity_unchanged() {
        let e = json!({"id": "1", "title": "Dune"});
        let reg = CallbackRegistry::new();
        let result = resolve_computed(&e, &[], &reg).unwrap();
        assert_eq!(result, e);
    }

    #[test]
    fn computes_single_field() {
        let e = json!({"id": "1", "year": 1965});
        let reg = make_registry("is_classic", |entity| {
            let year = entity["year"].as_f64().unwrap_or(0.0);
            Value::Bool(year < 1980.0)
        });
        let desc = ComputedFieldDescriptor {
            name: "isClassic".to_string(),
            callback_id: "is_classic".to_string(),
        };
        let result = resolve_computed(&e, &[desc], &reg).unwrap();
        assert_eq!(result["isClassic"], json!(true));
        // Original fields preserved
        assert_eq!(result["id"], json!("1"));
        assert_eq!(result["year"], json!(1965));
    }

    #[test]
    fn missing_callback_is_operation_error() {
        let e = json!({"id": "1"});
        let reg = CallbackRegistry::new(); // no callbacks registered
        let desc = ComputedFieldDescriptor {
            name: "missing".to_string(),
            callback_id: "unregistered_id".to_string(),
        };
        let err = resolve_computed(&e, &[desc], &reg).unwrap_err();
        assert_eq!(err.tag(), "OperationError");
    }

    #[test]
    fn computes_multiple_fields() {
        let e = json!({"id": "1", "title": "Dune", "year": 1965});
        let mut reg = CallbackRegistry::new();
        reg.register_computed(
            "display",
            Box::new(|entity: &Value| {
                let title = entity["title"].as_str().unwrap_or("");
                let year = entity["year"].as_f64().unwrap_or(0.0) as i64;
                Value::String(format!("{title} ({year})"))
            }),
        );
        reg.register_computed(
            "classic",
            Box::new(|entity: &Value| {
                let year = entity["year"].as_f64().unwrap_or(0.0);
                Value::Bool(year < 1980.0)
            }),
        );

        let descs = vec![
            ComputedFieldDescriptor {
                name: "displayName".to_string(),
                callback_id: "display".to_string(),
            },
            ComputedFieldDescriptor {
                name: "isClassic".to_string(),
                callback_id: "classic".to_string(),
            },
        ];
        let result = resolve_computed(&e, &descs, &reg).unwrap();
        assert_eq!(result["displayName"], json!("Dune (1965)"));
        assert_eq!(result["isClassic"], json!(true));
    }

    #[test]
    fn preserves_boundary_undefined_marker_for_bridge_encoding() {
        let e = json!({"id": "1", "title": "Dune"});
        let reg = make_registry("maybe_rating", |_| json!({"__proseqlUndefined__": 1}));
        let desc = ComputedFieldDescriptor {
            name: "ratingCategory".to_string(),
            callback_id: "maybe_rating".to_string(),
        };
        let result = resolve_computed(&e, &[desc], &reg).unwrap();
        assert_eq!(result["ratingCategory"], json!({"__proseqlUndefined__": 1}));
    }
}
