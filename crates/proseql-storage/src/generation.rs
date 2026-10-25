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
    /// Checked prefix evidence for hosts without a trustworthy identity.
    /// Identity-aware hosts conservatively replace on token changes.
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
    fn from_stat(path: &str, stat: FileStat, hash: Option<u64>) -> Self {
        Self {
            path: path.into(),
            covered_len: stat.len,
            modified_ns: stat.modified_ns,
            change_id: stat.change_id,
            check_hash: hash,
        }
    }

    pub fn observe(host: &dyn StorageHost, path: &str) -> Result<Option<Self>, EngineError> {
        let Some(stat) = host.stat(path)? else {
            return Ok(None);
        };
        if stat.change_id.is_some() {
            return Ok(Some(Self::from_stat(path, stat, None)));
        }
        let hash = hash_range(host, path, 0, stat.len, DefaultHasher::new())?.finish();
        if host.stat(path)? != Some(stat) {
            return Err(changed(path));
        }
        Ok(Some(Self::from_stat(path, stat, Some(hash))))
    }

    pub fn check(&self, host: &dyn StorageHost) -> Result<GenerationCheck, EngineError> {
        if self.change_id.is_some() {
            return Ok(match host.stat(&self.path)? {
                None => GenerationCheck::Missing,
                Some(stat) if self.matches_stat(stat) => GenerationCheck::Unchanged,
                Some(_) => GenerationCheck::Replaced,
            });
        }
        self.advance(host).map(|(check, _)| check)
    }

    fn matches_stat(&self, stat: FileStat) -> bool {
        stat.len == self.covered_len
            && stat.modified_ns == self.modified_ns
            && stat.change_id == self.change_id
    }

    /// Capture the next generation under the same observation. Trustworthy
    /// tokens avoid content reads; a changed token means replacement, not a
    /// proven append. Tokenless hosts check the prefix and metadata together:
    /// separate check/observe calls could otherwise publish stale offsets.
    pub fn advance(
        &self,
        host: &dyn StorageHost,
    ) -> Result<(GenerationCheck, Option<Self>), EngineError> {
        let Some(stat) = host.stat(&self.path)? else {
            return Ok((GenerationCheck::Missing, None));
        };
        if self.change_id.is_some() || stat.change_id.is_some() {
            let check = if self.matches_stat(stat) {
                GenerationCheck::Unchanged
            } else {
                GenerationCheck::Replaced
            };
            return Ok((check, Some(Self::from_stat(&self.path, stat, None))));
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
        Ok((check, Some(Self::from_stat(&self.path, stat, Some(hash)))))
    }
}
