use std::sync::Arc;
use std::time::Duration;

use indexmap::IndexMap;
use proseql_engine::errors::EngineError;
use proseql_formats::FormatRegistry;
use proseql_storage::append::{
    encode_append_lines, is_append_format, load_append_file, plan_append, PlannedAppend,
    TornLineDiagnostic,
};
use proseql_storage::collection_file::{encode_collection_file, load_collection_file};
use proseql_storage::document_graph::{
    load_document_graph_sources, DocumentGraphTransformHost, LoadedDocumentGraph,
};
use proseql_storage::document_source::{
    load_document_sources, plan_document_source, LoadedDocumentSources, PlannedDocumentWrite,
    SaveDocumentSourceInput,
};
use proseql_storage::host::StorageHost;
use proseql_storage::partitioned::{
    file_source, load_partitioned_source_with, matches_partition_path, partition_path,
    plan_partitioned_source, LoadedPartitions,
};
use proseql_storage::persistence::{CollectionStorageConfig, DurableStorageHost};
use proseql_storage::source_config::NormalizedCollectionFileSourceConfig;
use proseql_storage::source_config::NormalizedDatabaseSourceConfig;
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
    /// Lazy partition policies by source ID (native only). Each named source
    /// must be a `Partitioned` JSONL source of an `append_only` collection
    /// without `unique_fields` or relationships; open fails with
    /// `SourceConfigError` otherwise. See `docs/native-sources.md`.
    pub lazy_partitions: IndexMap<String, crate::lazy::LazyPartitionPolicy>,
    /// How often the managed watch compares lazy sources with the disk (the
    /// directory listing and the loaded partitions only).
    pub lazy_watch_interval: Duration,
}

impl Default for NativeSourceRuntimeOptions {
    fn default() -> Self {
        Self {
            formats: FormatRegistry::with_builtins(),
            transforms: None,
            watch_debounce: Some(Duration::from_millis(50)),
            lazy_partitions: IndexMap::new(),
            lazy_watch_interval: Duration::from_secs(2),
        }
    }
}

/// The writes for one mutation and the source state they produce.
pub(crate) struct SourcePlan {
    pub writes: Vec<PlannedDocumentWrite>,
    pub documents: LoadedDocumentSources,
    pub files: IndexMap<String, IndexMap<String, Value>>,
    pub partitions: IndexMap<String, LoadedPartitions>,
}

/// Appends for one mutation of append-only collections, and the records they add.
pub(crate) struct AppendPlan {
    /// Sorted by path.
    pub writes: Vec<PlannedAppend>,
    /// New records in journal order.
    pub records: Vec<AppendedRecord>,
}

/// One record an append plan writes.
pub(crate) struct AppendedRecord {
    pub collection: String,
    /// The file the record's line goes to.
    pub path: String,
    pub id: String,
    pub record: Value,
}

/// Bytes compared at the end of an append target before the append.
const APPEND_CONFLICT_TAIL: usize = 4096;

pub(crate) struct SourceState {
    pub config: NormalizedSourceConfig,
    /// Append-only collections on JSONL/NDJSON collection-file or partitioned
    /// sources. They persist creates by appending lines, never by rewriting.
    pub appendable: std::collections::HashSet<String>,
    /// Torn final lines ignored by the last load and not yet appended over.
    pub torn: Vec<TornLineDiagnostic>,
    /// Basenames of files this runtime appended to. The managed watcher skips
    /// a reload when such a file still equals its stored content.
    pub self_written: std::collections::HashSet<String>,
    pub documents: LoadedDocumentSources,
    /// Records of each collection-file source, keyed by collection name.
    pub files: IndexMap<String, IndexMap<String, Value>>,
    pub partitions: IndexMap<String, LoadedPartitions>,
    pub graph: LoadedDocumentGraph,
    pub transforms: Option<Arc<dyn DocumentGraphTransformHost>>,
    /// Stored bytes of every loaded file, the conflict baseline.
    pub contents: IndexMap<String, Vec<u8>>,
    /// Lazy partitioned collections by collection name. Their records are not
    /// in `partitions`; the engine collection holds the loaded partitions.
    pub lazy: IndexMap<String, crate::lazy::LazyCollection>,
    pub lazy_watch_interval: Duration,
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
                proseql_storage::source_config::NormalizedDatabaseSourceConfig::CollectionFile(
                    source,
                ) => &source.collection == name,
                NormalizedDatabaseSourceConfig::Partitioned(source) => &source.collection == name,
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
            if let proseql_storage::source_config::NormalizedDatabaseSourceConfig::CollectionFile(
                source,
            ) = source
            {
                Self::require_writable_path(&normalized, &source.id, &source.path)?;
            }
        }
        Ok(normalized)
    }

    /// Collections that persist creates by appending lines.
    pub fn appendable_collections(
        config: &NativeSourceRuntimeConfig,
        normalized: &NormalizedSourceConfig,
    ) -> std::collections::HashSet<String> {
        let append_only = config
            .collections
            .iter()
            .filter(|collection| collection.descriptor.append_only)
            .map(|collection| collection.descriptor.name.as_str())
            .collect::<std::collections::HashSet<_>>();
        normalized
            .sources
            .iter()
            .filter_map(|source| match source {
                NormalizedDatabaseSourceConfig::CollectionFile(source)
                    if is_append_format(&source.format) =>
                {
                    Some(&source.collection)
                }
                NormalizedDatabaseSourceConfig::Partitioned(source)
                    if is_append_format(&source.format) =>
                {
                    Some(&source.collection)
                }
                _ => None,
            })
            .filter(|collection| append_only.contains(collection.as_str()))
            .cloned()
            .collect()
    }

    fn require_writable_path(
        config: &NormalizedSourceConfig,
        owner: &str,
        path: &str,
    ) -> Result<(), EngineError> {
        let contains = |root: &str| {
            if root == "." {
                !std::path::Path::new(path).is_absolute()
                    && path != ".."
                    && !path.starts_with("../")
            } else {
                std::path::Path::new(path).starts_with(root)
            }
        };
        for source in &config.sources {
            let conflicting = match source {
                proseql_storage::source_config::NormalizedDatabaseSourceConfig::Documents(
                    source,
                ) => {
                    source.id != owner
                        && contains(&source.root)
                        && proseql_storage::source_config::matches_document_source_pattern(
                            source, path,
                        )
                }
                proseql_storage::source_config::NormalizedDatabaseSourceConfig::DocumentGraph(
                    source,
                ) => source.roots.iter().any(|root| {
                    if !contains(&root.root) {
                        return false;
                    }
                    let relative = proseql_storage::path::relative_to_root(&root.root, path);
                    proseql_storage::source_config::matches_any_glob(&relative, &root.include)
                        && !proseql_storage::source_config::matches_any_glob(
                            &relative,
                            &root.exclude,
                        )
                }),
                proseql_storage::source_config::NormalizedDatabaseSourceConfig::CollectionFile(
                    source,
                ) => source.id != owner && source.path == path,
                NormalizedDatabaseSourceConfig::Partitioned(source) => {
                    source.id != owner && matches_partition_path(source, path)
                }
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

    #[allow(clippy::too_many_arguments)]
    pub fn load(
        host: &dyn StorageHost,
        formats: &FormatRegistry,
        config: NormalizedSourceConfig,
        appendable: std::collections::HashSet<String>,
        transforms: Option<Arc<dyn DocumentGraphTransformHost>>,
        lazy: &IndexMap<String, crate::lazy::LazyCollection>,
        lazy_watch_interval: Duration,
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
        for source in &config.sources {
            if let NormalizedDatabaseSourceConfig::Partitioned(source) = source {
                if host.exists(&source.root)? {
                    for path in host.list_directory(&source.root)? {
                        if matches_partition_path(source, &path) {
                            Self::require_writable_path(&config, &source.id, &path)?;
                            host.exists(&path)?;
                        }
                    }
                }
            }
        }
        let snapshot = crate::read_snapshot::ReadSnapshot::new(host);
        let mut torn = Vec::new();
        let mut files = IndexMap::new();
        let mut file_contents = IndexMap::new();
        for source in &config.sources {
            let proseql_storage::source_config::NormalizedDatabaseSourceConfig::CollectionFile(
                source,
            ) = source
            else {
                continue;
            };
            if host.exists(&source.path)? {
                // Append-only files keep raw bytes: a torn final line can end
                // inside a UTF-8 sequence. Other files stay strict text.
                let content = if appendable.contains(&source.collection) {
                    snapshot.read_bytes(&source.path)?
                } else {
                    snapshot.read(&source.path)?.into_bytes()
                };
                file_contents.insert(source.path.clone(), content);
            }
            let collection = config
                .collection_configs
                .get(&source.collection)
                .ok_or_else(|| {
                    crate::operation_error(
                        "unknown-collection",
                        format!("Unknown collection '{}'", source.collection),
                    )
                })?;
            let records = if appendable.contains(&source.collection) {
                let loaded = load_append_file(&snapshot, formats, source, collection, false)?;
                torn.extend(loaded.torn);
                loaded.records
            } else {
                load_collection_file(&snapshot, formats, source, collection)?
            };
            files.insert(source.collection.clone(), records);
        }
        let mut partitions = IndexMap::new();
        let mut lazy_state = IndexMap::new();
        for source in &config.sources {
            if let NormalizedDatabaseSourceConfig::Partitioned(source) = source {
                if let Some(lazy) = lazy.get(&source.collection) {
                    // Lazy: list file names only; partitions load on demand.
                    let mut state = lazy.skeleton();
                    state.known = crate::lazy::list_partitions(host, source)?;
                    lazy_state.insert(source.collection.clone(), state);
                    continue;
                }
                let collection = &config.collection_configs[&source.collection];
                let (loaded, partition_torn) = load_partitioned_source_with(
                    &snapshot,
                    formats,
                    source,
                    collection,
                    appendable.contains(&source.collection),
                )?;
                torn.extend(partition_torn);
                for path in loaded.files.keys() {
                    let content = if appendable.contains(&source.collection) {
                        snapshot.read_bytes(path)?
                    } else {
                        snapshot.read(path)?.into_bytes()
                    };
                    file_contents.insert(path.clone(), content);
                }
                partitions.insert(source.collection.clone(), loaded);
            }
        }
        let documents = load_document_sources(&snapshot, formats, &config, None)?;
        let graph =
            load_document_graph_sources(&snapshot, formats, &config, None, transforms.as_deref())?;
        let mut contents = documents
            .documents
            .iter()
            .map(|document| {
                snapshot
                    .read(&document.path)
                    .map(|content| (document.path.clone(), content.into_bytes()))
            })
            .collect::<Result<IndexMap<_, _>, _>>()?;
        contents.extend(file_contents);
        Ok(Self {
            config,
            appendable,
            torn,
            self_written: std::collections::HashSet::new(),
            documents,
            files,
            partitions,
            graph,
            transforms,
            contents,
            lazy: lazy_state,
            lazy_watch_interval,
        })
    }

    pub fn collections(&self) -> IndexMap<String, IndexMap<String, Value>> {
        let mut collections = self.documents.collections.clone();
        collections.extend(self.files.clone());
        collections.extend(
            self.partitions
                .iter()
                .map(|(name, partitions)| (name.clone(), partitions.records())),
        );
        for (name, values) in &self.graph.collections {
            collections.insert(name.clone(), values.clone());
        }
        // Lazy collections hold their loaded partitions in the engine only;
        // a snapshot replacement must leave them alone (see `lazy_refresh`).
        collections.retain(|name, _| !self.lazy.contains_key(name));
        collections
    }

    pub fn plan(
        &self,
        formats: &FormatRegistry,
        candidate: &IndexMap<String, IndexMap<String, Value>>,
    ) -> Result<SourcePlan, EngineError> {
        let mut next = self.documents.clone();
        let mut writes = Vec::new();
        let mut files = self.files.clone();
        let mut partitions = self.partitions.clone();
        for source in &self.config.sources {
            if let NormalizedDatabaseSourceConfig::Partitioned(source) = source {
                if self.appendable.contains(&source.collection) {
                    continue;
                }
                let records = candidate
                    .get(&source.collection)
                    .cloned()
                    .unwrap_or_default();
                let (loaded, planned) = plan_partitioned_source(
                    formats,
                    source,
                    &self.config.collection_configs[&source.collection],
                    &self.partitions[&source.collection],
                    &records,
                )?;
                for write in &planned {
                    Self::require_writable_path(&self.config, &source.id, &write.path)?;
                }
                writes.extend(planned);
                partitions.insert(source.collection.clone(), loaded);
            }
        }
        for source in &self.config.sources {
            let proseql_storage::source_config::NormalizedDatabaseSourceConfig::CollectionFile(
                source,
            ) = source
            else {
                continue;
            };
            if self.appendable.contains(&source.collection) {
                continue;
            }
            let records = candidate
                .get(&source.collection)
                .cloned()
                .unwrap_or_default();
            if self.files.get(&source.collection) == Some(&records) {
                continue;
            }
            let collection = self
                .config
                .collection_configs
                .get(&source.collection)
                .ok_or_else(|| {
                    crate::operation_error(
                        "unknown-collection",
                        format!("Unknown collection '{}'", source.collection),
                    )
                })?;
            writes.push(PlannedDocumentWrite {
                path: source.path.clone(),
                content: encode_collection_file(formats, source, collection, &records)?,
            });
            files.insert(source.collection.clone(), records);
        }
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
        next.collections = candidate
            .iter()
            .filter(|(name, _)| !files.contains_key(*name) && !partitions.contains_key(*name))
            .map(|(name, records)| (name.clone(), records.clone()))
            .collect();
        writes.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(SourcePlan {
            writes,
            documents: next,
            files,
            partitions,
        })
    }

    /// The file and collection-file view an append-only record is written to.
    fn append_target(
        &self,
        collection: &str,
        record: &Value,
    ) -> Result<(String, NormalizedCollectionFileSourceConfig), EngineError> {
        for source in &self.config.sources {
            match source {
                NormalizedDatabaseSourceConfig::CollectionFile(source)
                    if source.collection == collection =>
                {
                    return Ok((source.path.clone(), source.clone()));
                }
                NormalizedDatabaseSourceConfig::Partitioned(source)
                    if source.collection == collection =>
                {
                    let path = partition_path(source, record)?;
                    Self::require_writable_path(&self.config, &source.id, &path)?;
                    let file = file_source(source, &path);
                    return Ok((path, file));
                }
                _ => {}
            }
        }
        Err(crate::operation_error(
            "unowned-collection",
            format!("Collection '{collection}' has no source owner"),
        ))
    }

    /// Plan appends for the journal's changes to append-only collections. Only
    /// the new records are routed and encoded; no collection is snapshotted.
    pub fn plan_appends(
        &self,
        formats: &FormatRegistry,
        journal: &proseql_engine::change_set::ChangeSet,
    ) -> Result<AppendPlan, EngineError> {
        let mut by_path: IndexMap<
            String,
            (
                String,
                NormalizedCollectionFileSourceConfig,
                IndexMap<String, Value>,
            ),
        > = IndexMap::new();
        let mut records = Vec::new();
        for change in journal.entities() {
            if !self.appendable.contains(&change.collection) {
                continue;
            }
            let (None, Some(record)) = (&change.before, &change.after) else {
                return Err(crate::operation_error(
                    "append-only",
                    format!(
                        "Append-only collection '{}' can only add records; '{}' changed",
                        change.collection, change.id
                    ),
                ));
            };
            let (path, file) = self.append_target(&change.collection, record)?;
            if let Some(lazy) = self.lazy.get(&change.collection) {
                // The engine's ID check covered the resident partitions; an
                // append into a partition that is not resident was not checked.
                if !lazy.resident.contains_key(&path) {
                    return Err(crate::operation_error(
                        "lazy-partition-not-loaded",
                        format!(
                            "Record '{}' routes to partition '{path}', which was not loaded for the ID check; include the partition field '{}' in the create input",
                            change.id,
                            lazy.source.partition_by.field()
                        ),
                    ));
                }
            }
            by_path
                .entry(path.clone())
                .or_insert_with(|| (change.collection.clone(), file, IndexMap::new()))
                .2
                .insert(change.id.clone(), record.clone());
            records.push(AppendedRecord {
                collection: change.collection.clone(),
                path,
                id: change.id.clone(),
                record: record.clone(),
            });
        }
        let mut writes = Vec::with_capacity(by_path.len());
        for (path, (collection, file, batch)) in &by_path {
            let lines = encode_append_lines(
                formats,
                file,
                &self.config.collection_configs[collection],
                batch,
            )?;
            let current = self.contents.get(path).map(Vec::as_slice).unwrap_or(&[]);
            writes.push(plan_append(path, current, lines));
        }
        writes.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(AppendPlan { writes, records })
    }

    /// Reject an append when its target changed since load. Compares the file
    /// length and its final bytes only, so the cost does not grow with the file.
    pub fn check_append_conflicts(
        &self,
        host: &dyn DurableStorageHost,
        writes: &[PlannedAppend],
    ) -> Result<(), EngineError> {
        for write in writes {
            let current = host.read_tail(&write.path, APPEND_CONFLICT_TAIL)?;
            let unchanged = match (current, self.contents.get(&write.path)) {
                (None, None) => true,
                (Some(tail), Some(stored)) => {
                    tail.len == stored.len() as u64 && stored.ends_with(&tail.tail)
                }
                _ => false,
            };
            if !unchanged {
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

    /// Record durable appends in the stored file state and source records.
    pub fn apply_appends(&mut self, plan: AppendPlan) {
        for write in &plan.writes {
            let content = self.contents.entry(write.path.clone()).or_default();
            content.truncate(write.keep_len as usize);
            content.extend_from_slice(write.data.as_bytes());
            self.torn.retain(|torn| torn.path != write.path);
            if let Some(name) = std::path::Path::new(&write.path)
                .file_name()
                .and_then(|name| name.to_str())
            {
                self.self_written.insert(name.to_owned());
            }
        }
        for AppendedRecord {
            collection,
            path,
            id,
            record,
        } in plan.records
        {
            if let Some(lazy) = self.lazy.get_mut(&collection) {
                lazy.record_append(&path, id);
            } else if let Some(partitions) = self.partitions.get_mut(&collection) {
                partitions.files.entry(path).or_default().insert(id, record);
            } else if let Some(records) = self.files.get_mut(&collection) {
                records.insert(id, record);
            }
        }
    }

    /// `true` when the watcher events in `names` (file basenames) are fully
    /// explained by this runtime's own appends: every file with such a name
    /// under the watch roots is a stored file that still equals its content.
    pub fn own_appends_explain(
        &self,
        host: &dyn StorageHost,
        events: &[proseql_storage::host::StorageEvent],
    ) -> Result<bool, EngineError> {
        if events.is_empty() {
            // An earlier debounced pass already handled every event.
            return Ok(true);
        }
        let basename = |path: &str| {
            std::path::Path::new(path)
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_owned)
        };
        if events.iter().all(|event| event.path.is_some()) {
            // Exact paths: every changed file must be one this runtime
            // appended to and still equal its stored bytes. A same-named file
            // elsewhere (for example under an overlapping graph root) has
            // another path and reloads.
            for event in events {
                let changed =
                    proseql_storage::path::normalize_path(event.path.as_deref().unwrap_or(""));
                let Some((path, stored)) = self
                    .contents
                    .iter()
                    .find(|(path, _)| proseql_storage::path::normalize_path(path) == changed)
                else {
                    return Ok(false);
                };
                if !basename(path).is_some_and(|name| self.self_written.contains(&name))
                    || !host.exists(path)?
                    || &host.read_bytes(path)? != stored
                {
                    return Ok(false);
                }
            }
            return Ok(true);
        }
        let names = events
            .iter()
            .map(|event| event.filename.clone())
            .collect::<Vec<_>>();
        let mut wanted = std::collections::HashSet::new();
        for name in &names {
            match name {
                Some(name) if self.self_written.contains(name) => {
                    wanted.insert(name.as_str());
                }
                _ => return Ok(false),
            }
        }
        let graph_roots = self
            .config
            .sources
            .iter()
            .filter_map(|source| match source {
                NormalizedDatabaseSourceConfig::DocumentGraph(source) => Some(source),
                _ => None,
            })
            .flat_map(|source| source.roots.iter().map(|root| root.root.clone()))
            .collect::<Vec<_>>();
        let mut candidates = std::collections::BTreeSet::new();
        for root in self.watch_roots(host)? {
            // Without paths, a graph file under the same watch root can share
            // the basename; its change cannot be told apart, so reload.
            if graph_roots.iter().any(|graph| {
                std::path::Path::new(graph).starts_with(&root)
                    || std::path::Path::new(&root).starts_with(graph)
            }) {
                return Ok(false);
            }
            for path in host.list_recursive(&root)? {
                if basename(&path).is_some_and(|name| wanted.contains(name.as_str())) {
                    candidates.insert(path);
                }
            }
        }
        for path in self.contents.keys() {
            if basename(path).is_some_and(|name| wanted.contains(name.as_str())) {
                candidates.insert(path.clone());
            }
        }
        for path in candidates {
            let Some(stored) = self.contents.get(&path) else {
                return Ok(false);
            };
            if !host.exists(&path)? || &host.read_bytes(&path)? != stored {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn check_conflicts(
        &self,
        host: &dyn StorageHost,
        writes: &[PlannedDocumentWrite],
    ) -> Result<(), EngineError> {
        for write in writes {
            let current = if host.exists(&write.path)? {
                Some(host.read(&write.path)?.into_bytes())
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
                proseql_storage::source_config::NormalizedDatabaseSourceConfig::CollectionFile(
                    source,
                ) => roots.push(
                    std::path::Path::new(&source.path)
                        .parent()
                        .map(|parent| parent.to_string_lossy().into_owned())
                        .unwrap_or_else(|| ".".to_owned()),
                ),
                // Lazy sources are polled by the runtime's own watcher, which
                // reads only the listing and the loaded partitions.
                NormalizedDatabaseSourceConfig::Partitioned(source)
                    if self.lazy.contains_key(&source.collection) => {}
                NormalizedDatabaseSourceConfig::Partitioned(source) => {
                    roots.push(source.root.clone())
                }
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
