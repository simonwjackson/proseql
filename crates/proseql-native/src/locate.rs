//! Generation-checked positional indexes and nonresident ID lookup.
use crate::{ExecutionModel, MutationInner, NativeRuntime};
use proseql_engine::callbacks::CallbackRegistry;
use proseql_engine::errors::EngineError;
use proseql_engine::scan::RowLocation;
use proseql_formats::FormatRegistry;
use proseql_storage::generation::{GenerationCheck, SourceGeneration};
use proseql_storage::host::StorageHost;
use proseql_storage::index::{rows, IdLocator, TimeIndex, UNKNOWN_OFFSET};
use proseql_storage::persistence::CollectionStorageConfig;
use proseql_storage::source_config::{
    NormalizedCollectionFileSourceConfig, PartitionedSourceConfig,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

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

#[derive(Default)]
pub(crate) struct IndexState {
    times: BTreeMap<(String, String), TimeIndex>,
    ids: Option<IdLocator>,
    validated: BTreeMap<String, SourceGeneration>,
    codec: Option<CodecContext>,
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
        if self.codec.as_ref().is_some_and(|codec| !codec.positional) {
            return Ok(None);
        }
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
        if let Some(codec) = self.codec.as_ref().filter(|codec| !codec.positional) {
            let mut decode = |path: &str| codec.ids(host, path);
            if let Some(locator) = self.ids.as_mut() {
                locator.refresh_partitions(host, paths, &mut decode)?;
            } else {
                self.ids = Some(IdLocator::build_partitions(host, paths, &mut decode)?);
            }
        } else if let Some(locator) = self.ids.as_mut() {
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
        if location.offset == UNKNOWN_OFFSET {
            return Ok(codec.decode_partition(host, path)?.records.shift_remove(id));
        }
        let bytes = rows::read_line(host, path, location.offset)?;
        let file = proseql_storage::partitioned::file_source(&codec.source, path);
        let decoder = RowDecoder {
            collection: &codec.collection,
            storage: &codec.storage,
            source: &codec.source,
            callbacks: &codec.callbacks,
        };
        Ok(decoder
            .decode_row(host, &codec.formats, &file, &bytes)?
            .filter(|row| row.get("id").and_then(Value::as_str) == Some(id)))
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
    let listed = crate::lazy::list_partitions(host, &source)?;
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

    let config = &sources.config.collection_configs[collection];
    let mut decode_config = config.clone();
    decode_config.schema = crate::schema_checks::storage_decode_schema(&config.schema);
    let decoder = RowDecoder {
        collection: config,
        storage: &decode_config,
        source: &source,
        callbacks: &sources.callbacks,
    };

    // The locator scans IDs, not payloads. Validate every row it covers once
    // per checked generation, as the resident full-scope load does. Validation
    // never retains a partition's records or populates the engine collection.
    let validation = proseql_storage::diagnostics::span("streaming_id_validation");
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
            let file = proseql_storage::partitioned::file_source(&source, path);
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
                    decoder.decode_row(host, formats, &file, bytes).map(|_| ())
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
    drop(validation);
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

#[cfg(test)]
mod tests {
    use super::*;
    use proseql_engine::descriptor::{IdStrategy, SchemaNode};
    use proseql_formats::{FormatCodec, FormatOptions};
    use proseql_storage::memory::MemoryStorageHost;
    use proseql_storage::source_config::PartitionKey;

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
        assert!(index.time_index(&host, path, "at").unwrap().is_none());
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
