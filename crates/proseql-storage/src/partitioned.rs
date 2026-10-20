//! Aggregate flat collection files and project only changed partitions.
use indexmap::IndexMap;
use proseql_engine::errors::{EngineError, SourceConfigError};
use proseql_formats::FormatRegistry;
use serde_json::Value;

use crate::append::{is_append_format, load_append_file, TornLineDiagnostic};
use crate::collection_file::{
    encode_collection_file, load_collection_file, validate_collection_file_ids,
};
use crate::document_source::PlannedDocumentWrite;
use crate::host::StorageHost;
use crate::path::{join_path, normalize_path};
use crate::persistence::CollectionStorageConfig;
use crate::source_config::{
    NormalizedCollectionFileSourceConfig, PartitionKey, PartitionedSourceConfig,
};

#[derive(Debug, Clone, Default)]
pub struct LoadedPartitions {
    pub files: IndexMap<String, IndexMap<String, Value>>,
}

impl LoadedPartitions {
    pub fn records(&self) -> IndexMap<String, Value> {
        self.files
            .values()
            .flat_map(|records| {
                records
                    .iter()
                    .map(|(id, record)| (id.clone(), record.clone()))
            })
            .collect()
    }
}

pub(crate) fn safe_component(key: &str) -> bool {
    !key.is_empty()
        && !key.starts_with('.')
        && key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

fn error(source: &PartitionedSourceConfig, path: &str, message: impl Into<String>) -> EngineError {
    EngineError::SourceConfig(Box::new(SourceConfigError {
        message: message.into(),
        source_id: Some(source.id.clone()),
        collection: Some(source.collection.clone()),
        path: Some(path.into()),
    }))
}

pub fn partition_path(
    source: &PartitionedSourceConfig,
    record: &Value,
) -> Result<String, EngineError> {
    let field = match &source.partition_by {
        PartitionKey::Field { field } | PartitionKey::Prefix { field, .. } => field,
    };
    let value = record.get(field).and_then(Value::as_str).ok_or_else(|| {
        error(
            source,
            &source.root,
            format!("Partition field '{field}' must be a string"),
        )
    })?;
    let key = match &source.partition_by {
        PartitionKey::Field { .. } => value,
        PartitionKey::Prefix { delimiter, .. } => value
            .split_once(delimiter)
            .map(|(prefix, _)| prefix)
            .ok_or_else(|| {
                error(
                    source,
                    &source.root,
                    format!("Partition field '{field}' has no delimiter '{delimiter}'"),
                )
            })?,
    };
    if !safe_component(key) {
        return Err(error(
            source,
            &source.root,
            format!("Unsafe partition key '{key}'"),
        ));
    }
    Ok(join_path(&source.root, &format!("{key}.{}", source.format)))
}

pub fn matches_partition_path(source: &PartitionedSourceConfig, path: &str) -> bool {
    let normalized = normalize_path(path);
    let prefix = format!("{}/", source.root.trim_end_matches('/'));
    let relative = if source.root == "." && !std::path::Path::new(&normalized).is_absolute() {
        Some(normalized.as_str())
    } else {
        normalized.strip_prefix(&prefix)
    };
    relative.is_some_and(|relative| {
        !relative.contains('/') && relative.ends_with(&format!(".{}", source.format))
    })
}

/// The collection-file view of one partition file.
pub fn file_source(
    source: &PartitionedSourceConfig,
    path: &str,
) -> NormalizedCollectionFileSourceConfig {
    NormalizedCollectionFileSourceConfig {
        id: source.id.clone(),
        collection: source.collection.clone(),
        path: path.into(),
        format: source.format.clone(),
        prose: source.prose.clone(),
    }
}

pub fn load_partitioned_source(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    source: &PartitionedSourceConfig,
    collection: &CollectionStorageConfig,
) -> Result<LoadedPartitions, EngineError> {
    load_partitioned_source_with(host, formats, source, collection, false).map(|(loaded, _)| loaded)
}

/// Load every partition. With `append_only` on a JSONL source, a torn final
/// line in a partition is ignored and returned as a diagnostic (see
/// [`crate::append`]); all other checks are unchanged.
pub fn load_partitioned_source_with(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    source: &PartitionedSourceConfig,
    collection: &CollectionStorageConfig,
    append_only: bool,
) -> Result<(LoadedPartitions, Vec<TornLineDiagnostic>), EngineError> {
    let mut loaded = LoadedPartitions::default();
    let mut torn = Vec::new();
    if !host.exists(&source.root)? {
        return Ok((loaded, torn));
    }
    let tolerate_torn = append_only && is_append_format(&source.format);
    let mut paths = host.list_directory(&source.root)?;
    paths.sort();
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        if !matches_partition_path(source, &path) || !host.exists(&path)? {
            continue;
        }
        let file = file_source(source, &path);
        let records = if tolerate_torn {
            let file = load_append_file(host, formats, &file, collection, true)?;
            torn.extend(file.torn);
            file.records
        } else {
            validate_collection_file_ids(host, formats, &file)?;
            load_collection_file(host, formats, &file, collection)?
        };
        for (id, record) in &records {
            if !seen.insert(id.clone()) {
                return Err(error(
                    source,
                    &path,
                    format!("Duplicate partition record '{id}'"),
                ));
            }
            if partition_path(source, record)? != path {
                return Err(error(
                    source,
                    &path,
                    format!("Record '{id}' is in the wrong partition"),
                ));
            }
        }
        loaded.files.insert(path, records);
    }
    Ok((loaded, torn))
}

pub fn plan_partitioned_source(
    formats: &FormatRegistry,
    source: &PartitionedSourceConfig,
    collection: &CollectionStorageConfig,
    previous: &LoadedPartitions,
    candidate: &IndexMap<String, Value>,
) -> Result<(LoadedPartitions, Vec<PlannedDocumentWrite>), EngineError> {
    let mut next = LoadedPartitions {
        files: previous
            .files
            .keys()
            .map(|path| (path.clone(), IndexMap::new()))
            .collect(),
    };
    for (id, record) in candidate {
        let path = partition_path(source, record)?;
        next.files
            .entry(path)
            .or_default()
            .insert(id.clone(), record.clone());
    }
    let mut writes = Vec::new();
    for (path, records) in &next.files {
        if previous.files.get(path) == Some(records) {
            continue;
        }
        writes.push(PlannedDocumentWrite {
            path: path.clone(),
            content: encode_collection_file(
                formats,
                &file_source(source, path),
                collection,
                records,
            )?,
        });
    }
    Ok((next, writes))
}
