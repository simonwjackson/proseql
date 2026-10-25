//! The execution-model switch and the per-collection slots each
//! query-while-scanning builder owns.
//!
//! Owner: the parent (contract) until cutover, then `integrator`. Builders do
//! not edit this file; each fills the state type in its own module. Contract:
//! `openspec/changes/query-while-scanning/contract.md`.

// Skeleton: the integrator removes this allow at cutover.
#![allow(dead_code)]

/// How lazy partitioned collections execute reads and writes.
///
/// `Resident` is today's model: an operation loads the partitions it touches
/// into the engine collection, then runs. `Streaming` queries while scanning
/// the text and keeps no rows after an operation returns. Non-lazy
/// collections are not affected by this switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExecutionModel {
    Resident,
    #[default]
    Streaming,
}

/// Query-while-scanning state of one lazy collection. Each field belongs to
/// one builder, which defines its type in its own module and may add fields
/// there freely. Reloads move this state to the new source state
/// (`SourceState::lazy_adopt`); owners must re-check generations before use.
#[derive(Default)]
pub(crate) struct LazyStreamState {
    /// Owner `index`: time indexes, ID locator, generations.
    pub index: crate::locate::IndexState,
    /// Owner `append`: append bookkeeping (rows staged in the open mutation).
    pub append: crate::write::append::AppendState,
    /// Owner `mutate`: streaming watch state and poll baselines.
    pub watch: crate::write::watch::WatchState,
}

impl LazyStreamState {
    /// Resident bytes held between operations, for the idle memory target.
    pub fn resident_bytes(&self) -> usize {
        self.index.resident_bytes() + self.append.resident_bytes() + self.watch.resident_bytes()
    }
}
