//! Watches retain evaluated results and generation baselines, never source rows.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::lazy::{list_partitions, LazyCollection};
use crate::streaming::{ReadOutput, ReadRequest};
use crate::{ExecutionModel, NativeRuntime, NativeWatch, RuntimeState};
use proseql_engine::errors::EngineError;
use proseql_engine::query::pipeline::QueryInput;
use proseql_engine::reactive::external::{ChangeEventPublisher, ExternalWatch};
use proseql_engine::reactive::{CallbackSubscription, ValueSubscription, WatchQueryConfig};
use proseql_storage::generation::{GenerationCheck, SourceGeneration};
use proseql_storage::host::StorageHost;
use serde_json::Value;

#[derive(Default)]
pub(crate) struct WatchState {
    entries: BTreeMap<u64, Entry>,
    pub(crate) baseline: BTreeMap<String, SourceGeneration>,
    next_id: u64,
    revision: u64,
    reload_pending: bool,
}

struct Entry {
    config: WatchQueryConfig,
    publisher: Arc<ExternalWatch>,
    dirty: bool,
    last_error: Option<EngineError>,
}

impl WatchState {
    pub fn resident_bytes(&self) -> usize {
        self.baseline
            .iter()
            .map(|(path, generation)| {
                path.capacity()
                    + generation.path.capacity()
                    + std::mem::size_of::<SourceGeneration>()
            })
            .sum::<usize>()
            + self
                .entries
                .values()
                .map(|entry| entry.publisher.resident_bytes() + std::mem::size_of::<Entry>())
                .sum::<usize>()
    }

    fn prune(&mut self) {
        self.entries.retain(|_, entry| entry.publisher.is_active());
        if self.entries.is_empty() {
            self.baseline.clear();
        }
    }

    fn changed(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        for entry in self.entries.values_mut() {
            entry.dirty = true;
        }
    }
}

fn input(config: &WatchQueryConfig) -> QueryInput {
    QueryInput {
        r#where: config.r#where.clone(),
        sort: config.sort.clone(),
        offset: config.offset,
        limit: config.limit,
        select: config.select.clone(),
        ..Default::default()
    }
}

impl NativeRuntime {
    pub(crate) fn streaming_watch_applies(&self, collection: &str) -> bool {
        self.inner
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .sources
                    .as_ref()
                    .and_then(|s| s.lazy.get(collection))
                    .map(|lazy| lazy.execution_model == ExecutionModel::Streaming)
            })
            .unwrap_or(false)
    }

    fn watch_rows(
        &self,
        collection: &str,
        config: &WatchQueryConfig,
    ) -> Result<Vec<Value>, EngineError> {
        let input = input(config);
        if let Some(answer) = self.streaming_read(
            collection,
            ReadRequest::Query {
                input: &input,
                populate: None,
            },
        ) {
            return answer.map(|(output, _)| match output {
                ReadOutput::Rows(rows) => rows,
                _ => unreachable!("query read output"),
            });
        }
        // During the staged rollout exec can still decline the hook. This is
        // intentionally the existing engine, not a second query implementation.
        self.query(collection, input, None)
    }

    fn register_streaming_watch<S>(
        &self,
        collection: &str,
        config: WatchQueryConfig,
        subscribe: impl FnOnce(&ExternalWatch) -> Result<S, EngineError>,
    ) -> Result<(NativeWatch<S>, Arc<ExternalWatch>), EngineError> {
        let mut subscribe = Some(subscribe);
        loop {
            let (before, revision) = {
                let mut state = self.lock_open()?;
                self.drain_unpins(&mut state);
                let sources = state.sources.as_ref().expect("streaming source");
                let (_, paths) =
                    sources.lazy_scope(collection, config.r#where.as_ref(), "watch")?;
                let before = observe(state.host.as_ref(), &paths)?;
                (before, sources.lazy[collection].stream.watch.revision)
            };
            let rows = self.watch_rows(collection, &config)?;
            let mut state = self.lock_open()?;
            let sources = state.sources.as_ref().expect("streaming source");
            let (_, paths) = sources.lazy_scope(collection, config.r#where.as_ref(), "watch")?;
            if before != observe(state.host.as_ref(), &paths)?
                || sources.lazy[collection].stream.watch.revision != revision
            {
                continue;
            }
            let publisher = Arc::new(ExternalWatch::from_database(
                rows,
                config.debounce_ms,
                &state.database,
            ));
            let subscription = subscribe.take().expect("subscribe once")(&publisher)?;
            let watch = &mut state
                .sources
                .as_mut()
                .expect("source mode")
                .lazy
                .get_mut(collection)
                .expect("lazy collection")
                .stream
                .watch;
            watch.prune();
            watch.next_id = watch.next_id.wrapping_add(1);
            watch.entries.insert(
                watch.next_id,
                Entry {
                    config,
                    publisher: Arc::clone(&publisher),
                    dirty: false,
                    last_error: None,
                },
            );
            watch.baseline.extend(before);
            return Ok((
                NativeWatch {
                    subscription,
                    _pin: None,
                },
                publisher,
            ));
        }
    }

    pub(crate) fn streaming_watch(
        &self,
        collection: &str,
        config: WatchQueryConfig,
    ) -> Result<NativeWatch<ValueSubscription>, EngineError> {
        self.register_streaming_watch(collection, config, ExternalWatch::subscribe)
            .map(|(watch, _)| watch)
    }

    pub(crate) fn streaming_watch_with_callback(
        &self,
        collection: &str,
        config: WatchQueryConfig,
        callback: Box<dyn Fn(Value) + Send + Sync>,
    ) -> Result<NativeWatch<CallbackSubscription>, EngineError> {
        let (watch, publisher) =
            self.register_streaming_watch(collection, config, |publisher| {
                publisher.subscribe_callback(callback)
            })?;
        publisher.deliver_initial();
        Ok(watch)
    }

    pub(crate) fn refresh_streaming_watches(&self) -> Result<(), EngineError> {
        let (jobs, events, mut first_error) = {
            let mut state = self.lock_open()?;
            let events = ChangeEventPublisher::new(&state.database);
            let Some(sources) = state.sources.as_mut() else {
                return Ok(());
            };
            let mut jobs = Vec::new();
            let mut first_error = None;
            for (name, lazy) in &mut sources.lazy {
                if lazy.execution_model != ExecutionModel::Streaming {
                    continue;
                }
                let watch = &mut lazy.stream.watch;
                watch.prune();
                for (id, entry) in &watch.entries {
                    if !entry.dirty {
                        if let Some(error) = &entry.last_error {
                            first_error.get_or_insert_with(|| error.clone());
                        }
                    }
                    if entry.dirty {
                        jobs.push((
                            name.clone(),
                            *id,
                            watch.revision,
                            entry.config.clone(),
                            Arc::clone(&entry.publisher),
                        ));
                    }
                }
            }
            (jobs, events, first_error)
        };
        let mut reloaded = BTreeSet::new();
        let mut completed = false;
        for (name, id, revision, config, publisher) in jobs {
            let result = self.watch_rows(&name, &config);
            let accepted = {
                let mut state = self.lock_open()?;
                let Some(lazy) = state.sources.as_mut().and_then(|s| s.lazy.get_mut(&name)) else {
                    continue;
                };
                if lazy.stream.watch.revision != revision {
                    continue;
                }
                let Some(entry) = lazy.stream.watch.entries.get_mut(&id) else {
                    continue;
                };
                entry.dirty = false;
                completed = true;
                match result {
                    Ok(rows) => {
                        entry.last_error = None;
                        if lazy.stream.watch.reload_pending {
                            lazy.stream.watch.reload_pending = false;
                            reloaded.insert(name.clone());
                        }
                        Some(rows)
                    }
                    Err(error) => {
                        entry.last_error = Some(error.clone());
                        first_error.get_or_insert(error);
                        None
                    }
                }
            };
            // Bad external bytes keep the last accepted result. A later edit
            // changes the generation and retries; the subscription stays live.
            if let Some(rows) = accepted {
                publisher.replace(revision, rows);
            }
        }
        if completed || first_error.is_some() {
            if let Ok(mut state) = self.lock_open() {
                state.last_reload_error = first_error.clone();
            }
        }
        for collection in reloaded {
            events.publish(proseql_engine::reactive::ChangeEvent {
                collection,
                operation: proseql_engine::reactive::ChangeOperation::Reload,
            });
        }
        first_error.map_or(Ok(()), Err)
    }
}

fn observe(
    host: &dyn StorageHost,
    paths: &[String],
) -> Result<BTreeMap<String, SourceGeneration>, EngineError> {
    paths
        .iter()
        .filter_map(|path| match SourceGeneration::observe(host, path) {
            Ok(Some(generation)) => Some(Ok((path.clone(), generation))),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

pub(crate) fn refresh_applies(state: &RuntimeState) -> bool {
    state.sources.as_ref().is_some_and(|s| {
        s.lazy
            .values()
            .any(|lazy| lazy.execution_model == ExecutionModel::Streaming)
    })
}

pub(crate) fn refresh(state: &mut RuntimeState) -> Result<(), EngineError> {
    if let Some(sources) = state.sources.as_mut() {
        sources.lazy_refresh(&mut state.database, state.host.as_ref(), &state.formats)?;
        state.database.take_committed_changes();
        sources.lazy_trim(&mut state.database)?;
    }
    Ok(())
}

/// Also used by explicit source reload, which calls lazy_refresh directly.
pub(crate) fn refresh_collection(
    lazy: &mut LazyCollection,
    host: &dyn StorageHost,
) -> Result<(), EngineError> {
    let listed = list_partitions(host, &lazy.source)?;
    let watch = &mut lazy.stream.watch;
    watch.prune();
    let changed = listed != lazy.known
        || watch
            .baseline
            .values()
            .map(|generation| generation.check(host))
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|check| *check != GenerationCheck::Unchanged);
    lazy.known = listed;
    if changed {
        lazy.stream.index = Default::default();
        watch.changed();
        watch.reload_pending = true;
        // Failed bytes are also baselined: retry only after another change.
        let paths = covered_paths(lazy);
        lazy.stream.watch.baseline = observe(host, &paths)?;
    }
    Ok(())
}

pub(crate) fn prune(lazy: &mut LazyCollection) {
    lazy.stream.watch.prune();
    let paths = covered_paths(lazy);
    lazy.stream
        .watch
        .baseline
        .retain(|path, _| paths.contains(path));
}

fn covered_paths(lazy: &LazyCollection) -> Vec<String> {
    lazy.known
        .iter()
        .filter(|(_, key)| {
            lazy.stream.watch.entries.values().any(|entry| {
                proseql_storage::partition_prune::PartitionFilter::from_where(
                    entry.config.r#where.as_ref(),
                    &lazy.source.partition_by,
                )
                .matches(key)
            })
        })
        .map(|(path, _)| path.clone())
        .collect()
}

/// Advance the poll baseline after durable success, while the batch still
/// exists. Re-evaluation runs after append's silent cleanup and after unlock.
pub(crate) fn capture_commit(state: &mut RuntimeState) {
    let Some(sources) = state.sources.as_mut() else {
        return;
    };
    for lazy in sources.lazy.values_mut() {
        if lazy.execution_model != ExecutionModel::Streaming {
            continue;
        }
        lazy.stream.watch.prune();
        lazy.stream.watch.changed();
        let paths = covered_paths(lazy);
        if let Ok(baseline) = observe(state.host.as_ref(), &paths) {
            lazy.stream.watch.baseline = baseline;
        }
    }
}

#[cfg(test)]
mod metrics {
    use super::*;
    use crate::{
        FullScanPolicy, LazyPartitionPolicy, NativeCollectionConfig, NativeSourceRuntimeConfig,
        NativeSourceRuntimeOptions,
    };
    use indexmap::IndexMap;
    use proseql_engine::descriptor::{
        CollectionDescriptor, DuplicateIdPolicy, IdStrategy, SchemaNode, StructField,
        ValidationMode,
    };
    use proseql_storage::source_config::{
        DatabaseSourceConfig, PartitionKey, PartitionedSourceConfig, TimeBucket,
    };
    use std::io::Write;
    use std::time::Instant;

    #[test]
    #[ignore = "synthetic watch memory/poll measurement; run alone in release mode"]
    fn one_month_watch_and_ten_month_poll_cost() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor = CollectionDescriptor {
            name: "samples".into(),
            schema: SchemaNode::Struct {
                fields: [
                    ("id", SchemaNode::Str),
                    ("atUtc", SchemaNode::Str),
                    ("value", SchemaNode::Num),
                    ("payload", SchemaNode::Str),
                ]
                .into_iter()
                .map(|(name, schema)| StructField {
                    name: name.into(),
                    schema,
                })
                .collect(),
            },
            id_strategy: IdStrategy::Provided,
            append_only: true,
            duplicate_ids: DuplicateIdPolicy::IgnoreIdentical,
            relationships: vec![],
            indexes: vec![],
            ordered_indexes: vec!["atUtc".into()],
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
            validation_mode: ValidationMode::Strict,
        };
        // January has the same 66,960-row count as Stage 0. Nine other months are
        // listed; their payload cannot affect the cost of an unchanged range poll.
        for month in 1..=10 {
            let mut file = std::io::BufWriter::new(
                std::fs::File::create(dir.path().join(format!("2025-{month:02}.jsonl"))).unwrap(),
            );
            for n in 0..if month == 1 { 66_960 } else { 1 } {
                let day = n / 2160 + 1;
                let minute = n % 1440;
                let at = format!(
                    "2025-{month:02}-{day:02}T{:02}:{:02}:00.000Z",
                    minute / 60,
                    minute % 60
                );
                writeln!(file, "{}", serde_json::json!({"id": format!("sample:{at}:{n}"), "atUtc": at, "value": n, "payload": "x".repeat(192)})).unwrap();
            }
        }
        let runtime = NativeRuntime::open_sources_with_options(
            NativeSourceRuntimeConfig {
                collections: vec![NativeCollectionConfig::new(descriptor)],
                sources: vec![DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
                    id: "samples".into(),
                    collection: "samples".into(),
                    root: dir.path().to_string_lossy().into_owned(),
                    format: "jsonl".into(),
                    partition_by: PartitionKey::TimeBucket {
                        field: "atUtc".into(),
                        bucket: TimeBucket::Month,
                    },
                    prose: None,
                })],
            },
            NativeSourceRuntimeOptions {
                execution_model: ExecutionModel::Streaming,
                watch_debounce: None,
                lazy_partitions: IndexMap::from([(
                    "samples".into(),
                    LazyPartitionPolicy {
                        max_loaded_partitions: 0,
                        full_scan: FullScanPolicy::Allow,
                    },
                )]),
                ..Default::default()
            },
        )
        .unwrap();
        for limit in [Some(16), None] {
            let watch = runtime
                .watch(
                    "samples",
                    WatchQueryConfig {
                        r#where: Some(serde_json::json!({"atUtc":{"$startsWith":"2025-01"}})),
                        select: Some(serde_json::json!(["id"])),
                        limit,
                        debounce_ms: Some(0),
                        ..Default::default()
                    },
                )
                .unwrap();
            let output = watch.recv().unwrap();
            let (fingerprints, host) = {
                let mut state = runtime.lock_open().unwrap();
                let host = Arc::clone(&state.host);
                let sources = state.sources.as_mut().unwrap();
                let lazy = sources.lazy.get_mut("samples").unwrap();
                let entry = lazy.stream.watch.entries.values().next().unwrap();
                let (values, serialized) = entry.publisher.retained_sizes();
                let generation_bytes = lazy
                    .stream
                    .watch
                    .baseline
                    .iter()
                    .map(|(path, generation)| {
                        path.capacity()
                            + generation.path.capacity()
                            + std::mem::size_of::<SourceGeneration>()
                    })
                    .sum::<usize>();
                eprintln!("watch rows_scanned=66960 result_rows={} result_value_payload_bytes={values} serialized_baseline_bytes={serialized} generations={} generation_payload_bytes={generation_bytes} watch_payload_bytes={}", output.as_array().unwrap().len(), lazy.stream.watch.baseline.len(), lazy.stream.watch.resident_bytes());
                assert!(lazy.resident.is_empty());
                assert_eq!(lazy.stream.watch.baseline.len(), 1);
                (sources.lazy_fingerprints(), host)
            };
            let started = Instant::now();
            let intervals = 1000;
            for _ in 0..intervals {
                assert!(!crate::lazy::disk_differs(host.as_ref(), &fingerprints).unwrap());
            }
            eprintln!(
                "poll listed_months=10 covered_months=1 intervals={intervals} mean_us={:.3}",
                started.elapsed().as_secs_f64() * 1_000_000.0 / f64::from(intervals)
            );
            drop(output);
            drop(watch);
            let mut state = runtime.lock_open().unwrap();
            let lazy = state
                .sources
                .as_mut()
                .unwrap()
                .lazy
                .get_mut("samples")
                .unwrap();
            prune(lazy);
            assert!(lazy.stream.watch.baseline.is_empty());
            assert!(lazy.stream.watch.entries.is_empty());
        }
    }
}

/// A failed mutation can still discover valid external rows. Keep the
/// original mutation error, but let watches accept that external generation.
pub(crate) fn capture_external(state: &mut RuntimeState) {
    let Some(sources) = state.sources.as_mut() else {
        return;
    };
    for lazy in sources.lazy.values_mut() {
        if lazy.execution_model != ExecutionModel::Streaming {
            continue;
        }
        lazy.stream.watch.prune();
        let paths = covered_paths(lazy);
        if let Ok(current) = observe(state.host.as_ref(), &paths) {
            if current != lazy.stream.watch.baseline {
                lazy.stream.index = Default::default();
                lazy.stream.watch.baseline = current;
                lazy.stream.watch.changed();
                lazy.stream.watch.reload_pending = true;
            }
        }
    }
}
