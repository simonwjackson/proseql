//! Storage codecs have no callback registry. Collections with host checks stage
//! raw records, then use the engine's callback-aware decoder before publication.
//! Keep its returned values: decoding can filter Record keys as well as validate.
use indexmap::IndexMap;
use proseql_engine::callbacks::CallbackRegistry;
use proseql_engine::descriptor::{IdStrategy, SchemaNode};
use proseql_engine::errors::EngineError;
use proseql_engine::validator::decode_owned_value_with_callbacks;
use serde_json::Value;

/// A temporary schema for storage loading, never an engine descriptor. Stage
/// the entire raw payload when host checks exist: decoding values beneath a
/// rejected Record key before its predicate runs could incorrectly fail a load.
pub(crate) fn storage_decode_schema(schema: &SchemaNode) -> SchemaNode {
    if needs_host_decode(schema) {
        SchemaNode::Unknown
    } else {
        schema.clone()
    }
}

fn needs_host_decode(schema: &SchemaNode) -> bool {
    match schema {
        SchemaNode::Checked { inner, checks } => {
            checks.iter().any(|check| check.callback_id().is_some()) || needs_host_decode(inner)
        }
        SchemaNode::Struct { fields } => {
            fields.iter().any(|field| needs_host_decode(&field.schema))
        }
        SchemaNode::Array { item: inner }
        | SchemaNode::Optional(inner)
        | SchemaNode::OptionalWithDefault { inner, .. }
        | SchemaNode::NullOr(inner) => needs_host_decode(inner),
        SchemaNode::Record { key, value } => needs_host_decode(key) || needs_host_decode(value),
        _ => false,
    }
}

/// Apply the original engine schema once to staged raw payloads. Collections
/// without host checks already decoded in storage and must not decode twice
/// (for example NumberFromString expects encoded strings, not runtime numbers).
/// Call before durable migration writeback, snapshot publication or lazy eviction.
pub(crate) fn decode_loaded_records(
    schema: &SchemaNode,
    id_strategy: &IdStrategy,
    records: &mut IndexMap<String, Value>,
    callbacks: &CallbackRegistry,
) -> Result<(), EngineError> {
    if !needs_host_decode(schema) {
        return Ok(());
    }
    for (id, record) in records {
        let mut payload = record.clone();
        let derived = matches!(id_strategy, IdStrategy::DerivedFromKey);
        if derived {
            if let Some(object) = payload.as_object_mut() {
                object.shift_remove("id");
            }
        }
        let mut decoded = decode_owned_value_with_callbacks(schema, payload, Some(callbacks))?;
        if derived {
            if let Some(object) = decoded.as_object_mut() {
                object.insert("id".into(), Value::String(id.clone()));
            }
        }
        *record = decoded;
    }
    Ok(())
}
