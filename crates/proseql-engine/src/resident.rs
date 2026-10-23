//! Resident records: a host-managed subset of a collection's stored records.
//!
//! The engine assumes that a collection holds every record a query can match.
//! Native lazy partitions keep that assumption at the runtime layer: before an
//! operation runs, the runtime makes every partition the operation can touch
//! resident, so the engine sees all records that can match. These methods move
//! stored records in and out of a collection without a mutation. They run no
//! hooks and no foreign-key checks; callers must only use them for
//! collections without relationships, unique fields or computed fields.
//!
//! Moving records is never a mutation, also inside an owned transaction: the
//! records are already stored, so they must not enter the transaction journal
//! (which plans writes and rollback) or the committed-change delta. When the
//! host publishes a move, it goes straight to the reactive snapshots, which
//! hold the committed view, and to change subscribers.

use serde_json::Value;

use crate::change_set::{ChangeSet, EntityChange};
use crate::errors::EngineError;
use crate::reactive::{ChangeEvent, ChangeOperation};
use crate::relationships::helpers::col_nf;
use crate::relationships::Database;

impl Database {
    /// Load stored records into `collection` (see
    /// [`crate::collection::Collection::load_resident_records`]). With
    /// `publish`, watches and change subscribers see the records as an update
    /// of the collection; without it nothing is published. Either way the
    /// records stay out of the transaction journal, so a rollback keeps them
    /// and a commit does not write them.
    pub fn load_resident_records(
        &mut self,
        collection: &str,
        records: Vec<Value>,
        position: Option<usize>,
        publish: bool,
    ) -> Result<usize, EngineError> {
        let (loaded, changes) = self
            .collections
            .get_mut(collection)
            .ok_or_else(|| col_nf(collection))?
            .load_resident_records(records, position, publish)?;
        if publish && loaded > 0 {
            self.publish_resident_move(collection, changes);
        }
        Ok(loaded)
    }

    /// Validate a transient canonical Value block with exactly the resident
    /// loader's schema/callback/ID checks, without storing it or building indexes.
    pub fn validate_resident_records(
        &self,
        collection: &str,
        records: &[Value],
    ) -> Result<(), EngineError> {
        self.collections
            .get(collection)
            .ok_or_else(|| col_nf(collection))?
            .validate_resident_block(records)
    }

    /// Atomically validate an incoming block, silently evict `removing`, then
    /// insert before a surviving ID (or append). Outgoing IDs still participate
    /// in duplicate checks. An error leaves every accepted record unchanged.
    /// Hosts must never evict records that a live watch can match.
    pub fn replace_resident_records(
        &mut self,
        collection: &str,
        records: Vec<Value>,
        removing: &[String],
        before_id: Option<&str>,
        publish: bool,
    ) -> Result<usize, EngineError> {
        let (loaded, changes) = self
            .collections
            .get_mut(collection)
            .ok_or_else(|| col_nf(collection))?
            .replace_resident_records(records, removing, before_id, publish)?;
        if publish && loaded > 0 {
            self.publish_resident_move(collection, changes);
        }
        Ok(loaded)
    }

    /// Drop resident records from `collection` (see
    /// [`crate::collection::Collection::unload_resident_records`]), with the
    /// same journal and publication rules as [`Self::load_resident_records`].
    pub fn unload_resident_records(
        &mut self,
        collection: &str,
        ids: &[String],
        publish: bool,
    ) -> Result<usize, EngineError> {
        let (removed, changes) = self
            .collections
            .get_mut(collection)
            .ok_or_else(|| col_nf(collection))?
            .unload_resident_records(ids, publish);
        if publish && removed > 0 {
            self.publish_resident_move(collection, changes);
        }
        Ok(removed)
    }

    /// Show moved stored records to watches: apply them to the committed
    /// reactive snapshot and notify. Inside an owned transaction the snapshot
    /// still excludes the transaction's own changes, so watches see stored
    /// records only, never uncommitted ones.
    fn publish_resident_move(&self, collection: &str, changes: Vec<EntityChange>) {
        let mut set = ChangeSet::default();
        for change in changes {
            set.record(change);
        }
        self.reactive.apply_changes(&set);
        self.reactive.publish(ChangeEvent {
            collection: collection.to_owned(),
            operation: ChangeOperation::Update,
        });
    }

    /// Drop snapshot records that no host-managed watch scope needs. Unlike
    /// refresh, this does not clone resident records into another full snapshot.
    /// Hosts must include every ID that any live watch can match.
    pub fn retain_reactive_snapshot_records(
        &self,
        collection: &str,
        ids: &std::collections::HashSet<&str>,
    ) -> Result<(), EngineError> {
        if !self.collections.contains_key(collection) {
            return Err(col_nf(collection));
        }
        self.reactive
            .retain_collection_snapshot_records(collection, ids);
        Ok(())
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
