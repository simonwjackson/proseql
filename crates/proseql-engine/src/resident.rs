//! Resident records: a host-managed subset of a collection's stored records.
//!
//! The engine assumes that a collection holds every record a query can match.
//! Native lazy partitions keep that assumption at the runtime layer: before an
//! operation runs, the runtime makes every partition the operation can touch
//! resident, so the engine sees all records that can match. These methods move
//! stored records in and out of a collection without a mutation. They run no
//! hooks and no foreign-key checks; callers must only use them for
//! collections without relationships, unique fields or computed fields.

use serde_json::Value;

use crate::errors::EngineError;
use crate::reactive::ChangeOperation;
use crate::relationships::helpers::col_nf;
use crate::relationships::Database;

impl Database {
    /// Load stored records into `collection` (see
    /// [`crate::collection::Collection::load_resident_records`]). With
    /// `publish`, watches and change subscribers see the records as an update
    /// of the collection; without it nothing is published.
    pub fn load_resident_records(
        &mut self,
        collection: &str,
        records: Vec<Value>,
        position: Option<usize>,
        publish: bool,
    ) -> Result<usize, EngineError> {
        let loaded = self
            .collections
            .get_mut(collection)
            .ok_or_else(|| col_nf(collection))?
            .load_resident_records(records, position, publish)?;
        if publish && loaded > 0 {
            self.sync_reactive_snapshots();
            self.emit_owner_change_event(collection, ChangeOperation::Update);
        }
        Ok(loaded)
    }

    /// Drop resident records from `collection` (see
    /// [`crate::collection::Collection::unload_resident_records`]).
    pub fn unload_resident_records(
        &mut self,
        collection: &str,
        ids: &[String],
        publish: bool,
    ) -> Result<usize, EngineError> {
        let removed = self
            .collections
            .get_mut(collection)
            .ok_or_else(|| col_nf(collection))?
            .unload_resident_records(ids, publish);
        if publish && removed > 0 {
            self.sync_reactive_snapshots();
            self.emit_owner_change_event(collection, ChangeOperation::Update);
        }
        Ok(removed)
    }

    /// Replace the snapshot that live watches evaluate for `collection` with
    /// the current resident state, so records dropped without publishing are
    /// not retained by the watch machinery. Publishes nothing.
    pub fn refresh_reactive_snapshot(&self, collection: &str) -> Result<(), EngineError> {
        let current = self
            .collections
            .get(collection)
            .ok_or_else(|| col_nf(collection))?;
        self.reactive
            .refresh_collection_snapshot(collection, current);
        Ok(())
    }
}
