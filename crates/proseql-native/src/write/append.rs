//! Creates on streaming lazy collections without loading partitions.
//!
//! Owner: `append` (#16a). Contract:
//! `openspec/changes/query-while-scanning/contract.md`.
//!
//! Recommended approach (the contract explains it): check every incoming ID
//! against the collection's `IdLocator` (verify candidates by reading the
//! row; `ignore_identical` compares the validated stored record), then let
//! the engine create the batch in the engine collection exactly as today, so
//! validation, defaults, ID generation, hooks, change events and rollback
//! keep their meaning. The existing commit path appends the lines durably.
//! After a durable commit, [`after_commit`] removes the batch from the engine
//! collection and records the new rows in the `IdLocator`; after a rollback,
//! [`after_rollback`] drops any bookkeeping. Memory is then one batch, not
//! the partitions it routes to.
//!
//! The hook signatures are binding; everything else here is `append`'s.

// Skeleton: the owner removes this allow once the seam is implemented.
#![allow(dead_code)]

use crate::{MutationInner, RuntimeState};
use proseql_engine::collection::CreateManyResult;
use proseql_engine::errors::EngineError;
use proseql_engine::scan::unimplemented_seam;
use serde_json::Value;

/// Append bookkeeping of one lazy collection (slot `LazyStreamState::append`).
#[derive(Default)]
pub(crate) struct AppendState {
    _private: (),
}

impl AppendState {
    pub fn resident_bytes(&self) -> usize {
        0
    }
}

/// Whether creates on `collection` take the streaming path.
pub(crate) fn applies(_inner: &MutationInner<'_>, _collection: &str) -> bool {
    false
}

/// `NativeMutation::create` on a streaming lazy collection.
pub(crate) fn create(
    _inner: &mut MutationInner<'_>,
    _collection: &str,
    _data: Value,
) -> Result<Value, EngineError> {
    Err(unimplemented_seam("append::create"))
}

/// `NativeMutation::create_many` on a streaming lazy collection.
pub(crate) fn create_many(
    _inner: &mut MutationInner<'_>,
    _collection: &str,
    _data: Vec<Value>,
) -> Result<CreateManyResult, EngineError> {
    Err(unimplemented_seam("append::create_many"))
}

/// Called with the runtime lock held, after a mutation committed durably.
/// Infallible on purpose: the rows are already on disk. If bookkeeping cannot
/// be updated, mark the index state stale so the next use rebuilds it.
pub(crate) fn after_commit(_state: &mut RuntimeState) {}

/// Called with the runtime lock held, after a mutation rolled back.
pub(crate) fn after_rollback(_state: &mut RuntimeState) {}
