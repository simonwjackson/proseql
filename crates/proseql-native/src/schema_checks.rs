//! Storage codecs decode values without a callback registry. Defer only host
//! checks in that phase; the original schema remains on every engine collection.
//! Snapshot/resident publication validates that original schema with callbacks.
//! Lazy reloads also validate before evicting their last-known-good records.
use proseql_engine::callbacks::CallbackRegistry;
use proseql_engine::descriptor::{IdStrategy, SchemaNode};
use proseql_engine::errors::EngineError;
use proseql_engine::validator::validate_value_with_callbacks;
use proseql_storage::persistence::CollectionStorageConfig;
use serde_json::Value;

/// An ephemeral storage-decoding schema, never an engine descriptor. Preserve
/// transforms and built-in checks; host checks must run before publication.
pub(crate) fn storage_decode_schema(schema: &SchemaNode) -> SchemaNode {
    let mut schema = schema.clone();
    defer_host_checks(&mut schema);
    schema
}

fn defer_host_checks(schema: &mut SchemaNode) {
    match schema {
        SchemaNode::Checked { inner, checks } => {
            checks.retain(|check| check.callback_id().is_none());
            defer_host_checks(inner);
        }
        SchemaNode::Struct { fields } => {
            for field in fields {
                defer_host_checks(&mut field.schema);
            }
        }
        SchemaNode::Array { item: inner }
        | SchemaNode::Optional(inner)
        | SchemaNode::OptionalWithDefault { inner, .. }
        | SchemaNode::NullOr(inner) => defer_host_checks(inner),
        SchemaNode::Record { key, value } => {
            defer_host_checks(key);
            defer_host_checks(value);
        }
        _ => {}
    }
}

/// Validate already-decoded lazy records before removing any old resident
/// records. Engine insertion validates again, but that is too late to preserve
/// last-known-good on an invalid replacement of an existing partition.
pub(crate) fn validate_loaded_records<'a>(
    config: &CollectionStorageConfig,
    records: impl IntoIterator<Item = &'a Value>,
    callbacks: &CallbackRegistry,
) -> Result<(), EngineError> {
    for record in records {
        if matches!(config.id_strategy, IdStrategy::DerivedFromKey) {
            let mut payload = record.clone();
            if let Some(object) = payload.as_object_mut() {
                object.shift_remove("id");
            }
            validate_value_with_callbacks(&config.schema, &payload, Some(callbacks))?;
        } else {
            validate_value_with_callbacks(&config.schema, record, Some(callbacks))?;
        }
    }
    Ok(())
}
