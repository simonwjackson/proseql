//! ID lookups and index state for streaming lazy collections.
//!
//! Owner: `index` (#15). Contract:
//! `openspec/changes/query-while-scanning/contract.md`.
//!
//! Builds and maintains `proseql_storage::index::{TimeIndex, IdLocator}` and
//! their generations per lazy collection, inside [`IndexState`]. `exec` reads
//! time indexes through [`IndexState::time_index`]; `append` checks IDs
//! through [`IndexState::id_locator`]. Those accessor signatures and the two
//! find-by-ID hooks are binding; everything else here is `index`'s.

// Skeleton: the owner removes this allow once the seam is implemented.
#![allow(dead_code)]

use crate::{MutationInner, NativeRuntime};
use proseql_engine::errors::EngineError;
use proseql_storage::host::StorageHost;
use proseql_storage::index::{IdLocator, TimeIndex};
use serde_json::Value;

/// Index state of one lazy collection (slot `LazyStreamState::index`).
#[derive(Default)]
pub(crate) struct IndexState {
    _private: (),
}

impl IndexState {
    /// The current time index of `path` on the ordered field `field`, built or
    /// refreshed on demand from the text. `exec` passes the field its range
    /// filter uses. `None` when the file cannot seek on that field (not an
    /// ordered index of the collection, unsorted rows) or the index is not
    /// built yet and building is not worth it.
    pub fn time_index(
        &mut self,
        _host: &dyn StorageHost,
        _path: &str,
        _field: &str,
    ) -> Result<Option<&TimeIndex>, EngineError> {
        Ok(None)
    }

    /// The collection's ID locator, built on first use by scanning ID fields
    /// only, and checked against generations before it is returned.
    pub fn id_locator(
        &mut self,
        _host: &dyn StorageHost,
        _paths: &[String],
    ) -> Result<&mut IdLocator, EngineError> {
        Err(proseql_engine::scan::unimplemented_seam(
            "IndexState::id_locator",
        ))
    }

    pub fn resident_bytes(&self) -> usize {
        0
    }
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
    /// `NativeRuntime::find_by_id` for a streaming lazy collection. `None`
    /// falls back to the resident path. Must not be called with the lock held.
    pub(crate) fn streaming_find_by_id(
        &self,
        _collection: &str,
        _id: &str,
    ) -> Option<Result<Option<Value>, EngineError>> {
        None
    }
}

/// `NativeMutation::find_by_id` for a streaming lazy collection, after the
/// engine collection (which holds rows created in this mutation) missed.
/// `None` falls back to the resident path.
pub(crate) fn mutation_find_by_id(
    _inner: &mut MutationInner<'_>,
    _collection: &str,
    _id: &str,
) -> Option<Result<Option<Value>, EngineError>> {
    None
}
