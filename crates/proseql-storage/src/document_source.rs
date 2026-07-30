use indexmap::IndexMap;
use proseql_engine::errors::{
    DuplicatePhysicalFileError, DuplicateRecordError, EngineError, InvalidDocumentSourceError,
    SourceConfigError, SourceRecordOrigin, UnknownCollectionError,
};
use proseql_formats::FormatRegistry;
use serde_json::{Map, Value};

use crate::host::StorageHost;
use crate::persistence::{
    decode_entity_map, encode_value, is_version_sidecar_path, run_migrations,
    strip_derived_id_field, MigrationHost, ValidationMode,
};
use crate::source_config::{
    matches_document_source_pattern, NormalizedDatabaseSourceConfig,
    NormalizedDocumentSourceConfig, NormalizedSourceConfig, UnknownCollectionPolicy,
};

#[derive(Debug, Clone, PartialEq)]
pub struct LoadedDocument {
    pub source_id: String,
    pub path: String,
    pub data: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadedDocumentSources {
    pub collections: IndexMap<String, IndexMap<String, Value>>,
    pub origins: IndexMap<String, SourceRecordOrigin>,
    pub documents: Vec<LoadedDocument>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SavedDocumentSource {
    pub origins: IndexMap<String, SourceRecordOrigin>,
    pub documents: Vec<LoadedDocument>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SaveDocumentSourceInput {
    pub config: NormalizedSourceConfig,
    pub source_id: String,
    pub collections: IndexMap<String, IndexMap<String, Value>>,
    pub origins: IndexMap<String, SourceRecordOrigin>,
    pub documents: Vec<LoadedDocument>,
}

fn origin_key(collection: &str, id: &str) -> String {
    format!("{collection}\u{0}{id}")
}

fn collection_maps(names: &[String]) -> IndexMap<String, IndexMap<String, Value>> {
    names
        .iter()
        .map(|name| (name.clone(), IndexMap::new()))
        .collect()
}

fn duplicate_record_error(
    collection: &str,
    id: &str,
    first: SourceRecordOrigin,
    duplicate: SourceRecordOrigin,
) -> EngineError {
    EngineError::DuplicateRecord(Box::new(DuplicateRecordError {
        collection: collection.to_owned(),
        id: id.to_owned(),
        first,
        duplicate,
        message: format!("Duplicate record '{collection}/{id}' across document sources"),
    }))
}

fn source_config_error(
    message: impl Into<String>,
    source_id: &str,
    collection: Option<&str>,
    path: Option<&str>,
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
        source_config_error(
            format!(
                "Source '{}' references collection '{}' without a declared collection config",
                source_id, collection
            ),
            source_id,
            Some(collection),
            path,
        )
    })
}

fn validate_document_source_config(
    config: &NormalizedSourceConfig,
    source: &NormalizedDocumentSourceConfig,
) -> Result<(), EngineError> {
    for collection in &source.collections {
        let _ = collection_config(config, &source.id, collection, Some(&source.root))?;
        if !config.collections.contains(collection) {
            return Err(source_config_error(
                format!(
                    "Source '{}' references collection '{}' outside the normalized collection list",
                    source.id, collection
                ),
                &source.id,
                Some(collection),
                Some(&source.root),
            ));
        }
    }
    Ok(())
}

fn clone_document_for_source(
    document: &LoadedDocument,
    source: &NormalizedDocumentSourceConfig,
    config: &NormalizedSourceConfig,
) -> Map<String, Value> {
    let mut cloned = document.data.clone();
    for collection_name in &source.collections {
        let Some(Value::Object(section)) = cloned.get_mut(collection_name) else {
            continue;
        };
        let mut next = Map::new();
        if let Some(version) = config
            .collection_configs
            .get(collection_name)
            .and_then(|cfg| cfg.version)
        {
            next.insert("_version".to_owned(), Value::Number(version.into()));
        } else if let Some(version) = section.get("_version") {
            next.insert("_version".to_owned(), version.clone());
        }
        *section = next;
    }
    cloned
}

pub fn load_document_sources(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    config: &NormalizedSourceConfig,
    migration_host: Option<&dyn MigrationHost>,
) -> Result<LoadedDocumentSources, EngineError> {
    let mut collections = collection_maps(&config.collections);
    let mut origins = IndexMap::new();
    let mut documents = Vec::new();

    for source in &config.sources {
        let NormalizedDatabaseSourceConfig::Documents(source) = source else {
            continue;
        };
        validate_document_source_config(config, source)?;
        if !host.exists(&source.root)? {
            if source.optional {
                continue;
            }
            return Err(EngineError::Storage(Box::new(
                proseql_engine::errors::StorageError {
                    path: source.root.clone(),
                    operation: proseql_engine::errors::StorageOperation::List,
                    message: format!("Source root '{}' does not exist", source.root),
                    cause: None,
                },
            )));
        }
        let mut seen_paths = std::collections::HashSet::new();
        let mut matched = host
            .list_recursive(&source.root)?
            .into_iter()
            .filter(|path| {
                matches_document_source_pattern(source, path)
                    && !is_version_sidecar_path(path, &source.format)
            })
            .collect::<Vec<_>>();
        matched.sort();
        for path in matched {
            if !seen_paths.insert(path.clone()) {
                return Err(EngineError::DuplicatePhysicalFile(Box::new(
                    DuplicatePhysicalFileError {
                        source_id: source.id.clone(),
                        path: path.clone(),
                        message: format!(
                            "Document source '{}' discovered '{}' more than once",
                            source.id, path
                        ),
                    },
                )));
            }
            let raw = host.read(&path)?;
            if raw.trim().is_empty() {
                documents.push(LoadedDocument {
                    source_id: source.id.clone(),
                    path,
                    data: Map::new(),
                });
                continue;
            }
            let parsed = formats
                .deserialize(&raw, &source.format)
                .map_err(crate::persistence::format_error)?;
            let document = match parsed {
                Value::Null => Map::new(),
                Value::Object(document) => document,
                _ => {
                    return Err(EngineError::InvalidDocumentSource(Box::new(
                        InvalidDocumentSourceError {
                            source_id: source.id.clone(),
                            path: path.clone(),
                            message: format!(
                                "Document source '{}' file '{}' must contain a top-level object",
                                source.id, path
                            ),
                            collection: None,
                            id: None,
                        },
                    )))
                }
            };
            for (section_name, section_value) in &document {
                if source.collections.contains(section_name) {
                    continue;
                }
                if source.unknown_collections == UnknownCollectionPolicy::Error {
                    return Err(EngineError::UnknownCollection(Box::new(
                        UnknownCollectionError {
                            source_id: source.id.clone(),
                            path: path.clone(),
                            collection: section_name.clone(),
                            message: format!("Unknown collection '{}' in '{}'", section_name, path),
                        },
                    )));
                }
                let _ = section_value;
            }

            for collection_name in &source.collections {
                let Some(section_value) = document.get(collection_name).cloned() else {
                    continue;
                };
                let Value::Object(mut section) = section_value else {
                    return Err(EngineError::InvalidDocumentSource(Box::new(
                        InvalidDocumentSourceError {
                            source_id: source.id.clone(),
                            path: path.clone(),
                            message: format!(
                                "Collection '{}' in '{}' must be an object keyed by record id",
                                collection_name, path
                            ),
                            collection: Some(collection_name.clone()),
                            id: None,
                        },
                    )));
                };
                let file_version =
                    section.get("_version").and_then(Value::as_u64).unwrap_or(0) as u32;
                section.shift_remove("_version");
                let collection_config =
                    collection_config(config, &source.id, collection_name, Some(&path))?;
                if let Some(target_version) = collection_config.version {
                    if file_version > target_version {
                        return Err(EngineError::InvalidDocumentSource(Box::new(
                            InvalidDocumentSourceError {
                                source_id: source.id.clone(),
                                path: path.clone(),
                                message: format!(
                                    "File version {file_version} for collection '{collection_name}' is ahead of config version {target_version}"
                                ),
                                collection: Some(collection_name.clone()),
                                id: None,
                            },
                        )));
                    }
                    if file_version < target_version {
                        crate::persistence::validate_migration_registry(
                            collection_name,
                            target_version,
                            &collection_config.migrations,
                        )?;
                        if !collection_config.migrations.is_empty() {
                            section = run_migrations(
                                section,
                                file_version,
                                target_version,
                                &collection_config.migrations,
                                collection_name,
                                migration_host,
                            )?;
                        }
                    }
                }
                let decoded = decode_entity_map(
                    &path,
                    &collection_config.schema,
                    &collection_config.id_strategy,
                    section,
                    ValidationMode::Strict,
                )?;
                for (id, entity) in decoded {
                    let key = origin_key(collection_name, &id);
                    let origin = SourceRecordOrigin {
                        source_id: source.id.clone(),
                        path: path.clone(),
                        collection: collection_name.clone(),
                        id: id.clone(),
                    };
                    if let Some(first) = origins.get(&key).cloned() {
                        return Err(duplicate_record_error(collection_name, &id, first, origin));
                    }
                    let collection_entries = collections.get_mut(collection_name).ok_or_else(|| {
                        source_config_error(
                            format!(
                                "Source '{}' references collection '{}' outside the normalized collection list",
                                source.id, collection_name
                            ),
                            &source.id,
                            Some(collection_name),
                            Some(&path),
                        )
                    })?;
                    collection_entries.insert(id.clone(), entity);
                    origins.insert(key, origin);
                }
            }
            documents.push(LoadedDocument {
                source_id: source.id.clone(),
                path,
                data: document,
            });
        }
    }

    Ok(LoadedDocumentSources {
        collections,
        origins,
        documents,
    })
}

pub fn save_document_source(
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    input: SaveDocumentSourceInput,
    _migration_host: Option<&dyn MigrationHost>,
) -> Result<SavedDocumentSource, EngineError> {
    let source = input
        .config
        .sources
        .iter()
        .find_map(|source| match source {
            NormalizedDatabaseSourceConfig::Documents(source) if source.id == input.source_id => {
                Some(source.clone())
            }
            _ => None,
        })
        .ok_or_else(|| {
            EngineError::InvalidDocumentSource(Box::new(InvalidDocumentSourceError {
                source_id: input.source_id.clone(),
                path: String::new(),
                message: format!("Unknown document source '{}'", input.source_id),
                collection: None,
                id: None,
            }))
        })?;

    let mut projected_by_path = IndexMap::new();
    for document in input
        .documents
        .iter()
        .filter(|document| document.source_id == source.id)
    {
        projected_by_path.insert(
            document.path.clone(),
            clone_document_for_source(document, &source, &input.config),
        );
    }

    let mut new_origins = input.origins.clone();
    for (key, origin) in input.origins.iter() {
        if origin.source_id != source.id || !source.collections.contains(&origin.collection) {
            continue;
        }
        let exists = input
            .collections
            .get(&origin.collection)
            .map(|collection| collection.contains_key(&origin.id))
            .unwrap_or(false);
        if !exists {
            new_origins.shift_remove(key);
            if let Some(document) = projected_by_path.get_mut(&origin.path) {
                if let Some(Value::Object(section)) = document.get_mut(&origin.collection) {
                    section.shift_remove(&origin.id);
                }
            }
        }
    }

    for collection_name in &source.collections {
        let Some(collection) = input.collections.get(collection_name) else {
            continue;
        };
        let collection_config = collection_config(
            &input.config,
            &source.id,
            collection_name,
            Some(&source.root),
        )?;
        for (id, entity) in collection {
            let key = origin_key(collection_name, id);
            let existing_origin = input.origins.get(&key);
            if let Some(existing_origin) = existing_origin {
                if existing_origin.source_id != source.id {
                    continue;
                }
            }
            let path = existing_origin
                .map(|origin| origin.path.clone())
                .unwrap_or_else(|| source.outbox.clone());
            let document = projected_by_path
                .entry(path.clone())
                .or_insert_with(Map::new);
            let section_value = document
                .entry(collection_name.clone())
                .or_insert_with(|| Value::Object(Map::new()));
            let section = section_value.as_object_mut().ok_or_else(|| {
                EngineError::InvalidDocumentSource(Box::new(InvalidDocumentSourceError {
                    source_id: source.id.clone(),
                    path: path.clone(),
                    message: format!(
                        "Collection '{}' in '{}' must be an object keyed by record id",
                        collection_name, path
                    ),
                    collection: Some(collection_name.clone()),
                    id: None,
                }))
            })?;
            if let Some(version) = collection_config.version {
                section.insert("_version".to_owned(), Value::Number(version.into()));
            }
            let encoded = encode_value(
                &collection_config.schema,
                &strip_derived_id_field(entity, &collection_config.id_strategy),
                id,
            )?;
            section.insert(id.clone(), encoded);
            new_origins.insert(
                key,
                SourceRecordOrigin {
                    source_id: source.id.clone(),
                    path: path.clone(),
                    collection: collection_name.clone(),
                    id: id.clone(),
                },
            );
        }
    }

    let mut merged_documents = input
        .documents
        .into_iter()
        .filter(|document| document.source_id != source.id)
        .collect::<Vec<_>>();
    let writes = projected_by_path
        .iter()
        .map(|(path, data)| {
            formats
                .serialize(&Value::Object(data.clone()), &source.format, None)
                .map(|raw| (path.clone(), raw, data.clone()))
                .map_err(crate::persistence::format_error)
        })
        .collect::<Result<Vec<_>, _>>()?;
    for (path, raw, data) in writes {
        host.ensure_dir(&path)?;
        host.write(&path, &raw)?;
        merged_documents.push(LoadedDocument {
            source_id: source.id.clone(),
            path,
            data,
        });
    }
    merged_documents.sort_by(|left, right| left.path.cmp(&right.path));

    Ok(SavedDocumentSource {
        origins: new_origins,
        documents: merged_documents,
    })
}
