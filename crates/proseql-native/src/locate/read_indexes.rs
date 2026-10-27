//! Request-local derived state. Unchanged committed indexes are borrowed;
//! sidecar loads, refreshes and canonical builds publish only on full success.
use super::{IndexState, SourceGeneration, Store, TimeIndex};
use proseql_engine::errors::EngineError;
use proseql_storage::host::StorageHost;
use std::collections::{BTreeMap, BTreeSet};

type TimeKey = (String, String);
struct PendingTime {
    index: TimeIndex,
    validated: bool,
}
#[derive(Default)]
pub(crate) struct ReadIndexes {
    times: BTreeMap<TimeKey, PendingTime>,
    validated: BTreeMap<String, SourceGeneration>,
    cleared_append_proofs: BTreeSet<String>,
    store: Option<Store>,
}

impl ReadIndexes {
    fn store(&mut self, committed: &IndexState) -> Option<&Store> {
        if self.store.is_none() {
            self.store = committed.store.as_ref().map(Store::fork);
        }
        self.store.as_ref()
    }

    pub(crate) fn checked_validation(
        &mut self,
        committed: &IndexState,
        host: &dyn StorageHost,
        path: &str,
        observed: &SourceGeneration,
    ) -> Result<bool, EngineError> {
        if observed.path != path {
            return Ok(false);
        }
        if self.validated.get(path) == Some(observed)
            || committed.validated.get(path) == Some(observed)
        {
            return Ok(true);
        }
        if let Some(loaded) = self
            .store(committed)
            .and_then(|store| store.load(host, observed, "valid"))
        {
            if loaded.unchanged && loaded.payload.is_empty() {
                self.stage_validation(path, observed.clone());
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub(crate) fn time_index<'a>(
        &'a mut self,
        committed: &'a IndexState,
        host: &dyn StorageHost,
        path: &str,
        field: &str,
        observed: SourceGeneration,
    ) -> Result<Option<&'a TimeIndex>, EngineError> {
        if committed
            .codec
            .as_ref()
            .is_some_and(|codec| !codec.positional)
        {
            return Ok(None);
        }
        let key = (path.to_owned(), field.to_owned());
        if !self.times.contains_key(&key) {
            if let Some(index) = committed.times.get(&key) {
                if index.generation() == Some(&observed) {
                    return Ok(index.seek(None, None).is_some().then_some(index));
                }
                // Only changed indexes need a copy. The committed version and
                // its validation marker remain intact if this request fails.
                let mut next = index.clone();
                let mut validated = false;
                let refreshed = (|| {
                    if let Some(proof) = committed.append_proof(path) {
                        if next.extend_checked_append(
                            host,
                            &proof.before,
                            &proof.after,
                            proof.start,
                        )? {
                            validated = committed.time_validated.get(&key) == Some(&proof.before);
                            return Ok(());
                        }
                    }
                    next.refresh_observed(host, observed)?;
                    if index.generation() != next.generation() {
                        self.cleared_append_proofs.insert(path.into());
                    }
                    Ok::<_, EngineError>(())
                })();
                if let Err(error) = refreshed {
                    self.cleared_append_proofs.insert(path.into());
                    return Err(error);
                }
                self.times.insert(
                    key.clone(),
                    PendingTime {
                        index: next,
                        validated,
                    },
                );
            } else if let Some(index) = self
                .store(committed)
                .and_then(|store| TimeIndex::load(host, store, &observed, field, 32))
            {
                self.times.insert(
                    key.clone(),
                    PendingTime {
                        index,
                        validated: true,
                    },
                );
            }
        }
        Ok(self
            .times
            .get(&key)
            .map(|pending| &pending.index)
            .filter(|index| index.seek(None, None).is_some()))
    }

    pub(crate) fn begin_time_index(
        &self,
        committed: &IndexState,
        path: &str,
        field: &str,
        observed: SourceGeneration,
    ) -> Result<Option<TimeIndex>, EngineError> {
        if self.times.contains_key(&(path.into(), field.into())) {
            return Ok(None);
        }
        committed.begin_time_index(path, field, observed)
    }

    pub(crate) fn stage_time_index(&mut self, path: &str, field: &str, index: TimeIndex) {
        self.times.insert(
            (path.into(), field.into()),
            PendingTime {
                index,
                validated: true,
            },
        );
    }

    pub(crate) fn stage_validation(&mut self, path: &str, generation: SourceGeneration) {
        debug_assert_eq!(path, generation.path);
        self.validated.insert(path.into(), generation);
    }

    /// This is infallible and runs under the runtime lock, after Executor::finish
    /// and all canonical identity/duplicate checks have succeeded.
    pub(crate) fn commit(self, committed: &mut IndexState) {
        if let Some(store) = self.store {
            committed.store = Some(store);
        }
        for path in self.cleared_append_proofs {
            committed.clear_append_proof(&path);
        }
        for (key, pending) in self.times {
            if pending.validated {
                committed.publish_time_index(&key.0, &key.1, pending.index);
            } else {
                committed.time_validated.remove(&key);
                committed.times.insert(key, pending.index);
            }
        }
        for (path, generation) in self.validated {
            committed.record_validation(&path, generation);
        }
    }
}

/// Content snapshot of all mutable IndexState data, including the Store's
/// interior memo. Codec context is immutable and is never touched by a read.
#[cfg(test)]
pub(crate) fn snapshot(committed: &IndexState) -> Vec<u8> {
    let proofs = committed
        .append_proofs
        .iter()
        .map(|(path, proof)| (path, &proof.before, &proof.after, proof.start))
        .collect::<Vec<_>>();
    format!(
        "{:?}",
        (
            &committed.times,
            &committed.time_validated,
            &committed.ids,
            &committed.validated,
            proofs,
            &committed.store
        )
    )
    .into_bytes()
}

#[cfg(test)]
pub(crate) fn counts(committed: &IndexState) -> (usize, usize, usize) {
    (
        committed.times.len(),
        committed.time_validated.len(),
        committed.validated.len(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use proseql_storage::memory::MemoryStorageHost;

    #[test]
    fn unchanged_time_index_is_borrowed_without_an_overlay_copy_or_store_fork() {
        let host = MemoryStorageHost::default();
        let path = "parts/one.jsonl";
        host.write(path, "{\"id\":\"a\",\"at\":1}\n{\"id\":\"b\",\"at\":2}\n")
            .unwrap();
        let generation = SourceGeneration::observe(&host, path).unwrap().unwrap();
        let mut committed = IndexState::default();
        committed.publish_time_index(path, "at", TimeIndex::build(&host, path, "at", 32).unwrap());
        let original = &committed.times[&(path.into(), "at".into())];
        let mut attempt = ReadIndexes::default();
        let borrowed = attempt
            .time_index(&committed, &host, path, "at", generation)
            .unwrap()
            .unwrap();
        assert!(std::ptr::eq(original, borrowed));
        assert!(attempt.times.is_empty());
        assert!(attempt.store.is_none());
    }
}
