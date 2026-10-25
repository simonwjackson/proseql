//! Checked identities for derived, in-memory indexes over text files.

use crate::host::{FileStat, StorageHost};
use proseql_engine::errors::{EngineError, OperationError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceGeneration {
    pub path: String,
    pub covered_len: u64,
    pub modified_ns: Option<u128>,
    pub change_id: Option<u64>,
    /// Hash of the entire covered prefix, also retained on identity-aware hosts
    /// so that growth can be proved to be append-only.
    pub check_hash: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GenerationCheck {
    Unchanged,
    Appended { from_offset: u64 },
    Replaced,
    Missing,
}

pub(crate) fn changed(path: &str) -> EngineError {
    EngineError::Operation(OperationError {
        operation: "read".into(),
        reason: "source-changed".into(),
        message: format!("Source '{path}' changed while building its index; retry the operation"),
    })
}

fn hash_prefix(host: &dyn StorageHost, path: &str, len: u64) -> Result<Option<u64>, EngineError> {
    let mut offset = 0;
    let mut hash = 0xcbf29ce484222325_u64;
    while offset < len {
        let bytes = host.read_range(path, offset, (len - offset).min(64 * 1024) as usize)?;
        if bytes.is_empty() || bytes.len() as u64 > len - offset {
            return Ok(None);
        }
        offset += bytes.len() as u64;
        for byte in bytes {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    Ok(Some(hash))
}

impl SourceGeneration {
    pub fn observe(host: &dyn StorageHost, path: &str) -> Result<Option<Self>, EngineError> {
        let Some(stat) = host.stat(path)? else {
            return Ok(None);
        };
        let hash = hash_prefix(host, path, stat.len)?;
        if hash.is_none() || host.stat(path)? != Some(stat) {
            return Err(changed(path));
        }
        Ok(Some(Self {
            path: path.into(),
            covered_len: stat.len,
            modified_ns: stat.modified_ns,
            change_id: stat.change_id,
            check_hash: hash,
        }))
    }

    pub fn check(&self, host: &dyn StorageHost) -> Result<GenerationCheck, EngineError> {
        let Some(stat) = host.stat(&self.path)? else {
            return Ok(GenerationCheck::Missing);
        };
        let previous = FileStat {
            len: self.covered_len,
            modified_ns: self.modified_ns,
            change_id: self.change_id,
        };
        if stat == previous && stat.change_id.is_some() {
            return Ok(GenerationCheck::Unchanged);
        }
        if stat.len < self.covered_len {
            return Ok(GenerationCheck::Replaced);
        }
        let hash = hash_prefix(host, &self.path, self.covered_len)?;
        if host.stat(&self.path)? != Some(stat) {
            return Err(changed(&self.path));
        }
        if hash.is_none() || hash != self.check_hash {
            return Ok(GenerationCheck::Replaced);
        }
        Ok(if stat.len > self.covered_len {
            GenerationCheck::Appended {
                from_offset: self.covered_len,
            }
        } else {
            GenerationCheck::Unchanged
        })
    }
}
