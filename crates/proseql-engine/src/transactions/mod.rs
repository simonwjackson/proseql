use indexmap::{IndexMap, IndexSet};
use serde_json::Value;

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

pub struct TransactionContext<'a> {
    db: &'a mut Database,
    snapshots: IndexMap<String, IndexMap<String, Value>>,
    mutated_collections: IndexSet<String>,
    persistence: Option<&'a dyn TransactionPersistenceHook>,
    active: bool,
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

impl Database {
    pub fn begin_transaction<'a>(
        &'a mut self,
        persistence: Option<&'a dyn TransactionPersistenceHook>,
    ) -> Result<TransactionContext<'a>, EngineError> {
        if self.active_transaction_kind != ActiveTransactionKind::None {
            return Err(tx_error(
                TransactionOperation::Begin,
                "another transaction is already active",
                "Cannot begin transaction: another transaction is already active",
            ));
        }
        self.active_transaction_kind = ActiveTransactionKind::Manual;
        Ok(TransactionContext {
            snapshots: self.snapshot_all_collection_states(),
            db: self,
            mutated_collections: IndexSet::new(),
            persistence,
            active: true,
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
        self.active_transaction_kind = ActiveTransactionKind::Callback;
        let snapshots = self.snapshot_all_collection_states();
        let mut ctx = TransactionContext {
            db: self,
            snapshots,
            mutated_collections: IndexSet::new(),
            persistence,
            active: true,
        };
        match f(&mut ctx) {
            Ok(value) => {
                ctx.commit()?;
                Ok(value)
            }
            Err(error) => {
                if ctx.active {
                    let _ = ctx.rollback();
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

    pub(crate) fn with_reactive_events_suppressed<R>(
        &mut self,
        f: impl FnOnce(&mut Database) -> Result<R, EngineError>,
    ) -> Result<R, EngineError> {
        self.reactive_event_suppression_depth =
            self.reactive_event_suppression_depth.saturating_add(1);
        let result = f(self);
        self.reactive_event_suppression_depth =
            self.reactive_event_suppression_depth.saturating_sub(1);
        result
    }
}

impl<'a> TransactionContext<'a> {
    fn ensure_active(&self, action: &str) -> Result<(), EngineError> {
        if self.active {
            Ok(())
        } else {
            Err(tx_error(
                match action {
                    "commit" => TransactionOperation::Commit,
                    "rollback" => TransactionOperation::Rollback,
                    _ => TransactionOperation::Begin,
                },
                "transaction is no longer active",
                format!("Cannot {}: transaction is no longer active", action),
            ))
        }
    }

    fn track_mutations_from(&mut self, before: &IndexMap<String, IndexMap<String, Value>>) {
        for (collection, snapshot) in before {
            let changed = self
                .db
                .collections
                .get(collection)
                .map(|current| current.snapshot_state() != *snapshot)
                .unwrap_or(false);
            if changed {
                self.mutated_collections.insert(collection.clone());
            }
        }
    }

    fn run_mutation<R>(
        &mut self,
        f: impl FnOnce(&mut Database) -> Result<R, EngineError>,
    ) -> Result<R, EngineError> {
        self.ensure_active("perform operation")?;
        let before = self.db.snapshot_all_collection_states();
        let result = self.db.with_reactive_events_suppressed(f);
        self.track_mutations_from(&before);
        result
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
        self.active = false;
        self.db.active_transaction_kind = ActiveTransactionKind::None;
        self.db.sync_reactive_snapshots();
        if let Some(persistence) = self.persistence {
            for collection in &self.mutated_collections {
                persistence.schedule(collection);
            }
        }
        for collection in &self.mutated_collections {
            self.db
                .emit_owner_change_event(collection, crate::reactive::ChangeOperation::Update);
        }
        Ok(())
    }

    pub fn rollback(&mut self) -> Result<(), EngineError> {
        self.ensure_active("rollback")?;
        self.db.restore_all_collection_states(&self.snapshots);
        self.db.sync_reactive_snapshots();
        self.active = false;
        self.db.active_transaction_kind = ActiveTransactionKind::None;
        Err(tx_error(
            TransactionOperation::Rollback,
            "transaction rolled back",
            "Transaction rolled back",
        ))
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn mutated_collections(&self) -> &IndexSet<String> {
        &self.mutated_collections
    }
}
