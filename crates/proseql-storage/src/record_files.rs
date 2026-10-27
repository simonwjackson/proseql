//! Stem-keyed, single-object files. Loading and planning perform no writes.
use crate::{
    generation::{GenerationCheck, SourceGeneration},
    host::StorageHost,
    partitioned::safe_component,
    path::{join_path, relative_to_root},
    persistence::{decode_entity_map, CollectionStorageConfig, ValidationMode},
    source_config::RecordFilesSourceConfig,
};
use indexmap::IndexMap;
use proseql_engine::{
    descriptor::IdStrategy,
    errors::{EngineError, SourceConfigError},
};
use proseql_formats::FormatRegistry;
use serde_json::Value;

#[derive(Debug, Clone, Default)]
pub struct LoadedRecordFiles {
    pub records: IndexMap<String, Value>,
    pub generations: IndexMap<String, SourceGeneration>,
}

#[derive(Debug)]
pub enum RecordFileOperation {
    Replace { path: String, content: String },
    Remove { path: String },
}
impl RecordFileOperation {
    pub fn path(&self) -> &str {
        match self {
            Self::Replace { path, .. } | Self::Remove { path } => path,
        }
    }
}

pub fn error(
    source: &RecordFilesSourceConfig,
    path: &str,
    message: impl Into<String>,
) -> EngineError {
    EngineError::SourceConfig(Box::new(SourceConfigError {
        message: message.into(),
        source_id: Some(source.id.clone()),
        collection: Some(source.collection.clone()),
        path: Some(path.into()),
    }))
}
pub fn record_path(source: &RecordFilesSourceConfig, id: &str) -> Result<String, EngineError> {
    let path = join_path(&source.root, &format!("{id}.{}", source.format));
    if !safe_component(id) {
        return Err(error(
            source,
            &path,
            format!("Unsafe record ID '{id}' at '{path}'"),
        ));
    }
    Ok(path)
}
/// Extension filtering deliberately does not validate stems. A matching bad
/// stem must be reported by load, never silently filtered out.
pub fn matches_record_path(source: &RecordFilesSourceConfig, path: &str) -> bool {
    let relative = relative_to_root(&source.root, path);
    !relative.starts_with('.')
        && !relative.contains('/')
        && relative.ends_with(&format!(".{}", source.format))
}

pub fn load_record_files(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    source: &RecordFilesSourceConfig,
    collection: &CollectionStorageConfig,
) -> Result<LoadedRecordFiles, EngineError> {
    let mut loaded = LoadedRecordFiles::default();
    if !host.exists(&source.root)? {
        return Ok(loaded);
    }
    let mut paths = host.list_directory_with_stat(&source.root)?;
    paths.sort_by(|a, b| a.0.cmp(&b.0));
    for (path, stat) in paths {
        if !matches_record_path(source, &path) || host.is_directory(&path)? {
            continue;
        }
        // exists also performs interrupted-replacement recovery before stat.
        if !host.exists(&path)? {
            continue;
        }
        let id = std::path::Path::new(&path)
            .file_stem()
            .and_then(|id| id.to_str())
            .ok_or_else(|| error(source, &path, "Invalid filename"))?;
        record_path(source, id)?;
        let generation = SourceGeneration::observe_stat(host, &path, stat)?;
        let raw = host.read(&path)?;
        let decoded = formats
            .deserialize(&raw, &source.format)
            .map_err(|cause| error(source, &path, format!("Cannot decode '{path}': {cause:?}")))?;
        if !decoded.is_object() {
            return Err(error(
                source,
                &path,
                format!("Expected one record object at '{path}'"),
            ));
        }
        if matches!(collection.id_strategy, IdStrategy::Provided)
            && decoded.get("id").and_then(Value::as_str) != Some(id)
        {
            return Err(error(
                source,
                &path,
                format!("Payload ID must equal file stem '{id}' at '{path}'"),
            ));
        }
        let entries = serde_json::Map::from_iter([(id.to_owned(), decoded)]);
        let records = decode_entity_map(
            &path,
            &collection.schema,
            &collection.id_strategy,
            entries,
            ValidationMode::Strict,
        )
        .map_err(|cause| {
            error(
                source,
                &path,
                format!("Invalid record at '{path}': {cause}"),
            )
        })?;
        if generation.check(host)? != GenerationCheck::Unchanged {
            return Err(error(
                source,
                &path,
                format!("Source changed during load at '{path}'"),
            ));
        }
        loaded.records.extend(records);
        loaded.generations.insert(id.into(), generation);
    }
    Ok(loaded)
}

pub fn plan_record_files(
    formats: &FormatRegistry,
    source: &RecordFilesSourceConfig,
    collection: &CollectionStorageConfig,
    previous: &LoadedRecordFiles,
    candidate: &IndexMap<String, Value>,
) -> Result<Vec<RecordFileOperation>, EngineError> {
    let mut operations = Vec::new();
    for (id, record) in candidate {
        let path = record_path(source, id)?;
        if previous.records.get(id) == Some(record) {
            continue;
        }
        let mut payload = record.clone();
        if matches!(collection.id_strategy, IdStrategy::DerivedFromKey) {
            if let Some(object) = payload.as_object_mut() {
                object.shift_remove("id");
            }
        }
        if !payload.is_object() {
            return Err(error(source, &path, "RecordFiles requires object payloads"));
        }
        let payload = crate::persistence::encode_value(&collection.schema, &payload, id).map_err(
            |cause| {
                error(
                    source,
                    &path,
                    format!("Cannot encode record at '{path}': {cause}"),
                )
            },
        )?;
        let content = formats
            .serialize(&payload, &source.format, None)
            .map_err(|cause| error(source, &path, format!("Cannot encode '{path}': {cause:?}")))?;
        operations.push(RecordFileOperation::Replace { path, content });
    }
    for id in previous.records.keys() {
        if !candidate.contains_key(id) {
            operations.push(RecordFileOperation::Remove {
                path: record_path(source, id)?,
            });
        }
    }
    operations.sort_by(|a, b| a.path().cmp(b.path()));
    Ok(operations)
}

pub fn check_record_conflicts(
    host: &dyn StorageHost,
    previous: &LoadedRecordFiles,
    operations: &[RecordFileOperation],
) -> Result<(), EngineError> {
    for operation in operations {
        let path = operation.path();
        let id = std::path::Path::new(path)
            .file_stem()
            .and_then(|id| id.to_str())
            .unwrap_or("");
        let generation = previous
            .generations
            .get(id)
            .filter(|generation| generation.path == path);
        let unchanged = match generation {
            Some(generation) => generation.check(host)? == GenerationCheck::Unchanged,
            None => !host.exists(path)?,
        };
        if !unchanged {
            return Err(EngineError::Operation(
                proseql_engine::errors::OperationError {
                    operation: "write".into(),
                    reason: "source-changed".into(),
                    message: format!("File '{path}' changed since load; reload before retrying"),
                },
            ));
        }
    }
    Ok(())
}
