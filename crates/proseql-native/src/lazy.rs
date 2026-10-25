//! Lazy JSONL source configuration, partition manifests and watch generations.
//! Lazy rows are scanned from text and never installed in the engine.

use std::collections::{BTreeMap, BTreeSet};
use std::hash::Hasher;

use indexmap::IndexMap;
use proseql_engine::errors::{EngineError, OperationError, SourceConfigError};
use proseql_engine::query::indexes::IndexUsed;
use proseql_storage::append::is_append_format;
use proseql_storage::host::StorageHost;
use proseql_storage::partition_prune::{partition_key_of_path, PartitionFilter};
use proseql_storage::partitioned::matches_partition_path;
use proseql_storage::source_config::{
    NormalizedDatabaseSourceConfig, NormalizedSourceConfig, PartitionedSourceConfig,
};
use serde_json::Value;

use crate::sources::{NativeSourceRuntimeConfig, SourceState};

/// Full-scan policy for a lazy partitioned source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LazyPartitionPolicy {
    /// Ignored compatibility setting. Lazy collections never retain partitions.
    pub max_loaded_partitions: usize,
    /// What a query without a usable partition-field filter does.
    pub full_scan: FullScanPolicy,
}

impl LazyPartitionPolicy {
    /// A policy with `max_loaded_partitions` and full scans allowed.
    pub fn new(max_loaded_partitions: usize) -> Self {
        Self {
            max_loaded_partitions,
            full_scan: FullScanPolicy::Allow,
        }
    }
}

/// What an operation that cannot prune partitions does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FullScanPolicy {
    /// Scan every partition for that operation.
    #[default]
    Allow,
    /// Fail with `OperationError` (reason `lazy-full-scan`) and scan nothing.
    Error,
}

/// What a native query read. Returned by `NativeRuntime::query_with_stats`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeQueryStats {
    /// Partitions the query needed loaded: the partitions its filter can
    /// touch for a lazy source, every partition file for an eager
    /// partitioned source, 0 for other sources.
    pub partitions_loaded: usize,
    /// Of those, the partitions this query read from disk (lazy sources only).
    pub partitions_read: usize,
    /// Always zero for lazy sources,
    /// or `partitions_loaded` for eager partitioned sources.
    pub partitions_resident: usize,
    /// The index that supplied the candidates or their order.
    pub index_used: IndexUsed,
    /// Rows the predicate ran on at most.
    pub candidate_rows: usize,
    /// The ordered index supplied the sort order.
    pub index_sorted: bool,
}

/// The lazy state of one source. Returned by `NativeRuntime::lazy_partition_status`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LazyPartitionStatus {
    pub source_id: String,
    pub collection: String,
    /// Partition files in the last directory listing (plus files this
    /// runtime created).
    pub partitions: Vec<String>,
    /// Always empty. Lazy rows are not resident.
    pub loaded: Vec<String>,
    /// Always empty. Watches retain results, not partitions.
    pub pinned: Vec<String>,
}

pub(crate) struct LazyCollection {
    pub source_id: String,
    pub collection: String,
    pub policy: LazyPartitionPolicy,
    pub source: PartitionedSourceConfig,
    /// Partition file path → partition key, from the directory listing.
    pub known: BTreeMap<String, String>,
    /// Query-while-scanning state; see `execution.rs`.
    pub stream: crate::execution::LazyStreamState,
}

impl LazyCollection {
    /// The same source and policy with nothing listed or loaded.
    pub fn skeleton(&self) -> Self {
        Self {
            source_id: self.source_id.clone(),
            collection: self.collection.clone(),
            policy: self.policy,
            source: self.source.clone(),
            known: BTreeMap::new(),
            stream: Default::default(),
        }
    }

    /// Record a durable append's target in the manifest.
    pub fn record_append(&mut self, path: &str) {
        if let Some(key) = partition_key_of_path(&self.source, path) {
            self.known.insert(path.to_owned(), key);
        }
    }

    pub fn status(&self) -> LazyPartitionStatus {
        LazyPartitionStatus {
            source_id: self.source_id.clone(),
            collection: self.collection.clone(),
            partitions: self.known.keys().cloned().collect(),
            loaded: Vec::new(),
            pinned: Vec::new(),
        }
    }
}

fn config_error(
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

/// Check the lazy policies against the configuration (contract section 4).
pub(crate) fn configure_lazy(
    config: &NativeSourceRuntimeConfig,
    normalized: &NormalizedSourceConfig,
    policies: &IndexMap<String, LazyPartitionPolicy>,
) -> Result<IndexMap<String, LazyCollection>, EngineError> {
    let mut lazy = IndexMap::new();
    for (source_id, policy) in policies {
        let source = normalized
            .sources
            .iter()
            .find_map(|source| match source {
                NormalizedDatabaseSourceConfig::Partitioned(source) if &source.id == source_id => {
                    Some(Ok(source))
                }
                NormalizedDatabaseSourceConfig::Documents(source) if &source.id == source_id => {
                    Some(Err(()))
                }
                NormalizedDatabaseSourceConfig::DocumentGraph(source)
                    if &source.id == source_id =>
                {
                    Some(Err(()))
                }
                NormalizedDatabaseSourceConfig::CollectionFile(source)
                    if &source.id == source_id =>
                {
                    Some(Err(()))
                }
                _ => None,
            })
            .ok_or_else(|| {
                config_error(
                    format!("Lazy partition policy names unknown source '{source_id}'"),
                    source_id,
                    None,
                    None,
                )
            })?
            .map_err(|()| {
                config_error(
                    format!("Lazy partitions need a Partitioned source; '{source_id}' is not one"),
                    source_id,
                    None,
                    None,
                )
            })?;
        let name = source.collection.as_str();
        let fail = |message: String| config_error(message, source_id, Some(name), None);
        if !is_append_format(&source.format) {
            return Err(fail(format!(
                "Lazy partitions need a JSONL source; '{source_id}' uses '{}'",
                source.format
            )));
        }
        let descriptor = &config
            .collections
            .iter()
            .find(|collection| collection.descriptor.name == name)
            .ok_or_else(|| fail(format!("Unknown collection '{name}'")))?
            .descriptor;
        if !descriptor.append_only {
            return Err(fail(format!(
                "Lazy partitions need append_only: true on collection '{name}'"
            )));
        }
        if !descriptor.before_create_hooks.is_empty()
            || !descriptor.after_create_hooks.is_empty()
            || !descriptor.before_update_hooks.is_empty()
            || !descriptor.after_update_hooks.is_empty()
            || !descriptor.before_delete_hooks.is_empty()
            || !descriptor.after_delete_hooks.is_empty()
            || !descriptor.on_change_hooks.is_empty()
            || !descriptor.computed_fields.is_empty()
            || !descriptor.migrations.is_empty()
        {
            return Err(fail(format!("Lazy partitions do not support hooks, computed fields or migrations on collection '{name}'")));
        }
        if !descriptor.unique_fields.is_empty() {
            return Err(fail(format!(
                "Lazy partitions do not support unique_fields on collection '{name}'"
            )));
        }
        if !descriptor.relationships.is_empty() {
            return Err(fail(format!(
                "Lazy partitions do not support relationships from collection '{name}'"
            )));
        }
        if let Some(other) = config.collections.iter().find(|collection| {
            collection
                .descriptor
                .relationships
                .iter()
                .any(|(_, relationship)| relationship.target == name)
        }) {
            return Err(fail(format!(
                "Lazy partitions do not support relationships into collection '{name}' (from '{}')",
                other.descriptor.name
            )));
        }
        lazy.insert(
            name.to_owned(),
            LazyCollection {
                source_id: source_id.clone(),
                collection: name.to_owned(),
                policy: *policy,
                source: source.clone(),
                known: BTreeMap::new(),
                stream: Default::default(),
            },
        );
    }
    Ok(lazy)
}

/// List the partition files of a lazy source. Decodes nothing.
pub(crate) fn list_partitions(
    host: &dyn StorageHost,
    source: &PartitionedSourceConfig,
) -> Result<BTreeMap<String, String>, EngineError> {
    let mut known = BTreeMap::new();
    if !host.exists(&source.root)? {
        return Ok(known);
    }
    for path in host.list_directory(&source.root)? {
        if !matches_partition_path(source, &path) || !host.exists(&path)? {
            continue;
        }
        if let Some(key) = partition_key_of_path(source, &path) {
            known.insert(path, key);
        }
    }
    Ok(known)
}

/// The lazy-source state the managed watcher compares with disk.
pub(crate) struct LazyFingerprint {
    source: PartitionedSourceConfig,
    known: BTreeSet<String>,
    generations: Vec<proseql_storage::generation::SourceGeneration>,
}

/// Length and hash of a file's bytes, as the lazy watcher compares them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileFingerprint {
    len: usize,
    hash: u64,
}

impl FileFingerprint {
    pub(crate) fn from_hash(len: usize, hash: u64) -> Self {
        Self { len, hash }
    }
    pub(crate) fn of(content: &[u8]) -> Self {
        Self {
            len: content.len(),
            hash: content_hash(content),
        }
    }
}

fn content_hash(content: &[u8]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write(content);
    hasher.finish()
}

/// Compare directory listings and watch-covered file generations.
pub(crate) fn disk_differs(
    host: &dyn StorageHost,
    fingerprints: &[LazyFingerprint],
) -> Result<bool, EngineError> {
    for fingerprint in fingerprints {
        let listed = list_partitions(host, &fingerprint.source)?;
        if !listed.keys().eq(fingerprint.known.iter()) {
            return Ok(true);
        }
        for generation in &fingerprint.generations {
            if generation.check(host)? != proseql_storage::generation::GenerationCheck::Unchanged {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

impl SourceState {
    pub fn is_lazy(&self, collection: &str) -> bool {
        self.lazy.contains_key(collection)
    }

    fn lazy_ref(&self, collection: &str) -> Result<&LazyCollection, EngineError> {
        self.lazy.get(collection).ok_or_else(|| {
            crate::operation_error(
                "unknown-collection",
                format!("Collection '{collection}' has no lazy source"),
            )
        })
    }

    /// The partitions an operation filtered by `where_clause` can touch. A
    /// clause that does not prune is a full scan: every partition under
    /// `FullScanPolicy::Allow`, a typed error under `FullScanPolicy::Error`.
    pub fn lazy_scope(
        &self,
        collection: &str,
        where_clause: Option<&Value>,
        operation: &str,
    ) -> Result<(PartitionFilter, Vec<String>), EngineError> {
        let lazy = self.lazy_ref(collection)?;
        let filter = PartitionFilter::from_where(where_clause, &lazy.source.partition_by);
        // The policy refuses every operation that cannot prune, whatever
        // happens to be loaded, so behaviour does not depend on history.
        if filter.is_all() && lazy.policy.full_scan == FullScanPolicy::Error {
            return Err(EngineError::Operation(OperationError {
                operation: operation.to_owned(),
                reason: "lazy-full-scan".to_owned(),
                message: format!(
                    "{operation} on lazy collection '{collection}' has no filter on partition field '{}' and would load all {} partitions; source '{}' sets full_scan: Error",
                    lazy.source.partition_by.field(),
                    lazy.known.len(),
                    lazy.source_id
                ),
            }));
        }
        let paths = lazy
            .known
            .iter()
            .filter(|(_, key)| filter.matches(key))
            .map(|(path, _)| path.clone())
            .collect();
        Ok((filter, paths))
    }

    /// Every partition, under the full-scan policy (for lookups by ID).
    pub fn lazy_full_scope(
        &self,
        collection: &str,
        operation: &str,
    ) -> Result<Vec<String>, EngineError> {
        self.lazy_scope(collection, None, operation)
            .map(|(_, paths)| paths)
    }

    /// Move derived indexes and live watches across an eager-source reload.
    pub fn lazy_adopt(&mut self, previous: &mut SourceState) {
        for (name, lazy) in &mut self.lazy {
            if let Some(old) = previous.lazy.get_mut(name) {
                lazy.stream = std::mem::take(&mut old.stream);
                lazy.known = std::mem::take(&mut old.known);
            }
        }
    }

    pub fn lazy_fingerprints(&mut self) -> Vec<LazyFingerprint> {
        self.lazy
            .values_mut()
            .map(|lazy| {
                crate::write::watch::prune(lazy);
                LazyFingerprint {
                    source: lazy.source.clone(),
                    known: lazy.known.keys().cloned().collect(),
                    generations: lazy.stream.watch.baseline.values().cloned().collect(),
                }
            })
            .collect()
    }

    /// The lazy state of `source_id`, or `None` when it is not lazy.
    pub fn lazy_status(&self, source_id: &str) -> Option<LazyPartitionStatus> {
        self.lazy
            .values()
            .find(|lazy| lazy.source_id == source_id)
            .map(LazyCollection::status)
    }

    /// Partition files of an eager partitioned collection (for stats).
    pub fn eager_partition_count(&self, collection: &str) -> usize {
        self.partitions
            .get(collection)
            .map_or(0, |partitions| partitions.files.len())
    }
}
