//! Lazy partitions: a `Partitioned` JSONL source whose files load on demand.
//!
//! # Where the seam is
//!
//! The engine assumes that a collection holds every record a query can match.
//! This module keeps that assumption true at the runtime layer instead of
//! teaching the engine about files. Before an operation runs, the runtime
//! computes the partitions the operation can touch (from the partition-field
//! conditions of its filter, see `proseql_storage::partition_prune`) and makes
//! them resident with `Database::load_resident_records`. The engine then runs
//! its normal query, index and aggregate code over the resident records, which
//! include every record that can match. After the operation, the runtime
//! evicts least recently used partitions that no watch pins, down to the
//! bound, with `Database::unload_resident_records`.
//!
//! Loading and eviction are not mutations: they run no hooks, write no
//! journal entries and publish no change events. External file changes found
//! by a reload are published like any reload.
//!
//! The preconditions (append-only JSONL, no unique fields, no relationships in
//! or out) make this sound: queries without population never look outside
//! their own collection, and creates only need the target partition for the
//! ID check.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::hash::Hasher;

use indexmap::IndexMap;
use proseql_engine::errors::{EngineError, OperationError, SourceConfigError};
use proseql_engine::query::indexes::IndexUsed;
use proseql_engine::relationships::Database;
use proseql_formats::FormatRegistry;
use proseql_storage::append::{is_append_format, load_append_file, TornLineDiagnostic};
use proseql_storage::host::StorageHost;
use proseql_storage::partition_prune::{partition_key_of_path, PartitionFilter};
use proseql_storage::partitioned::{file_source, matches_partition_path, partition_path};
use proseql_storage::source_config::{
    NormalizedDatabaseSourceConfig, NormalizedSourceConfig, PartitionedSourceConfig,
};
use serde_json::Value;

use crate::sources::{NativeSourceRuntimeConfig, SourceState};

/// How a lazy partitioned source keeps partitions in memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LazyPartitionPolicy {
    /// Partitions kept loaded after an operation, at least 1. A full scan and
    /// partitions pinned by watches can exceed it; the next operation evicts
    /// the least recently used unpinned partitions down to it.
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
    /// Load every partition for that operation, then evict down to the bound.
    #[default]
    Allow,
    /// Fail with `OperationError` (reason `lazy-full-scan`) and load nothing.
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
    /// Partitions resident after the query and its eviction (lazy sources),
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
    /// Loaded partition files, in path order.
    pub loaded: Vec<String>,
    /// Loaded partition files pinned by live watches.
    pub pinned: Vec<String>,
}

pub(crate) struct LazyCollection {
    pub source_id: String,
    pub collection: String,
    pub policy: LazyPartitionPolicy,
    pub source: PartitionedSourceConfig,
    /// Partition file path → partition key, from the directory listing.
    pub known: BTreeMap<String, String>,
    /// Loaded partitions by path.
    pub resident: BTreeMap<String, Resident>,
    /// Listed partitions that a watch covers but that failed to load, with
    /// the `(length, hash)` of the bytes that failed. The watcher retries
    /// them when those bytes change.
    pending: BTreeMap<String, Option<(usize, u64)>>,
    clock: u64,
    pins: HashMap<u64, Pin>,
    next_pin: u64,
}

pub(crate) struct Resident {
    /// Record IDs in file order, then in append order.
    pub ids: Vec<String>,
    last_used: u64,
    /// Hash of the stored content, computed by the watcher when needed.
    hash: Option<(usize, u64)>,
}

struct Pin {
    filter: PartitionFilter,
    paths: BTreeSet<String>,
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
            resident: BTreeMap::new(),
            clock: 0,
            pins: HashMap::new(),
            next_pin: 1,
            pending: BTreeMap::new(),
        }
    }

    fn pinned(&self) -> HashSet<&str> {
        self.pins
            .values()
            .flat_map(|pin| pin.paths.iter().map(String::as_str))
            .collect()
    }

    /// Record an append by this runtime: the target is resident (checked when
    /// the append was planned) and now exists.
    pub fn record_append(&mut self, path: &str, id: String) {
        let resident = self
            .resident
            .entry(path.to_owned())
            .or_insert_with(|| Resident {
                ids: Vec::new(),
                last_used: 0,
                hash: None,
            });
        resident.ids.push(id);
        resident.hash = None;
        self.pending.remove(path);
        if !self.known.contains_key(path) {
            if let Some(key) = partition_key_of_path(&self.source, path) {
                for pin in self.pins.values_mut() {
                    if pin.filter.matches(&key) {
                        pin.paths.insert(path.to_owned());
                    }
                }
                self.known.insert(path.to_owned(), key);
            }
        }
    }

    pub fn status(&self) -> LazyPartitionStatus {
        let pinned = self.pinned();
        LazyPartitionStatus {
            source_id: self.source_id.clone(),
            collection: self.collection.clone(),
            partitions: self.known.keys().cloned().collect(),
            loaded: self.resident.keys().cloned().collect(),
            pinned: self
                .resident
                .keys()
                .filter(|path| pinned.contains(path.as_str()))
                .cloned()
                .collect(),
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
        if policy.max_loaded_partitions == 0 {
            return Err(fail(
                "Lazy partitions need max_loaded_partitions of at least 1".to_owned(),
            ));
        }
        lazy.insert(
            name.to_owned(),
            LazyCollection {
                source_id: source_id.clone(),
                collection: name.to_owned(),
                policy: *policy,
                source: source.clone(),
                known: BTreeMap::new(),
                resident: BTreeMap::new(),
                clock: 0,
                pins: HashMap::new(),
                next_pin: 1,
                pending: BTreeMap::new(),
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

/// One decoded partition file.
struct LoadedPartition {
    records: IndexMap<String, Value>,
    /// Raw bytes; `None` when the file does not exist.
    content: Option<Vec<u8>>,
    torn: Option<TornLineDiagnostic>,
}

/// The lazy-source state the managed watcher compares with the disk.
pub(crate) struct LazyFingerprint {
    source: PartitionedSourceConfig,
    known: BTreeSet<String>,
    /// Resident path → `(length, hash)` of the stored content (`None`: no file).
    resident: Vec<(String, Option<(usize, u64)>)>,
    /// Pending path → `(length, hash)` of the bytes that failed to load.
    pending: Vec<(String, Option<(usize, u64)>)>,
}

fn file_fingerprint(
    host: &dyn StorageHost,
    path: &str,
) -> Result<Option<(usize, u64)>, EngineError> {
    if !host.exists(path)? {
        return Ok(None);
    }
    let content = host.read_bytes(path)?;
    Ok(Some((content.len(), content_hash(&content))))
}

fn content_hash(content: &[u8]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write(content);
    hasher.finish()
}

/// `true` when a lazy source's directory listing or a loaded partition's
/// bytes differ from `fingerprints`. Reads only loaded partitions.
pub(crate) fn disk_differs(
    host: &dyn StorageHost,
    fingerprints: &[LazyFingerprint],
) -> Result<bool, EngineError> {
    for fingerprint in fingerprints {
        let listed = list_partitions(host, &fingerprint.source)?;
        if !listed.keys().eq(fingerprint.known.iter()) {
            return Ok(true);
        }
        for (path, stored) in fingerprint.resident.iter().chain(&fingerprint.pending) {
            if &file_fingerprint(host, path)? != stored {
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

    fn read_partition(
        &self,
        host: &dyn StorageHost,
        formats: &FormatRegistry,
        lazy: &LazyCollection,
        path: &str,
    ) -> Result<LoadedPartition, EngineError> {
        let snapshot = crate::read_snapshot::ReadSnapshot::new(host);
        let file = file_source(&lazy.source, path);
        let config = &self.config.collection_configs[&lazy.collection];
        let loaded = load_append_file(&snapshot, formats, &file, config, true)?;
        for (id, record) in &loaded.records {
            let routed = partition_path(&lazy.source, record).map_err(|cause| {
                let message = match &cause {
                    EngineError::SourceConfig(config) => config.message.clone(),
                    other => other.to_string(),
                };
                config_error(
                    format!("Record '{id}': {message}"),
                    &lazy.source_id,
                    Some(&lazy.collection),
                    Some(path),
                )
            })?;
            if routed != path {
                return Err(config_error(
                    format!("Record '{id}' is in the wrong partition"),
                    &lazy.source_id,
                    Some(&lazy.collection),
                    Some(path),
                ));
            }
        }
        let content = if host.exists(path)? {
            Some(snapshot.read_bytes(path)?)
        } else {
            None
        };
        Ok(LoadedPartition {
            records: loaded.records,
            content,
            torn: loaded.torn,
        })
    }

    /// Insertion position for a partition: before the first record of the
    /// next loaded partition in path order, so resident records keep the
    /// order of an eager load (partition path, then file order).
    fn lazy_position(lazy: &LazyCollection, database: &Database, path: &str) -> Option<usize> {
        let collection = database.collection(&lazy.collection)?;
        lazy.resident
            .range::<str, _>((std::ops::Bound::Excluded(path), std::ops::Bound::Unbounded))
            .find_map(|(_, resident)| resident.ids.first())
            .and_then(|id| collection.position_of(id))
    }

    /// Make `paths` resident and mark them used. Returns the number of files
    /// read. `publish` reports the loaded records as a change (used for
    /// partitions that appear on disk while a watch covers them).
    #[allow(clippy::too_many_arguments)]
    pub fn lazy_ensure(
        &mut self,
        database: &mut Database,
        host: &dyn StorageHost,
        formats: &FormatRegistry,
        collection: &str,
        paths: &[String],
        publish: bool,
    ) -> Result<usize, EngineError> {
        let mut read = 0;
        let missing = {
            let lazy = self.lazy_ref(collection)?;
            paths
                .iter()
                .filter(|path| !lazy.resident.contains_key(*path))
                .cloned()
                .collect::<BTreeSet<_>>()
        };
        for path in missing {
            let lazy = self.lazy_ref(collection)?;
            // A live watch that covers this partition but does not pin it yet
            // (a file found later, or one that failed to load) joins it now,
            // and sees the records as a change.
            let joining = partition_key_of_path(&lazy.source, &path)
                .map(|key| {
                    lazy.pins
                        .iter()
                        .filter(|(_, pin)| pin.filter.matches(&key) && !pin.paths.contains(&path))
                        .map(|(id, _)| *id)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let partition = self.read_partition(host, formats, lazy, &path)?;
            let ids = partition.records.keys().cloned().collect::<Vec<_>>();
            let position = Self::lazy_position(lazy, database, &path);
            let source_id = lazy.source_id.clone();
            database
                .load_resident_records(
                    collection,
                    partition.records.into_values().collect(),
                    position,
                    publish || !joining.is_empty(),
                )
                .map_err(|error| match error {
                    EngineError::DuplicateKey(duplicate) => config_error(
                        format!("Duplicate partition record '{}'", duplicate.value),
                        &source_id,
                        Some(collection),
                        Some(&path),
                    ),
                    other => other,
                })?;
            read += usize::from(partition.content.is_some());
            if let Some(content) = partition.content {
                self.contents.insert(path.clone(), content);
            }
            if let Some(torn) = partition.torn {
                self.torn.retain(|existing| existing.path != path);
                self.torn.push(torn);
            }
            let lazy = self.lazy.get_mut(collection).expect("lazy collection");
            if let Some(key) = partition_key_of_path(&lazy.source, &path) {
                lazy.known.insert(path.clone(), key);
            }
            for id in joining {
                if let Some(pin) = lazy.pins.get_mut(&id) {
                    pin.paths.insert(path.clone());
                }
            }
            lazy.pending.remove(&path);
            lazy.resident.insert(
                path,
                Resident {
                    ids,
                    last_used: 0,
                    hash: None,
                },
            );
        }
        let lazy = self.lazy.get_mut(collection).expect("lazy collection");
        lazy.clock += 1;
        for path in paths {
            if let Some(resident) = lazy.resident.get_mut(path) {
                resident.last_used = lazy.clock;
            }
        }
        Ok(read)
    }

    /// Make the partition a new record routes to resident, so the engine's ID
    /// check and `duplicate_ids` comparison see that partition. A partition
    /// file that does not exist yet becomes resident and empty without a read.
    /// A record whose partition cannot be computed here is left to the append
    /// plan, which rejects targets that are not resident.
    pub fn lazy_ensure_for_record(
        &mut self,
        database: &mut Database,
        host: &dyn StorageHost,
        formats: &FormatRegistry,
        collection: &str,
        record: &Value,
    ) -> Result<(), EngineError> {
        let lazy = self.lazy_ref(collection)?;
        let Ok(path) = partition_path(&lazy.source, record) else {
            return Ok(());
        };
        if !lazy.resident.contains_key(&path)
            && !lazy.known.contains_key(&path)
            && !host.exists(&path)?
        {
            let lazy = self.lazy.get_mut(collection).expect("lazy collection");
            lazy.clock += 1;
            lazy.resident.insert(
                path,
                Resident {
                    ids: Vec::new(),
                    last_used: lazy.clock,
                    hash: None,
                },
            );
            return Ok(());
        }
        self.lazy_ensure(database, host, formats, collection, &[path], false)
            .map(|_| ())
    }

    /// Evict least recently used, unpinned partitions until at most
    /// `max_loaded_partitions` unpinned partitions stay loaded. Pinned
    /// partitions do not count against the bound.
    pub fn lazy_trim(&mut self, database: &mut Database) -> Result<(), EngineError> {
        for name in self.lazy.keys().cloned().collect::<Vec<_>>() {
            let mut evicted = false;
            loop {
                let lazy = &self.lazy[&name];
                let pinned = lazy.pinned();
                let unpinned = lazy
                    .resident
                    .iter()
                    .filter(|(path, _)| !pinned.contains(path.as_str()));
                if unpinned.clone().count() <= lazy.policy.max_loaded_partitions {
                    break;
                }
                let Some(path) = unpinned
                    .min_by(|(left_path, left), (right_path, right)| {
                        left.last_used
                            .cmp(&right.last_used)
                            .then_with(|| left_path.cmp(right_path))
                    })
                    .map(|(path, _)| path.clone())
                else {
                    break;
                };
                self.lazy_evict(database, &name, &path, false)?;
                evicted = true;
            }
            if evicted && database.watch_subscription_count() > 0 {
                database.refresh_reactive_snapshot(&name)?;
            }
        }
        Ok(())
    }

    fn lazy_evict(
        &mut self,
        database: &mut Database,
        collection: &str,
        path: &str,
        publish: bool,
    ) -> Result<(), EngineError> {
        let lazy = self.lazy.get_mut(collection).expect("lazy collection");
        if let Some(resident) = lazy.resident.remove(path) {
            database.unload_resident_records(collection, &resident.ids, publish)?;
        }
        self.contents.shift_remove(path);
        Ok(())
    }

    /// Pin `paths` for a watch with `filter`. Partitions that appear later and
    /// match the filter join the pin.
    pub fn lazy_pin(&mut self, collection: &str, filter: PartitionFilter, paths: &[String]) -> u64 {
        let lazy = self.lazy.get_mut(collection).expect("lazy collection");
        let id = lazy.next_pin;
        lazy.next_pin += 1;
        lazy.pins.insert(
            id,
            Pin {
                filter,
                paths: paths.iter().cloned().collect(),
            },
        );
        id
    }

    pub fn lazy_unpin(&mut self, collection: &str, id: u64) {
        if let Some(lazy) = self.lazy.get_mut(collection) {
            lazy.pins.remove(&id);
        }
    }

    /// Take over the loaded partitions, pins and stored contents of the
    /// previous state after a reload listed the sources again.
    pub fn lazy_adopt(&mut self, previous: &mut SourceState) {
        for (name, lazy) in &mut self.lazy {
            let Some(old) = previous.lazy.get_mut(name) else {
                continue;
            };
            lazy.resident = std::mem::take(&mut old.resident);
            lazy.pins = std::mem::take(&mut old.pins);
            lazy.clock = old.clock;
            lazy.next_pin = old.next_pin;
            lazy.pending = std::mem::take(&mut old.pending);
            for path in lazy.resident.keys() {
                if let Some(content) = previous.contents.get(path) {
                    self.contents.insert(path.clone(), content.clone());
                }
            }
            self.torn.extend(
                previous
                    .torn
                    .iter()
                    .filter(|torn| lazy.resident.contains_key(&torn.path))
                    .cloned(),
            );
            // The listing just taken does not know files this runtime created
            // after the previous listing; resident paths stay known.
            for path in lazy.resident.keys() {
                if let Some(key) = partition_key_of_path(&lazy.source, path) {
                    lazy.known.entry(path.clone()).or_insert(key);
                }
            }
        }
    }

    /// Bring loaded partitions up to date with the disk after a reload or a
    /// watcher event. Reads only loaded partitions and the directory listing:
    /// removed files are dropped, changed files are decoded again (the old
    /// records stay when the new content fails), and new files that a watch
    /// covers are loaded. Changes are published to watches.
    pub fn lazy_refresh(
        &mut self,
        database: &mut Database,
        host: &dyn StorageHost,
        formats: &FormatRegistry,
    ) -> Result<(), EngineError> {
        let mut first_error = None;
        for name in self.lazy.keys().cloned().collect::<Vec<_>>() {
            let listed = list_partitions(host, &self.lazy[&name].source)?;
            let resident = self.lazy[&name]
                .resident
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            for path in resident {
                let exists = listed.contains_key(&path) || host.exists(&path)?;
                if !exists {
                    let had_file = self.contents.contains_key(&path);
                    if had_file {
                        self.lazy_evict(database, &name, &path, true)?;
                    }
                    continue;
                }
                let current = host.read_bytes(&path)?;
                if self.contents.get(&path) == Some(&current) {
                    continue;
                }
                if let Err(error) =
                    self.lazy_reload_partition(database, host, formats, &name, &path)
                {
                    first_error.get_or_insert(error);
                }
            }
            let lazy = self.lazy.get_mut(&name).expect("lazy collection");
            // New files a watch covers, plus earlier ones that failed to load.
            lazy.pending.retain(|path, _| listed.contains_key(path));
            let added = listed
                .iter()
                .filter(|(path, _)| {
                    lazy.pending.contains_key(*path) || !lazy.known.contains_key(*path)
                })
                .filter(|(path, _)| !lazy.resident.contains_key(*path))
                .filter(|(_, key)| lazy.pins.values().any(|pin| pin.filter.matches(key)))
                .map(|(path, _)| path.clone())
                .collect::<Vec<_>>();
            let mut known = listed;
            for path in lazy.resident.keys() {
                if let Some(key) = partition_key_of_path(&lazy.source, path) {
                    known.entry(path.clone()).or_insert(key);
                }
            }
            lazy.known = known;
            for path in added {
                if let Err(error) =
                    self.lazy_ensure(database, host, formats, &name, &[path.clone()], true)
                {
                    let failed = file_fingerprint(host, &path).ok().flatten();
                    let lazy = self.lazy.get_mut(&name).expect("lazy collection");
                    lazy.pending.insert(path, failed);
                    first_error.get_or_insert(error);
                }
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn lazy_reload_partition(
        &mut self,
        database: &mut Database,
        host: &dyn StorageHost,
        formats: &FormatRegistry,
        collection: &str,
        path: &str,
    ) -> Result<(), EngineError> {
        let lazy = self.lazy_ref(collection)?;
        let partition = self.read_partition(host, formats, lazy, path)?;
        let old_ids = lazy.resident[path].ids.clone();
        let old = old_ids.iter().map(String::as_str).collect::<HashSet<_>>();
        if let Some(resident) = database.collection(collection) {
            if let Some(id) = partition
                .records
                .keys()
                .find(|id| !old.contains(id.as_str()) && resident.get(id).is_some())
            {
                return Err(config_error(
                    format!("Duplicate partition record '{id}'"),
                    &lazy.source_id,
                    Some(collection),
                    Some(path),
                ));
            }
        }
        database.unload_resident_records(collection, &old_ids, true)?;
        let lazy = self.lazy_ref(collection)?;
        let position = Self::lazy_position(lazy, database, path);
        let ids = partition.records.keys().cloned().collect::<Vec<_>>();
        database.load_resident_records(
            collection,
            partition.records.into_values().collect(),
            position,
            true,
        )?;
        match partition.content {
            Some(content) => self.contents.insert(path.to_owned(), content),
            None => self.contents.shift_remove(path),
        };
        self.torn.retain(|torn| torn.path != path);
        self.torn.extend(partition.torn);
        let lazy = self.lazy.get_mut(collection).expect("lazy collection");
        if let Some(resident) = lazy.resident.get_mut(path) {
            resident.ids = ids;
            resident.hash = None;
        }
        Ok(())
    }

    /// What the managed watcher compares with the disk. Hashes stored
    /// contents that changed since the last call.
    pub fn lazy_fingerprints(&mut self) -> Vec<LazyFingerprint> {
        let contents = &self.contents;
        self.lazy
            .values_mut()
            .map(|lazy| LazyFingerprint {
                source: lazy.source.clone(),
                known: lazy.known.keys().cloned().collect(),
                resident: lazy
                    .resident
                    .iter_mut()
                    .map(|(path, resident)| {
                        let stored = contents.get(path).map(|content| {
                            *resident
                                .hash
                                .get_or_insert_with(|| (content.len(), content_hash(content)))
                        });
                        (path.clone(), stored)
                    })
                    .collect(),
                pending: lazy
                    .pending
                    .iter()
                    .map(|(path, failed)| (path.clone(), *failed))
                    .collect(),
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

    pub fn lazy_resident_count(&self, collection: &str) -> usize {
        self.lazy
            .get(collection)
            .map_or(0, |lazy| lazy.resident.len())
    }
}
