//! Recursive relationship population.

use indexmap::IndexMap;
use serde_json::Value;

use crate::collection::Collection;
use crate::descriptor::{RelationshipDescriptor, RelationshipKind};
use crate::errors::{CollectionNotFoundError, DanglingReferenceError, EngineError};

use super::helpers::{col_nf, ref_fk, resolve_inv_fk_population};

// ── Population ────────────────────────────────────────────────────────────────

/// Recursively apply a populate configuration to a list of entities.
///
/// Max recursion depth: 5 (mirrors TS `MAX_POPULATE_DEPTH = 5`).
/// Stops silently at depth > 5 (no error).
pub(super) fn apply_populate(
    entities: Vec<Value>,
    populate_config: &Value,
    source_col_name: &str,
    all_collections: &IndexMap<String, Collection>,
    depth: usize,
) -> Result<Vec<Value>, EngineError> {
    if depth > 5 {
        return Ok(entities);
    }

    let config_obj = match populate_config.as_object() {
        Some(m) if !m.is_empty() => m,
        _ => return Ok(entities),
    };

    let rels: Vec<(String, RelationshipDescriptor)> = all_collections
        .get(source_col_name)
        .ok_or_else(|| col_nf(source_col_name))?
        .descriptor
        .relationships
        .clone();

    let mut result = Vec::with_capacity(entities.len());

    for entity in entities {
        let mut populated = entity.as_object().cloned().unwrap_or_default();

        for (rel_name, rel_value) in config_obj {
            let rel_desc = match rels.iter().find(|(n, _)| n == rel_name) {
                Some((_, d)) => d,
                None => continue,
            };

            match rel_desc.kind {
                RelationshipKind::Ref => {
                    let fk_field = ref_fk(rel_name, &rel_desc.foreign_key);
                    let fk_val = entity.get(&fk_field);

                    match fk_val {
                        None | Some(Value::Null) => {}
                        Some(Value::String(tid)) => {
                            let tid = tid.clone();
                            let target_col_name = rel_desc.target.clone();
                            let nested_cfg = nested_pop_config(rel_value);

                            // Separate missing-COLLECTION from missing-ENTITY:
                            // - missing collection → `CollectionNotFound` (descriptor mismatch)
                            // - missing entity    → `DanglingReferenceError`
                            let target_col = all_collections
                                .get(target_col_name.as_str())
                                .ok_or_else(|| {
                                    EngineError::CollectionNotFound(CollectionNotFoundError {
                                        collection: target_col_name.clone(),
                                        message: format!(
                                            "Populate: collection '{}' referenced by '{}' relationship is not in the database",
                                            target_col_name, rel_name
                                        ),
                                    })
                                })?;

                            match target_col.get(&tid).cloned() {
                                Some(target) => {
                                    let target = if let Some(ncfg) = nested_cfg {
                                        apply_populate(
                                            vec![target],
                                            ncfg,
                                            &target_col_name,
                                            all_collections,
                                            depth + 1,
                                        )?
                                        .into_iter()
                                        .next()
                                        .unwrap_or(Value::Null)
                                    } else {
                                        target
                                    };
                                    populated.insert(rel_name.clone(), target);
                                }
                                None => {
                                    // Dangling string FK → DanglingReferenceError
                                    return Err(EngineError::DanglingReference(
                                        DanglingReferenceError {
                                            collection: rel_desc.target.clone(),
                                            field: fk_field.clone(),
                                            target_id: tid.clone(),
                                            message: format!(
                                                "Entity in \"{}\" references missing \"{}\" with {}=\"{}\"",
                                                source_col_name, rel_desc.target, fk_field, tid
                                            ),
                                        },
                                    ));
                                }
                            }
                        }
                        Some(_) => {
                            // Non-string / non-null FK in a Ref field → population skips it.
                            // Population only resolves String FKs (a ref must be a string id).
                        }
                    }
                }
                RelationshipKind::Inverse => {
                    let fk_field =
                        resolve_inv_fk_population(rel_desc, source_col_name, all_collections);
                    let target_col_name = rel_desc.target.clone();
                    let entity_id = entity
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let nested_cfg = nested_pop_config(rel_value);

                    // Missing target collection → CollectionNotFound (descriptor mismatch,
                    // not a dangling reference — the inverse always returns an array).
                    let target_col_for_inv = all_collections
                        .get(target_col_name.as_str())
                        .ok_or_else(|| {
                            EngineError::CollectionNotFound(CollectionNotFoundError {
                                collection: target_col_name.clone(),
                                message: format!(
                                    "Populate: collection '{}' referenced by inverse '{}' relationship is not in the database",
                                    target_col_name, rel_name
                                ),
                            })
                        })?;

                    let children: Vec<Value> = target_col_for_inv
                        .list()
                        .into_iter()
                        .filter(|t| t.get(&fk_field) == Some(&Value::String(entity_id.clone())))
                        .cloned()
                        .collect();

                    let children = if let Some(ncfg) = nested_cfg {
                        apply_populate(
                            children,
                            ncfg,
                            &target_col_name,
                            all_collections,
                            depth + 1,
                        )?
                    } else {
                        children
                    };

                    populated.insert(rel_name.clone(), Value::Array(children));
                }
            }
        }

        result.push(Value::Object(populated));
    }

    Ok(result)
}

/// Extract the nested populate config from a populate value.
/// `true` → no nesting (`None`); `{...}` → nested config (`Some`).
fn nested_pop_config(v: &Value) -> Option<&Value> {
    match v {
        Value::Object(_) => Some(v),
        _ => None,
    }
}
