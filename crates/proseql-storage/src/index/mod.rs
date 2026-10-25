//! Positional indexes over text partitions, without resident rows.
//!
//! Seam owner: `index` (#15). Contract:
//! `openspec/changes/query-while-scanning/contract.md`.
//!
//! The public method signatures below are binding: `exec` uses
//! [`TimeIndex::seek`], `append` uses [`IdLocator`]. Internals are free.
//!
//! `allowDisposableBinaryFiles` is false for this run: these structures live
//! in memory and are rebuilt from text. A text JSON sidecar is allowed only if
//! it is checked against [`SourceGeneration`] and safe to delete.

use crate::generation::SourceGeneration;
use proseql_engine::errors::EngineError;
use proseql_engine::scan::{unimplemented_seam, RowLocation};
use serde_json::Value;

/// Sparse map from an ordered key to byte offsets in one partition file:
/// one entry every `stride` rows. Valid only while its generation is
/// unchanged; out-of-order rows disable seeking for that file.
#[derive(Debug, Clone, Default)]
pub struct TimeIndex {
    _private: (),
}

/// Where a scan of one file must start and may stop for a key range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeekRange {
    /// Byte offset of a line start at or before the first possible match.
    pub start_offset: u64,
    /// Byte offset of a line start after the last possible match, or `None`
    /// to read to the end of the file.
    pub end_offset: Option<u64>,
    /// Ordinal (within the file) of the row at `start_offset`, so the
    /// executor keeps stable natural-order ordinals after a seek.
    pub start_row: u64,
}

impl TimeIndex {
    /// The generation this index was built from.
    pub fn generation(&self) -> Option<&SourceGeneration> {
        None
    }

    /// Byte range to scan for `lower <= key <= upper` (either bound may be
    /// absent; exclusivity is applied by the executor's filter). `None` when
    /// the index cannot seek (unsorted file, stale generation): scan it all.
    pub fn seek(&self, _lower: Option<&Value>, _upper: Option<&Value>) -> Option<SeekRange> {
        None
    }
}

/// Exact ID membership and location for one lazy collection, across all its
/// partitions, without record payloads.
///
/// `locate` may return false positives (for example when it stores hashes);
/// callers verify by reading the row at the returned location. It must never
/// return a false negative while its generations are current.
#[derive(Debug, Clone, Default)]
pub struct IdLocator {
    _private: (),
}

impl IdLocator {
    /// Candidate locations for `id`: the partition file path and the row's
    /// location in it. Empty when the ID is absent.
    pub fn locate(&self, _id: &str) -> Result<Vec<(String, RowLocation)>, EngineError> {
        Err(unimplemented_seam("IdLocator::locate"))
    }

    /// Record rows appended by this runtime after a durable commit.
    pub fn record_appended(
        &mut self,
        _path: &str,
        _rows: &[(String, RowLocation)],
    ) -> Result<(), EngineError> {
        Err(unimplemented_seam("IdLocator::record_appended"))
    }

    /// Resident bytes, for the open/idle memory targets.
    pub fn resident_bytes(&self) -> usize {
        0
    }
}
