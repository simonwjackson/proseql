//! Shared relationship resolution, validation, and error helpers.

use std::collections::HashSet;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::collection::Collection;
use crate::descriptor::{RelationshipDescriptor, RelationshipKind};
use crate::errors::{
    CollectionNotFoundError, EngineError, ForeignKeyError, NotFoundError, OperationError,
};
use crate::query::sort::value_to_js_string;
use crate::validator::js_eq;

// ── FK resolvers ──────────────────────────────────────────────────────────────

/// Resolve the FK field for **population** of an inverse relationship.
///
/// Priority (matches TS `resolveInverseForeignKey`):
/// 1. Explicit `foreign_key` on the inverse descriptor.
/// 2. Reverse Ref in target collection: use that Ref's **explicit** `foreign_key` ONLY.
/// 3. Singularize SOURCE collection name (`ies`→`y`, else strip `s`) and append `Id`.
pub(super) fn resolve_inv_fk_population(
    desc: &RelationshipDescriptor,
    source_col_name: &str,
    all_collections: &IndexMap<String, Collection>,
) -> String {
    // 1. Explicit FK on the inverse descriptor
    if let Some(ref fk) = desc.foreign_key {
        return fk.clone();
    }

    // 2. Reverse Ref in target collection: explicit FK ONLY
    if let Some(target_col) = all_collections.get(desc.target.as_str()) {
        for (_, rel_desc) in &target_col.descriptor.relationships {
            if rel_desc.kind == RelationshipKind::Ref && rel_desc.target == source_col_name {
                if let Some(ref fk) = rel_desc.foreign_key {
                    return fk.clone();
                }
                // No explicit FK → fall through to singularize
            }
        }
    }

    // 3. Singularize SOURCE collection name (TS fallback)
    format!("{}Id", singularize(source_col_name))
}

/// Resolve the FK field for **CRUD** operations on an inverse relationship.
///
/// Priority (matches TS `findForeignKey`):
/// 1. Explicit `foreign_key` on the inverse descriptor.
/// 2. Reverse Ref in target collection: explicit FK OR derived `<relName>Id`.
/// 3. `None` — no singularize fallback for CRUD (TS returns `null`).
pub(super) fn resolve_inv_fk_crud(
    desc: &RelationshipDescriptor,
    source_col_name: &str,
    all_collections: &IndexMap<String, Collection>,
) -> Option<String> {
    // 1. Explicit FK on the inverse descriptor
    if let Some(ref fk) = desc.foreign_key {
        return Some(fk.clone());
    }

    // 2. Reverse Ref: explicit FK or derived name
    if let Some(target_col) = all_collections.get(desc.target.as_str()) {
        for (rel_name, rel_desc) in &target_col.descriptor.relationships {
            if rel_desc.kind == RelationshipKind::Ref && rel_desc.target == source_col_name {
                return Some(ref_fk(rel_name, &rel_desc.foreign_key));
            }
        }
    }

    // 3. No fallback for CRUD
    None
}

/// TS singularize: `name.endsWith("ies") → slice(-3) + "y"`, else `.replace(/s$/, "")`.
fn singularize(name: &str) -> String {
    if let Some(stem) = name.strip_suffix("ies") {
        format!("{stem}y")
    } else {
        name.strip_suffix('s').unwrap_or(name).to_string()
    }
}

// ── Generic connect resolver ──────────────────────────────────────────────────

/// Build the `ForeignKeyError.value` string from a connect input.
///
/// - id-based connect (`{ "id": "ghost" }`) → bare id string `"ghost"`.
/// - arbitrary field connect (`{ "name": "Ghost" }`) → compact JSON `{"name":"Ghost"}`.
///
/// Mirrors JS behaviour: the TS engine surfaces the id or JSON.stringify of the
/// connect clause in error messages.
pub(super) fn connect_fk_error_value(input: &Value) -> String {
    if let Some(id) = input.get("id").and_then(Value::as_str) {
        return id.to_string();
    }
    // Compact JSON representation (JSON.stringify-like)
    input.to_string()
}

/// Resolve a connect input to a target entity's ID.
///
/// Mirrors TS `resolveConnectInput`:
/// 1. If input has an `id` field: look up by id (O(1)).
/// 2. Otherwise: find the first entity matching ALL input fields via JS `===`.
pub(super) fn resolve_connect(
    input: &Value,
    target_col: &str,
    all_collections: &IndexMap<String, Collection>,
) -> Result<String, String> {
    let obj = match input.as_object() {
        Some(o) => o,
        None => {
            return Err(format!("connect input must be an object, got: {}", input));
        }
    };

    let target = match all_collections.get(target_col) {
        Some(c) => c,
        None => return Err(format!("target collection '{}' not found", target_col)),
    };

    // Fast path: id field present
    if let Some(id_val) = obj.get("id") {
        let id_str = match id_val.as_str() {
            Some(s) => s,
            None => {
                return Err(format!(
                    "connect input.id must be a string, got: {}",
                    id_val
                ));
            }
        };
        if target.get(id_str).is_some() {
            return Ok(id_str.to_string());
        }
        return Err(format!(
            "Entity with id='{}' not found in '{}'",
            id_str, target_col
        ));
    }

    // Slow path: arbitrary field matching (JS strict equality)
    for entity in target.list() {
        if let Some(entity_obj) = entity.as_object() {
            let matches = obj
                .iter()
                .all(|(k, v)| entity_obj.get(k).map(|ev| js_eq(ev, v)).unwrap_or(false));
            if matches {
                if let Some(id_str) = entity.get("id").and_then(Value::as_str) {
                    return Ok(id_str.to_string());
                }
            }
        }
    }

    Err(format!(
        "No entity matching {:?} found in '{}'",
        input, target_col
    ))
}

/// Returns `true` if `value` contains at least one key starting with `$`.
/// Mirrors TS `isRelationshipOperation(value)`.
pub(super) fn is_relationship_op(value: &Value) -> bool {
    value
        .as_object()
        .map(|obj| obj.keys().any(|k| k.starts_with('$')))
        .unwrap_or(false)
}

// ── FK helpers ─────────────────────────────────────────────────────────────────

/// Return target entity ids whose foreign key points at `parent_id`.
pub(super) fn related_entity_ids(
    all_collections: &IndexMap<String, Collection>,
    target_collection: &str,
    foreign_key: &str,
    parent_id: &str,
) -> Vec<String> {
    all_collections
        .get(target_collection)
        .map(|collection| {
            collection
                .list()
                .into_iter()
                .filter(|entity| {
                    entity.get(foreign_key) == Some(&Value::String(parent_id.to_string()))
                })
                .filter_map(|entity| entity.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Derive the FK field name for a Ref relationship.
pub(super) fn ref_fk(rel_name: &str, foreign_key: &Option<String>) -> String {
    foreign_key
        .clone()
        .unwrap_or_else(|| format!("{}Id", rel_name))
}

/// Validate FK constraints for a create input or assembled entity state.
///
/// Mirrors TS `validateForeignKeysEffect`:
/// - `null` / absent FK values are skipped.
/// - ALL non-null FK values are coerced via `String(value)` (JS String coercion)
///   and looked up in the target collection.  This handles numeric, boolean,
///   object, and array FK values — exactly as TS does with `targetMap.has(String(value))`.
/// - Missing target collection: returns `ForeignKeyError` (not `CollectionNotFound`),
///   same as TS when the collection ref is unknown.
pub(crate) fn validate_fk(
    collection_name: &str,
    relationships: &[(String, RelationshipDescriptor)],
    data: &Value,
    all_collections: &IndexMap<String, Collection>,
) -> Result<(), EngineError> {
    validate_fk_with_exists(
        collection_name,
        relationships,
        data,
        |target_collection, target_id| {
            all_collections
                .get(target_collection)
                .map(|collection| collection.get(target_id).is_some())
                .unwrap_or(false)
        },
    )
}

pub(crate) fn validate_fk_with_owner_snapshot(
    collection_name: &str,
    relationships: &[(String, RelationshipDescriptor)],
    data: &Value,
    owner_snapshot: &IndexMap<String, Value>,
    all_collections: &IndexMap<String, Collection>,
) -> Result<(), EngineError> {
    validate_fk_with_exists(
        collection_name,
        relationships,
        data,
        |target_collection, target_id| {
            if target_collection == collection_name {
                owner_snapshot.contains_key(target_id)
            } else {
                all_collections
                    .get(target_collection)
                    .map(|collection| collection.get(target_id).is_some())
                    .unwrap_or(false)
            }
        },
    )
}

fn validate_fk_with_exists(
    collection_name: &str,
    relationships: &[(String, RelationshipDescriptor)],
    data: &Value,
    exists: impl Fn(&str, &str) -> bool,
) -> Result<(), EngineError> {
    let obj = match data.as_object() {
        Some(o) => o,
        None => return Ok(()),
    };

    for (rel_name, rel_desc) in relationships {
        if rel_desc.kind != RelationshipKind::Ref {
            continue;
        }
        let fk_field = ref_fk(rel_name, &rel_desc.foreign_key);
        let fk_val = match obj.get(&fk_field) {
            None | Some(Value::Null) => continue,
            Some(v) => v,
        };
        let tid = value_to_js_string(fk_val);
        if !exists(rel_desc.target.as_str(), &tid) {
            return Err(EngineError::ForeignKey(Box::new(ForeignKeyError {
                collection: collection_name.to_string(),
                field: fk_field.clone(),
                value: tid.clone(),
                target_collection: rel_desc.target.clone(),
                message: format!(
                    "FK constraint: '{}' references non-existent '{}' ({}={})",
                    collection_name, rel_desc.target, fk_field, tid
                ),
            })));
        }
    }

    Ok(())
}

pub(crate) fn fk_field_names(
    relationships: &[(String, RelationshipDescriptor)],
) -> HashSet<String> {
    relationships
        .iter()
        .filter(|(_, desc)| desc.kind == RelationshipKind::Ref)
        .map(|(name, desc)| ref_fk(name, &desc.foreign_key))
        .collect()
}

pub(crate) fn payload_touches_fk_field(value: &Value, fk_fields: &HashSet<String>) -> bool {
    value
        .as_object()
        .map(|object| object.keys().any(|key| fk_fields.contains(key)))
        .unwrap_or(false)
}

// ── Error helpers ─────────────────────────────────────────────────────────────

pub(crate) fn col_nf(name: &str) -> EngineError {
    EngineError::CollectionNotFound(CollectionNotFoundError {
        collection: name.to_string(),
        message: format!("Collection '{}' not found", name),
    })
}

pub(crate) fn ent_nf(collection: &str, id: &str) -> EngineError {
    EngineError::NotFound(NotFoundError {
        collection: collection.to_string(),
        id: id.to_string(),
        message: format!(
            "Entity with id \"{}\" not found in collection \"{}\"",
            id, collection
        ),
    })
}

pub(crate) fn op_err(operation: &str, reason: &str) -> EngineError {
    EngineError::Operation(OperationError {
        operation: operation.to_string(),
        reason: reason.to_string(),
        message: format!("{}: {}", operation, reason),
    })
}

pub(super) fn require_obj(v: Value, context: &str) -> Result<Map<String, Value>, EngineError> {
    match v {
        Value::Object(m) => Ok(m),
        _ => Err(op_err(context, "input must be a JSON object")),
    }
}
