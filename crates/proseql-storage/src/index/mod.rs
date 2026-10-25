//! Disposable in-memory indexes over checked text generations.
mod id;
pub mod rows;
mod time;

pub use id::{id_error, IdLocator};
pub use time::TimeIndex;

/// A candidate recorded after commit has not yet been scanned for ordering.
pub const UNKNOWN_ORDINAL: u64 = u64::MAX;

/// Conservative byte window for an inclusive ordered-key range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeekRange {
    pub start_offset: u64,
    pub end_offset: Option<u64>,
    pub start_row: u64,
}
