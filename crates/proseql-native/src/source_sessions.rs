//! Explicit durable source lifetimes. The idle owner contains configuration
//! and services, never a loaded database or a second copy of source records.
use crate::{
    has_global_hooks, lazy, operation_error, sources::SourceState, NativeRuntime,
    NativeRuntimeOptions, NativeSourceRuntimeConfig, NativeSourceRuntimeOptions, RuntimeServices,
};
use indexmap::IndexMap;
use proseql_engine::errors::EngineError;
use proseql_storage::{
    document_graph::DocumentGraphTransformHost, fs::FsStorageHost, persistence::DurableStorageHost,
    source_config::NormalizedSourceConfig,
};
use std::{
    collections::HashSet,
    marker::PhantomData,
    ops::Deref,
    rc::Rc,
    sync::{Arc, Condvar, Mutex},
    thread::ThreadId,
    time::Duration,
};

/// How a session asks the process allocator to return unused pages.
/// This never frees live Rust objects or installs a global allocator.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum IdleMemoryReclaim {
    /// Drop owned state only. The allocator can retain freed pages.
    #[default]
    None,
    /// Call glibc malloc_trim after all session state is dropped. Supported on
    /// Linux GNU only; custom allocators can require their own reclamation.
    GlibcTrim,
}
impl IdleMemoryReclaim {
    fn validate(self) -> Result<(), EngineError> {
        if self == Self::GlibcTrim && !cfg!(all(target_os = "linux", target_env = "gnu")) {
            return Err(operation_error(
                "unsupported-memory-reclaim",
                "GlibcTrim requires Linux GNU. Use None and your allocator's own reclamation policy",
            ));
        }
        Ok(())
    }
    fn release(self) -> bool {
        #[cfg(all(target_os = "linux", target_env = "gnu"))]
        if self == Self::GlibcTrim {
            extern "C" {
                fn malloc_trim(pad: usize) -> std::ffi::c_int;
            }
            let _phase = proseql_storage::diagnostics::span("session_allocator_reclaim");
            // glibc only releases unused allocator pages. Live pointers remain
            // valid, including outputs owned by the caller or another thread.
            return unsafe { malloc_trim(0) } != 0;
        }
        false
    }
}

#[derive(Default)]
struct SessionGate {
    owner: Mutex<Option<ThreadId>>,
    available: Condvar,
}
impl SessionGate {
    fn enter(&self, reclaim: IdleMemoryReclaim) -> Result<SessionLease<'_>, EngineError> {
        let thread = std::thread::current().id();
        let mut owner = self
            .owner
            .lock()
            .map_err(|_| operation_error("poisoned", "Source-session gate is poisoned"))?;
        while let Some(active) = *owner {
            if active == thread {
                return Err(operation_error("session-reentrant","A source session is already active on this thread. Use that runtime instead of opening another session"));
            }
            owner = self
                .available
                .wait(owner)
                .map_err(|_| operation_error("poisoned", "Source-session gate is poisoned"))?;
        }
        *owner = Some(thread);
        Ok(SessionLease {
            gate: self,
            reclaim,
            _same_thread: PhantomData,
        })
    }
}
struct SessionLease<'a> {
    gate: &'a SessionGate,
    reclaim: IdleMemoryReclaim,
    // A session must close on its opening thread so reentrant detection cannot
    // mistake a moved session for another caller waiting for the same owner.
    _same_thread: PhantomData<Rc<()>>,
}
impl Drop for SessionLease<'_> {
    fn drop(&mut self) {
        self.reclaim.release();
        if let Ok(mut owner) = self.gate.owner.lock() {
            *owner = None;
            self.gate.available.notify_one();
        }
    }
}

/// Shared source preparation for permanent runtimes and explicit sessions.
/// Validation and codec installation must not diverge between those lifetimes.
pub(crate) struct PreparedSourceRuntime {
    config: crate::NativeRuntimeConfig,
    normalized: NormalizedSourceConfig,
    appendable: HashSet<String>,
    lazy: IndexMap<String, lazy::LazyCollection>,
    transforms: Option<Arc<dyn DocumentGraphTransformHost>>,
    lazy_watch_interval: Duration,
    watch_debounce: Option<Duration>,
    services: RuntimeServices,
    host: Arc<dyn DurableStorageHost>,
}
impl PreparedSourceRuntime {
    pub(crate) fn new(
        config: NativeSourceRuntimeConfig,
        host: Arc<dyn DurableStorageHost>,
        options: NativeSourceRuntimeOptions,
    ) -> Result<Self, EngineError> {
        let normalized = SourceState::normalize(&config)?;
        let appendable = SourceState::appendable_collections(&config, &normalized);
        let lazy = lazy::configure_lazy(
            &config,
            &normalized,
            &options.lazy_partitions,
            options.execution_model,
        )?;
        if !lazy.is_empty() && has_global_hooks(&options.callbacks) {
            return Err(operation_error(
                "unsupported-descriptor",
                "Lazy sources do not support global hooks",
            ));
        }
        let config = SourceState::descriptor_config(config);
        let services = RuntimeServices::new(
            &config,
            NativeRuntimeOptions {
                callbacks: options.callbacks,
                formats: options.formats,
                plugin_codecs: options.plugin_codecs,
            },
        )?;
        Ok(Self {
            config,
            normalized,
            appendable,
            lazy,
            transforms: options.transforms,
            lazy_watch_interval: options.lazy_watch_interval,
            watch_debounce: options.watch_debounce,
            services,
            host,
        })
    }
    pub(crate) fn open(&self) -> Result<NativeRuntime, EngineError> {
        let sources = {
            let _phase = proseql_storage::diagnostics::span("source_load");
            SourceState::load(
                self.host.as_ref(),
                &self.services.formats,
                self.normalized.clone(),
                self.appendable.clone(),
                self.transforms.clone(),
                &self.lazy,
                self.lazy_watch_interval,
                &self.services.callbacks,
            )?
        };
        let loaded = sources.collections();
        let runtime = NativeRuntime::from_loaded(
            self.config.clone(),
            Arc::clone(&self.host),
            self.services.clone(),
            loaded,
            None,
            Some(sources),
        )?;
        if let Some(debounce) = self.watch_debounce {
            if let Err(error) = runtime.start_managed_watch(debounce) {
                let _ = runtime.close();
                return Err(error);
            }
        }
        Ok(runtime)
    }
}

/// A serialized source-session owner with no historical records at idle.
/// Each session reopens durable sources. Long-lived NativeRuntime behavior is
/// unchanged. Registered callbacks/codecs/hosts can themselves own memory.
/// Source validation and source I/O happen at session open, not owner creation.
pub struct NativeSourceSessions {
    prepared: PreparedSourceRuntime,
    gate: SessionGate,
    reclaim: IdleMemoryReclaim,
}
impl NativeSourceSessions {
    pub fn new(
        config: NativeSourceRuntimeConfig,
        options: NativeSourceRuntimeOptions,
    ) -> Result<Self, EngineError> {
        Self::with_host(
            config,
            Arc::new(FsStorageHost::new_polling(Duration::from_secs(2))?),
            options,
        )
    }
    /// The host must provide durable storage. Memory owned by a custom host is
    /// separate from the session cache and must be included in consumer budgets.
    pub fn with_host(
        config: NativeSourceRuntimeConfig,
        host: Arc<dyn DurableStorageHost>,
        options: NativeSourceRuntimeOptions,
    ) -> Result<Self, EngineError> {
        Ok(Self {
            prepared: PreparedSourceRuntime::new(config, host, options)?,
            gate: SessionGate::default(),
            reclaim: IdleMemoryReclaim::None,
        })
    }
    /// Select an explicit allocator policy before sharing the owner. Selecting
    /// an unsupported policy fails rather than silently retaining memory.
    pub fn reclaim_idle_memory(mut self, policy: IdleMemoryReclaim) -> Result<Self, EngineError> {
        policy.validate()?;
        self.reclaim = policy;
        Ok(self)
    }
    /// Apply the selected allocator policy after dropping caller-owned output.
    /// Session close cannot reclaim pages containing results that are still
    /// alive. Returns glibc's release result, or false for the None policy.
    pub fn release_unused_memory(&self) -> bool {
        self.reclaim.release()
    }
    /// Open one active runtime. Holding the returned value keeps its data and
    /// watches active. Drop it or call close to end that ownership.
    pub fn open_session(&self) -> Result<NativeSourceSession<'_>, EngineError> {
        let lease = self.gate.enter(self.reclaim)?;
        let runtime = self.prepared.open()?;
        Ok(NativeSourceSession {
            runtime,
            _lease: lease,
            closed: false,
        })
    }
    /// Run one coherent operation, then release its source state before return.
    /// Owned results can leave the session; a watch needs an open session for
    /// future updates. On error, cleanup still runs and preserves that error.
    pub fn with_session<R>(
        &self,
        f: impl FnOnce(&NativeRuntime) -> Result<R, EngineError>,
    ) -> Result<R, EngineError> {
        let mut session = self.open_session()?;
        let result = f(&session);
        // Keep the lease until discarded output and secondary close errors
        // have dropped. Otherwise the allocator trim runs while that memory
        // is still live. Borrowing here also preserves this drop order if
        // close unwinds: result drops before the earlier session variable.
        let closed = session.runtime.close();
        session.closed = true;
        let result = match (result, closed) {
            (Err(error), _) => Err(error),
            (Ok(value), Ok(())) => Ok(value),
            (Ok(_), Err(error)) => Err(error),
        };
        drop(session);
        result
    }
}

/// An active source lifetime. Dereferences to the existing native runtime.
/// Last-known-good state, subscriptions and cache reuse last until close.
pub struct NativeSourceSession<'a> {
    // Field order matters: drop the runtime before the lease trims unused
    // pages and permits another caller to open the next session.
    runtime: NativeRuntime,
    _lease: SessionLease<'a>,
    closed: bool,
}
impl Deref for NativeSourceSession<'_> {
    type Target = NativeRuntime;
    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}
impl NativeSourceSession<'_> {
    pub fn close(mut self) -> Result<(), EngineError> {
        let _phase = proseql_storage::diagnostics::span("session_release");
        let result = self.runtime.close();
        self.closed = true;
        result
    }
}
impl Drop for NativeSourceSession<'_> {
    fn drop(&mut self) {
        if !self.closed {
            let _phase = proseql_storage::diagnostics::span("session_release");
            let _ = self.runtime.close();
        }
    }
}
