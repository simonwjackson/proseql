//! Durable, long-running native proseQL runtime.
//!
//! The runtime owns one database backed by either a single file or configured
//! document and graph sources. It serializes mutations and publishes them only
//! after durable persistence. Source-mode batches replace files individually;
//! a write-stage failure quarantines the runtime because a prefix can be durable.

// Let unit tests reuse tests/support/parity.rs without copying its fixtures.
#[cfg(test)]
extern crate self as proseql_native;

mod bounded;
pub use bounded::BoundedQueryStats;
mod callbacks;
mod execution;
#[allow(deprecated)]
pub use execution::ExecutionModel;
mod lazy;
#[cfg(test)]
mod lifecycle_tests;
mod locate;
mod read_snapshot;
mod schema_checks;
mod source_sessions;
mod sources;
mod stored_file;
mod streaming;
mod write;
pub use lazy::{FullScanPolicy, LazyPartitionPolicy, LazyPartitionStatus, NativeQueryStats};
pub use source_sessions::{IdleMemoryReclaim, NativeSourceSession, NativeSourceSessions};
use sources::SourceState;
pub use sources::{
    NativeSourceRuntimeConfig, NativeSourceRuntimeOptions, RecordFilesReload,
    RecordFilesReloadCallback,
};

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::Duration;

use indexmap::IndexMap;
pub use proseql_engine::callbacks::CallbackRegistry;
use proseql_engine::collection::Collection;
use proseql_engine::descriptor::CollectionDescriptor;
use proseql_engine::errors::{EngineError, OperationError};
use proseql_engine::id_gen::NanoIdGenerator;
use proseql_engine::plugins::PluginCodecMetadata;
use proseql_engine::query::aggregate::{
    compute_aggregates, compute_grouped_aggregates, AggregateConfig, AggregateResult, GroupResult,
};
use proseql_engine::query::pipeline::QueryInput;
use proseql_engine::reactive::{CallbackSubscription, ValueSubscription, WatchQueryConfig};
use proseql_engine::relationships::Database;
use proseql_formats::FormatRegistry;
use proseql_storage::fs::FsStorageHost;
use proseql_storage::host::{StorageHost, WatchHandle};
use proseql_storage::memory::MemoryStorageHost;
use proseql_storage::persistence::{
    load_collections_from_file, save_collections_to_file, CallbackRegistryMigrationHost,
    DurableStorageHost, LoadCollectionConfig, MigrationStep, SaveCollectionConfig,
};
use serde_json::Value;

const OPEN: u8 = 0;
const CLOSING: u8 = 1;
const CLOSED: u8 = 2;

#[derive(Debug, Clone)]
pub struct NativeCollectionConfig {
    pub descriptor: CollectionDescriptor,
}

impl NativeCollectionConfig {
    pub fn new(descriptor: CollectionDescriptor) -> Self {
        Self { descriptor }
    }
}

#[derive(Debug, Clone)]
pub struct NativeRuntimeConfig {
    pub path: String,
    pub collections: Vec<NativeCollectionConfig>,
}

/// Host callbacks and codecs for single-file mode. Existing `open*` methods
/// use empty callbacks and built-in codecs. Source mode has equivalent options.
pub struct NativeRuntimeOptions {
    /// Registered Rust closures. Consumed and shared with engine collections.
    pub callbacks: CallbackRegistry,
    pub formats: FormatRegistry,
    /// Callback codecs appended after `formats`; the last extension wins.
    pub plugin_codecs: Vec<PluginCodecMetadata>,
}

impl Default for NativeRuntimeOptions {
    fn default() -> Self {
        Self {
            callbacks: CallbackRegistry::new(),
            formats: FormatRegistry::with_builtins(),
            plugin_codecs: Vec::new(),
        }
    }
}

#[derive(Clone)]
struct RuntimeServices {
    callbacks: Arc<CallbackRegistry>,
    dispatch: Arc<callbacks::Dispatch>,
    formats: Arc<FormatRegistry>,
}

impl RuntimeServices {
    fn new(
        config: &NativeRuntimeConfig,
        mut options: NativeRuntimeOptions,
    ) -> Result<Self, EngineError> {
        validate_config(config, &options.callbacks)?;
        for codec in &options.plugin_codecs {
            for (id, present) in [
                (
                    &codec.encode_callback_id,
                    options
                        .callbacks
                        .has_codec_encode(&codec.encode_callback_id),
                ),
                (
                    &codec.decode_callback_id,
                    options
                        .callbacks
                        .has_codec_decode(&codec.decode_callback_id),
                ),
            ] {
                if !present {
                    return Err(operation_error(
                        "missing-callback",
                        format!("Codec '{}' callback '{}' is not registered", codec.name, id),
                    ));
                }
            }
        }
        let dispatch = callbacks::Dispatch::install(config, &mut options.callbacks);
        let callbacks = Arc::new(options.callbacks);
        for codec in options.plugin_codecs {
            options
                .formats
                .register(Box::new(proseql_formats::plugin_codec(
                    Arc::clone(&callbacks),
                    &codec,
                )));
        }
        Ok(Self {
            callbacks,
            dispatch,
            formats: Arc::new(options.formats),
        })
    }
}

/// Restricted mutation view used by [`NativeRuntime::mutate`]. Keeping the raw
/// database private ensures every exposed write participates in the engine's
/// reversible transaction journal.
pub struct NativeMutation<'a> {
    inner: RefCell<MutationInner<'a>>,
    read_only: Option<&'a IndexMap<String, String>>,
}

struct MutationInner<'a> {
    database: &'a mut Database,
    /// Present when the runtime has lazy partitioned collections.
    lazy: Option<LazyAccess<'a>>,
}

struct LazyAccess<'a> {
    sources: &'a mut SourceState,
    host: &'a dyn DurableStorageHost,
    formats: &'a FormatRegistry,
}

impl MutationInner<'_> {
    fn find_by_id(&mut self, collection: &str, id: &str) -> Result<Option<Value>, EngineError> {
        let in_engine = self
            .database
            .collection(collection)
            .is_some_and(|records| records.get(id).is_some());
        if !in_engine {
            if let Some(found) = crate::locate::mutation_find_by_id(self, collection, id) {
                return found;
            }
        }
        let found = self
            .database
            .collection(collection)
            .ok_or_else(|| {
                operation_error(
                    "unknown-collection",
                    format!("Unknown collection '{collection}'"),
                )
            })?
            .get(id)
            .cloned();
        Ok(found)
    }
}

impl NativeMutation<'_> {
    fn require_writable(&self, collection: &str) -> Result<(), EngineError> {
        if let Some(source) = self.read_only.and_then(|owners| owners.get(collection)) {
            return Err(operation_error(
                "read-only-source",
                format!("Collection '{collection}' is read-only, owned by source '{source}'"),
            ));
        }
        Ok(())
    }

    /// Find a record by ID. Lazy lookups require FullScanPolicy::Allow, except
    /// for records staged earlier in the same mutation.
    pub fn find_by_id(&self, collection: &str, id: &str) -> Result<Option<Value>, EngineError> {
        self.inner.borrow_mut().find_by_id(collection, id)
    }

    /// Create a record. Lazy collections check duplicate IDs globally from text.
    pub fn create(&mut self, collection: &str, data: Value) -> Result<Value, EngineError> {
        self.require_writable(collection)?;
        let inner = self.inner.get_mut();
        if crate::write::append::applies(inner, collection) {
            return crate::write::append::create(inner, collection, data);
        }
        inner.database.create(collection, data)
    }

    /// Create several records atomically. With `duplicate_ids: ignore_identical`,
    /// identical re-creates return their stored records and write nothing.
    pub fn create_many(
        &mut self,
        collection: &str,
        data: Vec<Value>,
    ) -> Result<proseql_engine::collection::CreateManyResult, EngineError> {
        self.require_writable(collection)?;
        let inner = self.inner.get_mut();
        if crate::write::append::applies(inner, collection) {
            return crate::write::append::create_many(inner, collection, data);
        }
        inner.database.create_many(collection, data, false)
    }

    pub fn update(
        &mut self,
        collection: &str,
        id: &str,
        updates: Value,
    ) -> Result<Value, EngineError> {
        self.require_writable(collection)?;
        self.inner
            .get_mut()
            .database
            .update(collection, id, updates)
    }

    pub fn update_if_revision(
        &mut self,
        collection: &str,
        id: &str,
        expected_revision: u64,
        updates: Value,
    ) -> Result<Value, EngineError> {
        self.require_writable(collection)?;
        self.inner
            .get_mut()
            .database
            .update_if_revision(collection, id, expected_revision, updates)
    }

    pub fn delete(&mut self, collection: &str, id: &str) -> Result<Value, EngineError> {
        self.require_writable(collection)?;
        self.inner.get_mut().database.delete(collection, id)
    }
}

/// A live watch on a native runtime. Lazy watches retain delivered results,
/// not source partitions.
pub struct NativeWatch<S> {
    subscription: S,
}

impl<S> std::ops::Deref for NativeWatch<S> {
    type Target = S;

    fn deref(&self) -> &S {
        &self.subscription
    }
}

/// Stops the lazy-source poller of a managed watch.
struct LazyPollHandle {
    stop: Arc<AtomicBool>,
}

impl WatchHandle for LazyPollHandle {
    fn stop(&self) -> Result<(), EngineError> {
        self.stop.store(true, Ordering::Release);
        Ok(())
    }
}

#[derive(Clone)]
pub struct NativeRuntime {
    inner: Arc<RuntimeCore>,
}

struct RuntimeCore {
    state: Mutex<RuntimeState>,
    lifecycle: AtomicU8,
    close_complete: Condvar,
    watch_generation: AtomicU64,
    /// Events reported by the managed watcher since the last reload.
    watch_events: Mutex<Vec<proseql_storage::host::StorageEvent>>,
}

struct RuntimeState {
    config: NativeRuntimeConfig,
    sources: Option<SourceState>,
    database: Database,
    callbacks: Arc<CallbackRegistry>,
    dispatch: Arc<callbacks::Dispatch>,
    formats: Arc<FormatRegistry>,
    host: Arc<dyn DurableStorageHost>,
    watch: Vec<Box<dyn WatchHandle>>,
    last_persisted_content: Option<String>,
    last_reload_error: Option<EngineError>,
    quarantine_error: Option<EngineError>,
    rollback_failure_once: bool,
    resources_released: bool,
}

/// Finish the lifecycle even when a host or codec panics during close. A
/// waiting closer must never depend on the first caller reaching its return.
struct ClosingState<'a> {
    core: &'a RuntimeCore,
    state: MutexGuard<'a, RuntimeState>,
}

impl Drop for ClosingState<'_> {
    fn drop(&mut self) {
        self.state.watch = Vec::new();
        self.state.sources = None;
        self.state.last_persisted_content = None;
        self.state.last_reload_error = None;
        self.state.quarantine_error = None;
        let callbacks = Arc::clone(&self.state.callbacks);
        self.state.database = Database::new(IndexMap::new(), callbacks);
        self.state.resources_released = true;
        if let Ok(mut events) = self.core.watch_events.lock() {
            *events = Vec::new();
        }
        self.core.lifecycle.store(CLOSED, Ordering::Release);
        self.core.close_complete.notify_all();
    }
}

fn operation_error(reason: &str, message: impl Into<String>) -> EngineError {
    EngineError::Operation(OperationError {
        operation: "native-runtime".to_owned(),
        reason: reason.to_owned(),
        message: message.into(),
    })
}

impl NativeRuntime {
    /// Open a filesystem-backed runtime for a single process owner.
    pub fn open(config: NativeRuntimeConfig) -> Result<Self, EngineError> {
        let host = Arc::new(FsStorageHost::new_polling(Duration::from_secs(2))?);
        Self::open_with_host(config, host)
    }

    pub fn open_with_host<H>(config: NativeRuntimeConfig, host: Arc<H>) -> Result<Self, EngineError>
    where
        H: DurableStorageHost + 'static,
    {
        let host: Arc<dyn DurableStorageHost> = host;
        Self::open_with_dyn_host(config, host)
    }

    pub fn open_with_dyn_host(
        config: NativeRuntimeConfig,
        host: Arc<dyn DurableStorageHost>,
    ) -> Result<Self, EngineError> {
        Self::open_with_dyn_host_and_options(config, host, NativeRuntimeOptions::default())
    }

    pub fn open_with_options(
        config: NativeRuntimeConfig,
        options: NativeRuntimeOptions,
    ) -> Result<Self, EngineError> {
        let host = Arc::new(FsStorageHost::new_polling(Duration::from_secs(2))?);
        Self::open_with_dyn_host_and_options(config, host, options)
    }

    pub fn open_with_host_and_options<H>(
        config: NativeRuntimeConfig,
        host: Arc<H>,
        options: NativeRuntimeOptions,
    ) -> Result<Self, EngineError>
    where
        H: DurableStorageHost + 'static,
    {
        Self::open_with_dyn_host_and_options(config, host, options)
    }

    pub fn open_with_dyn_host_and_options(
        config: NativeRuntimeConfig,
        host: Arc<dyn DurableStorageHost>,
        options: NativeRuntimeOptions,
    ) -> Result<Self, EngineError> {
        let services = RuntimeServices::new(&config, options)?;
        let loaded = load_single_file(
            host.as_ref(),
            &services.formats,
            &config,
            &services.callbacks,
        )?;
        let runtime = Self::from_loaded(
            config,
            host,
            services,
            loaded.collections,
            loaded.content,
            None,
        )?;
        // The storage loader's migration writeback stays in memory until the
        // aggregate database is valid. Preserve undeclared sections
        // at the value level rather than serializing only declared collections.
        if let Some(content) = loaded.migrated_content {
            let mut state = runtime.lock_open()?;
            state.host.replace_durable(&state.config.path, &content)?;
            state.last_persisted_content = Some(content);
        }
        Ok(runtime)
    }

    /// Open writable documents and read-only graphs with default native services.
    pub fn open_sources(config: NativeSourceRuntimeConfig) -> Result<Self, EngineError> {
        Self::open_sources_with_options(config, NativeSourceRuntimeOptions::default())
    }

    pub fn open_sources_with_options(
        config: NativeSourceRuntimeConfig,
        options: NativeSourceRuntimeOptions,
    ) -> Result<Self, EngineError> {
        let host = Arc::new(FsStorageHost::new_polling(Duration::from_secs(2))?);
        Self::open_sources_with_host(config, host, options)
    }

    pub fn open_sources_with_host(
        config: NativeSourceRuntimeConfig,
        host: Arc<dyn DurableStorageHost>,
        options: NativeSourceRuntimeOptions,
    ) -> Result<Self, EngineError> {
        source_sessions::PreparedSourceRuntime::new(config, host, options)?.open()
    }

    fn from_loaded(
        config: NativeRuntimeConfig,
        host: Arc<dyn DurableStorageHost>,
        services: RuntimeServices,
        loaded: IndexMap<String, IndexMap<String, Value>>,
        source_content: Option<String>,
        sources: Option<SourceState>,
    ) -> Result<Self, EngineError> {
        let RuntimeServices {
            callbacks: registry,
            dispatch,
            formats,
        } = services;
        let mut collections = IndexMap::new();
        for collection in &config.collections {
            let name = collection.descriptor.name.clone();
            collections.insert(
                name.clone(),
                Collection::new(
                    name,
                    collection.descriptor.clone(),
                    Arc::clone(&registry),
                    collection
                        .descriptor
                        .id_generator
                        .as_ref()
                        .and_then(|name| registry.instantiate_id_generator(name))
                        .unwrap_or_else(|| Box::new(NanoIdGenerator)),
                ),
            );
        }
        let mut database = Database::new(collections, Arc::clone(&registry));
        database.commit_snapshot_transaction(states_to_records(loaded))?;
        database.take_committed_changes();
        let mut sources = sources;
        if let Some(sources) = sources.as_mut() {
            // Give streaming index state the codec context it needs for lazy
            // sources (custom codecs). Reloads keep it (`lazy_adopt`).
            crate::locate::configure_streaming_index(sources, &formats);
        }
        Ok(Self {
            inner: Arc::new(RuntimeCore {
                state: Mutex::new(RuntimeState {
                    config,
                    sources,
                    database,
                    callbacks: registry,
                    dispatch,
                    formats,
                    host,
                    watch: Vec::new(),
                    last_persisted_content: source_content,
                    last_reload_error: None,
                    quarantine_error: None,
                    rollback_failure_once: false,
                    resources_released: false,
                }),
                lifecycle: AtomicU8::new(OPEN),
                close_complete: Condvar::new(),
                watch_generation: AtomicU64::new(0),
                watch_events: Mutex::new(Vec::new()),
            }),
        })
    }

    fn lock_open(&self) -> Result<MutexGuard<'_, RuntimeState>, EngineError> {
        if self.inner.lifecycle.load(Ordering::Acquire) != OPEN {
            return Err(operation_error(
                "closed",
                "Native runtime is closing or closed",
            ));
        }
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| operation_error("poisoned", "Native runtime lock is poisoned"))?;
        if self.inner.lifecycle.load(Ordering::Acquire) != OPEN {
            return Err(operation_error(
                "closed",
                "Native runtime is closing or closed",
            ));
        }
        if let Some(error) = &state.quarantine_error {
            return Err(operation_error(
                "quarantined",
                format!("Native runtime invariants could not be restored: {error}"),
            ));
        }
        Ok(state)
    }

    /// Read the eager engine. Durable lazy rows are never present here; use
    /// query, query_bounded, aggregates or find_by_id for lazy collections.
    pub fn read<R>(
        &self,
        f: impl FnOnce(&Database) -> Result<R, EngineError>,
    ) -> Result<R, EngineError> {
        let state = self.lock_open()?;
        f(&state.database)
    }

    /// Find a record by ID. Lazy lookups require FullScanPolicy::Allow, except
    /// for records staged earlier in the same mutation.
    pub fn find_by_id(&self, collection: &str, id: &str) -> Result<Option<Value>, EngineError> {
        if let Some(found) = self.streaming_find_by_id(collection, id) {
            return found;
        }
        self.read(|database| {
            let collection = database.collection(collection).ok_or_else(|| {
                operation_error(
                    "unknown-collection",
                    format!("Unknown collection '{collection}'"),
                )
            })?;
            Ok(collection.get(id).cloned())
        })
    }

    /// Run a query. Lazy collections scan the selected partitions without
    /// retaining rows. For other collections this
    /// equals `read(|db| db.query(..))`.
    pub fn query(
        &self,
        collection: &str,
        input: QueryInput,
        populate: Option<Value>,
    ) -> Result<Vec<Value>, EngineError> {
        if let Some(read) = self.streaming_read(
            collection,
            streaming::ReadRequest::Query {
                input: &input,
                populate: populate.as_ref(),
            },
        ) {
            return read.map(|(output, _)| match output {
                streaming::ReadOutput::Rows(rows) => rows,
                _ => unreachable!("streaming query returns rows"),
            });
        }
        self.with_scope(collection, |database| {
            database.query(collection, input, populate)
        })
        .map(|(rows, _)| rows)
    }

    /// Query with physical read and candidate statistics. Lazy queries prune
    /// partitions, enforce FullScanPolicy, and scan without retaining rows.
    pub fn query_with_stats(
        &self,
        collection: &str,
        input: QueryInput,
        populate: Option<Value>,
    ) -> Result<(Vec<Value>, NativeQueryStats), EngineError> {
        if let Some(read) = self.streaming_read(
            collection,
            streaming::ReadRequest::QueryWithStats {
                input: &input,
                populate: populate.as_ref(),
            },
        ) {
            return read.map(|(output, _)| match output {
                streaming::ReadOutput::RowsWithStats(rows, stats) => (rows, stats),
                _ => unreachable!("streaming query_with_stats returns rows and stats"),
            });
        }
        self.with_scope(collection, |database| {
            let stats = database.explain_query(collection, &input)?;
            let rows = database.query(collection, input, populate)?;
            Ok((rows, stats))
        })
        .map(|((rows, stats), scope)| {
            (
                rows,
                NativeQueryStats {
                    partitions_loaded: scope.loaded,
                    partitions_read: scope.read,
                    partitions_resident: scope.resident,
                    index_used: stats.index_used,
                    candidate_rows: stats.candidate_rows,
                    index_sorted: stats.index_sorted,
                },
            )
        })
    }

    /// Cursor-paginated query, scanning lazy partitions like `query_with_stats`.
    pub fn query_cursor(
        &self,
        collection: &str,
        input: QueryInput,
        cursor: &proseql_engine::query::CursorConfig,
        populate: Option<Value>,
    ) -> Result<proseql_engine::query::CursorPageResult, EngineError> {
        if let Some(read) = self.streaming_read(
            collection,
            streaming::ReadRequest::Cursor {
                input: &input,
                cursor,
                populate: populate.as_ref(),
            },
        ) {
            return read.map(|(output, _)| match output {
                streaming::ReadOutput::Page(page) => page,
                _ => unreachable!("streaming cursor query returns a page"),
            });
        }
        self.with_scope(collection, |database| {
            database.query_cursor(collection, &input, cursor, populate)
        })
        .map(|(page, _)| page)
    }

    /// Scalar aggregates over the records matching `where_clause`, scanning
    /// lazy partitions like `query_with_stats`.
    pub fn aggregate(
        &self,
        collection: &str,
        where_clause: Option<Value>,
        config: &AggregateConfig,
    ) -> Result<AggregateResult, EngineError> {
        if let Some(read) = self.streaming_read(
            collection,
            streaming::ReadRequest::Aggregate {
                filter: where_clause.as_ref(),
                config,
            },
        ) {
            return read.map(|(output, _)| match output {
                streaming::ReadOutput::Aggregate(result) => result,
                _ => unreachable!("streaming aggregate returns an aggregate"),
            });
        }
        let rows = self.query(
            collection,
            QueryInput {
                r#where: where_clause,
                ..QueryInput::default()
            },
            None,
        )?;
        Ok(compute_aggregates(&rows, config))
    }

    /// Grouped aggregates over the records matching `where_clause`, scanning
    /// lazy partitions like `query_with_stats`.
    pub fn aggregate_grouped(
        &self,
        collection: &str,
        where_clause: Option<Value>,
        group_by: &[String],
        config: &AggregateConfig,
    ) -> Result<Vec<GroupResult>, EngineError> {
        if let Some(read) = self.streaming_read(
            collection,
            streaming::ReadRequest::Grouped {
                filter: where_clause.as_ref(),
                group_by,
                config,
            },
        ) {
            return read.map(|(output, _)| match output {
                streaming::ReadOutput::Grouped(groups) => groups,
                _ => unreachable!("streaming grouped aggregate returns groups"),
            });
        }
        let rows = self.query(
            collection,
            QueryInput {
                r#where: where_clause,
                ..QueryInput::default()
            },
            None,
        )?;
        Ok(compute_grouped_aggregates(&rows, group_by, config))
    }

    /// Watch a query. Lazy watches retain delivered results and checked file
    /// generations, not partitions. FullScanPolicy applies to their filters.
    pub fn watch(
        &self,
        collection: &str,
        config: WatchQueryConfig,
    ) -> Result<NativeWatch<ValueSubscription>, EngineError> {
        if self.streaming_watch_applies(collection) {
            return self.streaming_watch(collection, config);
        }
        self.watch_scoped(move |database| database.watch(collection, config))
    }

    /// Like [`Self::watch`], delivering results to `callback`.
    pub fn watch_with_callback(
        &self,
        collection: &str,
        config: WatchQueryConfig,
        callback: Box<dyn Fn(Value) + Send + Sync>,
    ) -> Result<NativeWatch<CallbackSubscription>, EngineError> {
        if self.streaming_watch_applies(collection) {
            return self.streaming_watch_with_callback(collection, config, callback);
        }
        self.watch_scoped(move |database| {
            database.watch_with_callback(collection, config, callback)
        })
    }

    /// The lazy state of `source_id`, or `None` when that source is not lazy.
    pub fn lazy_partition_status(
        &self,
        source_id: &str,
    ) -> Result<Option<LazyPartitionStatus>, EngineError> {
        let state = self.lock_open()?;
        Ok(state
            .sources
            .as_ref()
            .and_then(|sources| sources.lazy_status(source_id)))
    }

    /// Execute an eager operation. Lazy operations use the scanner before this.
    fn with_scope<R>(
        &self,
        collection: &str,
        f: impl FnOnce(&Database) -> Result<R, EngineError>,
    ) -> Result<(R, ScopeStats), EngineError> {
        let state = self.lock_open()?;
        let loaded = state
            .sources
            .as_ref()
            .map_or(0, |sources| sources.eager_partition_count(collection));
        Ok((
            f(&state.database)?,
            ScopeStats {
                loaded,
                read: 0,
                resident: loaded,
            },
        ))
    }

    fn watch_scoped<S>(
        &self,
        subscribe: impl FnOnce(&Database) -> Result<S, EngineError>,
    ) -> Result<NativeWatch<S>, EngineError> {
        let state = self.lock_open()?;
        Ok(NativeWatch {
            subscription: subscribe(&state.database)?,
        })
    }

    /// Execute an engine mutation as one durable source commit.
    ///
    /// One runtime serializes all callers. Multiple runtime instances targeting
    /// the same path are intentionally unsupported; applications must provide a
    /// single process owner when they need exact conditional-update semantics.
    pub fn mutate<R>(
        &self,
        f: impl FnOnce(&mut NativeMutation<'_>) -> Result<R, EngineError>,
    ) -> Result<R, EngineError> {
        let mut state = self.lock_open()?;
        let callbacks = state.dispatch.batch();
        let read_only = state
            .sources
            .as_ref()
            .map(|sources| sources.graph.owned_collections.clone());
        let lazy = state
            .sources
            .as_ref()
            .is_some_and(|sources| !sources.lazy.is_empty());
        let mut session = state.database.begin_owned_transaction()?;
        let stepped = {
            let RuntimeState {
                database,
                sources,
                formats,
                host,
                ..
            } = &mut *state;
            let lazy = sources.as_mut().filter(|_| lazy).map(|sources| LazyAccess {
                sources,
                host: host.as_ref(),
                formats,
            });
            database.transaction_step(&mut session, |database| {
                f(&mut NativeMutation {
                    inner: RefCell::new(MutationInner { database, lazy }),
                    read_only: read_only.as_ref(),
                })
            })
        };
        let result = match stepped {
            Ok(result) => result,
            Err(error) => {
                rollback_preserving_original(&self.inner, &mut state, session, &error);
                crate::write::append::after_rollback(&mut state);
                self.after_failed_mutation(state);
                return Err(error);
            }
        };
        if state.sources.is_some() {
            if let Err(error) = crate::write::tx::check_before_commit(&state) {
                rollback_preserving_original(&self.inner, &mut state, session, &error);
                crate::write::append::after_rollback(&mut state);
                self.after_failed_mutation(state);
                return Err(error);
            }
            let committed = commit_source_mutation(&self.inner, &mut state, session, result);
            match &committed {
                Ok(_) => {
                    crate::write::watch::capture_commit(&mut state);
                    crate::write::append::after_commit(&mut state);
                }
                Err(_) => crate::write::append::after_rollback(&mut state),
            }
            let result = match committed {
                Ok(result) => result,
                Err(error) => {
                    self.after_failed_mutation(state);
                    return Err(error);
                }
            };
            let replay = callbacks.finish();
            drop(state);
            // The mutation is durable; watch errors surface through the watch API.
            let _ = self.refresh_streaming_watches();
            replay();
            return Ok(result);
        }
        let candidate = state.database.snapshot_all_collection_states();
        let content = match serialize_candidate(&state.config, &state.formats, &candidate) {
            Ok(content) => content,
            Err(error) => {
                rollback_preserving_original(&self.inner, &mut state, session, &error);
                return Err(error);
            }
        };
        if let Err(error) = state.host.replace_durable(&state.config.path, &content) {
            rollback_preserving_original(&self.inner, &mut state, session, &error);
            return Err(error);
        }
        if let Err(error) = state.database.commit_owned_transaction(session) {
            state.quarantine_error = Some(error.clone());
            self.inner.lifecycle.store(CLOSED, Ordering::Release);
            return Err(error);
        }
        state.database.take_committed_changes();
        state.last_persisted_content = Some(content);
        let replay = callbacks.finish();
        drop(state);
        replay();
        Ok(result)
    }

    /// After a source-mode mutation failed and rolled back (and the runtime is
    /// not quarantined): let streaming watches pick up external rows the
    /// failed mutation discovered, as a resident load would have published
    /// them. The caller returns its original error unchanged.
    fn after_failed_mutation(&self, mut state: MutexGuard<'_, RuntimeState>) {
        if state.sources.is_none() || state.quarantine_error.is_some() {
            return;
        }
        crate::write::watch::capture_external(&mut state);
        drop(state);
        let _ = self.refresh_streaming_watches();
    }

    /// Validate and durably replace every collection in single-file mode.
    /// Source mode rejects bulk replacement; use guarded `mutate` instead.
    pub fn replace_all(
        &self,
        candidate: IndexMap<String, IndexMap<String, Value>>,
    ) -> Result<(), EngineError> {
        let mut state = self.lock_open()?;
        if state.sources.is_some() {
            return Err(operation_error(
                "unsupported-operation",
                "Use mutate for source-mode writes",
            ));
        }
        let content = serialize_candidate(&state.config, &state.formats, &candidate)?;

        // Round-trip through the strict loader before either disk or visible
        // state is promoted. This also rejects malformed and unknown shapes.
        let memory = MemoryStorageHost::default();
        memory.write(&state.config.path, &content)?;
        let mut loaded = load_collections_from_file(
            &memory,
            &state.formats,
            &state.config.path,
            &load_configs(&state.config),
            None,
        )?;
        decode_loaded_collections(&state.config, &mut loaded, &state.callbacks)?;
        let validated = states_to_records(loaded);
        state
            .database
            .validate_snapshot_transaction(validated.clone())?;
        state.host.replace_durable(&state.config.path, &content)?;
        if let Err(error) = state.database.commit_snapshot_transaction(validated) {
            state.quarantine_error = Some(error.clone());
            self.inner.lifecycle.store(CLOSED, Ordering::Release);
            return Err(error);
        }
        state.database.take_committed_changes();
        state.last_persisted_content = Some(content);
        Ok(())
    }

    /// Strictly reload the complete source. A malformed candidate is reported
    /// and retained as a diagnostic while the current LKG remains visible.
    pub fn reload(&self) -> Result<(), EngineError> {
        let mut state = self.lock_open()?;
        let callback = state
            .sources
            .as_ref()
            .and_then(|s| s.on_record_files_reload.clone());
        let result = reload_locked(&mut state, false, None);
        drop(state);
        // An invalid edit to a partition a streaming watch covers fails the
        // reload, as it does for a resident (pinned) partition today.
        if let (Ok(diffs), Some(callback)) = (&result, callback) {
            for diff in diffs {
                callback(diff.clone());
            }
        }
        let watches = self.refresh_streaming_watches();
        result.map(|_| ()).and(watches)
    }

    pub fn last_reload_error(&self) -> Result<Option<EngineError>, EngineError> {
        let state = self.lock_open()?;
        Ok(state.last_reload_error.clone())
    }

    /// Graph fragment diagnostics from the last accepted source snapshot.
    /// Custom transforms report line warnings through their own injected sink.
    pub fn document_graph_diagnostics(
        &self,
    ) -> Result<Vec<proseql_storage::document_graph::DocumentGraphDiagnostic>, EngineError> {
        let state = self.lock_open()?;
        Ok(state
            .sources
            .as_ref()
            .map(|sources| sources.graph.diagnostics.clone())
            .unwrap_or_default())
    }

    /// Interrupted appends that the last load ignored: unterminated,
    /// unparseable final lines of append-only JSONL files. The next append to
    /// such a file removes the line first.
    pub fn torn_line_diagnostics(
        &self,
    ) -> Result<Vec<proseql_storage::append::TornLineDiagnostic>, EngineError> {
        let state = self.lock_open()?;
        Ok(state
            .sources
            .as_ref()
            .map(|sources| sources.torn.clone())
            .unwrap_or_default())
    }

    /// Start managed, debounced watches. Source mode watches source directories
    /// and existing ancestors of missing optional roots. Unchanged reloads do
    /// not publish collection changes.
    pub fn start_managed_watch(&self, debounce: Duration) -> Result<(), EngineError> {
        let mut state = self.lock_open()?;
        if !state.watch.is_empty() {
            return Err(operation_error(
                "watch-active",
                "A managed watch is already active",
            ));
        }
        let mut handles: Vec<Box<dyn WatchHandle>> = Vec::new();
        if let Some(sources) = &state.sources {
            if !sources.lazy.is_empty() {
                let stop = Arc::new(AtomicBool::new(false));
                start_lazy_poller(
                    Arc::downgrade(&self.inner),
                    sources.lazy_watch_interval,
                    Arc::clone(&stop),
                )?;
                handles.push(Box::new(LazyPollHandle { stop }));
            }
            for root in sources.watch_roots(state.host.as_ref())? {
                let weak = Arc::downgrade(&self.inner);
                let handle = state.host.watch_dir(
                    &root,
                    Box::new(move |event| {
                        if let Some(core) = weak.upgrade() {
                            if let Ok(mut events) = core.watch_events.lock() {
                                events.push(event);
                            }
                        }
                        schedule_reload(&weak, debounce)
                    }),
                )?;
                handles.push(handle);
            }
        } else {
            let weak = Arc::downgrade(&self.inner);
            handles.push(state.host.watch(
                &state.config.path,
                Box::new(move |_| schedule_reload(&weak, debounce)),
            )?);
        }
        state.watch = handles;
        Ok(())
    }

    /// Fault seam for conformance tests which prove that rollback failure
    /// quarantines the facade without replacing the original operation error.
    #[doc(hidden)]
    pub fn inject_rollback_failure_once(&self) -> Result<(), EngineError> {
        let mut state = self.lock_open()?;
        state.rollback_failure_once = true;
        Ok(())
    }

    pub fn flush(&self) -> Result<(), EngineError> {
        let mut state = self.lock_open()?;
        persist_current(&mut state)
    }

    /// Marks the runtime closing before waiting for active work. Final flush
    /// failure is returned, but the runtime remains closed and its watcher is
    /// always released.
    pub fn close(&self) -> Result<(), EngineError> {
        let was_open = match self.inner.lifecycle.compare_exchange(
            OPEN,
            CLOSING,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => true,
            Err(CLOSING) => {
                // Another clone owns the close. Its state lock can still be
                // waiting behind active work, so acquiring that lock alone is
                // not a completion barrier. A session must wait for cleanup
                // before releasing its source lease to the next caller.
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                while !state.resources_released {
                    state = self
                        .inner
                        .close_complete
                        .wait(state)
                        .unwrap_or_else(|error| error.into_inner());
                }
                return Ok(());
            }
            Err(_) => false,
        };
        // A panic can poison an active session. Recover the guard only to stop
        // services and discard state, never to persist a partially applied write.
        let (state, poisoned) = match self.inner.state.lock() {
            Ok(state) => (state, false),
            Err(error) => (error.into_inner(), true),
        };
        if state.resources_released {
            return Ok(());
        }
        let mut closing = ClosingState {
            core: &self.inner,
            state,
        };
        let state = &mut *closing.state;
        self.inner.watch_generation.fetch_add(1, Ordering::AcqRel);
        let flush_result = if poisoned {
            Err(operation_error(
                "poisoned",
                "Native runtime lock is poisoned. Uncommitted state was not persisted",
            ))
        } else if was_open {
            persist_current(state)
        } else {
            Ok(())
        };
        if !poisoned && flush_result.is_ok() {
            if let Some(sources) = &state.sources {
                for lazy in sources.lazy.values() {
                    lazy.stream.index.save(state.host.as_ref());
                }
            }
        }
        let mut stop_result = Ok(());
        for handle in state.watch.drain(..) {
            if let Err(error) = handle.stop() {
                if stop_result.is_ok() {
                    stop_result = Err(error);
                }
            }
        }
        // ClosingState releases state and wakes other closers on success,
        // returned errors, and unwinding. It still owns the state lock here.
        flush_result.and(stop_result)
    }
}

/// What one scoped operation loaded.
struct ScopeStats {
    loaded: usize,
    read: usize,
    resident: usize,
}

/// Persist a source-mode transaction, then publish it.
///
/// Append-only collections on JSONL sources persist their new records from
/// the transaction journal: only the new records are routed, encoded and
/// conflict-checked, and only their lines are written. Other collections use
/// the snapshot-and-rewrite plan, which skips append-only collections.
fn commit_source_mutation<R>(
    core: &RuntimeCore,
    state: &mut RuntimeState,
    session: proseql_engine::transactions::OwnedTransactionSession,
    result: R,
) -> Result<R, EngineError> {
    let sources = state.sources.as_ref().expect("source mode");
    let touched = session.touched_collections();
    let needs_rewrite_plan = touched
        .iter()
        .any(|name| !sources.appendable.contains(name));
    let plan = (|| {
        for name in touched {
            if sources.graph.owned_collections.contains_key(name) {
                return Err(operation_error(
                    "read-only-source",
                    format!("Transaction changed read-only collection '{name}'"),
                ));
            }
        }
        let appends = sources.plan_appends(&state.formats, session.journal())?;
        let rewrite = if needs_rewrite_plan {
            let candidate = state
                .database
                .snapshot_collection_states_except(&sources.appendable);
            let plan = sources.plan(&state.formats, &candidate)?;
            sources.check_conflicts(state.host.as_ref(), &plan.writes)?;
            sources.check_record_operations(state.host.as_ref(), &plan.record_operations)?;
            Some(plan)
        } else {
            None
        };
        sources.check_append_conflicts(state.host.as_ref(), &appends.writes)?;
        Ok((appends, rewrite))
    })();
    let (appends, mut rewrite) = match plan {
        Ok(plan) => plan,
        Err(error) => {
            rollback_preserving_original(core, state, session, &error);
            return Err(error);
        }
    };
    enum Write<'a> {
        Replace(&'a proseql_storage::document_source::PlannedDocumentWrite),
        Append(&'a proseql_storage::append::PlannedAppend),
        Record(&'a proseql_storage::record_files::RecordFileOperation),
    }
    let mut writes = appends.writes.iter().map(Write::Append).collect::<Vec<_>>();
    if let Some(rewrite) = &rewrite {
        writes.extend(rewrite.writes.iter().map(Write::Replace));
        writes.extend(rewrite.record_operations.iter().map(Write::Record));
    }
    let path_of = |write: &Write<'_>| match write {
        Write::Replace(write) => write.path.clone(),
        Write::Append(write) => write.path.clone(),
        Write::Record(write) => write.path().to_owned(),
    };
    writes.sort_by_key(path_of);
    let mut completed = Vec::new();
    for write in &writes {
        let outcome = match write {
            Write::Record(operation) => {
                use proseql_storage::record_files::RecordFileOperation;
                match operation {
                    RecordFileOperation::Replace { path, content } => state.host.replace_durable(path, content),
                    RecordFileOperation::Remove { path } => state.host.remove_durable(path),
                }.map_err(|cause| operation_error("source-write-failed", format!("Durable source operation failed at '{}'; completed paths: {:?}; cause: {cause}. Reopen and inspect before retrying", operation.path(), completed)))
            },
            Write::Replace(write) => state
                .host
                .replace_durable(&write.path, &write.content)
                .map_err(|cause| {
                    operation_error("source-write-failed", format!("Durable source write failed at '{}'; completed paths: {:?}; cause: {cause}. Reopen and inspect before retrying", write.path, completed))
                }),
            Write::Append(write) => crate::write::append::commit(
                state.host.as_ref(), state.sources.as_mut().expect("source mode"), write,
            ).map_err(|cause| append_failure(&write.path, &completed, cause)),
        };
        if let Err(error) = outcome {
            rollback_preserving_original(core, state, session, &error);
            state.quarantine_error = Some(error.clone());
            return Err(error);
        }
        completed.push(path_of(write));
    }
    drop(writes);
    // Capture committed generations before publication. Failure cannot safely
    // resume this runtime after durable operations, so use the same quarantine.
    if let Some(plan) = &mut rewrite {
        let observed = plan.capture_record_generations(
            state.host.as_ref(),
            &state.sources.as_ref().expect("source mode").config,
        );
        if let Err(error) = observed {
            rollback_preserving_original(core, state, session, &error);
            state.quarantine_error = Some(error.clone());
            return Err(error);
        }
    }
    if let Err(error) = state.database.commit_owned_transaction(session) {
        state.quarantine_error = Some(error.clone());
        return Err(error);
    }
    state.database.take_committed_changes();
    let sources = state.sources.as_mut().expect("source mode remains active");
    if let Some(sources::SourcePlan {
        writes,
        documents,
        files,
        partitions,
        record_files,
        record_operations: _,
    }) = rewrite
    {
        sources.documents = documents;
        sources.record_files = record_files;
        // The rewrite plan skips append-only collections; keep their state.
        for (name, records) in files {
            if !sources.appendable.contains(&name) {
                sources.files.insert(name, records);
            }
        }
        for (name, loaded) in partitions {
            if !sources.appendable.contains(&name) {
                sources.partitions.insert(name, loaded);
            }
        }
        for write in writes {
            sources
                .contents
                .insert(write.path, write.content.into_bytes().into());
        }
    }
    sources.apply_appends(appends);
    Ok(result)
}

/// A typed `StorageError` for a failed durable append, naming the completed
/// paths per the crash rule.
fn append_failure(path: &str, completed: &[String], cause: EngineError) -> EngineError {
    let detail = format!(
        "Durable append failed at '{path}'; completed paths: {completed:?}; cause: {cause}. Reopen and inspect before retrying"
    );
    match cause {
        EngineError::Storage(storage) => {
            EngineError::Storage(Box::new(proseql_engine::errors::StorageError {
                message: detail,
                ..*storage
            }))
        }
        other => EngineError::Storage(Box::new(proseql_engine::errors::StorageError {
            path: path.to_owned(),
            operation: proseql_engine::errors::StorageOperation::Write,
            message: detail,
            cause: serde_json::to_value(&other).ok(),
        })),
    }
}

fn rollback_preserving_original(
    core: &RuntimeCore,
    state: &mut RuntimeState,
    session: proseql_engine::transactions::OwnedTransactionSession,
    original: &EngineError,
) {
    let rollback = if state.rollback_failure_once {
        state.rollback_failure_once = false;
        state.database.abandon_owned_transaction_guard();
        Err(operation_error(
            "injected-rollback-failure",
            "Injected rollback failure",
        ))
    } else {
        state.database.rollback_owned_transaction(session)
    };
    if let Err(rollback_error) = rollback {
        state.quarantine_error = Some(operation_error(
            "rollback-failed",
            format!("Original error: {original}; rollback error: {rollback_error}"),
        ));
        core.lifecycle.store(CLOSED, Ordering::Release);
    }
}

fn schedule_reload(weak: &Weak<RuntimeCore>, debounce: Duration) {
    let Some(core) = weak.upgrade() else {
        return;
    };
    let generation = core.watch_generation.fetch_add(1, Ordering::AcqRel) + 1;
    let weak = Arc::downgrade(&core);
    std::thread::spawn(move || {
        std::thread::sleep(debounce);
        let Some(core) = weak.upgrade() else {
            return;
        };
        if core.lifecycle.load(Ordering::Acquire) != OPEN
            || core.watch_generation.load(Ordering::Acquire) != generation
        {
            return;
        }
        let mut delivery = None;
        if let Ok(mut state) = core.state.lock() {
            if core.lifecycle.load(Ordering::Acquire) == OPEN && state.quarantine_error.is_none() {
                let changed = core
                    .watch_events
                    .lock()
                    .map(|mut events| std::mem::take(&mut *events))
                    .ok();
                let callback = state
                    .sources
                    .as_ref()
                    .and_then(|s| s.on_record_files_reload.clone());
                if let (Ok(diffs), Some(callback)) =
                    (reload_locked(&mut state, true, changed), callback)
                {
                    delivery = Some((callback, diffs));
                }
            }
        };
        if let Some((callback, diffs)) = delivery {
            for diff in diffs {
                callback(diff);
            }
        }
        // Errors are recorded in last_reload_error by the hook.
        let _ = NativeRuntime {
            inner: Arc::clone(&core),
        }
        .refresh_streaming_watches();
    });
}

/// Reload the source. With `suppress_self_write`, an unchanged single file or
/// source files that only changed by this runtime's own appends (`changed`
/// holds the watcher's file basenames) do not reload.
fn reload_locked(
    state: &mut RuntimeState,
    suppress_self_write: bool,
    changed: Option<Vec<proseql_storage::host::StorageEvent>>,
) -> Result<Vec<RecordFilesReload>, EngineError> {
    let changed = changed.filter(|_| suppress_self_write);
    let mut diffs = Vec::new();
    let result: Result<(), EngineError> = (|| {
        if let Some(sources) = &state.sources {
            if let Some(names) = &changed {
                if sources.own_appends_explain(state.host.as_ref(), names)? {
                    return Ok(());
                }
            }
            let mut next = SourceState::load(
                state.host.as_ref(),
                &state.formats,
                sources.config.clone(),
                sources.appendable.clone(),
                sources.transforms.clone(),
                &sources.lazy,
                sources.lazy_watch_interval,
                &state.callbacks,
                sources.on_record_files_reload.clone(),
            )?;
            let accepted_diffs = sources.record_reload_diff(&next);
            state
                .database
                .commit_snapshot_transaction(states_to_records(next.collections()))?;
            state.database.take_committed_changes();
            if let Some(previous) = state.sources.as_mut() {
                next.lazy_adopt(previous);
            }
            state.sources = Some(next);
            diffs = accepted_diffs;
            return refresh_lazy_locked(state);
        }
        let content = state.host.read(&state.config.path)?;
        if suppress_self_write && state.last_persisted_content.as_deref() == Some(&content) {
            return Ok(());
        }
        let loaded = load_single_file(
            state.host.as_ref(),
            &state.formats,
            &state.config,
            &state.callbacks,
        )?;
        let records = states_to_records(loaded.collections);
        if let Some(migrated) = &loaded.migrated_content {
            state
                .database
                .validate_snapshot_transaction(records.clone())?;
            state.host.replace_durable(&state.config.path, migrated)?;
        }
        if let Err(error) = state.database.commit_snapshot_transaction(records) {
            // Ordinary invalid reloads keep the last valid database usable.
            // Only an unexpected failure after durable migration writeback
            // makes the visible state unsafe to use.
            if loaded.migrated_content.is_some() {
                state.quarantine_error = Some(error.clone());
            }
            return Err(error);
        }
        state.database.take_committed_changes();
        state.last_persisted_content = Some(loaded.migrated_content.unwrap_or(content));
        Ok(())
    })();
    match result {
        Ok(()) => {
            state.last_reload_error = None;
            Ok(diffs)
        }
        Err(error) => {
            state.last_reload_error = Some(error.clone());
            Err(error)
        }
    }
}

/// Refresh lazy manifests and invalidate watch/index state. Watch evaluation
/// runs after the runtime lock is released.
fn refresh_lazy_locked(state: &mut RuntimeState) -> Result<(), EngineError> {
    crate::write::watch::refresh(state)
}

/// Poll lazy sources: compare the listing and watch-covered generations with the
/// stored state outside the runtime lock, and refresh only on a difference.
/// The runtime's own appends update the stored state, so they never refresh.
fn start_lazy_poller(
    weak: Weak<RuntimeCore>,
    interval: Duration,
    stop: Arc<AtomicBool>,
) -> Result<(), EngineError> {
    std::thread::Builder::new()
        .name("proseql-lazy-watch".into())
        .spawn(move || loop {
            std::thread::sleep(interval);
            if stop.load(Ordering::Acquire) {
                return;
            }
            let Some(core) = weak.upgrade() else {
                return;
            };
            if core.lifecycle.load(Ordering::Acquire) != OPEN {
                return;
            }
            let snapshot = {
                let Ok(mut state) = core.state.lock() else {
                    return;
                };
                if state.quarantine_error.is_some() {
                    continue;
                }
                let host = Arc::clone(&state.host);
                state
                    .sources
                    .as_mut()
                    .map(|sources| (host, sources.lazy_fingerprints()))
            };
            let Some((host, fingerprints)) = snapshot else {
                return;
            };
            let host: &dyn StorageHost = host.as_ref();
            if !lazy::disk_differs(host, &fingerprints).unwrap_or(true) {
                continue;
            }
            if let Ok(mut state) = core.state.lock() {
                if core.lifecycle.load(Ordering::Acquire) == OPEN
                    && state.quarantine_error.is_none()
                    && !stop.load(Ordering::Acquire)
                {
                    let result = refresh_lazy_locked(&mut state);
                    state.last_reload_error = result.err();
                }
            };
            // Errors are recorded in last_reload_error by the hook.
            let _ = NativeRuntime {
                inner: Arc::clone(&core),
            }
            .refresh_streaming_watches();
        })
        .map(|_| ())
        .map_err(|error| {
            operation_error(
                "watch-start",
                format!("Cannot start the lazy watcher: {error}"),
            )
        })
}

fn persist_current(state: &mut RuntimeState) -> Result<(), EngineError> {
    if state.sources.is_some() {
        return Ok(());
    }
    let snapshot = state.database.snapshot_all_collection_states();
    let content = serialize_candidate(&state.config, &state.formats, &snapshot)?;
    state.host.replace_durable(&state.config.path, &content)?;
    state.last_persisted_content = Some(content);
    Ok(())
}

fn has_global_hooks(callbacks: &CallbackRegistry) -> bool {
    !callbacks.global_before_create_hooks().is_empty()
        || !callbacks.global_before_update_hooks().is_empty()
        || !callbacks.global_before_delete_hooks().is_empty()
        || !callbacks.global_after_create_hooks().is_empty()
        || !callbacks.global_after_update_hooks().is_empty()
        || !callbacks.global_after_delete_hooks().is_empty()
        || !callbacks.global_on_change_hooks().is_empty()
}

fn validate_config(
    config: &NativeRuntimeConfig,
    callbacks: &CallbackRegistry,
) -> Result<(), EngineError> {
    for collection in &config.collections {
        let descriptor = &collection.descriptor;
        proseql_engine::descriptor::validate_collection_descriptor(descriptor)?;
        proseql_engine::schema_checks::validate_schema_checks(&descriptor.schema, callbacks)
            .map_err(|error| match error {
                EngineError::Validation(mut error) => {
                    error.message = format!("Collection '{}': {}", descriptor.name, error.message);
                    EngineError::Validation(error)
                }
                other => other,
            })?;
        let require = |id: &str, present: bool| {
            if present {
                Ok(())
            } else {
                Err(operation_error(
                    "missing-callback",
                    format!(
                        "Collection '{}' callback or ID generator '{}' is not registered",
                        descriptor.name, id
                    ),
                ))
            }
        };
        macro_rules! hooks {
            ($field:ident, $global:ident, $lookup:ident) => {
                for id in descriptor.$field.iter().chain(callbacks.$global()) {
                    require(id, callbacks.$lookup(id).is_some())?;
                }
            };
        }
        hooks!(
            before_create_hooks,
            global_before_create_hooks,
            before_create_hook
        );
        hooks!(
            before_update_hooks,
            global_before_update_hooks,
            before_update_hook
        );
        hooks!(
            before_delete_hooks,
            global_before_delete_hooks,
            before_delete_hook
        );
        hooks!(
            after_create_hooks,
            global_after_create_hooks,
            after_create_hook
        );
        hooks!(
            after_update_hooks,
            global_after_update_hooks,
            after_update_hook
        );
        hooks!(
            after_delete_hooks,
            global_after_delete_hooks,
            after_delete_hook
        );
        hooks!(on_change_hooks, global_on_change_hooks, on_change_hook);
        for field in &descriptor.computed_fields {
            require(
                &field.callback_id,
                callbacks.has_computed(&field.callback_id),
            )?;
        }
        for step in &descriptor.migrations {
            require(
                &step.callback_id,
                callbacks.has_migration(&step.callback_id),
            )?;
        }
        if let Some(name) = &descriptor.id_generator {
            require(name, callbacks.has_id_generator(name))?;
        }
    }
    Ok(())
}

fn migration_steps(descriptor: &CollectionDescriptor) -> Vec<MigrationStep> {
    descriptor
        .migrations
        .iter()
        .map(|step| MigrationStep {
            from: step.from,
            to: step.to,
            description: step.description.clone(),
            callback_id: step.callback_id.clone(),
        })
        .collect()
}

/// Load and migrate in memory. The storage loader's ordinary writeback must
/// never bypass the native runtime's durable replacement and validation.
struct SingleFileLoad {
    collections: IndexMap<String, IndexMap<String, Value>>,
    content: Option<String>,
    migrated_content: Option<String>,
}

fn load_single_file(
    host: &dyn DurableStorageHost,
    formats: &FormatRegistry,
    config: &NativeRuntimeConfig,
    callbacks: &CallbackRegistry,
) -> Result<SingleFileLoad, EngineError> {
    let staged = MemoryStorageHost::default();
    let content = if host.exists(&config.path)? {
        Some(host.read(&config.path)?)
    } else {
        None
    };
    if let Some(content) = &content {
        staged.write(&config.path, content)?;
    }
    let migrations = CallbackRegistryMigrationHost::new(callbacks);
    let mut loaded = load_collections_from_file(
        &staged,
        formats,
        &config.path,
        &load_configs(config),
        Some(&migrations),
    )?;
    decode_loaded_collections(config, &mut loaded, callbacks)?;
    let migrated_content = if staged.exists(&config.path)? {
        Some(staged.read(&config.path)?).filter(|next| Some(next) != content.as_ref())
    } else {
        None
    };
    Ok(SingleFileLoad {
        collections: loaded,
        content,
        migrated_content,
    })
}

fn decode_loaded_collections(
    config: &NativeRuntimeConfig,
    loaded: &mut IndexMap<String, IndexMap<String, Value>>,
    callbacks: &CallbackRegistry,
) -> Result<(), EngineError> {
    for collection in &config.collections {
        let descriptor = &collection.descriptor;
        if let Some(records) = loaded.get_mut(&descriptor.name) {
            schema_checks::decode_loaded_records(
                &descriptor.schema,
                &descriptor.id_strategy,
                records,
                callbacks,
            )?;
        }
    }
    Ok(())
}

fn states_to_records(
    states: IndexMap<String, IndexMap<String, Value>>,
) -> IndexMap<String, Vec<Value>> {
    states
        .into_iter()
        .map(|(name, records)| (name, records.into_values().collect()))
        .collect()
}

fn load_configs(config: &NativeRuntimeConfig) -> Vec<LoadCollectionConfig> {
    config
        .collections
        .iter()
        .map(|collection| LoadCollectionConfig {
            name: collection.descriptor.name.clone(),
            schema: schema_checks::storage_decode_schema(&collection.descriptor.schema),
            id_strategy: collection.descriptor.id_strategy.clone(),
            version: collection.descriptor.version,
            migrations: migration_steps(&collection.descriptor),
        })
        .collect()
}

fn save_configs(config: &NativeRuntimeConfig) -> Vec<SaveCollectionConfig> {
    config
        .collections
        .iter()
        .map(|collection| SaveCollectionConfig {
            name: collection.descriptor.name.clone(),
            schema: collection.descriptor.schema.clone(),
            id_strategy: collection.descriptor.id_strategy.clone(),
            version: collection.descriptor.version,
        })
        .collect()
}

fn serialize_candidate(
    config: &NativeRuntimeConfig,
    formats: &FormatRegistry,
    candidate: &IndexMap<String, IndexMap<String, Value>>,
) -> Result<String, EngineError> {
    if candidate.len() != config.collections.len()
        || config
            .collections
            .iter()
            .any(|collection| !candidate.contains_key(&collection.descriptor.name))
    {
        return Err(operation_error(
            "source-shape",
            "Candidate must contain exactly the configured collections",
        ));
    }
    let memory = MemoryStorageHost::default();
    save_collections_to_file(
        &memory,
        formats,
        &config.path,
        &save_configs(config),
        candidate,
    )?;
    memory.read(&config.path)
}
