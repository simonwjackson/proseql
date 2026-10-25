//! Watches and change polling for streaming lazy collections, without
//! pinning partitions resident.
//!
//! Owner: `mutate` (#16b). Contract:
//! `openspec/changes/query-while-scanning/contract.md`.
//!
//! Watch semantics stay as documented in `docs/native-sources.md`: initial
//! result, change events after this runtime's own commits and after external
//! edits found by the lazy poller, last-known-good results after an invalid
//! external edit, and `lazy_watch_interval`. The memory a watch may keep is
//! its delivered result (caller-owned) plus a compact change baseline, never
//! the rows of the partitions it covers.
//!
//! The hook signatures are binding; everything else here is `mutate`'s.

// Skeleton: the owner removes this allow once the seam is implemented.
#![allow(dead_code)]

use crate::{NativeRuntime, NativeWatch, RuntimeState};
use proseql_engine::errors::EngineError;
use proseql_engine::reactive::{CallbackSubscription, ValueSubscription, WatchQueryConfig};
use proseql_engine::scan::unimplemented_seam;
use serde_json::Value;

/// Watch state of one lazy collection (slot `LazyStreamState::watch`).
#[derive(Default)]
pub(crate) struct WatchState {
    _private: (),
}

impl WatchState {
    pub fn resident_bytes(&self) -> usize {
        0
    }
}

impl NativeRuntime {
    /// Whether `watch`/`watch_with_callback` on `collection` take the
    /// streaming path. Must not be called with the lock held.
    pub(crate) fn streaming_watch_applies(&self, _collection: &str) -> bool {
        false
    }

    pub(crate) fn streaming_watch(
        &self,
        _collection: &str,
        _config: WatchQueryConfig,
    ) -> Result<NativeWatch<ValueSubscription>, EngineError> {
        Err(unimplemented_seam("watch::streaming_watch"))
    }

    pub(crate) fn streaming_watch_with_callback(
        &self,
        _collection: &str,
        _config: WatchQueryConfig,
        _callback: Box<dyn Fn(Value) + Send + Sync>,
    ) -> Result<NativeWatch<CallbackSubscription>, EngineError> {
        Err(unimplemented_seam("watch::streaming_watch_with_callback"))
    }
}

/// Whether the lazy poll refresh takes the streaming path. Called with the
/// runtime lock held, from `refresh_lazy_locked`.
pub(crate) fn refresh_applies(_state: &RuntimeState) -> bool {
    false
}

/// Streaming replacement for `refresh_lazy_locked`: detect changed, added and
/// removed partitions through generations, invalidate index state, and
/// publish changes to streaming watches.
pub(crate) fn refresh(_state: &mut RuntimeState) -> Result<(), EngineError> {
    Err(unimplemented_seam("watch::refresh"))
}

// ── hooks added in qws/base 2 (requested by mutate) ────────────────────────

/// Called with the runtime lock held, right after `commit_source_mutation`
/// succeeded and before `append::after_commit` removes the batch from the
/// engine collection. Capture what streaming watches need from this commit
/// (for example the committed rows of streaming lazy collections) into
/// `WatchState`. Must not publish anything to callers here.
pub(crate) fn capture_commit(_state: &mut RuntimeState) {}

/// Called with the runtime lock held after a source-mode mutation failed and
/// rolled back (not quarantined), before `refresh_streaming_watches` runs
/// without the lock. Mark streaming watches whose covered files the failed
/// mutation found changed or new as dirty. Must not publish anything here.
pub(crate) fn capture_external(_state: &mut RuntimeState) {}

impl NativeRuntime {
    /// Called without the runtime lock after every successful source-mode
    /// mutation (before host callbacks replay), after `reload`, after the
    /// managed watcher's reload, and after each lazy poll that refreshed.
    /// Deliver pending streaming-watch results here; `streaming_read` may be
    /// called. Return the error a resident reload would have returned (for
    /// example an invalid edit to a covered partition) and also record it in
    /// `RuntimeState::last_reload_error`, as the resident reload paths do.
    /// `reload()` returns it; the mutation, watcher and poller call sites
    /// ignore the return value.
    pub(crate) fn refresh_streaming_watches(&self) -> Result<(), EngineError> {
        Ok(())
    }
}
