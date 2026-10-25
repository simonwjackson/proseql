//! Creates on streaming lazy collections. Only one batch and verified duplicate
//! candidates enter the engine; source partitions never do. Durability remains
//! in the ordinary source commit path.
//!
//! Under ExecutionModel::Streaming, create_many on a lazy collection resolves
//! every generated ID before validating the batch. If the batch fails
//! validation, a stateful ID generator may have advanced past the first invalid
//! record; Resident stops at the first invalid record. Generated IDs were never
//! guaranteed to be gap-free.
//!
//! Under ExecutionModel::Streaming, creating a record with a new ID in a lazy
//! collection does not read or validate the other rows of its target partition.
//! An invalid existing row no longer blocks such a create, but every read that
//! scans the row still fails with the same error. Resident loads and validates
//! the whole target partition before a create.

use crate::{ExecutionModel, MutationInner, RuntimeState};
use indexmap::IndexMap;
use proseql_engine::collection::CreateManyResult;
use proseql_engine::errors::{EngineError, SerializationError};
use proseql_engine::scan::RowLocation;
use proseql_storage::append::{
    decode_append_bytes, jsonl_tail_bytes, JsonlTail, TornLineDiagnostic,
};
use proseql_storage::generation::SourceGeneration;
use proseql_storage::host::StorageHost;
use proseql_storage::index::rows;
use proseql_storage::partitioned::{check_partition_record, partition_path};
use serde_json::Value;
use std::collections::HashSet;

/// State of the open mutation only. Cleared on both publication and rollback.
#[derive(Default)]
pub(crate) struct AppendState {
    ids: Vec<String>,
    targets: Vec<(String, Option<SourceGeneration>)>,
    /// Where the next durable append starts, including a possible separator.
    starts: IndexMap<String, u64>,
}

impl AppendState {
    pub fn resident_bytes(&self) -> usize {
        self.ids.capacity() * std::mem::size_of::<String>()
            + self.ids.iter().map(String::capacity).sum::<usize>()
            + self.targets.capacity() * std::mem::size_of::<(String, Option<SourceGeneration>)>()
            + self
                .targets
                .iter()
                .map(|(path, _)| path.capacity())
                .sum::<usize>()
            + self.starts.capacity() * std::mem::size_of::<(String, u64)>()
            + self.starts.keys().map(String::capacity).sum::<usize>()
    }

    pub(crate) fn target_generations(&self) -> &[(String, Option<SourceGeneration>)] {
        &self.targets
    }
}

pub(crate) fn applies(inner: &MutationInner<'_>, collection: &str) -> bool {
    inner.lazy.as_ref().is_some_and(|access| {
        access
            .sources
            .lazy
            .get(collection)
            .is_some_and(|lazy| lazy.execution_model == ExecutionModel::Streaming)
    })
}

pub(crate) fn create(
    inner: &mut MutationInner<'_>,
    collection: &str,
    mut data: Value,
) -> Result<Value, EngineError> {
    // Nonobjects retain the engine's ordinary validation error and timing.
    if !data.is_object() {
        return inner.database.create(collection, data);
    }
    resolve_id(inner, collection, &mut data)?;
    prepare(inner, collection, std::slice::from_ref(&data))?;
    let borrowed = load_candidates(inner, collection, std::slice::from_ref(&data))?;
    let result = inner.database.create(collection, data);
    finish_create(
        inner,
        collection,
        &borrowed,
        result.as_ref().map(std::slice::from_ref),
    );
    result
}

pub(crate) fn create_many(
    inner: &mut MutationInner<'_>,
    collection: &str,
    mut data: Vec<Value>,
) -> Result<CreateManyResult, EngineError> {
    if data.is_empty() {
        return inner.database.create_many(collection, data, false);
    }
    for record in &mut data {
        if record.is_object() {
            resolve_id(inner, collection, record)?;
        }
    }
    prepare(inner, collection, &data)?;
    let borrowed = load_candidates(inner, collection, &data)?;
    let result = inner.database.create_many(collection, data, false);
    finish_create(
        inner,
        collection,
        &borrowed,
        result.as_ref().map(|batch| batch.created.as_slice()),
    );
    result
}

fn resolve_id(
    inner: &mut MutationInner<'_>,
    collection: &str,
    data: &mut Value,
) -> Result<(), EngineError> {
    let id = inner.database.resolve_create_id(collection, data)?;
    data.as_object_mut()
        .expect("object checked")
        .insert("id".into(), Value::String(id));
    Ok(())
}

/// Capture conflict generations before staging anything in the engine. A
/// compact baseline costs one target-file byte buffer, never resident rows.
fn prepare(
    inner: &mut MutationInner<'_>,
    collection: &str,
    data: &[Value],
) -> Result<(), EngineError> {
    let access = inner.lazy.as_mut().expect("streaming lazy access");
    for record in data {
        let lazy = &access.sources.lazy[collection];
        let Ok(path) = partition_path(&lazy.source, record) else {
            // Required-field validation stays with the engine. If schema defaults
            // route somewhere not prepared here, planning refuses that target,
            // just as the resident path refuses an unloaded target today.
            continue;
        };
        if lazy.stream.append.starts.contains_key(&path) {
            continue;
        }
        let generation = SourceGeneration::observe(access.host, &path)?;
        let content = if generation.is_some() && !access.sources.contents.contains_key(&path) {
            let bytes = access.host.read_bytes(&path)?;
            let torn = match jsonl_tail_bytes(&bytes) {
                JsonlTail::Torn { keep, line } => Some(TornLineDiagnostic {
                    path: path.clone(),
                    line,
                    bytes: bytes.len() - keep,
                    message: format!(
                        "Ignored an interrupted append in '{path}'; the next append removes it"
                    ),
                }),
                _ => None,
            };
            let content = crate::stored_file::StoredFile::append(&bytes, torn.as_ref());
            if let Some(torn) = torn {
                if !access.sources.torn.iter().any(|old| old.path == path) {
                    access.sources.torn.push(torn);
                }
            }
            Some(content)
        } else {
            None
        };
        // Do not overwrite an accepted baseline after an external change: the
        // ordinary length+tail conflict check must still reject that change.
        if let Some(content) = content {
            access
                .sources
                .contents
                .entry(path.clone())
                .or_insert(content);
        }
        let start = access
            .sources
            .contents
            .get(&path)
            .map_or(0, |content| content.plan(&path, String::new()).keep_len);
        let append = &mut access
            .sources
            .lazy
            .get_mut(collection)
            .expect("lazy collection")
            .stream
            .append;
        append.targets.push((path.clone(), generation));
        append.starts.insert(path, start);
    }
    Ok(())
}

/// Locate globally once per batch, then deduplicate hash-collision candidates.
fn candidates(
    index: &mut crate::locate::IndexState,
    host: &dyn StorageHost,
    paths: &[String],
    ids: &[String],
) -> Result<Vec<(String, RowLocation)>, EngineError> {
    let locator = index.id_locator(host, paths)?;
    let mut candidates = Vec::new();
    for id in ids {
        candidates.extend(locator.locate(id)?);
    }
    candidates.sort();
    candidates.dedup();
    Ok(candidates)
}

/// Load only verified ID hits. Equality/default/duplicate policy remains in
/// the engine. All candidates validate before any one is installed.
fn load_candidates(
    inner: &mut MutationInner<'_>,
    collection: &str,
    data: &[Value],
) -> Result<Vec<String>, EngineError> {
    let access = inner.lazy.as_mut().expect("streaming lazy access");
    let lazy = access
        .sources
        .lazy
        .get_mut(collection)
        .expect("lazy collection");
    lazy.known = crate::lazy::list_partitions(access.host, &lazy.source)?;
    let paths = lazy.known.keys().cloned().collect::<Vec<_>>();
    let ids = data
        .iter()
        .filter_map(|record| record.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let wanted = ids.iter().map(String::as_str).collect::<HashSet<_>>();
    let locations = candidates(&mut lazy.stream.index, access.host, &paths, &ids).map_err(
        |error| match error {
            EngineError::SourceConfig(mut error) => {
                error
                    .source_id
                    .get_or_insert_with(|| lazy.source_id.clone());
                error
                    .collection
                    .get_or_insert_with(|| collection.to_owned());
                EngineError::SourceConfig(error)
            }
            other => other,
        },
    )?;
    let config = &access.sources.config.collection_configs[collection];
    let mut decode_config = config.clone();
    decode_config.schema = crate::schema_checks::storage_decode_schema(&config.schema);
    let mut records = Vec::new();
    let mut borrowed = Vec::new();
    let mut seen = HashSet::new();
    for (path, location) in locations {
        let mut bytes = rows::read_line(access.host, &path, location.offset)?;
        // Keep the registered codec and callback-aware schema decode used by
        // ordinary partition loading; equality must compare canonical records.
        bytes.push(b'\n');
        let file = proseql_storage::partitioned::file_source(&lazy.source, &path);
        let mut loaded = decode_append_bytes(
            access.host,
            access.formats,
            &file,
            &decode_config,
            &bytes,
            true,
        )?;
        crate::schema_checks::decode_loaded_records(
            &config.schema,
            &config.id_strategy,
            &mut loaded.records,
            &access.sources.callbacks,
        )?;
        for (id, record) in loaded.records {
            check_partition_record(&lazy.source, &path, &id, &record)?;
            if !wanted.contains(id.as_str()) {
                continue;
            }
            if !seen.insert(id.clone()) {
                return Err(EngineError::SourceConfig(Box::new(
                    proseql_engine::errors::SourceConfigError {
                        source_id: Some(lazy.source_id.clone()),
                        collection: Some(collection.to_owned()),
                        path: Some(path.clone()),
                        message: format!("Duplicate partition record '{id}'"),
                    },
                )));
            }
            if inner
                .database
                .collection(collection)
                .is_none_or(|records| records.get(&id).is_none())
            {
                borrowed.push(id);
                records.push(record);
            }
        }
    }
    inner
        .database
        .load_resident_records(collection, records, None, false)?;
    Ok(borrowed)
}

fn finish_create(
    inner: &mut MutationInner<'_>,
    collection: &str,
    borrowed: &[String],
    result: Result<&[Value], &EngineError>,
) {
    let append = &mut inner
        .lazy
        .as_mut()
        .expect("lazy access")
        .sources
        .lazy
        .get_mut(collection)
        .expect("lazy collection")
        .stream
        .append;
    if let Ok(rows) = result {
        for row in rows {
            let id = row["id"].as_str().expect("engine create ID");
            if !borrowed.iter().any(|old| old == id) && !append.ids.iter().any(|old| old == id) {
                append.ids.push(id.to_owned());
            }
        }
    }
    // This cannot fail: the engine collection exists and these moves cannot
    // enter its journal or notify watches. Also runs when callers catch errors.
    let _ = inner
        .database
        .unload_resident_records(collection, borrowed, false);
}

fn json_error(error: serde_json::Error) -> EngineError {
    EngineError::Serialization(Box::new(SerializationError {
        format: "jsonl".into(),
        message: format!("Failed to deserialize jsonl data: {error}"),
        cause: Some(Value::String(error.to_string())),
    }))
}

/// Record offsets without refreshing an index whose generations predate our
/// append. If a bookkeeping read fails, discard the disposable index instead.
fn record_committed(
    index: &mut crate::locate::IndexState,
    host: &dyn StorageHost,
    starts: &IndexMap<String, u64>,
) -> Result<(), EngineError> {
    let Some(locator) = index.id_locator_if_built() else {
        return Ok(());
    };
    for (path, start) in starts {
        let Some(stat) = host.stat(path)? else {
            continue;
        };
        let mut appended = Vec::new();
        rows::visit_lines(host, path, *start, stat.len, 0, |bytes, location, _| {
            let record: Value = serde_json::from_slice(bytes).map_err(json_error)?;
            if let Some(id) = record.get("id").and_then(Value::as_str) {
                appended.push((id.to_owned(), location));
            }
            Ok(())
        })?;
        locator.record_appended(path, &appended)?;
    }
    Ok(())
}

pub(crate) fn after_commit(state: &mut RuntimeState) {
    let Some(sources) = state.sources.as_mut() else {
        return;
    };
    for (name, lazy) in &mut sources.lazy {
        if lazy.execution_model != ExecutionModel::Streaming {
            continue;
        }
        let append = std::mem::take(&mut lazy.stream.append);
        if !append.ids.is_empty()
            && record_committed(&mut lazy.stream.index, state.host.as_ref(), &append.starts)
                .is_err()
        {
            lazy.stream.index = Default::default();
        }
        let _ = state
            .database
            .unload_resident_records(name, &append.ids, false);
    }
}

pub(crate) fn after_rollback(state: &mut RuntimeState) {
    if let Some(sources) = state.sources.as_mut() {
        for lazy in sources.lazy.values_mut() {
            lazy.stream.append = Default::default();
        }
    }
}

#[cfg(test)]
mod tests {
    // Internal evidence: new streaming targets keep compact append baselines, not
    // the growing file. The public-path acceptance tests are streaming_append.rs.
    use super::*;
    use crate::{
        FullScanPolicy, LazyPartitionPolicy, NativeCollectionConfig, NativeRuntime,
        NativeSourceRuntimeConfig, NativeSourceRuntimeOptions,
    };
    use proseql_engine::descriptor::{
        CollectionDescriptor, IdStrategy, SchemaNode, StructField, ValidationMode,
    };
    use proseql_storage::source_config::{
        DatabaseSourceConfig, PartitionKey, PartitionedSourceConfig,
    };
    use serde_json::json;

    #[test]
    fn ten_appends_to_a_new_partition_retain_only_a_compact_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let source = PartitionedSourceConfig {
            id: "rows".into(),
            collection: "rows".into(),
            root: dir.path().join("rows").to_string_lossy().into_owned(),
            format: "jsonl".into(),
            partition_by: PartitionKey::Field {
                field: "partition".into(),
            },
            prose: None,
        };
        let descriptor = CollectionDescriptor {
            name: "rows".into(),
            schema: SchemaNode::Struct {
                fields: ["id", "partition", "payload"]
                    .into_iter()
                    .map(|name| StructField {
                        name: name.into(),
                        schema: SchemaNode::Str,
                    })
                    .collect(),
            },
            id_strategy: IdStrategy::Provided,
            relationships: vec![],
            indexes: vec![],
            ordered_indexes: vec![],
            unique_fields: vec![],
            before_create_hooks: vec![],
            after_create_hooks: vec![],
            before_update_hooks: vec![],
            after_update_hooks: vec![],
            before_delete_hooks: vec![],
            after_delete_hooks: vec![],
            on_change_hooks: vec![],
            computed_fields: vec![],
            search_index: vec![],
            id_generator: None,
            version: None,
            migrations: vec![],
            append_only: true,
            duplicate_ids: Default::default(),
            validation_mode: ValidationMode::Strict,
        };
        let runtime = NativeRuntime::open_sources_with_options(
            NativeSourceRuntimeConfig {
                collections: vec![NativeCollectionConfig::new(descriptor)],
                sources: vec![DatabaseSourceConfig::Partitioned(source.clone())],
            },
            NativeSourceRuntimeOptions {
                execution_model: ExecutionModel::Streaming,
                watch_debounce: None,
                lazy_partitions: IndexMap::from([(
                    "rows".into(),
                    LazyPartitionPolicy {
                        max_loaded_partitions: 0,
                        full_scan: FullScanPolicy::Allow,
                    },
                )]),
                ..Default::default()
            },
        )
        .unwrap();
        let mut baseline_size = None;
        for i in 0..10 {
            let row =
                json!({"id": i.to_string(), "partition": "new", "payload": "x".repeat(16 * 1024)});
            runtime.mutate(|db| db.create("rows", row.clone())).unwrap();
            let path = partition_path(&source, &row).unwrap();
            let state = runtime.lock_open().unwrap();
            let sources = state.sources.as_ref().unwrap();
            let stored = &sources.contents[&path];
            let crate::stored_file::StoredFile::Append(baseline) = stored else {
                panic!("new streaming partition retained full bytes");
            };
            assert_eq!(
                *baseline_size.get_or_insert(std::mem::size_of_val(baseline.as_ref())),
                std::mem::size_of_val(baseline.as_ref())
            );
            assert!(stored.len() > 16 * 1024 * (i + 1));
            // A compact tail cannot claim to contain an 8 KiB suffix, even when
            // the growing file does. This exercises the bounded baseline variant.
            let bytes = std::fs::read(&path).unwrap();
            assert!(!stored.ends_with(&bytes[bytes.len() - 8192..]));
            assert!(stored.matches(&bytes));
            assert!(sources.lazy["rows"].resident.is_empty());
            assert_eq!(sources.lazy["rows"].stream.append.resident_bytes(), 0);
            assert!(state.database.collection("rows").unwrap().is_empty());
        }
    }
}
