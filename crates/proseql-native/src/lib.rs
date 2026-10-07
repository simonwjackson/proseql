//! Durable, long-running native proseQL runtime.
//!
//! The runtime owns one database backed by either a single file or configured
//! document and graph sources. It serializes mutations and publishes them only
//! after durable persistence. Source-mode batches replace files individually;
//! a write-stage failure quarantines the runtime because a prefix can be durable.

mod read_snapshot;
mod sources;
use sources::SourceState;
pub use sources::{NativeSourceRuntimeConfig, NativeSourceRuntimeOptions};

use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use indexmap::IndexMap;
use proseql_engine::callbacks::CallbackRegistry;
use proseql_engine::collection::Collection;
use proseql_engine::descriptor::CollectionDescriptor;
use proseql_engine::errors::{EngineError, OperationError};
use proseql_engine::id_gen::NanoIdGenerator;
use proseql_engine::relationships::Database;
use proseql_formats::FormatRegistry;
use proseql_storage::fs::FsStorageHost;
use proseql_storage::host::{StorageHost, WatchHandle};
use proseql_storage::memory::MemoryStorageHost;
use proseql_storage::persistence::{
    load_collections_from_file, save_collections_to_file, DurableStorageHost, LoadCollectionConfig,
    SaveCollectionConfig,
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

/// Restricted mutation view used by [`NativeRuntime::mutate`]. Keeping the raw
/// database private ensures every exposed write participates in the engine's
/// reversible transaction journal.
pub struct NativeMutation<'a> {
    database: &'a mut Database,
    read_only: Option<&'a IndexMap<String, String>>,
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

    pub fn find_by_id(&self, collection: &str, id: &str) -> Result<Option<Value>, EngineError> {
        let collection = self.database.collection(collection).ok_or_else(|| {
            operation_error(
                "unknown-collection",
                format!("Unknown collection '{collection}'"),
            )
        })?;
        Ok(collection.get(id).cloned())
    }

    pub fn create(&mut self, collection: &str, data: Value) -> Result<Value, EngineError> {
        self.require_writable(collection)?;
        self.database.create(collection, data)
    }

    pub fn update(
        &mut self,
        collection: &str,
        id: &str,
        updates: Value,
    ) -> Result<Value, EngineError> {
        self.require_writable(collection)?;
        self.database.update(collection, id, updates)
    }

    pub fn update_if_revision(
        &mut self,
        collection: &str,
        id: &str,
        expected_revision: u64,
        updates: Value,
    ) -> Result<Value, EngineError> {
        self.require_writable(collection)?;
        self.database
            .update_if_revision(collection, id, expected_revision, updates)
    }

    pub fn delete(&mut self, collection: &str, id: &str) -> Result<Value, EngineError> {
        self.require_writable(collection)?;
        self.database.delete(collection, id)
    }
}

#[derive(Clone)]
pub struct NativeRuntime {
    inner: Arc<RuntimeCore>,
}

struct RuntimeCore {
    state: Mutex<RuntimeState>,
    lifecycle: AtomicU8,
    watch_generation: AtomicU64,
}

struct RuntimeState {
    config: NativeRuntimeConfig,
    sources: Option<SourceState>,
    database: Database,
    formats: FormatRegistry,
    host: Arc<dyn DurableStorageHost>,
    watch: Vec<Box<dyn WatchHandle>>,
    last_persisted_content: Option<String>,
    last_reload_error: Option<EngineError>,
    quarantine_error: Option<EngineError>,
    rollback_failure_once: bool,
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
        validate_config(&config)?;
        let formats = FormatRegistry::with_builtins();
        let load_configs = load_configs(&config);
        let loaded =
            load_collections_from_file(host.as_ref(), &formats, &config.path, &load_configs, None)?;
        let source_content = host.read(&config.path).ok();
        Self::from_loaded(config, host, formats, loaded, source_content, None)
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
        let normalized = SourceState::normalize(&config)?;
        let descriptors = SourceState::descriptor_config(config);
        validate_config(&descriptors)?;
        let sources = SourceState::load(
            host.as_ref(),
            &options.formats,
            normalized,
            options.transforms,
        )?;
        let loaded = sources.collections();
        let runtime = Self::from_loaded(
            descriptors,
            host,
            options.formats,
            loaded,
            None,
            Some(sources),
        )?;
        if let Some(debounce) = options.watch_debounce {
            runtime.start_managed_watch(debounce)?;
        }
        Ok(runtime)
    }

    fn from_loaded(
        config: NativeRuntimeConfig,
        host: Arc<dyn DurableStorageHost>,
        formats: FormatRegistry,
        loaded: IndexMap<String, IndexMap<String, Value>>,
        source_content: Option<String>,
        sources: Option<SourceState>,
    ) -> Result<Self, EngineError> {
        let registry = Arc::new(CallbackRegistry::new());
        let mut collections = IndexMap::new();
        for collection in &config.collections {
            let name = collection.descriptor.name.clone();
            collections.insert(
                name.clone(),
                Collection::new(
                    name,
                    collection.descriptor.clone(),
                    Arc::clone(&registry),
                    Box::new(NanoIdGenerator),
                ),
            );
        }
        let mut database = Database::new(collections, registry);
        database.commit_snapshot_transaction(states_to_records(loaded))?;
        database.take_committed_changes();
        Ok(Self {
            inner: Arc::new(RuntimeCore {
                state: Mutex::new(RuntimeState {
                    config,
                    sources,
                    database,
                    formats,
                    host,
                    watch: Vec::new(),
                    last_persisted_content: source_content,
                    last_reload_error: None,
                    quarantine_error: None,
                    rollback_failure_once: false,
                }),
                lifecycle: AtomicU8::new(OPEN),
                watch_generation: AtomicU64::new(0),
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

    pub fn read<R>(
        &self,
        f: impl FnOnce(&Database) -> Result<R, EngineError>,
    ) -> Result<R, EngineError> {
        let state = self.lock_open()?;
        f(&state.database)
    }

    pub fn find_by_id(&self, collection: &str, id: &str) -> Result<Option<Value>, EngineError> {
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
        let read_only = state
            .sources
            .as_ref()
            .map(|sources| sources.graph.owned_collections.clone());
        let mut session = state.database.begin_owned_transaction()?;
        let result = match state.database.transaction_step(&mut session, |database| {
            f(&mut NativeMutation {
                database,
                read_only: read_only.as_ref(),
            })
        }) {
            Ok(result) => result,
            Err(error) => {
                rollback_preserving_original(&self.inner, &mut state, session, &error);
                return Err(error);
            }
        };
        let candidate = state.database.snapshot_all_collection_states();
        if let Some(sources) = &state.sources {
            let plan = sources.plan(&state.formats, &candidate).and_then(|plan| {
                sources.check_conflicts(state.host.as_ref(), &plan.writes)?;
                for name in session.touched_collections() {
                    if sources.graph.owned_collections.contains_key(name) {
                        return Err(operation_error(
                            "read-only-source",
                            format!("Transaction changed read-only collection '{name}'"),
                        ));
                    }
                }
                Ok(plan)
            });
            let sources::SourcePlan {
                writes,
                documents: next,
                files,
            } = match plan {
                Ok(plan) => plan,
                Err(error) => {
                    rollback_preserving_original(&self.inner, &mut state, session, &error);
                    return Err(error);
                }
            };
            let mut completed = Vec::new();
            for write in &writes {
                if let Err(cause) = state.host.replace_durable(&write.path, &write.content) {
                    let error = operation_error("source-write-failed", format!("Durable source write failed at '{}'; completed paths: {:?}; cause: {cause}. Reopen and inspect before retrying", write.path, completed));
                    rollback_preserving_original(&self.inner, &mut state, session, &error);
                    state.quarantine_error = Some(error.clone());
                    return Err(error);
                }
                completed.push(write.path.clone());
            }
            if let Err(error) = state.database.commit_owned_transaction(session) {
                state.quarantine_error = Some(error.clone());
                return Err(error);
            }
            state.database.take_committed_changes();
            let sources = state.sources.as_mut().expect("source mode remains active");
            sources.documents = next;
            sources.files = files;
            for write in writes {
                sources.contents.insert(write.path, write.content);
            }
            return Ok(result);
        }
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
        Ok(result)
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
        let validated = states_to_records(load_collections_from_file(
            &memory,
            &state.formats,
            &state.config.path,
            &load_configs(&state.config),
            None,
        )?);
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
        reload_locked(&mut state, false)
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
        let mut handles = Vec::new();
        if let Some(sources) = &state.sources {
            for root in sources.watch_roots(state.host.as_ref())? {
                let weak = Arc::downgrade(&self.inner);
                let handle = state
                    .host
                    .watch_dir(&root, Box::new(move |_| schedule_reload(&weak, debounce)))?;
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
        if self
            .inner
            .lifecycle
            .compare_exchange(OPEN, CLOSING, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(());
        }
        self.inner.watch_generation.fetch_add(1, Ordering::AcqRel);
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| operation_error("poisoned", "Native runtime lock is poisoned"))?;
        let flush_result = persist_current(&mut state);
        let mut stop_result = Ok(());
        for handle in state.watch.drain(..) {
            if let Err(error) = handle.stop() {
                if stop_result.is_ok() {
                    stop_result = Err(error);
                }
            }
        }
        self.inner.lifecycle.store(CLOSED, Ordering::Release);
        flush_result.and(stop_result)
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
        if let Ok(mut state) = core.state.lock() {
            if core.lifecycle.load(Ordering::Acquire) == OPEN && state.quarantine_error.is_none() {
                let _ = reload_locked(&mut state, true);
            }
        };
    });
}

fn reload_locked(state: &mut RuntimeState, suppress_self_write: bool) -> Result<(), EngineError> {
    let result: Result<(), EngineError> = (|| {
        if let Some(sources) = &state.sources {
            let next = SourceState::load(
                state.host.as_ref(),
                &state.formats,
                sources.config.clone(),
                sources.transforms.clone(),
            )?;
            state
                .database
                .commit_snapshot_transaction(states_to_records(next.collections()))?;
            state.database.take_committed_changes();
            state.sources = Some(next);
            return Ok(());
        }
        let content = state.host.read(&state.config.path)?;
        if suppress_self_write && state.last_persisted_content.as_deref() == Some(&content) {
            return Ok(());
        }
        let loaded = load_collections_from_file(
            state.host.as_ref(),
            &state.formats,
            &state.config.path,
            &load_configs(&state.config),
            None,
        )?;
        state
            .database
            .commit_snapshot_transaction(states_to_records(loaded))?;
        state.database.take_committed_changes();
        state.last_persisted_content = Some(content);
        Ok(())
    })();
    match result {
        Ok(()) => {
            state.last_reload_error = None;
            Ok(())
        }
        Err(error) => {
            state.last_reload_error = Some(error.clone());
            Err(error)
        }
    }
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

fn validate_config(config: &NativeRuntimeConfig) -> Result<(), EngineError> {
    for collection in &config.collections {
        let descriptor = &collection.descriptor;
        let has_callbacks = !descriptor.before_create_hooks.is_empty()
            || !descriptor.after_create_hooks.is_empty()
            || !descriptor.before_update_hooks.is_empty()
            || !descriptor.after_update_hooks.is_empty()
            || !descriptor.before_delete_hooks.is_empty()
            || !descriptor.after_delete_hooks.is_empty()
            || !descriptor.on_change_hooks.is_empty()
            || !descriptor.computed_fields.is_empty();
        if has_callbacks || !descriptor.migrations.is_empty() || descriptor.id_generator.is_some() {
            return Err(operation_error(
                "unsupported-descriptor",
                format!(
                    "Collection '{}' requires callbacks, migrations, or a named ID generator; register-capable native configuration is not yet supported",
                    descriptor.name
                ),
            ));
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
            schema: collection.descriptor.schema.clone(),
            id_strategy: collection.descriptor.id_strategy.clone(),
            version: collection.descriptor.version,
            migrations: vec![],
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
