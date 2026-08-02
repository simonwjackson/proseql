use std::io::{self, Write};

use indexmap::{IndexMap, IndexSet};
use serde_json::Value;

use crate::change_set::ChangeSet;
use crate::collection::{
    CreateManyResult, DeleteManyResult, UpdateManyResult, UpsertManyResult, UpsertOutcome,
};
use crate::errors::{EngineError, TransactionError, TransactionOperation};
use crate::query::{CursorConfig, CursorPageResult, QueryInput};
use crate::relationships::{
    Database, DeleteManyWithRelResult, DeleteRelationshipsOptions, DeleteWithRelResult,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveTransactionKind {
    None,
    Manual,
    Callback,
}

pub trait TransactionPersistenceHook: Send + Sync {
    fn schedule(&self, collection: &str);
}

/// Owned transaction state that can live across host/JavaScript turns.
///
/// It contains only entity-granular reversible deltas and collection revisions;
/// it never owns or clones the database or any full collection snapshot.
#[derive(Debug)]
pub struct OwnedTransactionSession {
    journal: ChangeSet,
    touched_collections: IndexSet<String>,
    revisions_before: IndexMap<String, u64>,
    prior_changes: ChangeSet,
    journal_entries: usize,
    journal_bytes: usize,
    active: bool,
}

#[derive(Debug)]
pub struct CommittedTransaction {
    pub touched_collections: IndexSet<String>,
    pub journal_entries: usize,
    pub journal_bytes: usize,
}

pub struct TransactionContext<'a> {
    db: &'a mut Database,
    session: OwnedTransactionSession,
    persistence: Option<&'a dyn TransactionPersistenceHook>,
}

fn tx_error(
    operation: TransactionOperation,
    reason: &str,
    message: impl Into<String>,
) -> EngineError {
    EngineError::Transaction(TransactionError {
        operation,
        reason: reason.to_owned(),
        message: message.into(),
    })
}

#[derive(Default)]
struct CountingWriter(usize);

impl Write for CountingWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl OwnedTransactionSession {
    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn journal_entry_count(&self) -> usize {
        self.journal_entries
    }

    pub fn journal_bytes(&self) -> usize {
        self.journal_bytes
    }

    pub fn touched_collections(&self) -> &IndexSet<String> {
        &self.touched_collections
    }

    fn ensure_active(&self, action: &str) -> Result<(), EngineError> {
        if self.active {
            return Ok(());
        }
        Err(tx_error(
            match action {
                "commit" => TransactionOperation::Commit,
                "rollback" => TransactionOperation::Rollback,
                _ => TransactionOperation::Begin,
            },
            "transaction is no longer active",
            format!("Cannot {action}: transaction is no longer active"),
        ))
    }

    pub fn absorb_changes(&mut self, changes: ChangeSet) {
        self.journal_entries = self.journal_entries.saturating_add(changes.len());
        let mut counter = CountingWriter::default();
        let encoded_bytes = serde_json::to_writer(&mut counter, &changes).map_or(0, |()| counter.0);
        self.journal_bytes = self.journal_bytes.saturating_add(encoded_bytes);
        for change in changes.entities() {
            self.touched_collections.insert(change.collection.clone());
        }
        self.journal.extend(changes);
    }
}

impl Database {
    fn open_owned_transaction(
        &mut self,
        kind: ActiveTransactionKind,
        active_reason: &str,
    ) -> Result<OwnedTransactionSession, EngineError> {
        if self.active_transaction_kind != ActiveTransactionKind::None {
            return Err(tx_error(
                TransactionOperation::Begin,
                active_reason,
                format!("Cannot begin transaction: {active_reason}"),
            ));
        }
        // Preserve deltas completed before the session while isolating every
        // subsequent low-level mutation in the owned journal.
        let prior_changes = self.take_committed_changes();
        let revisions_before = self
            .collections
            .iter()
            .map(|(name, collection)| (name.clone(), collection.revision()))
            .collect();
        self.active_transaction_kind = kind;
        self.reactive_event_suppression_depth =
            self.reactive_event_suppression_depth.saturating_add(1);
        Ok(OwnedTransactionSession {
            journal: ChangeSet::default(),
            touched_collections: IndexSet::new(),
            revisions_before,
            prior_changes,
            journal_entries: 0,
            journal_bytes: 0,
            active: true,
        })
    }

    /// Last-resort lifecycle cleanup for a host defect after an owned session
    /// has already been removed from its runtime table. Ordinary failures must
    /// use rollback so state is restored; this only prevents an orphan guard.
    pub fn abandon_owned_transaction_guard(&mut self) {
        self.reactive_event_suppression_depth = 0;
        self.active_transaction_kind = ActiveTransactionKind::None;
        self.committed_changes = ChangeSet::default();
    }

    /// Open an owned transaction session suitable for a stateful host runtime.
    pub fn begin_owned_transaction(&mut self) -> Result<OwnedTransactionSession, EngineError> {
        self.open_owned_transaction(
            ActiveTransactionKind::Manual,
            "another transaction is already active",
        )
    }

    /// Execute one read or mutation against an active owned session. Successful
    /// and failed operations both drain documented partial artifacts into the
    /// reversible journal.
    pub fn transaction_step<R>(
        &mut self,
        session: &mut OwnedTransactionSession,
        f: impl FnOnce(&mut Database) -> Result<R, EngineError>,
    ) -> Result<R, EngineError> {
        session.ensure_active("perform operation")?;
        let result = f(self);
        let changes = self.take_committed_changes();
        session.absorb_changes(changes);
        result
    }

    pub fn commit_owned_transaction(
        &mut self,
        mut session: OwnedTransactionSession,
    ) -> Result<CommittedTransaction, EngineError> {
        session.ensure_active("commit")?;
        let trailing = self.take_committed_changes();
        session.absorb_changes(trailing);
        let journal_entries = session.journal_entry_count();
        let journal_bytes = session.journal_bytes();
        for change in session.journal.entities_mut() {
            change.after_position = change.after.as_ref().and_then(|_| {
                self.collections
                    .get(&change.collection)
                    .and_then(|collection| collection.entity_position(&change.id))
            });
        }
        let changes = std::mem::take(&mut session.journal);
        let touched_collections = std::mem::take(&mut session.touched_collections);

        // Reactive snapshots stayed at the pre-transaction state while the
        // session was active. Publish the journal's net effect once, atomically,
        // before delivering the collection-level commit events.
        self.reactive.apply_changes(&changes);
        self.committed_changes.extend(session.prior_changes);
        self.committed_changes.extend(changes);
        self.reactive_event_suppression_depth =
            self.reactive_event_suppression_depth.saturating_sub(1);
        self.active_transaction_kind = ActiveTransactionKind::None;
        session.active = false;
        for collection in &touched_collections {
            self.emit_owner_change_event(collection, crate::reactive::ChangeOperation::Update);
        }
        Ok(CommittedTransaction {
            touched_collections,
            journal_entries,
            journal_bytes,
        })
    }

    pub fn rollback_owned_transaction(
        &mut self,
        mut session: OwnedTransactionSession,
    ) -> Result<(), EngineError> {
        session.ensure_active("rollback")?;
        let trailing = self.take_committed_changes();
        session.absorb_changes(trailing);

        let mut entries = std::mem::take(&mut session.journal)
            .into_entities()
            .collect::<Vec<_>>();
        entries.reverse();
        let mut by_collection = IndexMap::<String, Vec<crate::change_set::EntityChange>>::new();
        for change in entries {
            by_collection
                .entry(change.collection.clone())
                .or_default()
                .push(change);
        }
        // Every touched collection is restored as one batch and rebuilds its
        // derived indexes exactly once. This includes net-zero journals: direct
        // materialized-row synchronization deliberately bypasses indexes and can
        // compact the entity delta away while leaving stale postings behind.
        for collection in &session.touched_collections {
            let changes = by_collection.shift_remove(collection).unwrap_or_default();
            if let Some(current) = self.collections.get_mut(collection) {
                current.rollback_entity_changes(&changes);
            }
        }
        debug_assert!(by_collection.is_empty());
        // Reactive snapshots were never advanced, and batch rollback writes no
        // ordinary deltas, so no inverse reactive application is needed.
        self.committed_changes = ChangeSet::default();
        for (collection, revision) in &session.revisions_before {
            if let Some(current) = self.collections.get_mut(collection) {
                current.restore_revision(*revision);
            }
        }
        self.committed_changes.extend(session.prior_changes);
        self.reactive_event_suppression_depth =
            self.reactive_event_suppression_depth.saturating_sub(1);
        self.active_transaction_kind = ActiveTransactionKind::None;
        session.active = false;
        Ok(())
    }

    pub fn begin_transaction<'a>(
        &'a mut self,
        persistence: Option<&'a dyn TransactionPersistenceHook>,
    ) -> Result<TransactionContext<'a>, EngineError> {
        let session = self.begin_owned_transaction()?;
        Ok(TransactionContext {
            db: self,
            session,
            persistence,
        })
    }

    pub fn transaction<A, F>(
        &mut self,
        persistence: Option<&dyn TransactionPersistenceHook>,
        f: F,
    ) -> Result<A, EngineError>
    where
        F: FnOnce(&mut TransactionContext<'_>) -> Result<A, EngineError>,
    {
        if self.active_transaction_kind != ActiveTransactionKind::None {
            return Err(tx_error(
                TransactionOperation::Begin,
                "nested transactions not supported",
                "Cannot begin transaction: nested transactions not supported",
            ));
        }
        let session = self.open_owned_transaction(
            ActiveTransactionKind::Callback,
            "nested transactions not supported",
        )?;
        let mut ctx = TransactionContext {
            db: self,
            session,
            persistence,
        };
        match f(&mut ctx) {
            Ok(value) => {
                ctx.commit()?;
                Ok(value)
            }
            Err(error) => {
                if ctx.is_active() {
                    let _ = ctx.rollback_internal();
                }
                Err(error)
            }
        }
    }

    pub(crate) fn snapshot_all_collection_states(
        &self,
    ) -> IndexMap<String, IndexMap<String, Value>> {
        self.collections
            .iter()
            .map(|(name, collection)| (name.clone(), collection.snapshot_state()))
            .collect()
    }

    pub(crate) fn restore_all_collection_states(
        &mut self,
        snapshots: &IndexMap<String, IndexMap<String, Value>>,
    ) {
        for (collection, snapshot) in snapshots {
            if let Some(current) = self.collections.get_mut(collection) {
                current.restore_state(snapshot.clone());
            }
        }
    }
}

impl<'a> TransactionContext<'a> {
    fn ensure_active(&self, action: &str) -> Result<(), EngineError> {
        self.session.ensure_active(action)
    }

    fn run_mutation<R>(
        &mut self,
        f: impl FnOnce(&mut Database) -> Result<R, EngineError>,
    ) -> Result<R, EngineError> {
        self.ensure_active("perform operation")?;
        self.db.transaction_step(&mut self.session, f)
    }

    pub fn transaction<A, F>(
        &mut self,
        _persistence: Option<&dyn TransactionPersistenceHook>,
        _f: F,
    ) -> Result<A, EngineError>
    where
        F: FnOnce(&mut TransactionContext<'_>) -> Result<A, EngineError>,
    {
        self.ensure_active("begin transaction")?;
        Err(tx_error(
            TransactionOperation::Begin,
            "nested transactions not supported",
            "Cannot begin transaction: nested transactions not supported",
        ))
    }

    pub fn begin_transaction(
        &mut self,
        _persistence: Option<&dyn TransactionPersistenceHook>,
    ) -> Result<(), EngineError> {
        self.ensure_active("begin transaction")?;
        Err(tx_error(
            TransactionOperation::Begin,
            "another transaction is already active",
            "Cannot begin transaction: another transaction is already active",
        ))
    }

    pub fn query(
        &self,
        collection: &str,
        input: QueryInput,
        populate: Option<Value>,
    ) -> Result<Vec<Value>, EngineError> {
        self.ensure_active("perform operation")?;
        self.db.query(collection, input, populate)
    }

    pub fn query_cursor(
        &self,
        collection: &str,
        input: &QueryInput,
        cursor: &CursorConfig,
        populate: Option<Value>,
    ) -> Result<CursorPageResult, EngineError> {
        self.ensure_active("perform operation")?;
        self.db.query_cursor(collection, input, cursor, populate)
    }

    pub fn find_by_id(&self, collection: &str, id: &str) -> Result<Option<Value>, EngineError> {
        self.ensure_active("perform operation")?;
        Ok(self
            .db
            .collection(collection)
            .ok_or_else(|| crate::relationships::helpers::col_nf(collection))?
            .get(id)
            .cloned())
    }

    pub fn create(&mut self, collection: &str, data: Value) -> Result<Value, EngineError> {
        self.run_mutation(|db| db.create(collection, data))
    }
    pub fn create_many(
        &mut self,
        collection: &str,
        inputs: Vec<Value>,
        skip_duplicates: bool,
    ) -> Result<CreateManyResult, EngineError> {
        self.run_mutation(|db| db.create_many(collection, inputs, skip_duplicates))
    }
    pub fn update(
        &mut self,
        collection: &str,
        id: &str,
        updates: Value,
    ) -> Result<Value, EngineError> {
        self.run_mutation(|db| db.update(collection, id, updates))
    }
    pub fn update_many(
        &mut self,
        collection: &str,
        where_clause: Value,
        updates: Value,
    ) -> Result<UpdateManyResult, EngineError> {
        self.run_mutation(|db| db.update_many(collection, where_clause, updates))
    }
    pub fn delete(&mut self, collection: &str, id: &str) -> Result<Value, EngineError> {
        self.run_mutation(|db| db.delete(collection, id))
    }
    pub fn delete_many(
        &mut self,
        collection: &str,
        where_clause: Value,
        soft: bool,
        limit: Option<usize>,
    ) -> Result<DeleteManyResult, EngineError> {
        self.run_mutation(|db| db.delete_many(collection, where_clause, soft, limit))
    }
    pub fn upsert(
        &mut self,
        collection: &str,
        where_clause: Value,
        create_data: Value,
        update_data: Value,
    ) -> Result<UpsertOutcome, EngineError> {
        self.run_mutation(|db| db.upsert(collection, where_clause, create_data, update_data))
    }
    pub fn upsert_many(
        &mut self,
        collection: &str,
        inputs: Vec<(Value, Value, Value)>,
    ) -> Result<UpsertManyResult, EngineError> {
        self.run_mutation(|db| db.upsert_many(collection, inputs))
    }
    pub fn create_with_relationships(
        &mut self,
        collection: &str,
        data: Value,
    ) -> Result<Value, EngineError> {
        self.run_mutation(|db| db.create_with_relationships(collection, data))
    }
    pub fn update_with_relationships(
        &mut self,
        collection: &str,
        id: &str,
        updates: Value,
    ) -> Result<Value, EngineError> {
        self.run_mutation(|db| db.update_with_relationships(collection, id, updates))
    }
    pub fn delete_with_relationships(
        &mut self,
        collection: &str,
        id: &str,
        options: DeleteRelationshipsOptions,
    ) -> Result<DeleteWithRelResult, EngineError> {
        self.run_mutation(|db| db.delete_with_relationships(collection, id, options))
    }
    pub fn delete_many_with_relationships(
        &mut self,
        collection: &str,
        predicate: &dyn Fn(&Value) -> bool,
        options: DeleteRelationshipsOptions,
    ) -> Result<DeleteManyWithRelResult, EngineError> {
        self.run_mutation(|db| db.delete_many_with_relationships(collection, predicate, options))
    }

    pub fn commit(&mut self) -> Result<(), EngineError> {
        self.ensure_active("commit")?;
        let placeholder = OwnedTransactionSession {
            journal: ChangeSet::default(),
            touched_collections: IndexSet::new(),
            revisions_before: IndexMap::new(),
            prior_changes: ChangeSet::default(),
            journal_entries: 0,
            journal_bytes: 0,
            active: false,
        };
        let session = std::mem::replace(&mut self.session, placeholder);
        let committed = self.db.commit_owned_transaction(session)?;
        if let Some(persistence) = self.persistence {
            for collection in &committed.touched_collections {
                persistence.schedule(collection);
            }
        }
        Ok(())
    }

    fn rollback_internal(&mut self) -> Result<(), EngineError> {
        self.ensure_active("rollback")?;
        let placeholder = OwnedTransactionSession {
            journal: ChangeSet::default(),
            touched_collections: IndexSet::new(),
            revisions_before: IndexMap::new(),
            prior_changes: ChangeSet::default(),
            journal_entries: 0,
            journal_bytes: 0,
            active: false,
        };
        let session = std::mem::replace(&mut self.session, placeholder);
        self.db.rollback_owned_transaction(session)
    }

    pub fn rollback(&mut self) -> Result<(), EngineError> {
        self.rollback_internal()?;
        Err(tx_error(
            TransactionOperation::Rollback,
            "transaction rolled back",
            "Transaction rolled back",
        ))
    }

    pub fn is_active(&self) -> bool {
        self.session.is_active()
    }
    pub fn mutated_collections(&self) -> &IndexSet<String> {
        self.session.touched_collections()
    }
    pub fn journal_entry_count(&self) -> usize {
        self.session.journal_entry_count()
    }
    pub fn journal_bytes(&self) -> usize {
        self.session.journal_bytes()
    }
}
