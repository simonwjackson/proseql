//! Generation-checked positional indexes and nonresident ID lookup.
use crate::{ExecutionModel, MutationInner, NativeRuntime};
use proseql_engine::errors::EngineError;
use proseql_formats::FormatRegistry;
use proseql_storage::generation::{GenerationCheck, SourceGeneration};
use proseql_storage::host::StorageHost;
use proseql_storage::index::{rows, IdLocator, TimeIndex};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Default)]
pub(crate) struct IndexState {
    times: BTreeMap<(String, String), TimeIndex>,
    ids: Option<IdLocator>,
    validated: BTreeMap<String, SourceGeneration>,
}

impl IndexState {
    // called by exec/append; removed at integration
    #[allow(dead_code)]
    pub fn time_index(
        &mut self,
        host: &dyn StorageHost,
        path: &str,
        field: &str,
    ) -> Result<Option<&TimeIndex>, EngineError> {
        let key = (path.to_owned(), field.to_owned());
        if let Some(index) = self.times.get_mut(&key) {
            index.refresh(host)?;
        } else {
            self.times
                .insert(key.clone(), TimeIndex::build(host, path, field, 1024)?);
        }
        Ok(self
            .times
            .get(&key)
            .filter(|index| index.seek(None, None).is_some()))
    }

    pub fn id_locator(
        &mut self,
        host: &dyn StorageHost,
        paths: &[String],
    ) -> Result<&mut IdLocator, EngineError> {
        if let Some(locator) = self.ids.as_mut() {
            locator.refresh(host, paths)?;
        } else {
            self.ids = Some(IdLocator::build(host, paths)?);
        }
        Ok(self.ids.as_mut().expect("built locator"))
    }

    // called by exec/append; removed at integration
    #[allow(dead_code)]
    pub fn id_locator_if_built(&mut self) -> Option<&mut IdLocator> {
        self.ids.as_mut()
    }

    pub fn resident_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.ids.as_ref().map_or(0, IdLocator::resident_bytes)
            + self
                .times
                .iter()
                .map(|((path, field), index)| {
                    path.capacity() + field.capacity() + index.resident_bytes()
                })
                .sum::<usize>()
            + self
                .validated
                .iter()
                .map(|(path, generation)| {
                    path.capacity()
                        + generation.path.capacity()
                        + std::mem::size_of::<SourceGeneration>()
                })
                .sum::<usize>()
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

fn decode_row(
    sources: &crate::sources::SourceState,
    host: &dyn StorageHost,
    formats: &FormatRegistry,
    source: &proseql_storage::source_config::PartitionedSourceConfig,
    path: &str,
    bytes: &[u8],
) -> Result<Option<Value>, EngineError> {
    let config = &sources.config.collection_configs[&source.collection];
    let mut decode_config = config.clone();
    decode_config.schema = crate::schema_checks::storage_decode_schema(&config.schema);
    let mut loaded = proseql_storage::append::decode_append_bytes(
        host,
        formats,
        &proseql_storage::partitioned::file_source(source, path),
        &decode_config,
        bytes,
        true,
    )?;
    crate::schema_checks::decode_loaded_records(
        &config.schema,
        &config.id_strategy,
        &mut loaded.records,
        &sources.callbacks,
    )?;
    for (id, row) in &loaded.records {
        proseql_storage::partitioned::check_partition_record(source, path, id, row)?;
    }
    Ok(loaded.records.into_values().next())
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
    let listed = crate::lazy::list_partitions(host, &source)?;
    let paths = listed.keys().cloned().collect::<Vec<_>>();
    sources
        .lazy
        .get_mut(collection)
        .expect("lazy collection")
        .known = listed;

    // The locator scans IDs, not payloads. Validate every row it covers once
    // per checked generation, as the resident full-scope load does. Validation
    // never retains a partition's records or populates the engine collection.
    for path in &paths {
        let previous = sources.lazy[collection]
            .stream
            .index
            .validated
            .get(path)
            .cloned();
        let check = previous
            .as_ref()
            .map(|generation| generation.check(host))
            .transpose()?;
        if check == Some(GenerationCheck::Unchanged) {
            continue;
        }
        let generation = SourceGeneration::observe(host, path)?;
        if let Some(generation) = generation {
            rows::visit_lines(
                host,
                path,
                0,
                generation.covered_len,
                0,
                |bytes, _, final_line| {
                    // Keep malformed terminated lines strict; single-line append
                    // decoding would otherwise classify them as a torn tail.
                    let mut terminated = Vec::new();
                    let bytes = if final_line {
                        bytes
                    } else {
                        terminated.extend_from_slice(bytes);
                        terminated.push(b'\n');
                        &terminated
                    };
                    decode_row(sources, host, formats, &source, path, bytes).map(|_| ())
                },
            )?;
            if generation.check(host)? != GenerationCheck::Unchanged {
                return Err(crate::operation_error(
                    "source-changed",
                    format!("Source '{path}' changed during ID validation"),
                ));
            }
            sources
                .lazy
                .get_mut(collection)
                .expect("lazy collection")
                .stream
                .index
                .validated
                .insert(path.clone(), generation);
        }
    }
    let candidates = sources
        .lazy
        .get_mut(collection)
        .expect("lazy collection")
        .stream
        .index
        .id_locator(host, &paths)
        .and_then(|locator| locator.locate(id))
        .map_err(|error| contextualize(error, &source))?;
    for (path, location) in candidates {
        let bytes = rows::read_line(host, &path, location.offset)?;
        if let Some(row) = decode_row(sources, host, formats, &source, &path, &bytes)? {
            if row.get("id").and_then(Value::as_str) == Some(id) {
                return Ok(Some(row));
            }
        }
    }
    Ok(None)
}

/// Called once when a runtime is assembled (`NativeRuntime::from_loaded`),
/// before any operation, with the runtime's final format registry. Store in
/// each lazy collection's `IndexState` whatever codec context it needs (for
/// example whether the source's codec is the built-in JSONL codec, the
/// registry, the source and collection config, and `sources.callbacks`).
/// Reloads move the configured state (`lazy_adopt`).
pub(crate) fn configure_streaming_index(
    _sources: &mut crate::sources::SourceState,
    _formats: &std::sync::Arc<proseql_formats::FormatRegistry>,
) {
}

impl NativeRuntime {
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
            .and_then(|sources| sources.lazy.get(collection))
            .is_some_and(|lazy| lazy.execution_model == ExecutionModel::Streaming)
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
    if lazy.sources.lazy.get(collection)?.execution_model != ExecutionModel::Streaming {
        return None;
    }
    Some(lookup(
        lazy.sources,
        lazy.host,
        lazy.formats,
        collection,
        id,
    ))
}
