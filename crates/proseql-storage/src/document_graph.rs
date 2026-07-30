use std::collections::HashSet;
use std::panic::{self, AssertUnwindSafe};

use indexmap::IndexMap;
use proseql_engine::errors::{
    DocumentGraphErrorKind, DocumentGraphSourceError, EngineError, SourceConfigError,
};
use proseql_engine::validator::decode_value;
use proseql_formats::{FormatRegistry, FormatRegistryError};
use serde_json::Value;

use crate::host::StorageHost;
use crate::path::{get_file_extension, relative_to_root};
use crate::persistence::{
    assert_no_physical_derived_id, hydrate_derived_id, require_hydratable_payload, run_migrations,
    MigrationHost,
};
use crate::source_config::{
    matches_any_glob, DocumentGraphFragmentErrorPolicy, NormalizedDatabaseSourceConfig,
    NormalizedDocumentGraphSourceConfig, NormalizedSourceConfig,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentGraphDiagnosticAction {
    SkippedFragment,
    SkippedRoot,
    IgnoredCollection,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DocumentGraphDiagnostic {
    pub source_id: String,
    pub root_id: String,
    pub path: Option<String>,
    pub action: DocumentGraphDiagnosticAction,
    pub collection: Option<String>,
    pub record_id: Option<String>,
    pub message: String,
    pub error: Option<DocumentGraphSourceError>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DocumentGraphTransformContext {
    pub source_id: String,
    pub root_id: String,
    pub path: String,
    pub extension: String,
}

pub trait DocumentGraphTransformHost: Send + Sync {
    fn run_transform(
        &self,
        callback_id: &str,
        document: &Value,
        context: &DocumentGraphTransformContext,
    ) -> Result<Value, Value>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct DocumentGraphRecordContribution {
    pub source_id: String,
    pub root_id: String,
    pub path: String,
    pub collection: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DocumentGraphRecordProvenance {
    pub source_id: String,
    pub collection: String,
    pub id: String,
    pub contributors: Vec<DocumentGraphRecordContribution>,
    pub effective_contributor: DocumentGraphRecordContribution,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadedDocumentGraph {
    pub collections: IndexMap<String, IndexMap<String, Value>>,
    pub contributing_paths: IndexMap<String, Vec<String>>,
    pub provenance: IndexMap<String, DocumentGraphRecordProvenance>,
    pub diagnostics: Vec<DocumentGraphDiagnostic>,
    pub owned_collections: IndexMap<String, String>,
}

fn provenance_key(collection: &str, id: &str) -> String {
    format!("{collection}\u{0}{id}")
}

fn graph_error(
    source_id: &str,
    path: &str,
    kind: DocumentGraphErrorKind,
    message: String,
) -> EngineError {
    EngineError::DocumentGraphSource(Box::new(DocumentGraphSourceError {
        source_id: source_id.to_owned(),
        path: path.to_owned(),
        message,
        kind,
        collection: None,
        record_id: None,
        contributing_paths: None,
        cause: None,
    }))
}

fn graph_source_config_error(
    source_id: &str,
    collection: Option<&str>,
    path: Option<&str>,
    message: impl Into<String>,
) -> EngineError {
    EngineError::SourceConfig(Box::new(SourceConfigError {
        message: message.into(),
        source_id: Some(source_id.to_owned()),
        collection: collection.map(str::to_owned),
        path: path.map(str::to_owned),
    }))
}

fn collection_config<'a>(
    config: &'a NormalizedSourceConfig,
    source_id: &str,
    collection: &str,
    path: Option<&str>,
) -> Result<&'a crate::persistence::CollectionStorageConfig, EngineError> {
    config.collection_configs.get(collection).ok_or_else(|| {
        graph_source_config_error(
            source_id,
            Some(collection),
            path,
            format!(
                "Source '{}' references collection '{}' without a declared collection config",
                source_id, collection
            ),
        )
    })
}

fn validate_source_config(
    config: &NormalizedSourceConfig,
    source: &NormalizedDocumentGraphSourceConfig,
) -> Result<(), EngineError> {
    for collection in &source.collections {
        let _ = collection_config(config, &source.id, collection, None)?;
    }
    for root in &source.roots {
        for collection in &root.collections {
            if !source.collections.contains(collection) {
                return Err(graph_source_config_error(
                    &source.id,
                    Some(collection),
                    Some(&root.root),
                    format!(
                        "Document graph source '{}' root '{}' references collection '{}' outside the graph source collections",
                        source.id, root.root, collection
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn deep_merge(base: Value, overlay: Value) -> Value {
    match (base, overlay) {
        (Value::Object(mut base), Value::Object(overlay)) => {
            for (key, overlay_value) in overlay {
                let next = base
                    .remove(&key)
                    .map(|base_value| deep_merge(base_value, overlay_value.clone()))
                    .unwrap_or_else(|| overlay_value.clone());
                base.insert(key, next);
            }
            Value::Object(base)
        }
        (_, overlay) => overlay,
    }
}

fn handle_fragment_error(
    source: &NormalizedDocumentGraphSourceConfig,
    diagnostics: &mut Vec<DocumentGraphDiagnostic>,
    root_id: &str,
    error: &DocumentGraphSourceError,
) -> Result<bool, EngineError> {
    match source.on_fragment_error {
        DocumentGraphFragmentErrorPolicy::Error => {
            Err(EngineError::DocumentGraphSource(Box::new(error.clone())))
        }
        DocumentGraphFragmentErrorPolicy::SkipFragment => {
            diagnostics.push(DocumentGraphDiagnostic {
                source_id: source.id.clone(),
                root_id: root_id.to_owned(),
                path: Some(error.path.clone()),
                action: DocumentGraphDiagnosticAction::SkippedFragment,
                collection: error.collection.clone(),
                record_id: error.record_id.clone(),
                message: error.message.clone(),
                error: Some(error.clone()),
            });
            Ok(false)
        }
        DocumentGraphFragmentErrorPolicy::SkipRoot => {
            diagnostics.push(DocumentGraphDiagnostic {
                source_id: source.id.clone(),
                root_id: root_id.to_owned(),
                path: Some(error.path.clone()),
                action: DocumentGraphDiagnosticAction::SkippedRoot,
                collection: error.collection.clone(),
                record_id: error.record_id.clone(),
                message: error.message.clone(),
                error: Some(error.clone()),
            });
            Ok(true)
        }
    }
}

pub fn load_document_graph_sources(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    config: &NormalizedSourceConfig,
    migration_host: Option<&dyn MigrationHost>,
    transform_host: Option<&dyn DocumentGraphTransformHost>,
) -> Result<LoadedDocumentGraph, EngineError> {
    let mut raw_collections: IndexMap<String, IndexMap<String, Value>> = IndexMap::new();
    let mut contributing_paths: IndexMap<String, Vec<String>> = IndexMap::new();
    let mut contributor_map: IndexMap<String, Vec<DocumentGraphRecordContribution>> =
        IndexMap::new();
    let mut diagnostics = Vec::new();
    let mut owned_collections = IndexMap::new();
    for source in &config.sources {
        let NormalizedDatabaseSourceConfig::DocumentGraph(source) = source else {
            continue;
        };
        for collection in &source.collections {
            owned_collections.insert(collection.clone(), source.id.clone());
            raw_collections.entry(collection.clone()).or_default();
        }

        validate_source_config(config, source)?;

        for root in &source.roots {
            if !host.exists(&root.root)? {
                if root.optional {
                    continue;
                }
                return Err(graph_error(
                    &source.id,
                    &root.root,
                    DocumentGraphErrorKind::MissingRoot,
                    format!(
                        "Document graph source '{}' root '{}' does not exist",
                        source.id, root.root
                    ),
                ));
            }
            let mut matched = host
                .list_recursive(&root.root)?
                .into_iter()
                .filter(|path| {
                    let relative = relative_to_root(&root.root, path);
                    matches_any_glob(&relative, &root.include)
                        && !matches_any_glob(&relative, &root.exclude)
                })
                .collect::<Vec<_>>();
            matched.sort_by(|a, b| {
                relative_to_root(&root.root, a).cmp(&relative_to_root(&root.root, b))
            });

            let root_allowed: HashSet<String> = root.collections.iter().cloned().collect();
            let mut root_effective: IndexMap<String, IndexMap<String, Value>> = source
                .collections
                .iter()
                .map(|collection| (collection.clone(), IndexMap::new()))
                .collect();
            let mut root_contributing: IndexMap<String, Vec<String>> = IndexMap::new();
            let mut root_provenance: IndexMap<String, Vec<DocumentGraphRecordContribution>> =
                IndexMap::new();
            let mut skip_root = false;

            for path in matched {
                let raw = host.read(&path)?;
                if raw.trim().is_empty() {
                    continue;
                }
                let extension = get_file_extension(&path);
                let parsed = match formats.deserialize(&raw, &extension) {
                    Ok(value) => value,
                    Err(FormatRegistryError::UnsupportedFormat(_)) => {
                        let error = DocumentGraphSourceError {
                            source_id: source.id.clone(),
                            path: path.clone(),
                            message: format!(
                                "Document graph source '{}' cannot decode '{}': extension '.{}' is not registered",
                                source.id, path, extension
                            ),
                            kind: DocumentGraphErrorKind::UnsupportedExtension,
                            collection: None,
                            record_id: None,
                            contributing_paths: None,
                            cause: None,
                        };
                        if source.on_fragment_error == DocumentGraphFragmentErrorPolicy::Error {
                            return Err(EngineError::DocumentGraphSource(Box::new(error)));
                        }
                        skip_root =
                            handle_fragment_error(source, &mut diagnostics, &root.id, &error)?;
                        if skip_root {
                            break;
                        }
                        continue;
                    }
                    Err(FormatRegistryError::Serialization(error)) => {
                        if source.on_fragment_error == DocumentGraphFragmentErrorPolicy::Error {
                            return Err(EngineError::Serialization(Box::new(error)));
                        }
                        let error = DocumentGraphSourceError {
                            source_id: source.id.clone(),
                            path: path.clone(),
                            message: format!(
                                "Document graph source '{}' cannot decode '{}': {}",
                                source.id,
                                path,
                                EngineError::Serialization(Box::new(error.clone()))
                            ),
                            kind: DocumentGraphErrorKind::Deserialize,
                            collection: None,
                            record_id: None,
                            contributing_paths: None,
                            cause: Some(Value::String(
                                EngineError::Serialization(Box::new(error)).to_string(),
                            )),
                        };
                        skip_root =
                            handle_fragment_error(source, &mut diagnostics, &root.id, &error)?;
                        if skip_root {
                            break;
                        }
                        continue;
                    }
                };

                let document = if let Some(callback_id) = &source.transform_callback_id {
                    let Some(transform_host) = transform_host else {
                        let error = DocumentGraphSourceError {
                            source_id: source.id.clone(),
                            path: path.clone(),
                            message: format!(
                                "Document graph source '{}' requires a transform host for callback '{}'",
                                source.id, callback_id
                            ),
                            kind: DocumentGraphErrorKind::TransformFailure,
                            collection: None,
                            record_id: None,
                            contributing_paths: None,
                            cause: None,
                        };
                        skip_root =
                            handle_fragment_error(source, &mut diagnostics, &root.id, &error)?;
                        if skip_root {
                            break;
                        }
                        continue;
                    };
                    let context = DocumentGraphTransformContext {
                        source_id: source.id.clone(),
                        root_id: root.id.clone(),
                        path: path.clone(),
                        extension: extension.clone(),
                    };
                    match panic::catch_unwind(AssertUnwindSafe(|| {
                        transform_host.run_transform(callback_id, &parsed, &context)
                    })) {
                        Ok(Ok(value)) => value,
                        Ok(Err(cause)) => {
                            let error = DocumentGraphSourceError {
                                source_id: source.id.clone(),
                                path: path.clone(),
                                message: format!("Document graph transform rejected '{path}'"),
                                kind: DocumentGraphErrorKind::TransformFailure,
                                collection: None,
                                record_id: None,
                                contributing_paths: None,
                                cause: Some(cause),
                            };
                            skip_root =
                                handle_fragment_error(source, &mut diagnostics, &root.id, &error)?;
                            if skip_root {
                                break;
                            }
                            continue;
                        }
                        Err(_) => {
                            let error = DocumentGraphSourceError {
                                source_id: source.id.clone(),
                                path: path.clone(),
                                message: format!("Document graph transform threw for '{path}'"),
                                kind: DocumentGraphErrorKind::TransformDefect,
                                collection: None,
                                record_id: None,
                                contributing_paths: None,
                                cause: Some(Value::String("panic".to_owned())),
                            };
                            skip_root =
                                handle_fragment_error(source, &mut diagnostics, &root.id, &error)?;
                            if skip_root {
                                break;
                            }
                            continue;
                        }
                    }
                } else {
                    parsed
                };

                let document = match document {
                    Value::Null => continue,
                    Value::Object(document) => document,
                    _ => {
                        let error = DocumentGraphSourceError {
                            source_id: source.id.clone(),
                            path: path.clone(),
                            message: format!("Document graph source '{}' file '{}' must resolve to a top-level object", source.id, path),
                            kind: DocumentGraphErrorKind::NonObject,
                            collection: None,
                            record_id: None,
                            contributing_paths: None,
                            cause: None,
                        };
                        skip_root =
                            handle_fragment_error(source, &mut diagnostics, &root.id, &error)?;
                        if skip_root {
                            break;
                        }
                        continue;
                    }
                };

                for (collection_name, section_value) in document {
                    if !source.collections.contains(&collection_name) {
                        let error = DocumentGraphSourceError {
                            source_id: source.id.clone(),
                            path: path.clone(),
                            message: format!("Unknown collection '{collection_name}' in '{path}'"),
                            kind: DocumentGraphErrorKind::UnknownCollection,
                            collection: Some(collection_name),
                            record_id: None,
                            contributing_paths: None,
                            cause: None,
                        };
                        skip_root =
                            handle_fragment_error(source, &mut diagnostics, &root.id, &error)?;
                        if skip_root {
                            break;
                        }
                        continue;
                    }
                    if !root_allowed.contains(&collection_name) {
                        diagnostics.push(DocumentGraphDiagnostic {
                            source_id: source.id.clone(),
                            root_id: root.id.clone(),
                            path: Some(path.clone()),
                            action: DocumentGraphDiagnosticAction::IgnoredCollection,
                            collection: Some(collection_name.clone()),
                            record_id: None,
                            message: format!(
                                "Collection '{collection_name}' is not allowed in root '{}'",
                                root.id
                            ),
                            error: None,
                        });
                        continue;
                    }
                    let mut section = match section_value {
                        Value::Object(section) => section,
                        _ => {
                            let error = DocumentGraphSourceError {
                                source_id: source.id.clone(),
                                path: path.clone(),
                                message: format!(
                                    "Collection '{}' in '{}' must be an object keyed by record id",
                                    collection_name, path
                                ),
                                kind: DocumentGraphErrorKind::NonObject,
                                collection: Some(collection_name.clone()),
                                record_id: None,
                                contributing_paths: None,
                                cause: None,
                            };
                            skip_root =
                                handle_fragment_error(source, &mut diagnostics, &root.id, &error)?;
                            if skip_root {
                                break;
                            }
                            continue;
                        }
                    };
                    let collection_config =
                        collection_config(config, &source.id, &collection_name, Some(&path))?;
                    let file_version =
                        section.get("_version").and_then(Value::as_u64).unwrap_or(0) as u32;
                    section.shift_remove("_version");
                    if let Some(target_version) = collection_config.version {
                        if file_version > target_version {
                            let error = DocumentGraphSourceError {
                                source_id: source.id.clone(),
                                path: path.clone(),
                                message: format!(
                                    "File version {file_version} is ahead of config version {target_version}. Cannot load data from a future version."
                                ),
                                kind: DocumentGraphErrorKind::Migration,
                                collection: Some(collection_name.clone()),
                                record_id: None,
                                contributing_paths: None,
                                cause: None,
                            };
                            skip_root =
                                handle_fragment_error(source, &mut diagnostics, &root.id, &error)?;
                            if skip_root {
                                break;
                            }
                            continue;
                        }
                        if file_version < target_version && !collection_config.migrations.is_empty()
                        {
                            section = match run_migrations(
                                section,
                                file_version,
                                target_version,
                                &collection_config.migrations,
                                &collection_name,
                                migration_host,
                            ) {
                                Ok(section) => section,
                                Err(error) => {
                                    let error = DocumentGraphSourceError {
                                        source_id: source.id.clone(),
                                        path: path.clone(),
                                        message: format!(
                                            "Document graph migration failed for '{path}'"
                                        ),
                                        kind: DocumentGraphErrorKind::Migration,
                                        collection: Some(collection_name.clone()),
                                        record_id: None,
                                        contributing_paths: None,
                                        cause: Some(Value::String(error.to_string())),
                                    };
                                    skip_root = handle_fragment_error(
                                        source,
                                        &mut diagnostics,
                                        &root.id,
                                        &error,
                                    )?;
                                    if skip_root {
                                        break;
                                    }
                                    continue;
                                }
                            };
                        }
                    }
                    for (id, value) in section {
                        let contribution = DocumentGraphRecordContribution {
                            source_id: source.id.clone(),
                            root_id: root.id.clone(),
                            path: path.clone(),
                            collection: collection_name.clone(),
                            id: id.clone(),
                        };
                        let collection_entries = root_effective.get_mut(&collection_name).ok_or_else(|| {
                            graph_source_config_error(
                                &source.id,
                                Some(&collection_name),
                                Some(&path),
                                format!(
                                    "Document graph source '{}' root '{}' references collection '{}' outside the graph source collections",
                                    source.id, root.root, collection_name
                                ),
                            )
                        })?;
                        if let Some(existing) = collection_entries.get_mut(&id) {
                            *existing = deep_merge(existing.clone(), value.clone());
                        } else {
                            collection_entries.insert(id.clone(), value.clone());
                        }
                        root_contributing
                            .entry(provenance_key(&collection_name, &id))
                            .or_default()
                            .push(path.clone());
                        root_provenance
                            .entry(provenance_key(&collection_name, &id))
                            .or_default()
                            .push(contribution);
                    }
                }
                if skip_root {
                    break;
                }
            }

            if skip_root {
                continue;
            }

            for collection_name in &source.collections {
                let current_collection =
                    raw_collections.entry(collection_name.clone()).or_default();
                let root_collection = root_effective
                    .shift_remove(collection_name)
                    .unwrap_or_default();
                for (id, merged_value) in root_collection {
                    let key = provenance_key(collection_name, &id);
                    let paths = root_contributing.get(&key).cloned().unwrap_or_default();
                    let contributors = root_provenance.get(&key).cloned().unwrap_or_default();
                    if let Some(existing) = current_collection.get_mut(&id) {
                        *existing = deep_merge(existing.clone(), merged_value.clone());
                    } else {
                        current_collection.insert(id.clone(), merged_value.clone());
                    }
                    contributing_paths
                        .entry(key.clone())
                        .or_default()
                        .extend(paths);
                    contributor_map.entry(key).or_default().extend(contributors);
                }
            }
        }
    }

    let mut collections: IndexMap<String, IndexMap<String, Value>> = IndexMap::new();
    let mut provenance = IndexMap::new();
    for (collection_name, records) in raw_collections {
        let collection_config =
            collection_config(config, "(document-graph)", &collection_name, None)?;
        let mut decoded_collection = IndexMap::new();
        for (id, merged_value) in records {
            let key = provenance_key(&collection_name, &id);
            let paths = contributing_paths.get(&key).cloned().unwrap_or_default();
            let contributors = contributor_map.get(&key).cloned().unwrap_or_default();
            let decoded = (|| {
                assert_no_physical_derived_id(
                    &id,
                    &merged_value,
                    &collection_config.id_strategy,
                    &contributors
                        .last()
                        .map(|c| c.path.clone())
                        .unwrap_or_default(),
                )?;
                let decoded = decode_value(&collection_config.schema, &merged_value)?;
                require_hydratable_payload(
                    &id,
                    &decoded,
                    &collection_config.id_strategy,
                    &contributors
                        .last()
                        .map(|c| c.path.clone())
                        .unwrap_or_default(),
                )?;
                Ok::<Value, EngineError>(hydrate_derived_id(
                    &id,
                    decoded,
                    &collection_config.id_strategy,
                ))
            })();
            let decoded = match decoded {
                Ok(decoded) => decoded,
                Err(error) => {
                    return Err(EngineError::DocumentGraphSource(Box::new(
                        DocumentGraphSourceError {
                            source_id: owned_collections
                                .get(&collection_name)
                                .cloned()
                                .unwrap_or_default(),
                            path: contributors
                                .last()
                                .map(|c| c.path.clone())
                                .unwrap_or_default(),
                            message: format!(
                                "Document graph validation failed for '{collection_name}/{id}'"
                            ),
                            kind: DocumentGraphErrorKind::Validation,
                            collection: Some(collection_name.clone()),
                            record_id: Some(id.clone()),
                            contributing_paths: Some(paths),
                            cause: Some(Value::String(error.to_string())),
                        },
                    )));
                }
            };
            decoded_collection.insert(id.clone(), decoded);
            if let Some(effective_contributor) = contributors.last().cloned() {
                provenance.insert(
                    key,
                    DocumentGraphRecordProvenance {
                        source_id: owned_collections
                            .get(&collection_name)
                            .cloned()
                            .unwrap_or_default(),
                        collection: collection_name.clone(),
                        id: id.clone(),
                        contributors,
                        effective_contributor,
                    },
                );
            }
        }
        collections.insert(collection_name, decoded_collection);
    }

    Ok(LoadedDocumentGraph {
        collections,
        contributing_paths,
        provenance,
        diagnostics,
        owned_collections,
    })
}
