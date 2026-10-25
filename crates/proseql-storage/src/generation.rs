//! Checked identities for derived, in-memory indexes over text files.

use crate::host::{FileStat, StorageHost};
use proseql_engine::errors::{EngineError, OperationError};
use std::collections::hash_map::DefaultHasher;
use std::hash::Hasher;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceGeneration {
    pub path: String,
    pub covered_len: u64,
    pub modified_ns: Option<u128>,
    pub change_id: Option<u64>,
    /// Full-prefix hash, including on identity-aware hosts: metadata alone
    /// cannot prove that growth did not also edit the covered prefix.
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

fn hash_range(
    host: &dyn StorageHost,
    path: &str,
    start: u64,
    end: u64,
    mut hash: DefaultHasher,
) -> Result<DefaultHasher, EngineError> {
    let mut offset = start;
    while offset < end {
        let bytes = host.read_range(path, offset, (end - offset).min(64 * 1024) as usize)?;
        if bytes.is_empty() || bytes.len() as u64 > end - offset {
            return Err(changed(path));
        }
        offset += bytes.len() as u64;
        hash.write(&bytes);
    }
    Ok(hash)
}

impl SourceGeneration {
    fn from_stat(path: &str, stat: FileStat, hash: u64) -> Self {
        Self {
            path: path.into(),
            covered_len: stat.len,
            modified_ns: stat.modified_ns,
            change_id: stat.change_id,
            check_hash: Some(hash),
        }
    }

    pub fn observe(host: &dyn StorageHost, path: &str) -> Result<Option<Self>, EngineError> {
        let Some(stat) = host.stat(path)? else {
            return Ok(None);
        };
        let hash = hash_range(host, path, 0, stat.len, DefaultHasher::new())?.finish();
        if host.stat(path)? != Some(stat) {
            return Err(changed(path));
        }
        Ok(Some(Self::from_stat(path, stat, hash)))
    }

    pub fn check(&self, host: &dyn StorageHost) -> Result<GenerationCheck, EngineError> {
        self.advance(host).map(|(check, _)| check)
    }

    /// Check the prefix and capture the next generation under the *same*
    /// metadata observation. Separating check and observe could otherwise
    /// accept a prefix edit between the two and publish stale offsets.
    pub fn advance(
        &self,
        host: &dyn StorageHost,
    ) -> Result<(GenerationCheck, Option<Self>), EngineError> {
        let Some(stat) = host.stat(&self.path)? else {
            return Ok((GenerationCheck::Missing, None));
        };
        let previous = FileStat {
            len: self.covered_len,
            modified_ns: self.modified_ns,
            change_id: self.change_id,
        };
        if stat == previous && stat.change_id.is_some() {
            return Ok((GenerationCheck::Unchanged, Some(self.clone())));
        }
        let prefix_len = self.covered_len.min(stat.len);
        let prefix = hash_range(host, &self.path, 0, prefix_len, DefaultHasher::new())?;
        let prefix_hash = prefix.finish();
        let hash = hash_range(host, &self.path, prefix_len, stat.len, prefix)?.finish();
        if host.stat(&self.path)? != Some(stat) {
            return Err(changed(&self.path));
        }
        let check = if stat.len < self.covered_len || Some(prefix_hash) != self.check_hash {
            GenerationCheck::Replaced
        } else if stat.len > self.covered_len {
            GenerationCheck::Appended {
                from_offset: self.covered_len,
            }
        } else {
            GenerationCheck::Unchanged
        };
        Ok((check, Some(Self::from_stat(&self.path, stat, hash))))
    }
}
