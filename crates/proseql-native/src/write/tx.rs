//! Commit-time conflict checks for streaming lazy collections.
//!
//! Owner: `mutate` (#16b). Contract:
//! `openspec/changes/query-while-scanning/contract.md`.
//!
//! Without resident partitions, the runtime no longer holds the bytes it
//! would compare with the disk before an append. Before a mutation that
//! appends to a streaming lazy collection commits, [`check_before_commit`]
//! verifies the target files' generations and fails with the same error
//! today's conflict detection returns when the disk changed underneath.
//!
//! The hook signature is binding; everything else here is `mutate`'s.

// Skeleton: the owner removes this allow once the seam is implemented.
#![allow(dead_code)]

use crate::RuntimeState;
use proseql_engine::errors::EngineError;

/// Called with the runtime lock held, before `commit_source_mutation`.
pub(crate) fn check_before_commit(_state: &RuntimeState) -> Result<(), EngineError> {
    Ok(())
}
