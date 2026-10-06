use std::sync::Arc;
use std::time::Duration;

use indexmap::IndexMap;
use proseql_engine::errors::EngineError;
use proseql_formats::FormatRegistry;
use proseql_storage::document_graph::{
    load_document_graph_sources, DocumentGraphTransformHost, LoadedDocumentGraph,
};
use proseql_storage::document_source::{
    load_document_sources, plan_document_source, LoadedDocumentSources, PlannedDocumentWrite,
    SaveDocumentSourceInput,
};
use proseql_storage::host::StorageHost;
use proseql_storage::persistence::CollectionStorageConfig;
use proseql_storage::source_config::{
    normalize_source_config, DatabaseSourceConfig, NormalizedSourceConfig, SourceConfigInput,
};
use serde_json::Value;

use crate::{NativeCollectionConfig, NativeRuntimeConfig};

/// A source-oriented configuration. Every declared collection has one owner.
#[derive(Debug, Clone)]
pub struct NativeSourceRuntimeConfig {
    pub collections: Vec<NativeCollectionConfig>,
    pub sources: Vec<DatabaseSourceConfig>,
}

/// Native codec and graph-transform services. Later codec registrations override
/// earlier registrations for the same extension.
pub struct NativeSourceRuntimeOptions {
    pub formats: FormatRegistry,
    pub transforms: Option<Arc<dyn DocumentGraphTransformHost>>,
    /// `None` disables automatic watching; explicit reload remains available.
    pub watch_debounce: Option<Duration>,
}

impl Default for NativeSourceRuntimeOptions {
    fn default() -> Self {
        Self {
            formats: FormatRegistry::with_builtins(),
            transforms: None,
            watch_debounce: Some(Duration::from_millis(50)),
        }
    }
}

pub(crate) struct SourceState {
    pub config: NormalizedSourceConfig,
    pub documents: LoadedDocumentSources,
    pub graph: LoadedDocumentGraph,
    pub transforms: Option<Arc<dyn DocumentGraphTransformHost>>,
    pub contents: IndexMap<String, String>,
}

impl SourceState {
    pub fn normalize(
        config: &NativeSourceRuntimeConfig,
    ) -> Result<NormalizedSourceConfig, EngineError> {
        let mut names = std::collections::HashSet::new();
        for collection in &config.collections {
            if !names.insert(&collection.descriptor.name) {
                return Err(crate::operation_error(
                    "duplicate-collection",
                    format!("Duplicate collection '{}'", collection.descriptor.name),
                ));
            }
        }
        let collections = config
            .collections
            .iter()
            .map(|collection| {
                let descriptor = &collection.descriptor;
                (
                    descriptor.name.clone(),
                    CollectionStorageConfig {
                        name: descriptor.name.clone(),
                        schema: descriptor.schema.clone(),
                        id_strategy: descriptor.id_strategy.clone(),
                        version: descriptor.version,
                        migrations: vec![],
                    },
                )
            })
            .collect();
        let normalized = normalize_source_config(SourceConfigInput {
            collections,
            sources: config.sources.clone(),
        })?;
        for name in &normalized.collections {
            let owned = normalized.sources.iter().any(|source| match source {
                proseql_storage::source_config::NormalizedDatabaseSourceConfig::Documents(
                    source,
                ) => source.collections.contains(name),
                proseql_storage::source_config::NormalizedDatabaseSourceConfig::DocumentGraph(
                    source,
                ) => source.collections.contains(name),
            });
            if !owned {
                return Err(crate::operation_error(
                    "unowned-collection",
                    format!("Collection '{name}' has no source owner"),
                ));
            }
        }
        for source in &normalized.sources {
            if let proseql_storage::source_config::NormalizedDatabaseSourceConfig::Documents(
                source,
            ) = source
            {
                Self::require_writable_path(&normalized, &source.id, &source.outbox)?;
            }
        }
        Ok(normalized)
    }

    fn require_writable_path(
        config: &NormalizedSourceConfig,
        owner: &str,
        path: &str,
    ) -> Result<(), EngineError> {
        for source in &config.sources {
            let conflicting = match source {
                proseql_storage::source_config::NormalizedDatabaseSourceConfig::Documents(
                    source,
                ) => {
                    source.id != owner
                        && proseql_storage::source_config::matches_document_source_pattern(
                            source, path,
                        )
                }
                proseql_storage::source_config::NormalizedDatabaseSourceConfig::DocumentGraph(
                    source,
                ) => source.roots.iter().any(|root| {
                    let relative = proseql_storage::path::relative_to_root(&root.root, path);
                    proseql_storage::source_config::matches_any_glob(&relative, &root.include)
                        && !proseql_storage::source_config::matches_any_glob(
                            &relative,
                            &root.exclude,
                        )
                }),
            };
            if conflicting {
                return Err(crate::operation_error(
                    "source-overlap",
                    format!("Writable path '{path}' overlaps another source"),
                ));
            }
        }
        Ok(())
    }

    pub fn load(
        host: &dyn StorageHost,
        formats: &FormatRegistry,
        config: NormalizedSourceConfig,
        transforms: Option<Arc<dyn DocumentGraphTransformHost>>,
    ) -> Result<Self, EngineError> {
        // FsStorageHost::exists recovers per-file markers. Do this before the
        // loader lists files: recovery can remove an uncommitted first write.
        for source in &config.sources {
            let proseql_storage::source_config::NormalizedDatabaseSourceConfig::Documents(source) =
                source
            else {
                continue;
            };
            host.exists(&source.outbox)?;
            if host.exists(&source.root)? {
                for path in host.list_recursive(&source.root)? {
                    if proseql_storage::source_config::matches_document_source_pattern(
                        source, &path,
                    ) {
                        Self::require_writable_path(&config, &source.id, &path)?;
                        host.exists(&path)?;
                    }
                }
            }
        }
        let snapshot = crate::read_snapshot::ReadSnapshot::new(host);
        let documents = load_document_sources(&snapshot, formats, &config, None)?;
        let graph =
            load_document_graph_sources(&snapshot, formats, &config, None, transforms.as_deref())?;
        let contents = documents
            .documents
            .iter()
            .map(|document| {
                snapshot
                    .read(&document.path)
                    .map(|content| (document.path.clone(), content))
            })
            .collect::<Result<_, _>>()?;
        Ok(Self {
            config,
            documents,
            graph,
            transforms,
            contents,
        })
    }

    pub fn collections(&self) -> IndexMap<String, IndexMap<String, Value>> {
        let mut collections = self.documents.collections.clone();
        for (name, values) in &self.graph.collections {
            collections.insert(name.clone(), values.clone());
        }
        collections
    }

    pub fn plan(
        &self,
        formats: &FormatRegistry,
        candidate: &IndexMap<String, IndexMap<String, Value>>,
    ) -> Result<(Vec<PlannedDocumentWrite>, LoadedDocumentSources), EngineError> {
        let mut next = self.documents.clone();
        let mut writes = Vec::new();
        for source in &self.config.sources {
            let proseql_storage::source_config::NormalizedDatabaseSourceConfig::Documents(source) =
                source
            else {
                continue;
            };
            let plan = plan_document_source(
                formats,
                SaveDocumentSourceInput {
                    config: self.config.clone(),
                    source_id: source.id.clone(),
                    collections: candidate.clone(),
                    origins: next.origins,
                    documents: next.documents,
                },
                Some(&self.documents.collections),
            )?;
            for write in &plan.writes {
                Self::require_writable_path(&self.config, &source.id, &write.path)?;
            }
            writes.extend(plan.writes);
            next.origins = plan.saved.origins;
            next.documents = plan.saved.documents;
        }
        next.collections = candidate.clone();
        writes.sort_by(|left, right| left.path.cmp(&right.path));
        Ok((writes, next))
    }

    pub fn check_conflicts(
        &self,
        host: &dyn StorageHost,
        writes: &[PlannedDocumentWrite],
    ) -> Result<(), EngineError> {
        for write in writes {
            let current = if host.exists(&write.path)? {
                Some(host.read(&write.path)?)
            } else {
                None
            };
            if current.as_ref() != self.contents.get(&write.path) {
                return Err(crate::operation_error(
                    "source-changed",
                    format!(
                        "File '{}' changed since load; reload before retrying",
                        write.path
                    ),
                ));
            }
        }
        Ok(())
    }

    pub fn watch_roots(&self, host: &dyn StorageHost) -> Result<Vec<String>, EngineError> {
        let mut roots = Vec::new();
        for source in &self.config.sources {
            match source {
                proseql_storage::source_config::NormalizedDatabaseSourceConfig::Documents(
                    source,
                ) => roots.push(source.root.clone()),
                proseql_storage::source_config::NormalizedDatabaseSourceConfig::DocumentGraph(
                    source,
                ) => roots.extend(source.roots.iter().map(|root| root.root.clone())),
            }
        }
        for root in &mut roots {
            while !host.exists(root)? {
                *root = std::path::Path::new(root)
                    .parent()
                    .filter(|path| !path.as_os_str().is_empty())
                    .ok_or_else(|| {
                        crate::operation_error("watch-root", "No existing source ancestor to watch")
                    })?
                    .to_string_lossy()
                    .into_owned();
            }
        }
        roots.sort();
        roots.dedup();
        // A recursive watch on an ancestor already covers nested roots.
        let all = roots.clone();
        roots.retain(|root| {
            !all.iter()
                .any(|parent| parent != root && std::path::Path::new(root).starts_with(parent))
        });
        Ok(roots)
    }

    pub fn descriptor_config(config: NativeSourceRuntimeConfig) -> NativeRuntimeConfig {
        NativeRuntimeConfig {
            path: String::new(),
            collections: config.collections,
        }
    }
}
