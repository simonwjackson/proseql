//! Source generations: cheap, checked identity of a partition file's bytes.
//!
//! Seam owner: `index` (#15). Contract:
//! `openspec/changes/query-while-scanning/contract.md`.
//!
//! Every derived structure (time index, ID locator, watch state) records the
//! generation it was built from and checks it before use. A stale generation
//! must lead to a correct rebuild or a full scan, never to a wrong answer.
//! Size and mtime alone are not enough: `index` combines `FileStat` with a
//! checked read (for example a hash of the bytes the structure covers) where
//! the host gives no `change_id`.

use crate::host::StorageHost;
use proseql_engine::errors::EngineError;
use proseql_engine::scan::unimplemented_seam;

/// What a structure built from a file knows about the bytes it covered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceGeneration {
    pub path: String,
    /// Bytes covered (a prefix of the file for append-only sources).
    pub covered_len: u64,
    pub modified_ns: Option<u128>,
    pub change_id: Option<u64>,
    /// Hash of the covered bytes, or of a checked suffix of them, when the
    /// host has no `change_id`. The exact scheme belongs to `index`.
    pub check_hash: Option<u64>,
}

/// The result of checking a generation against the disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GenerationCheck {
    /// Same bytes as when the structure was built.
    Unchanged,
    /// The covered prefix is unchanged and the file grew: rows from
    /// `from_offset` are new (append-only fast path).
    Appended { from_offset: u64 },
    /// The covered bytes changed or the file was replaced: rebuild.
    Replaced,
    /// The file is gone.
    Missing,
}

impl SourceGeneration {
    /// Observe a file now. `Ok(None)` when it is missing.
    pub fn observe(_host: &dyn StorageHost, _path: &str) -> Result<Option<Self>, EngineError> {
        Err(unimplemented_seam("SourceGeneration::observe"))
    }

    /// Compare with the disk.
    pub fn check(&self, _host: &dyn StorageHost) -> Result<GenerationCheck, EngineError> {
        Err(unimplemented_seam("SourceGeneration::check"))
    }
}
