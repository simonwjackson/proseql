//! The execution-model switch and the per-collection slots each
//! query-while-scanning builder owns.
//!
//! Owner: the parent (contract) until cutover, then `integrator`. Builders do
//! not edit this file; each fills the state type in its own module. Contract:
//! `openspec/changes/query-while-scanning/contract.md`.

/// Deprecated compatibility selector. Lazy collections always stream; eager
/// collections always use the resident engine, regardless of this value.
#[deprecated(note = "Lazy collections always stream; remove the execution_model setting")]
#[allow(deprecated)] // Deriving Default refers to the deprecated Streaming variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExecutionModel {
    /// Compatibility alias for Streaming. Does not enable lazy residency.
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
