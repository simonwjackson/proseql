//! Load and encode a collection-file source: one collection in one file.
//!
//! A Prose source gets its own codec built from the source's Prose options,
//! so two Prose files never share a learned template.

use indexmap::IndexMap;
use proseql_engine::errors::EngineError;
use proseql_formats::prose::ProseCodec;
use proseql_formats::FormatRegistry;
use serde_json::Value;

use crate::host::StorageHost;
use crate::memory::MemoryStorageHost;
use crate::persistence::{
    load_data, save_data, CollectionStorageConfig, LoadDataOptions, SaveDataOptions, ValidationMode,
};
use crate::source_config::NormalizedCollectionFileSourceConfig;

fn with_source_codec<R>(
    formats: &FormatRegistry,
    source: &NormalizedCollectionFileSourceConfig,
    f: impl FnOnce(&FormatRegistry) -> Result<R, EngineError>,
) -> Result<R, EngineError> {
    match &source.prose {
        Some(options) => f(&FormatRegistry::new(vec![Box::new(
            ProseCodec::with_options(options.clone()),
        )])),
        None => f(formats),
    }
}

/// Reads and validates the file's records. A missing file is an empty
/// collection.
pub fn load_collection_file(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    source: &NormalizedCollectionFileSourceConfig,
    collection: &CollectionStorageConfig,
) -> Result<IndexMap<String, Value>, EngineError> {
    with_source_codec(formats, source, |formats| {
        load_data(
            host,
            formats,
            &source.path,
            &collection.schema,
            LoadDataOptions {
                version: collection.version,
                migrations: collection.migrations.clone(),
                collection_name: Some(collection.name.clone()),
                format: Some(source.format.clone()),
                path: None,
                validation: ValidationMode::Strict,
                id_strategy: Some(collection.id_strategy.clone()),
            },
            None,
        )
    })
}

/// Reject duplicate or missing array IDs before the normal loader builds a map.
/// Object codecs already represent identity as unique keys.
pub fn validate_collection_file_ids(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    source: &NormalizedCollectionFileSourceConfig,
) -> Result<(), EngineError> {
    let _phase = crate::diagnostics::span("decode_id_validation_including_drop");
    with_source_codec(formats, source, |formats| {
        let raw = host.read(&source.path)?;
        let decoded = formats
            .deserialize(&raw, &source.format)
            .map_err(crate::persistence::format_error)?;
        if let Some(records) = decoded.as_array() {
            let mut ids = std::collections::HashSet::new();
            for record in records {
                let id = record.get("id").and_then(Value::as_str);
                if id.is_none() || !ids.insert(id.unwrap()) {
                    return Err(EngineError::SourceConfig(Box::new(
                        proseql_engine::errors::SourceConfigError {
                            message: "Partition records need unique string IDs".into(),
                            source_id: Some(source.id.clone()),
                            collection: Some(source.collection.clone()),
                            path: Some(source.path.clone()),
                        },
                    )));
                }
            }
        }
        Ok(())
    })
}

/// Returns the complete file content for `records`. The caller owns the
/// durable write.
pub fn encode_collection_file(
    formats: &FormatRegistry,
    source: &NormalizedCollectionFileSourceConfig,
    collection: &CollectionStorageConfig,
    records: &IndexMap<String, Value>,
) -> Result<String, EngineError> {
    with_source_codec(formats, source, |formats| {
        let memory = MemoryStorageHost::default();
        save_data(
            &memory,
            formats,
            &source.path,
            &collection.schema,
            records,
            SaveDataOptions {
                version: collection.version,
                format: Some(source.format.clone()),
                path: None,
                id_strategy: Some(collection.id_strategy.clone()),
            },
        )?;
        memory.read(&source.path)
    })
}
