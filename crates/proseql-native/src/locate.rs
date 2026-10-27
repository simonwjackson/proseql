//! Generation-checked positional indexes and nonresident ID lookup.
use crate::{MutationInner, NativeRuntime};
use proseql_engine::callbacks::CallbackRegistry;
use proseql_engine::errors::EngineError;
use proseql_engine::scan::RowLocation;
use proseql_formats::FormatRegistry;
use proseql_storage::generation::{GenerationCheck, SourceGeneration};
use proseql_storage::host::StorageHost;
use proseql_storage::index::persist::Store;
use proseql_storage::index::{rows, IdLocator, TimeIndex, UNKNOWN_OFFSET};
use proseql_storage::persistence::CollectionStorageConfig;
use proseql_storage::source_config::{
    NormalizedCollectionFileSourceConfig, PartitionedSourceConfig,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

pub(crate) mod read_indexes;

pub(crate) type RowVisitor<'a> =
    dyn FnMut(&str, &[u8], RowLocation, bool) -> Result<(), EngineError> + 'a;

pub(crate) type PathObservations = BTreeMap<String, Option<SourceGeneration>>;
pub(crate) type DecodedRowVisitor<'a> =
    dyn FnMut(&str, &[u8], RowLocation, bool) -> Result<Option<Box<str>>, EngineError> + 'a;

struct CodecContext {
    positional: bool,
    formats: Arc<FormatRegistry>,
    source: PartitionedSourceConfig,
    collection: CollectionStorageConfig,
    storage: CollectionStorageConfig,
    callbacks: Arc<CallbackRegistry>,
}

impl CodecContext {
    fn decode_partition(
        &self,
        host: &dyn StorageHost,
        path: &str,
    ) -> Result<proseql_storage::append::LoadedAppendFile, EngineError> {
        if !host.exists(path)? {
            return Ok(proseql_storage::append::LoadedAppendFile::default());
        }
        let bytes = host.read_bytes(path)?;
        let file = proseql_storage::partitioned::file_source(&self.source, path);
        let mut loaded = proseql_storage::append::decode_append_bytes(
            host,
            &self.formats,
            &file,
            &self.storage,
            &bytes,
            true,
        )?;
        crate::schema_checks::decode_loaded_records(
            &self.collection.schema,
            &self.collection.id_strategy,
            &mut loaded.records,
            &self.callbacks,
        )?;
        for (id, row) in &loaded.records {
            proseql_storage::partitioned::check_partition_record(&self.source, path, id, row)?;
        }
        Ok(loaded)
    }

    fn ids(&self, host: &dyn StorageHost, path: &str) -> Result<Vec<String>, EngineError> {
        Ok(self
            .decode_partition(host, path)?
            .records
            .into_keys()
            .collect())
    }
}

/// Evidence from the checked accepted text after our own durable append.
/// A consumer must match its cached generation to `before` and check `after`
/// against the host before extending from `start`.
#[derive(Clone)]
pub(crate) struct AppendProof {
    pub before: SourceGeneration,
    pub after: SourceGeneration,
    pub start: u64,
}

#[derive(Default)]
pub(crate) struct IndexState {
    times: BTreeMap<(String, String), TimeIndex>,
    time_validated: BTreeMap<(String, String), SourceGeneration>,
    ids: Option<IdLocator>,
    validated: BTreeMap<String, SourceGeneration>,
    codec: Option<CodecContext>,
    append_proofs: BTreeMap<String, AppendProof>,
    store: Option<Store>,
}

impl IndexState {
    /// Publish eligible derived state; failures never change a source result.
    pub(crate) fn save(&self, host: &dyn StorageHost) {
        if let Some(store) = &self.store {
            if let Some(ids) = &self.ids {
                ids.save(host, store);
            }
            for generation in self.validated.values() {
                store.save(host, generation, "valid", &[]);
            }
            for (key, index) in &self.times {
                if self.time_validated.get(key) == index.generation() {
                    index.save(host, store);
                }
            }
        }
    }

    /// True only for canonical validation of this exact observed generation.
    /// The caller still checks its fresh observation after scanning.
    pub(crate) fn checked_validation(
        &mut self,
        host: &dyn StorageHost,
        path: &str,
        observed: &SourceGeneration,
    ) -> Result<bool, EngineError> {
        if observed.path != path {
            return Ok(false);
        }
        if self.validated.get(path) == Some(observed) {
            return Ok(true);
        }
        if let Some(loaded) = self
            .store
            .as_ref()
            .and_then(|store| store.load(host, observed, "valid"))
        {
            if loaded.unchanged && loaded.payload.is_empty() {
                self.record_validation(path, observed.clone());
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Call only after full canonical validation, including duplicate checks.
    pub(crate) fn record_validation(&mut self, path: &str, generation: SourceGeneration) {
        debug_assert_eq!(path, generation.path);
        self.validated.insert(path.into(), generation);
    }

    /// Drop derived indexes, but keep the configured codec and sidecar context.
    pub fn invalidate(&mut self) {
        if let Some(store) = &self.store {
            store.clear();
        }
        self.times.clear();
        self.time_validated.clear();
        self.ids = None;
        self.validated.clear();
        self.append_proofs.clear();
    }

    /// Compatibility wrapper for callers that do not span a whole request.
    #[cfg(test)]
    pub fn time_index(
        &mut self,
        host: &dyn StorageHost,
        path: &str,
        field: &str,
        observed: SourceGeneration,
    ) -> Result<Option<&TimeIndex>, EngineError> {
        let mut attempt = read_indexes::ReadIndexes::default();
        let _ = attempt.time_index(self, host, path, field, observed)?;
        attempt.commit(self);
        Ok(self
            .times
            .get(&(path.into(), field.into()))
            .filter(|index| index.seek(None, None).is_some()))
    }

    pub(crate) fn begin_time_index(
        &self,
        path: &str,
        field: &str,
        observed: SourceGeneration,
    ) -> Result<Option<TimeIndex>, EngineError> {
        if self.times.contains_key(&(path.into(), field.into()))
            || self.codec.as_ref().is_some_and(|codec| !codec.positional)
        {
            return Ok(None);
        }
        // At 2,565 rows per raw shard, stride 1,024 scans much of every shard.
        // Thirty-two rows bounds that amplification at a measured metadata cost.
        Ok(Some(TimeIndex::begin_observed(
            path,
            field,
            32,
            Some(observed),
        )))
    }

    pub(crate) fn publish_time_index(&mut self, path: &str, field: &str, index: TimeIndex) {
        if let Some(generation) = index.generation() {
            self.time_validated
                .insert((path.into(), field.into()), generation.clone());
        }
        self.times.insert((path.into(), field.into()), index);
    }

    pub fn id_locator(
        &mut self,
        host: &dyn StorageHost,
        paths: &[String],
    ) -> Result<&mut IdLocator, EngineError> {
        if self.codec.as_ref().is_some_and(|codec| !codec.positional) {
            return self.id_locator_visiting(host, paths, &mut |_, _, _, _| Ok(()));
        }
        self.id_membership_observed(host, paths, &PathObservations::new())
    }

    fn id_membership_observed(
        &mut self,
        host: &dyn StorageHost,
        paths: &[String],
        observed: &PathObservations,
    ) -> Result<&mut IdLocator, EngineError> {
        // Appends need identities, not payload validation. An exact validation
        // proof loaded by lookup also needs no second validation-sidecar read.
        let refreshed = if let Some(locator) = self.ids.as_mut() {
            locator.refresh_observed_decoded(host, paths, observed, &mut |_, _, _, _| Ok(None))
        } else {
            (if let Some(store) = &self.store {
                IdLocator::build_persisted(host, paths, observed, None, store)
            } else {
                IdLocator::build_observed_decoded(host, paths, observed, &mut |_, _, _, _| Ok(None))
            })
            .map(|locator| self.ids = Some(locator))
        };
        if let Err(error) = refreshed {
            self.append_proofs.clear();
            return Err(error);
        }
        self.retain_append_proofs();
        Ok(self.ids.as_mut().expect("built locator"))
    }

    pub(crate) fn id_locator_visiting(
        &mut self,
        host: &dyn StorageHost,
        paths: &[String],
        visit: &mut RowVisitor<'_>,
    ) -> Result<&mut IdLocator, EngineError> {
        self.id_locator_observed(host, paths, &PathObservations::new(), visit)
    }

    pub(crate) fn id_locator_observed(
        &mut self,
        host: &dyn StorageHost,
        paths: &[String],
        observed: &PathObservations,
        visit: &mut RowVisitor<'_>,
    ) -> Result<&mut IdLocator, EngineError> {
        self.id_locator_observed_decoded(host, paths, observed, &mut |path, bytes, row, last| {
            visit(path, bytes, row, last)?;
            Ok(None)
        })
    }

    pub(crate) fn id_locator_observed_decoded(
        &mut self,
        host: &dyn StorageHost,
        paths: &[String],
        observed: &PathObservations,
        visit: &mut DecodedRowVisitor<'_>,
    ) -> Result<&mut IdLocator, EngineError> {
        let refreshed = (|| -> Result<(), EngineError> {
            if let Some(codec) = self.codec.as_ref().filter(|codec| !codec.positional) {
                let mut decode = |path: &str| codec.ids(host, path);
                if let Some(locator) = self.ids.as_mut() {
                    locator.refresh_partitions(host, paths, &mut decode)?;
                } else {
                    self.ids = Some(IdLocator::build_partitions(host, paths, &mut decode)?);
                }
            } else if let Some(locator) = self.ids.as_mut() {
                locator.refresh_observed_decoded(host, paths, observed, visit)?;
            } else {
                self.ids = Some(if let Some(store) = &self.store {
                    IdLocator::build_persisted(host, paths, observed, Some(visit), store)?
                } else {
                    IdLocator::build_observed_decoded(host, paths, observed, visit)?
                });
            }
            Ok(())
        })();
        if let Err(error) = refreshed {
            self.append_proofs.clear();
            return Err(error);
        }
        self.retain_append_proofs();
        Ok(self.ids.as_mut().expect("built locator"))
    }

    fn matches_validated_listing(
        &self,
        listed: &[(String, proseql_storage::host::FileStat)],
    ) -> bool {
        self.ids
            .as_ref()
            .is_some_and(|ids| ids.matches_listed_stats(listed))
            && listed.iter().all(|(path, stat)| {
                self.validated.get(path).is_some_and(|generation| {
                    stat.change_id.is_some()
                        && generation.change_id == stat.change_id
                        && generation.covered_len == stat.len
                        && generation.modified_ns == stat.modified_ns
                })
            })
    }

    fn retain_append_proofs(&mut self) {
        self.append_proofs.retain(|path, proof| {
            self.ids
                .as_ref()
                .and_then(|locator| locator.generation_for(path))
                == Some(&proof.after)
        });
    }

    pub fn id_locator_if_built(&mut self) -> Option<&mut IdLocator> {
        self.ids.as_mut()
    }

    pub(crate) fn append_proof(&self, path: &str) -> Option<&AppendProof> {
        self.append_proofs.get(path).inspect(|proof| {
            debug_assert_eq!(proof.start, proof.before.covered_len);
            debug_assert!(proof.start <= proof.after.covered_len);
        })
    }

    pub(crate) fn clear_append_proof(&mut self, path: &str) {
        if self.append_proof(path).is_some() {
            self.append_proofs.remove(path);
        }
    }

    /// Called only after append bookkeeping proved the complete accepted text.
    pub(crate) fn record_appended(
        &mut self,
        generation: SourceGeneration,
        start: u64,
        rows: &[(String, RowLocation)],
    ) -> Result<(), EngineError> {
        let path = generation.path.clone();
        let before = self
            .ids
            .as_ref()
            .and_then(|locator| locator.generation_for(&path))
            .cloned();
        // A repeated checked publication must preserve the original link,
        // not replace it with after→after evidence using the old start offset.
        if before.as_ref() == Some(&generation) {
            return Ok(());
        }
        let Some(locator) = self.ids.as_mut() else {
            return Ok(());
        };
        if let Err(error) = locator.accept_appended(generation.clone(), start, rows) {
            self.clear_append_proof(&path);
            return Err(error);
        }
        if locator.generation_for(&path) != Some(&generation) {
            self.clear_append_proof(&path);
            return Ok(());
        }
        if let Some(before) = before {
            if self.validated.get(&path) == Some(&before) {
                self.validated.insert(path.clone(), generation.clone());
            }
            let proof = AppendProof {
                before,
                after: generation,
                start,
            };
            self.append_proofs.insert(path, proof);
        } else {
            self.clear_append_proof(&path);
        }
        Ok(())
    }

    /// Verify a positional or whole-partition candidate using the runtime's
    /// registered codec and schema, without retaining any record payloads.
    pub(crate) fn verify_candidate(
        &mut self,
        host: &dyn StorageHost,
        path: &str,
        location: RowLocation,
        id: &str,
    ) -> Result<Option<Value>, EngineError> {
        let codec = self.codec.as_ref().ok_or_else(|| {
            crate::operation_error(
                "streaming-index-context",
                "Streaming index codec context is not configured",
            )
        })?;
        let generation = self
            .ids
            .as_ref()
            .and_then(|locator| locator.generation_for(path));
        if let Some(generation) = generation {
            if generation.check(host)? != GenerationCheck::Unchanged {
                self.append_proofs.remove(path);
                return Err(crate::operation_error(
                    "source-changed",
                    format!("Source '{path}' changed before candidate verification"),
                ));
            }
        }
        let row = if location.offset == UNKNOWN_OFFSET {
            codec.decode_partition(host, path)?.records.shift_remove(id)
        } else {
            let bytes = rows::read_line(host, path, location.offset)?;
            let file = proseql_storage::partitioned::file_source(&codec.source, path);
            let decoder = RowDecoder {
                collection: &codec.collection,
                storage: &codec.storage,
                source: &codec.source,
                callbacks: &codec.callbacks,
            };
            // Reuse the same audited borrowed validation as locator builds.
            // A store exists only for callback/default/migration-free schemas;
            // other schemas and all errors retain canonical replay below.
            let simple = (self.store.is_some()
                && codec.collection.version.is_none()
                && matches!(
                    codec.collection.id_strategy,
                    proseql_engine::descriptor::IdStrategy::Provided
                ))
            .then(|| proseql_engine::scan::decoder::SimpleDecoder::new(&codec.collection.schema))
            .flatten();
            let expected =
                proseql_storage::partition_prune::partition_key_of_path(&codec.source, path);
            let decoded = simple
                .as_ref()
                .and_then(|decoder| decoder.decode(&bytes).ok().flatten())
                .filter(|row| {
                    !id.is_empty()
                        && row
                            .get("id")
                            .and_then(proseql_engine::scan::borrowed::BorrowedValue::as_str)
                            == Some(id)
                        && crate::streaming::borrowed_partition_matches(
                            &codec.source,
                            expected.as_deref(),
                            row,
                        )
                })
                .map(|row| row.to_owned());
            match decoded {
                Some(row) => Some(row),
                None => decoder
                    .decode_row(host, &codec.formats, &file, &bytes)?
                    .filter(|row| row.get("id").and_then(Value::as_str) == Some(id)),
            }
        };
        if let Some(generation) = generation {
            if generation.check(host)? != GenerationCheck::Unchanged {
                self.append_proofs.remove(path);
                return Err(crate::operation_error(
                    "source-changed",
                    format!("Source '{path}' changed during candidate verification"),
                ));
            }
        }
        Ok(row)
    }
}

fn contextualize(
    error: EngineError,
    source: &proseql_storage::source_config::PartitionedSourceConfig,
) -> EngineError {
    match error {
        EngineError::SourceConfig(mut error) => {
            if error.source_id.is_none() {
                error.source_id = Some(source.id.clone());
            }
            if error.collection.is_none() {
                error.collection = Some(source.collection.clone());
            }
            EngineError::SourceConfig(error)
        }
        other => other,
    }
}

struct RowDecoder<'a> {
    collection: &'a CollectionStorageConfig,
    storage: &'a CollectionStorageConfig,
    source: &'a PartitionedSourceConfig,
    callbacks: &'a CallbackRegistry,
}

impl RowDecoder<'_> {
    fn decode_row(
        &self,
        host: &dyn StorageHost,
        formats: &FormatRegistry,
        file: &NormalizedCollectionFileSourceConfig,
        bytes: &[u8],
    ) -> Result<Option<Value>, EngineError> {
        let mut loaded = proseql_storage::append::decode_append_bytes(
            host,
            formats,
            file,
            self.storage,
            bytes,
            true,
        )?;
        crate::schema_checks::decode_loaded_records(
            &self.collection.schema,
            &self.collection.id_strategy,
            &mut loaded.records,
            self.callbacks,
        )?;
        for (id, row) in &loaded.records {
            proseql_storage::partitioned::check_partition_record(self.source, &file.path, id, row)?;
        }
        Ok(loaded.records.into_values().next())
    }
}

fn lookup(
    sources: &mut crate::sources::SourceState,
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    collection: &str,
    id: &str,
) -> Result<Option<Value>, EngineError> {
    // Keep the historical policy, even though membership can now avoid a scan.
    sources.lazy_full_scope(collection, "findById")?;
    let source = sources.lazy[collection].source.clone();
    let entries = if host.exists(&source.root)? {
        let mut entries = host.list_directory_with_stat(&source.root)?;
        entries.retain(|(path, _)| {
            proseql_storage::partitioned::matches_partition_path(&source, path)
        });
        entries.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        entries
    } else {
        Vec::new()
    };
    let lazy = sources.lazy.get_mut(collection).expect("lazy collection");
    if lazy
        .stream
        .index
        .codec
        .as_ref()
        .is_some_and(|codec| codec.positional)
        && lazy.known.keys().eq(entries.iter().map(|(path, _)| path))
        && lazy.stream.index.matches_validated_listing(&entries)
    {
        // Every file was freshly observed, including files other than the hit.
        // Reuse those observations without rebuilding owned generation maps.
        let index = &mut lazy.stream.index;
        let candidates = index
            .ids
            .as_ref()
            .expect("checked locator")
            .locate(id)
            .map_err(|error| contextualize(error, &source))?;
        for (path, location) in candidates {
            if let Some(row) = index.verify_candidate(host, &path, location, id)? {
                return Ok(Some(row));
            }
        }
        return Ok(None);
    }
    let mut listed = BTreeMap::new();
    let mut listed_stats = BTreeMap::new();
    {
        for (path, stat) in entries {
            if !proseql_storage::partitioned::matches_partition_path(&source, &path) {
                continue;
            }
            if let Some(key) =
                proseql_storage::partition_prune::partition_key_of_path(&source, &path)
            {
                listed_stats.insert(path.clone(), stat);
                listed.insert(path, key);
            }
        }
    }
    let paths = listed.keys().cloned().collect::<Vec<_>>();
    sources
        .lazy
        .get_mut(collection)
        .expect("lazy collection")
        .known = listed;

    if sources.lazy[collection]
        .stream
        .index
        .codec
        .as_ref()
        .is_some_and(|codec| !codec.positional)
    {
        let index = &mut sources
            .lazy
            .get_mut(collection)
            .expect("lazy collection")
            .stream
            .index;
        let candidates = index
            .id_locator(host, &paths)
            .and_then(|locator| locator.locate(id))
            .map_err(|error| contextualize(error, &source))?;
        for (path, location) in candidates {
            if let Some(row) = index.verify_candidate(host, &path, location, id)? {
                return Ok(Some(row));
            }
        }
        return Ok(None);
    }

    // Validate inside the locator's first scan. Already-covered membership can
    // come from append without payload validation; those paths still need a
    // separate pass. Changed observations conservatively validate whole files.
    let validation = proseql_storage::diagnostics::span("streaming_id_validation");
    let mut needed = BTreeMap::new();
    let mut validation_start = BTreeMap::new();
    let mut observed = PathObservations::new();
    for path in &paths {
        let generation = SourceGeneration::observe_stat(host, path, listed_stats[path])?;
        let index = &mut sources.lazy.get_mut(collection).expect("lazy").stream.index;
        if !index.checked_validation(host, path, &generation)?
            && !index.validated.contains_key(path)
        {
            if let Some(loaded) = index
                .store
                .as_ref()
                .and_then(|store| store.load(host, &generation, "valid"))
            {
                if loaded.payload.is_empty() {
                    if loaded.unchanged {
                        index.validated.insert(path.clone(), generation.clone());
                    } else if loaded.generation.covered_len > 0
                        && host
                            .read_range(path, loaded.generation.covered_len - 1, 1)
                            .ok()
                            .as_deref()
                            == Some(b"\n")
                    {
                        validation_start.insert(path.clone(), loaded.generation.covered_len);
                    }
                }
            }
        }
        let previous = sources.lazy[collection].stream.index.validated.get(path);
        observed.insert(path.clone(), Some(generation.clone()));
        if previous != Some(&generation) {
            // A changed observation is not evidence of an append-only prefix.
            needed.insert(path.clone(), generation);
        }
    }
    if needed.is_empty() {
        // Reuse the same fresh observation for validation and membership.
        // No schema layout or document decoder is needed on a warm lookup.
        let index = &mut sources
            .lazy
            .get_mut(collection)
            .expect("lazy collection")
            .stream
            .index;
        let candidates = index
            .id_membership_observed(host, &paths, &observed)
            .and_then(|locator| locator.locate(id))
            .map_err(|error| contextualize(error, &source))?;
        for (path, location) in candidates {
            if let Some(row) = index.verify_candidate(host, &path, location, id)? {
                return Ok(Some(row));
            }
        }
        return Ok(None);
    }
    let config = &sources.config.collection_configs[collection];
    let mut decode_config = config.clone();
    decode_config.schema = crate::schema_checks::storage_decode_schema(&config.schema);
    let decoder = RowDecoder {
        collection: config,
        storage: &decode_config,
        source: &source,
        callbacks: &sources.callbacks,
    };
    let files: BTreeMap<_, _> = needed
        .keys()
        .map(|path| {
            (
                path.clone(),
                (
                    proseql_storage::partitioned::file_source(&source, path),
                    proseql_storage::partition_prune::partition_key_of_path(&source, path),
                ),
            )
        })
        .collect();
    let prepared = proseql_engine::scan::decoder::SimpleDecoder::new(&config.schema);
    let validate_line =
        |path: &str, bytes: &[u8], final_line: bool| -> Result<Option<Box<str>>, EngineError> {
            use proseql_engine::scan::borrowed::BorrowedValue;
            let (file, expected) = &files[path];
            if matches!(
                config.id_strategy,
                proseql_engine::descriptor::IdStrategy::Provided
            ) {
                if let Some(row) = prepared
                    .as_ref()
                    .and_then(|decoder| decoder.decode(bytes).ok().flatten())
                {
                    if row
                        .get("id")
                        .and_then(BorrowedValue::as_str)
                        .is_some_and(|id| !id.is_empty())
                        && crate::streaming::borrowed_partition_matches(
                            &source,
                            expected.as_deref(),
                            &row,
                        )
                    {
                        return Ok(row
                            .get("id")
                            .and_then(BorrowedValue::as_str)
                            .map(Into::into));
                    }
                }
            }
            // Only canonical replay constructs errors and handles complex schemas.
            let mut terminated = Vec::new();
            let bytes = if final_line {
                bytes
            } else {
                terminated.extend_from_slice(bytes);
                terminated.push(b'\n');
                &terminated
            };
            decoder.decode_row(host, formats, file, bytes).map(|_| None)
        };
    // Append can build membership without validating payloads. Validate such
    // scopes before locator errors, preserving validation-before-duplicate
    // precedence. First-use builds still fuse the two scans.
    let prevalidated = sources.lazy[collection].stream.index.ids.is_some();
    if prevalidated {
        for (path, generation) in &needed {
            rows::visit_lines(
                host,
                path,
                *validation_start.get(path).unwrap_or(&0),
                generation.covered_len,
                0,
                |bytes, _, final_line| validate_line(path, bytes, final_line).map(|_| ()),
            )?;
        }
    }
    let mut visited = BTreeMap::<String, u64>::new();
    let candidates = {
        let mut visit = |path: &str, bytes: &[u8], location: RowLocation, final_line: bool| {
            if !prevalidated
                && needed.contains_key(path)
                && location.offset >= *validation_start.get(path).unwrap_or(&0)
            {
                let id = validate_line(path, bytes, final_line)?;
                visited.entry(path.into()).or_insert(location.offset);
                return Ok(id);
            }
            Ok(None)
        };
        sources
            .lazy
            .get_mut(collection)
            .expect("lazy collection")
            .stream
            .index
            .id_locator_observed_decoded(host, &paths, &observed, &mut visit)
            .and_then(|locator| locator.locate(id))
            .map_err(|error| contextualize(error, &source))?
    };
    for (path, generation) in &needed {
        let covered =
            prevalidated || visited.get(path) == Some(validation_start.get(path).unwrap_or(&0));
        if !covered {
            rows::visit_lines(
                host,
                path,
                *validation_start.get(path).unwrap_or(&0),
                generation.covered_len,
                0,
                |bytes, _, final_line| validate_line(path, bytes, final_line).map(|_| ()),
            )?;
        }
        if generation.check(host)? != GenerationCheck::Unchanged {
            return Err(crate::operation_error(
                "source-changed",
                format!("Source '{path}' changed during ID validation"),
            ));
        }
    }
    for (path, generation) in needed {
        sources
            .lazy
            .get_mut(collection)
            .expect("lazy collection")
            .stream
            .index
            .validated
            .insert(path, generation);
    }
    drop(validation);
    for (path, location) in candidates {
        if let Some(row) = sources
            .lazy
            .get_mut(collection)
            .expect("lazy collection")
            .stream
            .index
            .verify_candidate(host, &path, location, id)?
        {
            return Ok(Some(row));
        }
    }
    Ok(None)
}

/// Configure codec context once at runtime assembly; reloads move this state.
pub(crate) fn configure_streaming_index(
    sources: &mut crate::sources::SourceState,
    formats: &Arc<FormatRegistry>,
) {
    for (collection, lazy) in &mut sources.lazy {
        let config = sources.config.collection_configs[collection].clone();
        let mut storage = config.clone();
        storage.schema = crate::schema_checks::storage_decode_schema(&config.schema);
        let fingerprint_bytes = serde_json::to_vec(&(
            &config.schema,
            &config.id_strategy,
            &config.version,
            format!("{:?}", &config.migrations),
            format!(
                "{:?}",
                (
                    &lazy.source.id,
                    &lazy.source.collection,
                    &lazy.source.format,
                    &lazy.source.partition_by,
                    &lazy.source.prose
                )
            ),
        ))
        .unwrap_or_default();
        fn callback_free(schema: &proseql_engine::descriptor::SchemaNode) -> bool {
            use proseql_engine::descriptor::SchemaNode;
            match schema {
                SchemaNode::Checked { .. } | SchemaNode::OptionalWithDefault { .. } => false,
                SchemaNode::Struct { fields } => {
                    fields.iter().all(|field| callback_free(&field.schema))
                }
                SchemaNode::Array { item }
                | SchemaNode::Optional(item)
                | SchemaNode::NullOr(item) => callback_free(item),
                SchemaNode::Record { key, value } => callback_free(key) && callback_free(value),
                _ => true,
            }
        }
        let callback_free = callback_free(&config.schema) && config.migrations.is_empty();
        lazy.stream.index.store =
            (formats.borrowed_jsonl_compatible(&lazy.source.format) && callback_free).then(|| {
                Store::new(
                    lazy.source.root.clone(),
                    proseql_storage::index::persist::checksum(&fingerprint_bytes),
                )
            });
        lazy.stream.index.codec = Some(CodecContext {
            positional: formats.borrowed_jsonl_compatible(&lazy.source.format),
            formats: Arc::clone(formats),
            source: lazy.source.clone(),
            collection: config,
            storage,
            callbacks: Arc::clone(&sources.callbacks),
        });
    }
}

impl NativeRuntime {
    /// Release derived indexes for streaming lazy collections, keeping their
    /// codec context. Call when idle to trade retained metadata for the next
    /// operation's checked sidecar load or text rebuild cost. Publishes eligible
    /// disposable sidecars first. Results and durable source files do not change.
    /// This drops allocations; it does not promise allocator RSS reclamation.
    pub fn release_streaming_indexes(&self) -> Result<(), EngineError> {
        let mut state = self.lock_open()?;
        let state = &mut *state;
        if let Some(sources) = state.sources.as_mut() {
            for lazy in sources.lazy.values_mut() {
                lazy.stream.index.save(state.host.as_ref());
                lazy.stream.index.invalidate();
            }
        }
        Ok(())
    }

    pub(crate) fn streaming_find_by_id(
        &self,
        collection: &str,
        id: &str,
    ) -> Option<Result<Option<Value>, EngineError>> {
        let mut state = match self.lock_open() {
            Ok(state) => state,
            Err(error) => return Some(Err(error)),
        };
        if !state
            .sources
            .as_ref()
            .is_some_and(|sources| sources.is_lazy(collection))
        {
            return None;
        }
        let state = &mut *state;
        Some(lookup(
            state.sources.as_mut().expect("source runtime"),
            state.host.as_ref(),
            &state.formats,
            collection,
            id,
        ))
    }
}

pub(crate) fn mutation_find_by_id(
    inner: &mut MutationInner<'_>,
    collection: &str,
    id: &str,
) -> Option<Result<Option<Value>, EngineError>> {
    let lazy = inner.lazy.as_mut()?;
    lazy.sources.lazy.get(collection)?;
    Some(lookup(
        lazy.sources,
        lazy.host,
        lazy.formats,
        collection,
        id,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proseql_engine::descriptor::{IdStrategy, SchemaNode};
    use proseql_formats::{FormatCodec, FormatOptions};
    use proseql_storage::memory::MemoryStorageHost;
    use proseql_storage::source_config::PartitionKey;

    #[test]
    fn validation_proofs_require_exact_generation_schema_and_sound_sidecars() {
        use proseql_storage::fs::FsStorageHost;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let path = format!("{root}/one.jsonl");
        let host = FsStorageHost::new_polling(std::time::Duration::from_secs(60)).unwrap();
        host.write(&path, "{\"id\":\"a\"}\n").unwrap();
        let generation = SourceGeneration::observe(&host, &path).unwrap().unwrap();
        let store = Store::new(root.into(), 7);
        store.save(&host, &generation, "valid", &[]);
        let mut index = IndexState {
            store: Some(store.clone()),
            ..IndexState::default()
        };
        assert!(index.checked_validation(&host, &path, &generation).unwrap());
        assert!(index.checked_validation(&host, &path, &generation).unwrap());
        host.append(&path, "{\"id\":\"b\"}\n").unwrap();
        let grown = SourceGeneration::observe(&host, &path).unwrap().unwrap();
        assert!(!index.checked_validation(&host, &path, &grown).unwrap());
        host.write(&path, "{\"id\":\"c\"}\n").unwrap();
        let edited = SourceGeneration::observe(&host, &path).unwrap().unwrap();
        assert!(!index.checked_validation(&host, &path, &edited).unwrap());
        host.write(&path, "{\"id\":\"a\"}\n").unwrap();
        let generation = SourceGeneration::observe(&host, &path).unwrap().unwrap();
        store.save(&host, &generation, "valid", &[]);
        let mut other_schema = IndexState {
            store: Some(Store::new(root.into(), 8)),
            ..IndexState::default()
        };
        assert!(!other_schema
            .checked_validation(&host, &path, &generation)
            .unwrap());
        let cache = store.path(&path, "valid").unwrap();
        let original = std::fs::read(&cache).unwrap();
        for old in [false, true] {
            let mut bytes = original.clone();
            if old {
                bytes[16..24].copy_from_slice(&0u64.to_le_bytes());
                let end = bytes.len() - 8;
                let hash = proseql_storage::index::persist::checksum(&bytes[..end]);
                bytes[end..].copy_from_slice(&hash.to_le_bytes());
            } else {
                bytes.truncate(19);
            }
            std::fs::write(&cache, bytes).unwrap();
            index.validated.clear();
            assert!(!index.checked_validation(&host, &path, &generation).unwrap());
        }
    }

    #[test]
    fn validated_listing_shortcut_requires_each_exact_validation_generation() {
        use proseql_storage::fs::FsStorageHost;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let host = FsStorageHost::new_polling(std::time::Duration::from_secs(60)).unwrap();
        let paths = (0..3)
            .map(|file| format!("{root}/{file}.jsonl"))
            .collect::<Vec<_>>();
        for (file, path) in paths.iter().enumerate() {
            host.write(path, &format!("{{\"id\":\"{file}\"}}\n"))
                .unwrap();
        }
        let mut index = IndexState {
            ids: Some(IdLocator::build(&host, &paths).unwrap()),
            ..IndexState::default()
        };
        let listed = paths
            .iter()
            .map(|path| (path.clone(), host.stat(path).unwrap().unwrap()))
            .collect::<Vec<_>>();
        assert!(!index.matches_validated_listing(&listed));
        for path in &paths {
            index.record_validation(
                path,
                SourceGeneration::observe(&host, path).unwrap().unwrap(),
            );
        }
        assert!(index.matches_validated_listing(&listed));
        index.validated.get_mut(&paths[1]).unwrap().covered_len += 1;
        assert!(!index.matches_validated_listing(&listed));
    }

    #[test]
    fn own_append_proofs_chain_and_external_edits_clear_them() {
        let host = MemoryStorageHost::default();
        let path = "parts/one.jsonl";
        host.write(path, "{\"id\":\"a\"}\n").unwrap();
        let paths = vec![path.to_owned()];
        let mut index = IndexState::default();
        let mut before = index
            .id_locator(&host, &paths)
            .unwrap()
            .generation_for(path)
            .unwrap()
            .clone();
        for id in ["b", "c"] {
            let offset = host.stat(path).unwrap().unwrap().len;
            host.append(path, &format!("{{\"id\":\"{id}\"}}\n"))
                .unwrap();
            let after = SourceGeneration::observe(&host, path).unwrap().unwrap();
            index
                .record_appended(
                    after.clone(),
                    offset,
                    &[(
                        id.into(),
                        RowLocation {
                            partition: 0,
                            offset,
                            ordinal: 0,
                        },
                    )],
                )
                .unwrap();
            let proof = index.append_proof(path).unwrap();
            assert_eq!(proof.before, before);
            assert_eq!(proof.after, after);
            assert_eq!(proof.start, offset);
            assert_eq!(
                index.append_proof(path).unwrap().after,
                after,
                "proof is non-consuming"
            );
            before = after;
        }
        host.write(path, "{\"id\":\"external\"}\n").unwrap();
        index.id_locator(&host, &paths).unwrap();
        assert!(index.append_proof(path).is_none());
        assert_eq!(
            index
                .id_locator_if_built()
                .unwrap()
                .locate("external")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn repeated_checked_publication_keeps_the_original_append_proof() {
        for count in [1, 4096] {
            let host = MemoryStorageHost::default();
            let path = "parts/one.jsonl";
            let first = "{\"id\":\"a\"}\n";
            host.write(path, first).unwrap();
            let mut index = IndexState::default();
            let before = index
                .id_locator(&host, &[path.into()])
                .unwrap()
                .generation_for(path)
                .unwrap()
                .clone();
            let mut suffix = String::new();
            let rows = (0..count)
                .map(|ordinal| {
                    let id = format!("b-{ordinal}");
                    let offset = (first.len() + suffix.len()) as u64;
                    suffix.push_str(&format!("{{\"id\":\"{id}\"}}\n"));
                    (
                        id,
                        RowLocation {
                            partition: 0,
                            offset,
                            ordinal: 0,
                        },
                    )
                })
                .collect::<Vec<_>>();
            host.append(path, &suffix).unwrap();
            let after = SourceGeneration::observe(&host, path).unwrap().unwrap();
            for _ in 0..3 {
                index
                    .record_appended(after.clone(), first.len() as u64, &rows)
                    .unwrap();
                let proof = index.append_proof(path).expect("checked proof retained");
                assert_eq!(proof.before, before);
                assert_eq!(proof.after, after);
                assert_eq!(proof.start, first.len() as u64);
                assert_eq!(
                    index
                        .id_locator_if_built()
                        .unwrap()
                        .locate("b-0")
                        .unwrap()
                        .len(),
                    1
                );
            }
        }
    }

    struct DelegatingCodec;
    impl FormatCodec for DelegatingCodec {
        fn name(&self) -> &str {
            "jsonl"
        }
        fn extensions(&self) -> &[&str] {
            &["jsonl"]
        }
        fn encode(&self, value: &Value, options: Option<FormatOptions>) -> Result<String, String> {
            proseql_formats::codecs::jsonl_codec().encode(value, options)
        }
        fn decode(&self, text: &str) -> Result<Value, String> {
            proseql_formats::codecs::jsonl_codec().decode(text)
        }
    }

    #[test]
    fn custom_codec_declines_time_seek_and_returns_partition_candidates() {
        let host = MemoryStorageHost::default();
        let path = "parts/one.jsonl";
        host.write(path, "{\"id\":\"a\",\"month\":\"one\",\"at\":1}\n")
            .unwrap();
        let config = CollectionStorageConfig {
            name: "rows".into(),
            schema: SchemaNode::Unknown,
            id_strategy: IdStrategy::Provided,
            version: None,
            migrations: vec![],
        };
        let mut index = IndexState {
            codec: Some(CodecContext {
                positional: false,
                formats: Arc::new(FormatRegistry::new(vec![Box::new(DelegatingCodec)])),
                source: PartitionedSourceConfig {
                    id: "rows".into(),
                    collection: "rows".into(),
                    root: "parts".into(),
                    format: "jsonl".into(),
                    partition_by: PartitionKey::Field {
                        field: "month".into(),
                    },
                    prose: None,
                },
                collection: config.clone(),
                storage: config,
                callbacks: Arc::new(CallbackRegistry::default()),
            }),
            ..IndexState::default()
        };
        assert!(index
            .time_index(
                &host,
                path,
                "at",
                SourceGeneration::observe(&host, path).unwrap().unwrap()
            )
            .unwrap()
            .is_none());
        let paths = vec![path.to_owned()];
        let candidates = index
            .id_locator(&host, &paths)
            .unwrap()
            .locate("a")
            .unwrap();
        assert_eq!(candidates[0].1.offset, UNKNOWN_OFFSET);
        assert_eq!(
            index
                .verify_candidate(&host, path, candidates[0].1, "a")
                .unwrap()
                .unwrap()["id"],
            "a"
        );
        assert!(index
            .verify_candidate(&host, path, candidates[0].1, "absent")
            .unwrap()
            .is_none());
        host.append(path, "{\"id\":\"b\",\"month\":\"one\",\"at\":2}\n")
            .unwrap();
        let candidates = index
            .id_locator(&host, &paths)
            .unwrap()
            .locate("b")
            .unwrap();
        assert_eq!(candidates[0].1.offset, UNKNOWN_OFFSET);
    }
}
