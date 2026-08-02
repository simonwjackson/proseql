//! In-memory collection state with full CRUD semantics.
//!
//! A [`Collection`] is a named, schema-bound, in-memory store of JSON entities
//! keyed by their `id` field.  It is the U2 building block; higher layers
//! (Database, reactive engine, storage hosts) compose it.
//!
//! # TS references
//! - `packages/core/src/state/collection-state.ts` — `createCollectionState`
//! - `packages/core/src/operations/crud/create.ts` — `create`, `createMany`
//! - `packages/core/src/operations/crud/update.ts` — `update`, `updateMany`
//! - `packages/core/src/operations/crud/delete.ts` — `del`, `deleteMany`
//! - `packages/core/src/operations/crud/upsert.ts` — `upsert`, `upsertMany`
//! - `packages/core/src/operations/crud/unique-check.ts` — constraint checking
//!
//! # Design decisions (U2 scope)
//!
//! - **No foreign key checking** — FK validation requires cross-collection access;
//!   that is a database-level concern (U4).
//! - **No hooks, no reactive events** — lifecycle hooks (U7) and watch (U6) are
//!   composed on top.
//! - **No indexes** — index management (U3) is added on top of the store.
//! - **Insertion-ordered state** — `IndexMap<String, Value>` mirrors JS `Map`
//!   semantics: insertion order is preserved; updates keep position; delete+reinsert
//!   puts the entry at the end.
//! - **Timestamp overwrite** — `create` always overwrites `createdAt`/`updatedAt`
//!   unconditionally, matching TS `const raw = { ...input, id, createdAt: now, updatedAt: now }`.
//! - **OptionalWithDefault** — absent field invokes callback (or fails loudly
//!   if not registered); explicit `null` is schema-validated against the inner type
//!   (null ≠ absent for `OptionalWithDefault`).
//! - **Append-only** — `update`/`updateMany`/`delete`/`deleteMany`/`upsert`/
//!   `upsertMany` fail with `OperationError { reason: "append-only", ... }` matching
//!   the TS factory's `forbiddenOp` shape.
//! - **Computed fields** — field names declared in `descriptor.computed_fields`
//!   are stripped from create/update/upsert inputs before validation, matching
//!   TS `stripComputedFromInput`.
//! - **Soft delete** — inferred from schema: if the top-level struct has an optional
//!   `deletedAt` field, the collection supports soft delete.  Repeated soft delete
//!   preserves the original `deletedAt` and `updatedAt`.

use std::collections::HashSet;
use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::callbacks::CallbackRegistry;
use crate::change_set::{ChangeSet, EntityChange};
use crate::clock::Clock;
use crate::descriptor::{
    CollectionDescriptor, IdStrategy, SchemaNode, StructField, UniqueConstraintDescriptor,
};
use crate::errors::{
    DuplicateKeyError, EngineError, HookError, HookOperation, NotFoundError, OperationError,
    PluginError, UniqueConstraintError, ValidationError, ValidationIssue,
};
use crate::hooks::{
    run_after_create_hooks, run_after_delete_hooks, run_after_update_hooks,
    run_before_create_hooks, run_before_delete_hooks, run_before_update_hooks, run_on_change_hooks,
    AfterCreateContext, AfterDeleteContext, AfterUpdateContext, BeforeCreateContext,
    BeforeDeleteContext, BeforeUpdateContext, OnChangeContext,
};
use crate::id_gen::IdGenerator;
use crate::operators::{
    deep_merge_updates, update_touches_unique_fields, validate_immutable_fields,
};
use crate::query::indexes::QueryIndexes;
use crate::validator::{decode_value, js_eq, validate_value};

// ── Result types ──────────────────────────────────────────────────────────────

/// Whether an upsert created a new entity or updated an existing one.
///
/// Mirrors the TS `__action: "created" | "updated"` field on `UpsertResult<T>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpsertAction {
    Created,
    Updated,
}

/// Result of an upsert operation.
#[derive(Debug, Clone)]
pub struct UpsertOutcome {
    pub entity: Value,
    pub action: UpsertAction,
}

/// Result of a `createMany` operation.
///
/// Mirrors `CreateManyResult<T>` from `packages/core/src/types/crud-types.ts`.
#[derive(Debug, Clone, Default)]
pub struct CreateManyResult {
    pub created: Vec<Value>,
    pub skipped: Vec<SkippedEntry>,
}

/// Result of an `updateMany` operation.
///
/// Mirrors `UpdateManyResult<T>` from `packages/core/src/types/crud-types.ts`.
#[derive(Debug, Clone, Default)]
pub struct UpdateManyResult {
    pub count: usize,
    pub updated: Vec<Value>,
}

/// Result of a `deleteMany` operation.
///
/// Mirrors `DeleteManyResult<T>` from `packages/core/src/types/crud-types.ts`.
#[derive(Debug, Clone, Default)]
pub struct DeleteManyResult {
    pub count: usize,
    pub deleted: Vec<Value>,
}

/// Result of an `upsertMany` operation.
///
/// Mirrors `UpsertManyResult<T>` from `packages/core/src/types/crud-types.ts`.
#[derive(Debug, Clone, Default)]
pub struct UpsertManyResult {
    pub created: Vec<Value>,
    pub updated: Vec<Value>,
    pub unchanged: Vec<Value>,
}

/// A single entry that was skipped during a batch operation with `skipDuplicates`.
#[derive(Debug, Clone)]
pub struct SkippedEntry {
    pub data: Value,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub(crate) struct EntitySnapshot {
    pub value: Value,
    pub position: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct InternalUpdateOutcome {
    pub previous: Value,
    pub current: Value,
    pub transformed_updates: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct InternalCreateManyOutcome {
    pub result: CreateManyResult,
}

#[derive(Debug, Clone)]
pub(crate) struct InternalUpdateManyOutcome {
    pub result: UpdateManyResult,
    pub contexts: Vec<(String, Value, Value, Value)>,
}

#[derive(Debug, Clone)]
pub(crate) enum InternalUpsertPost {
    Created(Value),
    Updated {
        id: String,
        previous: Value,
        current: Value,
        transformed_updates: Value,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct InternalUpsertOutcome {
    pub result: UpsertOutcome,
    pub post: InternalUpsertPost,
}

#[derive(Debug, Clone)]
pub(crate) struct InternalUpsertManyOutcome {
    pub result: UpsertManyResult,
    pub created_contexts: Vec<Value>,
    pub updated_contexts: Vec<(String, Value, Value, Value)>,
}

// ── Collection ────────────────────────────────────────────────────────────────

/// In-memory collection of JSON entities keyed by `id`.
///
/// Entity order matches insertion order (JS `Map` semantics via `IndexMap`).
pub struct Collection {
    /// Logical name of this collection (used in error messages).
    pub name: String,
    /// Full descriptor including schema, constraints, id strategy, etc.
    pub descriptor: CollectionDescriptor,
    /// Entity store: id → JSON entity value (insertion-ordered).
    state: IndexMap<String, Value>,
    /// Callback registry for `OptionalWithDefault` defaults and `$removeBy` predicates.
    callbacks: Arc<CallbackRegistry>,
    /// ID generator used when the input does not supply an `id`.
    id_gen: Box<dyn IdGenerator>,
    named_id_generator_error: Option<String>,
    /// Clock used to produce ISO 8601 UTC timestamps.
    clock: Box<dyn Clock>,
    /// Whether the schema declares an optional `deletedAt` field (soft-delete support).
    supports_soft_delete: bool,
    /// Set of computed field names to strip from create/update/upsert inputs.
    computed_field_names: HashSet<String>,
    /// Query-time acceleration indexes (equality + full-text search).
    /// Ordinary mutations update postings incrementally; trusted whole-state
    /// replacements retain the canonical rebuild path.
    query_indexes: QueryIndexes,
    /// Net entity changes not yet drained by the database/WASM host.
    pending_changes: ChangeSet,
    /// Monotonic state revision used by synchronized host projections.
    revision: u64,
}

impl Collection {
    /// Create a new, empty collection using the system clock.
    ///
    /// **Not available on `wasm32-unknown-unknown`** — uses [`crate::clock::SystemClock`]
    /// which calls `SystemTime::now()` and panics in WASM.  WASM callers must
    /// use [`Collection::new_with_clock`] and inject a host-side [`Clock`]
    /// implementation (e.g. one backed by `Date.now()` via wasm-bindgen imports).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new(
        name: impl Into<String>,
        descriptor: CollectionDescriptor,
        callbacks: Arc<CallbackRegistry>,
        id_gen: Box<dyn IdGenerator>,
    ) -> Self {
        Self::new_with_clock(
            name,
            descriptor,
            callbacks,
            id_gen,
            Box::new(crate::clock::SystemClock),
        )
    }

    /// Create a new, empty collection with an injected clock.
    ///
    /// Use this in tests (`FixedClock`) and in WASM context (where `SystemTime` panics).
    pub fn new_with_clock(
        name: impl Into<String>,
        descriptor: CollectionDescriptor,
        callbacks: Arc<CallbackRegistry>,
        id_gen: Box<dyn IdGenerator>,
        clock: Box<dyn Clock>,
    ) -> Self {
        let supports_soft_delete = schema_has_deleted_at(&descriptor.schema);
        let computed_field_names: HashSet<String> = descriptor
            .computed_fields
            .iter()
            .map(|cf| cf.name.clone())
            .collect();
        let configured_named_generator = match &descriptor.id_strategy {
            IdStrategy::NamedGenerator { name } => Some(name.clone()),
            _ => descriptor.id_generator.clone(),
        };
        let (id_gen, named_id_generator_error) = if let Some(generator_name) =
            configured_named_generator
        {
            match callbacks.instantiate_id_generator(generator_name.as_str()) {
                Some(generator) => (generator, None),
                None => (
                    id_gen,
                    Some(format!(
                        "Collection '{}' references named id generator '{}' which is not registered",
                        descriptor.name, generator_name
                    )),
                ),
            }
        } else {
            (id_gen, None)
        };
        let mut query_indexes = QueryIndexes::new();
        query_indexes.configure(&descriptor.indexes, &descriptor.search_index);
        Self {
            name: name.into(),
            descriptor,
            state: IndexMap::new(),
            callbacks,
            id_gen,
            named_id_generator_error,
            clock,
            supports_soft_delete,
            computed_field_names,
            query_indexes,
            pending_changes: ChangeSet::default(),
            revision: 0,
        }
    }

    /// Rebuild all query indexes from the current entity snapshot.
    ///
    /// Reserved for trusted whole-state loads, recovery, and legacy snapshot
    /// restoration. Ordinary writes use entity-granular index deltas.
    fn rebuild_indexes(&mut self) {
        let entity_refs: Vec<(String, &Value)> =
            self.state.iter().map(|(id, v)| (id.clone(), v)).collect();
        self.query_indexes.rebuild(
            &entity_refs,
            &self.descriptor.indexes,
            &self.descriptor.search_index,
        );
    }

    fn insert_state(&mut self, id: String, entity: Value) -> Option<Value> {
        let before_position = self.state.get_index_of(&id);
        let before = self.state.insert(id.clone(), entity.clone());
        let after_position = self.state.get_index_of(&id);
        match &before {
            Some(previous) => self.query_indexes.replace(&id, previous, &entity),
            None => self.query_indexes.insert(&id, &entity),
        }
        self.pending_changes.record(EntityChange {
            collection: self.name.clone(),
            id,
            before: before.clone(),
            after: Some(entity),
            before_position,
            after_position,
        });
        self.revision = self.revision.saturating_add(1);
        before
    }

    fn remove_state(&mut self, id: &str) -> Option<Value> {
        let before_position = self.state.get_index_of(id);
        let removed = self.state.shift_remove(id)?;
        self.query_indexes.remove(id, &removed);
        self.pending_changes.record(EntityChange {
            collection: self.name.clone(),
            id: id.to_owned(),
            before: Some(removed.clone()),
            after: None,
            before_position,
            after_position: None,
        });
        self.revision = self.revision.saturating_add(1);
        Some(removed)
    }

    fn insert_state_at(&mut self, id: String, entity: Value, position: usize) {
        let before_position = self.state.get_index_of(&id);
        let before = self.state.shift_remove(&id);
        let after_position = position.min(self.state.len());
        self.state
            .shift_insert(after_position, id.clone(), entity.clone());
        // This primitive is reserved for rollback/restoration. Moving an entity
        // shifts unrelated insertion ordinals, so rebuild the derived indexes to
        // make equality bucket order exactly match the backing state.
        self.rebuild_indexes();
        self.pending_changes.record(EntityChange {
            collection: self.name.clone(),
            id,
            before,
            after: Some(entity),
            before_position,
            after_position: Some(after_position),
        });
        self.revision = self.revision.saturating_add(1);
    }

    fn replace_entire_state(&mut self, replacement: IndexMap<String, Value>) {
        let previous = std::mem::replace(&mut self.state, replacement);
        for (position, (id, before)) in previous.iter().enumerate() {
            let after = self.state.get(id).cloned();
            let after_position = self.state.get_index_of(id);
            self.pending_changes.record(EntityChange {
                collection: self.name.clone(),
                id: id.clone(),
                before: Some(before.clone()),
                after,
                before_position: Some(position),
                after_position,
            });
        }
        for (position, (id, after)) in self.state.iter().enumerate() {
            if !previous.contains_key(id) {
                self.pending_changes.record(EntityChange {
                    collection: self.name.clone(),
                    id: id.clone(),
                    before: None,
                    after: Some(after.clone()),
                    before_position: None,
                    after_position: Some(position),
                });
            }
        }
        if previous != self.state {
            self.revision = self.revision.saturating_add(1);
        }
        self.rebuild_indexes();
    }

    /// Drain committed entity-granular changes since the previous call.
    pub fn take_changes(&mut self) -> ChangeSet {
        // Earlier inserts/removals in an accumulated transaction can shift an
        // entity after its own change was recorded. Publish canonical final
        // positions rather than operation-local intermediate positions.
        for change in self.pending_changes.entities_mut() {
            change.after_position = change
                .after
                .as_ref()
                .and_then(|_| self.state.get_index_of(&change.id));
        }
        std::mem::take(&mut self.pending_changes)
    }

    /// Current monotonic collection revision.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Return the insertion-ordered list of all entity ids.
    ///
    /// Used internally by `narrow_candidates` for index-based candidate narrowing.
    fn insertion_order(&self) -> Vec<String> {
        self.state.keys().cloned().collect()
    }

    /// Try to narrow the candidate entity set for `where_clause` using
    /// acceleration indexes.
    ///
    /// Tries equality index first, then search index.  Returns `Some(ids)` in
    /// insertion order when an index can narrow the set, `None` when no index
    /// applies (caller should fall back to a full scan).
    ///
    /// The full where-clause filter is NOT applied here — narrowing guarantees
    /// no false negatives, and the caller must still run the predicate on the
    /// returned candidates.
    ///
    /// This is the only public entry point into the index layer; callers do not
    /// access `query_indexes` directly.
    pub fn exact_equality_candidate_ids<'a>(
        &'a self,
        where_clause: &Value,
    ) -> Option<(Vec<&'a str>, bool)> {
        self.query_indexes.exact_equality_posting(where_clause)
    }

    pub fn narrow_candidates(&self, where_clause: &Value) -> Option<Vec<String>> {
        if let Some(candidates) = self.query_indexes.narrow_by_equality(where_clause, &[]) {
            return Some(candidates);
        }
        let insertion_order = self.insertion_order();
        self.query_indexes
            .narrow_by_search(where_clause, &insertion_order)
    }

    // ── Public read API ───────────────────────────────────────────────────────

    /// Get an entity by id.  Returns `None` if not found.
    pub fn get(&self, id: &str) -> Option<&Value> {
        self.state.get(id)
    }

    /// Get an entity by id, failing with `NotFoundError` if absent.
    pub fn get_or_fail(&self, id: &str) -> Result<&Value, EngineError> {
        self.state.get(id).ok_or_else(|| not_found(&self.name, id))
    }

    /// Return all entities in insertion order.
    pub fn list(&self) -> Vec<&Value> {
        self.state.values().collect()
    }

    /// Iterate stable storage ids and entities in insertion order without cloning.
    pub fn entries(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.state.iter().map(|(id, value)| (id.as_str(), value))
    }

    pub fn position_of(&self, id: &str) -> Option<usize> {
        self.state.get_index_of(id)
    }

    pub fn entry_at(&self, position: usize) -> Option<(&str, &Value)> {
        self.state
            .get_index(position)
            .map(|(id, value)| (id.as_str(), value))
    }

    /// Resolve the stable storage key for a canonical row only when the value
    /// identifies exactly one row. Caller mutations can make multiple storage
    /// entries deeply equal; those values must be inlined rather than collapsed
    /// onto whichever matching handle happens to appear first.
    pub fn storage_id_for_value(&self, value: &Value) -> Option<&str> {
        let mut matches = self
            .state
            .iter()
            .filter_map(|(id, candidate)| (candidate == value).then_some(id.as_str()));
        let first = matches.next()?;
        matches.next().is_none().then_some(first)
    }

    pub(crate) fn merged_hook_ids(&self, global: &[String], local: &[String]) -> Vec<String> {
        global
            .iter()
            .cloned()
            .chain(local.iter().cloned())
            .collect()
    }

    fn hook_operation_label(operation: HookOperation) -> &'static str {
        match operation {
            HookOperation::Create => "create",
            HookOperation::Update => "update",
            HookOperation::Delete => "delete",
        }
    }

    fn missing_local_hook_error(&self, hook_id: &str, operation: HookOperation) -> EngineError {
        EngineError::Hook(HookError {
            hook: hook_id.to_owned(),
            collection: self.name.clone(),
            operation,
            reason: "missing-hook-callback".to_owned(),
            message: format!(
                "Hook callback '{}' for collection '{}' and operation '{}' is not registered",
                hook_id,
                self.name,
                Self::hook_operation_label(operation)
            ),
        })
    }

    fn missing_global_hook_error(&self, phase: &str, hook_id: &str) -> EngineError {
        EngineError::Plugin(Box::new(PluginError {
            plugin: "global-hooks".to_owned(),
            reason: "invalid_hook".to_owned(),
            message: format!("Global {phase} hook '{}' is not registered", hook_id),
        }))
    }

    fn validate_post_hook_registrations(
        &self,
        operation: HookOperation,
    ) -> Result<(), EngineError> {
        match operation {
            HookOperation::Create => {
                for hook_id in self.callbacks.global_after_create_hooks() {
                    if self.callbacks.after_create_hook(hook_id).is_none() {
                        return Err(self.missing_global_hook_error("afterCreate", hook_id));
                    }
                }
                for hook_id in &self.descriptor.after_create_hooks {
                    if self.callbacks.after_create_hook(hook_id).is_none() {
                        return Err(self.missing_local_hook_error(hook_id, operation));
                    }
                }
            }
            HookOperation::Update => {
                for hook_id in self.callbacks.global_after_update_hooks() {
                    if self.callbacks.after_update_hook(hook_id).is_none() {
                        return Err(self.missing_global_hook_error("afterUpdate", hook_id));
                    }
                }
                for hook_id in &self.descriptor.after_update_hooks {
                    if self.callbacks.after_update_hook(hook_id).is_none() {
                        return Err(self.missing_local_hook_error(hook_id, operation));
                    }
                }
            }
            HookOperation::Delete => {
                for hook_id in self.callbacks.global_after_delete_hooks() {
                    if self.callbacks.after_delete_hook(hook_id).is_none() {
                        return Err(self.missing_global_hook_error("afterDelete", hook_id));
                    }
                }
                for hook_id in &self.descriptor.after_delete_hooks {
                    if self.callbacks.after_delete_hook(hook_id).is_none() {
                        return Err(self.missing_local_hook_error(hook_id, operation));
                    }
                }
            }
        }

        for hook_id in self.callbacks.global_on_change_hooks() {
            if self.callbacks.on_change_hook(hook_id).is_none() {
                return Err(self.missing_global_hook_error("onChange", hook_id));
            }
        }
        for hook_id in &self.descriptor.on_change_hooks {
            if self.callbacks.on_change_hook(hook_id).is_none() {
                return Err(self.missing_local_hook_error(hook_id, operation));
            }
        }
        Ok(())
    }

    /// Number of entities currently in the collection.
    pub fn len(&self) -> usize {
        self.state.len()
    }

    /// `true` when the collection has no entities.
    pub fn is_empty(&self) -> bool {
        self.state.is_empty()
    }

    // ── Create ────────────────────────────────────────────────────────────────

    /// Create a single entity.
    ///
    /// Steps (mirrors TS `create.ts`):
    /// 1. Strip computed field keys from input
    /// 2. Determine id (from input or `id_gen`)
    /// 3. **Always** overwrite `createdAt` and `updatedAt` with current timestamp
    ///    (matches TS `const raw = { ...sanitizedInput, id, createdAt: now, updatedAt: now }`)
    /// 4. Apply `OptionalWithDefault` callbacks for absent fields; fail loudly if
    ///    a required callback is not registered
    /// 5. Validate against schema
    /// 6. Run beforeCreate hooks (global plugin hooks first)
    /// 7. Check for duplicate id → `DuplicateKeyError`
    /// 8. Check unique constraints → `UniqueConstraintError`
    /// 9. Insert into state
    pub fn create(&mut self, input: Value) -> Result<Value, EngineError> {
        let entity = self.create_no_post_hooks(input)?;
        self.run_after_create_entity(entity.clone());
        Ok(entity)
    }

    pub(crate) fn create_no_post_hooks(&mut self, input: Value) -> Result<Value, EngineError> {
        let mut obj = require_object(input, "create input")?;

        for name in &self.computed_field_names {
            obj.remove(name);
        }

        let id = self.resolve_id(&obj)?;
        let now = self.clock.now_iso();
        obj.insert("id".to_string(), Value::String(id.clone()));
        obj.insert("createdAt".to_string(), Value::String(now.clone()));
        obj.insert("updatedAt".to_string(), Value::String(now.clone()));
        self.apply_defaults(&mut obj, &self.descriptor.schema.clone())?;

        let hook_ids = self.merged_hook_ids(
            self.callbacks.global_before_create_hooks(),
            &self.descriptor.before_create_hooks,
        );
        let entity = run_before_create_hooks(
            &self.callbacks,
            &hook_ids,
            BeforeCreateContext {
                operation: HookOperation::Create,
                collection: self.name.clone(),
                data: self.validate_entity(Value::Object(obj), &id)?,
            },
        )?;

        if self.state.contains_key(&id) {
            return Err(EngineError::DuplicateKey(Box::new(DuplicateKeyError {
                collection: self.name.clone(),
                field: "id".to_string(),
                value: id.clone(),
                existing_id: id,
                message: format!("Duplicate value for field 'id': \"{}\"", entity["id"]),
            })));
        }

        self.check_unique_constraints(&entity, None)?;
        self.validate_post_hook_registrations(HookOperation::Create)?;

        self.insert_state(id, entity.clone());
        Ok(entity)
    }

    pub(crate) fn create_unhooked(&mut self, input: Value) -> Result<Value, EngineError> {
        let mut obj = require_object(input, "create input")?;

        for name in &self.computed_field_names {
            obj.remove(name);
        }

        let id = self.resolve_id(&obj)?;
        let now = self.clock.now_iso();
        obj.insert("id".to_string(), Value::String(id.clone()));
        obj.insert("createdAt".to_string(), Value::String(now.clone()));
        obj.insert("updatedAt".to_string(), Value::String(now.clone()));
        self.apply_defaults(&mut obj, &self.descriptor.schema.clone())?;
        let entity = self.validate_entity(Value::Object(obj), &id)?;

        if self.state.contains_key(&id) {
            return Err(EngineError::DuplicateKey(Box::new(DuplicateKeyError {
                collection: self.name.clone(),
                field: "id".to_string(),
                value: id.clone(),
                existing_id: id,
                message: format!("Duplicate value for field 'id': \"{}\"", entity["id"]),
            })));
        }

        self.check_unique_constraints(&entity, None)?;
        self.insert_state(id, entity.clone());
        Ok(entity)
    }

    /// Create multiple entities atomically.
    ///
    /// When `skip_duplicates` is `false` (default): the first validation/duplicate/
    /// unique failure aborts the entire operation; nothing is mutated.
    ///
    /// When `skip_duplicates` is `true`: failing entities are collected in
    /// `CreateManyResult.skipped`; successful entities are applied atomically.
    ///
    /// Mirrors TS `createMany` from `packages/core/src/operations/crud/create.ts`.
    pub fn create_many(
        &mut self,
        inputs: Vec<Value>,
        skip_duplicates: bool,
    ) -> Result<CreateManyResult, EngineError> {
        let outcome = self.create_many_internal(inputs, skip_duplicates)?;
        for entity in &outcome.result.created {
            self.run_after_create_entity(entity.clone());
        }
        Ok(outcome.result)
    }

    // ── Update ────────────────────────────────────────────────────────────────

    /// Update a single entity by id.
    ///
    /// Steps (mirrors TS `update.ts`):
    /// 1. Reject `id` / `createdAt` in updates → `ValidationError`
    /// 2. Strip computed fields from updates
    /// 3. Look up existing entity → `NotFoundError` if absent
    /// 4. Apply `deepMergeUpdates` with operators (including `$removeBy` via registry)
    /// 5. Auto-set `updatedAt` if not explicitly provided
    /// 6. Validate result against schema
    /// 7. Check unique constraints only when update touches unique fields
    /// 8. Replace in state (preserving insertion position)
    pub fn update(&mut self, id: &str, updates: Value) -> Result<Value, EngineError> {
        let outcome = self.update_internal(id, updates)?;
        self.run_after_update_context(
            id,
            outcome.previous.clone(),
            outcome.current.clone(),
            outcome.transformed_updates.clone(),
        );
        Ok(outcome.current)
    }

    /// Update all entities matching `predicate`.
    ///
    /// Steps (mirrors TS `updateMany`):
    /// 1. Validate immutable fields
    /// 2. Strip computed fields from updates
    /// 3. Find all matching entities
    /// 4. Apply merge + timestamp on each
    /// 5. Validate all
    /// 6. Apply atomically (single sweep)
    ///
    /// If any validation fails, the whole operation fails (no partial mutation).
    pub fn update_many(
        &mut self,
        predicate: impl Fn(&Value) -> bool,
        updates: Value,
    ) -> Result<UpdateManyResult, EngineError> {
        let outcome = self.update_many_internal(predicate, updates)?;
        for (id, previous, current, transformed_updates) in &outcome.contexts {
            self.run_after_update_context(
                id,
                previous.clone(),
                current.clone(),
                transformed_updates.clone(),
            );
        }
        Ok(outcome.result)
    }

    // ── Delete ────────────────────────────────────────────────────────────────

    /// Delete (hard or soft) a single entity by id.
    ///
    /// `soft` is honoured only when the collection schema declares a `deletedAt`
    /// field (detected at construction time).  Repeated soft delete preserves the
    /// original `deletedAt` and `updatedAt`, matching TS factory semantics.
    pub fn delete(&mut self, id: &str) -> Result<Value, EngineError> {
        self.delete_with_options(id, false)
    }

    /// Delete with explicit soft-delete option.
    pub fn delete_with_options(&mut self, id: &str, soft: bool) -> Result<Value, EngineError> {
        if self.descriptor.append_only {
            return Err(append_only_error("delete", &self.name));
        }

        let entity = self
            .state
            .get(id)
            .ok_or_else(|| not_found(&self.name, id))?
            .clone();

        let hook_ids = self.merged_hook_ids(
            self.callbacks.global_before_delete_hooks(),
            &self.descriptor.before_delete_hooks,
        );
        run_before_delete_hooks(
            &self.callbacks,
            &hook_ids,
            &BeforeDeleteContext {
                operation: HookOperation::Delete,
                collection: self.name.clone(),
                id: id.to_owned(),
                entity: entity.clone(),
            },
        )?;

        if soft && !self.supports_soft_delete {
            return Err(EngineError::Operation(OperationError {
                operation: "soft delete".to_string(),
                reason: "Entity does not have a deletedAt field".to_string(),
                message: "Entity does not have a deletedAt field".to_string(),
            }));
        }

        self.validate_post_hook_registrations(HookOperation::Delete)?;

        let deleted = if soft {
            let now = self.clock.now_iso();
            let mut soft_deleted: Map<String, Value> =
                entity.as_object().cloned().unwrap_or_default();

            let already_deleted = soft_deleted
                .get("deletedAt")
                .map(|v| !v.is_null())
                .unwrap_or(false);
            if !already_deleted {
                soft_deleted.insert("deletedAt".to_string(), Value::String(now.clone()));
                soft_deleted.insert("updatedAt".to_string(), Value::String(now));
            }

            let soft_deleted_value = Value::Object(soft_deleted);
            self.insert_state(id.to_string(), soft_deleted_value.clone());
            soft_deleted_value
        } else {
            self.remove_state(id).unwrap_or(Value::Null)
        };

        self.run_after_delete_entity(id, deleted.clone());
        Ok(deleted)
    }

    /// Delete multiple entities matching `predicate`.
    ///
    /// `limit` caps how many are deleted.  All deletions happen atomically after
    /// validation.
    pub fn delete_many(
        &mut self,
        predicate: impl Fn(&Value) -> bool,
        soft: bool,
        limit: Option<usize>,
    ) -> Result<DeleteManyResult, EngineError> {
        if self.descriptor.append_only {
            return Err(append_only_error("deleteMany", &self.name));
        }

        if soft && !self.supports_soft_delete {
            return Err(EngineError::Operation(OperationError {
                operation: "soft delete".to_string(),
                reason: "Entities do not have a deletedAt field".to_string(),
                message: "Entities do not have a deletedAt field".to_string(),
            }));
        }

        // Collect matching ids (with optional limit)
        let mut matching_ids: Vec<String> = self
            .state
            .iter()
            .filter(|(_, v)| predicate(v))
            .map(|(k, _)| k.clone())
            .collect();
        if self.callbacks.callback_aborted() {
            return Err(callback_abort_error("deleteMany"));
        }

        // TS source (`delete.ts`):
        //   if (options?.limit !== undefined && options.limit > 0) {
        //       matchingEntities = matchingEntities.slice(0, options.limit);
        //   }
        // limit = 0 means "no cap" (same as no limit at all).
        if let Some(lim) = limit {
            if lim > 0 {
                matching_ids.truncate(lim);
            }
        }

        if matching_ids.is_empty() {
            return Ok(DeleteManyResult::default());
        }

        let hook_ids = self.merged_hook_ids(
            self.callbacks.global_before_delete_hooks(),
            &self.descriptor.before_delete_hooks,
        );
        for id in &matching_ids {
            let entity = self.state.get(id.as_str()).cloned().unwrap_or(Value::Null);
            run_before_delete_hooks(
                &self.callbacks,
                &hook_ids,
                &BeforeDeleteContext {
                    operation: HookOperation::Delete,
                    collection: self.name.clone(),
                    id: id.clone(),
                    entity,
                },
            )?;
        }

        self.validate_post_hook_registrations(HookOperation::Delete)?;

        let now = self.clock.now_iso();
        let mut deleted = Vec::with_capacity(matching_ids.len());

        if soft {
            for id in &matching_ids {
                let mut soft_deleted: Map<String, Value> = self
                    .state
                    .get(id.as_str())
                    .unwrap()
                    .as_object()
                    .cloned()
                    .unwrap_or_default();

                let already_deleted = soft_deleted
                    .get("deletedAt")
                    .map(|v| !v.is_null())
                    .unwrap_or(false);
                if !already_deleted {
                    soft_deleted.insert("deletedAt".to_string(), Value::String(now.clone()));
                    soft_deleted.insert("updatedAt".to_string(), Value::String(now.clone()));
                }

                let result = Value::Object(soft_deleted);
                self.insert_state(id.clone(), result.clone());
                deleted.push(result);
            }
        } else {
            for id in &matching_ids {
                if let Some(entity) = self.remove_state(id) {
                    deleted.push(entity);
                }
            }
        }

        for entity in &deleted {
            let id = entity
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            self.run_after_delete_entity(&id, entity.clone());
        }

        let count = deleted.len();
        Ok(DeleteManyResult { count, deleted })
    }

    // ── Upsert ────────────────────────────────────────────────────────────────

    /// Upsert: find by `where_clause`, update if found, create if not.
    ///
    /// **Create path precedence** (mirrors TS `upsert.ts`):
    ///   1. `where` fields as base
    ///   2. `create_data` fields override where fields
    ///   3. `id` = `where.id` if it is a string, else `generateId()` —
    ///      `create_data.id` is NOT used as a fallback (TS overwrites it)
    ///   4. timestamps always overwrite
    ///
    /// **Update path**: applies `update_data` operators to the found entity, validates
    /// immutable fields, validates schema, checks unique constraints.
    pub fn upsert(
        &mut self,
        where_clause: Value,
        create_data: Value,
        update_data: Value,
    ) -> Result<UpsertOutcome, EngineError> {
        let outcome = self.upsert_internal(where_clause, create_data, update_data)?;
        match &outcome.post {
            InternalUpsertPost::Created(entity) => self.run_after_create_entity(entity.clone()),
            InternalUpsertPost::Updated {
                id,
                previous,
                current,
                transformed_updates,
            } => self.run_after_update_context(
                id,
                previous.clone(),
                current.clone(),
                transformed_updates.clone(),
            ),
        }
        Ok(outcome.result)
    }

    /// Upsert multiple inputs — true two-phase atomic implementation.
    ///
    /// **Phase 1 — Categorize using the initial state snapshot** (no mutation):
    /// - For each input match the `where` clause against the initial `self.state`.
    /// - Found → categorize as update candidate (apply merge + schema validation).
    /// - Not found → categorize as create candidate (build entity, defaults, schema).
    /// - Unchanged → collect separately.
    ///
    /// **Phase 2 — Validate all candidates together**:
    /// - Duplicate id check across all create candidates + existing state.
    /// - Unique constraint check: creates against existing + batch; updates against
    ///   non-updating state + other proposed entities.
    ///
    /// **Phase 3 — Apply atomically**: only if ALL validations passed.
    pub fn upsert_many(
        &mut self,
        inputs: Vec<(Value, Value, Value)>, // (where, create, update)
    ) -> Result<UpsertManyResult, EngineError> {
        let outcome = self.upsert_many_internal(inputs)?;
        for entity in &outcome.created_contexts {
            self.run_after_create_entity(entity.clone());
        }
        for (id, previous, validated, updates) in &outcome.updated_contexts {
            self.run_after_update_context(id, previous.clone(), validated.clone(), updates.clone());
        }
        Ok(outcome.result)
    }

    // ── Package-internal seams ─────────────────────────────────────────────────

    /// Return the current timestamp from this collection's clock.
    ///
    /// Used by `Database` cascade operations to obtain a consistent timestamp
    /// without exposing the private `clock` field.
    pub(crate) fn now_iso(&self) -> String {
        self.clock.now_iso()
    }

    /// Generate (and consume) the next ID from this collection's id generator,
    /// WITHOUT creating any entity.  Used by `create_with_relationships` to
    /// obtain the parent entity's ID before inverse child entities are created,
    /// so children can hold a FK pointing to the not-yet-created parent.
    pub(crate) fn reserve_id(&mut self) -> String {
        self.id_gen.generate()
    }

    /// Return a snapshot of the entity with `id`, or `None` if absent.
    ///
    /// Used by `Database::update` and `update_with_relationships` to take a
    /// point-in-time snapshot of an entity before mutating it, so it can be
    /// restored if a subsequent FK validation fails.
    pub(crate) fn snapshot_entity(&self, id: &str) -> Option<EntitySnapshot> {
        Some(EntitySnapshot {
            value: self.state.get(id)?.clone(),
            position: self.state.get_index_of(id)?,
        })
    }

    /// Snapshot the full collection state in insertion order.
    pub(crate) fn snapshot_state(&self) -> IndexMap<String, Value> {
        self.state.clone()
    }

    pub(crate) fn entity_ids(&self) -> HashSet<String> {
        self.state.keys().cloned().collect()
    }

    pub(crate) fn entity_position(&self, id: &str) -> Option<usize> {
        self.state.get_index_of(id)
    }

    pub(crate) fn upsert_will_create(&self, where_clause: &Value) -> bool {
        where_clause
            .as_object()
            .is_none_or(|where_obj| self.find_by_where(where_obj).is_none())
    }

    /// Undo only the entity created by the immediately preceding operation.
    ///
    /// This deliberately ignores the accumulated change-set before-image. If a
    /// transaction deleted the same id earlier, removing this failed create must
    /// retain that earlier delete rather than resurrecting the old entity.
    pub(crate) fn rollback_created_entity(&mut self, created: &Value) -> bool {
        let storage_id = self
            .state
            .iter()
            .rev()
            .find_map(|(id, entity)| (entity == created).then(|| id.clone()));
        storage_id
            .as_deref()
            .is_some_and(|id| self.remove_state(id).is_some())
    }

    pub(crate) fn restore_entity_value(&mut self, id: &str, value: Value) {
        let position = self.state.get_index_of(id).unwrap_or(self.state.len());
        self.insert_state_at(id.to_owned(), value, position);
    }

    /// Synchronize a caller-mutated materialized row without creating a formal
    /// mutation. This deliberately bypasses validation, hooks, revisions,
    /// reactive events, committed changes, and derived-index maintenance. The
    /// latter preserves the stale-index behavior of direct mutable TS rows.
    pub fn synchronize_materialized_value(&mut self, id: &str, value: Value) -> bool {
        let Some(current) = self.state.get_mut(id) else {
            return false;
        };
        *current = value;
        true
    }

    /// Restore a reversed, per-collection transaction journal and rebuild all
    /// derived indexes exactly once. The caller must provide changes in rollback
    /// order. An empty journal still rebuilds indexes because direct materialized
    /// row synchronization can compact a touched transaction to net zero while
    /// intentionally leaving its derived indexes stale.
    pub(crate) fn rollback_entity_changes(&mut self, changes: &[EntityChange]) {
        for change in changes {
            self.state.shift_remove(&change.id);
            if let Some(before) = &change.before {
                let position = change.before_position.unwrap_or(self.state.len());
                self.state.shift_insert(
                    position.min(self.state.len()),
                    change.id.clone(),
                    before.clone(),
                );
            }
        }
        self.rebuild_indexes();
    }

    pub(crate) fn restore_revision(&mut self, revision: u64) {
        self.revision = revision;
    }

    /// Replace the full collection state and rebuild indexes.
    pub(crate) fn restore_state(&mut self, snapshot: IndexMap<String, Value>) {
        self.replace_entire_state(snapshot);
    }

    /// Replace the entire collection state from already-loaded records.
    ///
    /// Unlike `create_many`, this preserves the incoming payloads exactly:
    /// no timestamp overwrite, no id generation, and no default injection.
    /// Each record is still schema-decoded, duplicate ids are rejected, unique
    /// constraints are enforced across the replacement set, and indexes are
    /// rebuilt atomically on success.
    pub(crate) fn replace_loaded_records(
        &mut self,
        records: Vec<Value>,
    ) -> Result<(), EngineError> {
        let original_state = self.state.clone();

        let mut validated_records = Vec::with_capacity(records.len());
        for record in records {
            let obj = require_object(record, "reload record")?;
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    EngineError::Validation(ValidationError {
                        message: "Reloaded record is missing required field 'id'".to_string(),
                        issues: vec![ValidationIssue {
                            field: "id".to_string(),
                            message: "Expected string, got absent".to_string(),
                            value: None,
                            expected: Some("string".to_string()),
                            received: Some("absent".to_string()),
                        }],
                    })
                })?
                .to_string();
            let entity = Value::Object(obj);
            self.validate_loaded_entity(&entity, &id)?;
            validated_records.push(entity);
        }

        self.state = IndexMap::new();
        let result = (|| {
            let mut new_state = IndexMap::new();
            let mut seen_ids = HashSet::new();
            let mut batch_index: Map<String, Value> = Map::new();

            for entity in validated_records {
                let id = entity
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if !seen_ids.insert(id.clone()) {
                    return Err(EngineError::DuplicateKey(Box::new(DuplicateKeyError {
                        collection: self.name.clone(),
                        field: "id".to_string(),
                        value: id.clone(),
                        existing_id: id.clone(),
                        message: format!("Duplicate value for field 'id': \"{id}\" (in batch)"),
                    })));
                }
                self.check_unique_constraints_with_batch(&entity, None, &batch_index)?;
                self.add_to_batch_constraint_index(&entity, &mut batch_index);
                new_state.insert(id, entity);
            }

            Ok(new_state)
        })();

        match result {
            Ok(new_state) => {
                self.state = original_state;
                self.replace_entire_state(new_state);
                Ok(())
            }
            Err(error) => {
                self.state = original_state;
                self.rebuild_indexes();
                Err(error)
            }
        }
    }

    /// Replace the entire collection state from trusted bootstrap data.
    ///
    /// Mirrors TS `createEffectDatabase(..., initialData)` semantics: records are
    /// inserted directly into the backing map without schema validation,
    /// relationship validation, default injection, timestamp overwrite, or
    /// unique-constraint checks. Only the `id` field is required so the data can
    /// be keyed in-memory.
    pub(crate) fn replace_trusted_loaded_records(
        &mut self,
        records: Vec<Value>,
    ) -> Result<(), EngineError> {
        let original_state = self.state.clone();
        let result = (|| {
            let mut new_state = IndexMap::new();
            for record in records {
                let obj = require_object(record, "initial record")?;
                let id = obj
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        EngineError::Validation(ValidationError {
                            message: "Initial record is missing required field 'id'".to_string(),
                            issues: vec![ValidationIssue {
                                field: "id".to_string(),
                                message: "Expected string, got absent".to_string(),
                                value: None,
                                expected: Some("string".to_string()),
                                received: Some("absent".to_string()),
                            }],
                        })
                    })?
                    .to_string();
                new_state.insert(id, Value::Object(obj));
            }
            Ok(new_state)
        })();

        match result {
            Ok(new_state) => {
                self.replace_entire_state(new_state);
                Ok(())
            }
            Err(error) => {
                self.state = original_state;
                self.rebuild_indexes();
                Err(error)
            }
        }
    }

    /// Directly replace the entity with `id` with `snapshot`, bypassing
    /// all validation.  If `snapshot` is `None`, the entity is removed.
    ///
    /// Used to roll back parent mutations when FK validation fails AFTER the
    /// schema-level update has already been applied. Indexes are restored by delta.
    pub(crate) fn restore_entity_snapshot(&mut self, id: &str, snapshot: Option<EntitySnapshot>) {
        match snapshot {
            Some(snapshot) => {
                self.insert_state_at(id.to_string(), snapshot.value, snapshot.position)
            }
            None => {
                self.remove_state(id);
            }
        }
    }

    /// Remove an entity from state WITHOUT any guards (append-only, soft-delete,
    /// schema validation).
    ///
    /// Used by hard-cascade to delete child entities even when the target
    /// collection is append-only (mirrors TS `map.delete(id)` direct approach).
    ///
    /// Removes index postings incrementally. Returns `Some(entity)` when the
    /// entity was present and removed, `None` when the entity was not found.
    pub(crate) fn delete_raw(&mut self, id: &str) -> Option<Value> {
        self.remove_state(id)
    }

    /// Directly merge `patches` into entity `id` without schema validation,
    /// uniqueness checks, or immutability guards.
    ///
    /// This is the "trusted patch" seam used by cascade-soft-delete to set
    /// `deletedAt`/`updatedAt` on related entities regardless of whether the
    /// schema declares those fields (mirrors the TS `Ref.update` direct-patch
    /// approach in `cascadeDeleteEntities`).
    ///
    /// Replaces affected index postings incrementally.
    /// Returns `true` if the entity existed, `false` otherwise (no-op).
    pub(crate) fn patch_raw(&mut self, id: &str, patches: Map<String, Value>) -> bool {
        if let Some(entity) = self.state.get(id) {
            let mut merged = entity.as_object().cloned().unwrap_or_default();
            for (k, v) in patches {
                merged.insert(k, v);
            }
            self.insert_state(id.to_string(), Value::Object(merged));
            true
        } else {
            false
        }
    }

    /// Shallow-merge `updates` into entity `id` using TS `Object.assign` semantics.
    ///
    /// Mirrors the TS relationship-aware CRUD step-10 (`Object.assign(updatedEntity, baseUpdate)`)
    /// and the `$update` target-entity path in `updateWithRelationships`:
    ///
    /// - **No operator processing** — `$increment`, `$append`, etc. are treated as
    ///   literal field values, not as update operators.
    /// - **Shallow merge** — update keys directly overwrite entity keys; no recursion.
    /// - **`updatedAt` forced** — set to `now()` unless the caller already includes it.
    /// - **Computed fields stripped** from `updates` before merge.
    /// - **Schema validated** — `decode_value` is run on the merged entity;
    ///   excess properties are stripped and transform schemas are applied.
    ///   Returns `ValidationError` on schema failure.
    /// - **No unique-constraint check**, no immutable-field check, no append-only guard.
    /// - **State replaced** and indexes rebuilt on success.
    ///
    /// Returns `NotFoundError` if the entity with `id` does not exist.
    pub(crate) fn update_relationship_shallow(
        &mut self,
        id: &str,
        updates: &Map<String, Value>,
    ) -> Result<Value, EngineError> {
        let existing = self
            .state
            .get(id)
            .ok_or_else(|| not_found(&self.name, id))?
            .clone();

        // Shallow merge: start with current entity, overwrite with update fields.
        // Strip computed fields from the incoming updates (they are derived, not stored).
        let mut merged = existing.as_object().cloned().unwrap_or_default();
        for (k, v) in updates {
            if !self.computed_field_names.contains(k) {
                merged.insert(k.clone(), v.clone());
            }
        }

        // Force updatedAt = now (mirror TS: `existing.updatedAt = now`).
        // Only skipped if the caller explicitly includes updatedAt in updates.
        if !updates.contains_key("updatedAt") {
            merged.insert("updatedAt".to_string(), Value::String(self.clock.now_iso()));
        }

        // Schema validate and decode (strips excess fields, applies transforms).
        let validated = self.validate_entity(Value::Object(merged), id)?;

        // Replace state — no unique/immutable/append-only guard.
        self.insert_state(id.to_string(), validated.clone());

        Ok(validated)
    }

    // ── Internal helpers ─────────────────────────────────────────────────

    pub(crate) fn run_after_create_entity(&self, entity: Value) {
        let after_hook_ids = self.merged_hook_ids(
            self.callbacks.global_after_create_hooks(),
            &self.descriptor.after_create_hooks,
        );
        let on_change_hook_ids = self.merged_hook_ids(
            self.callbacks.global_on_change_hooks(),
            &self.descriptor.on_change_hooks,
        );
        run_after_create_hooks(
            &self.callbacks,
            &after_hook_ids,
            &AfterCreateContext {
                operation: HookOperation::Create,
                collection: self.name.clone(),
                entity: entity.clone(),
            },
        );
        run_on_change_hooks(
            &self.callbacks,
            &on_change_hook_ids,
            &OnChangeContext::Create {
                collection: self.name.clone(),
                entity,
            },
        );
    }

    pub(crate) fn run_after_delete_entity(&self, id: &str, entity: Value) {
        let after_hook_ids = self.merged_hook_ids(
            self.callbacks.global_after_delete_hooks(),
            &self.descriptor.after_delete_hooks,
        );
        let on_change_hook_ids = self.merged_hook_ids(
            self.callbacks.global_on_change_hooks(),
            &self.descriptor.on_change_hooks,
        );
        run_after_delete_hooks(
            &self.callbacks,
            &after_hook_ids,
            &AfterDeleteContext {
                operation: HookOperation::Delete,
                collection: self.name.clone(),
                id: id.to_owned(),
                entity: entity.clone(),
            },
        );
        run_on_change_hooks(
            &self.callbacks,
            &on_change_hook_ids,
            &OnChangeContext::Delete {
                collection: self.name.clone(),
                id: id.to_owned(),
                entity,
            },
        );
    }

    pub(crate) fn run_after_update_context(
        &self,
        id: &str,
        previous: Value,
        current: Value,
        transformed_updates: Value,
    ) {
        let after_hook_ids = self.merged_hook_ids(
            self.callbacks.global_after_update_hooks(),
            &self.descriptor.after_update_hooks,
        );
        let on_change_hook_ids = self.merged_hook_ids(
            self.callbacks.global_on_change_hooks(),
            &self.descriptor.on_change_hooks,
        );
        run_after_update_hooks(
            &self.callbacks,
            &after_hook_ids,
            &AfterUpdateContext {
                operation: HookOperation::Update,
                collection: self.name.clone(),
                id: id.to_owned(),
                previous: previous.clone(),
                current: current.clone(),
                update: transformed_updates,
            },
        );
        run_on_change_hooks(
            &self.callbacks,
            &on_change_hook_ids,
            &OnChangeContext::Update {
                collection: self.name.clone(),
                id: id.to_owned(),
                previous,
                current,
            },
        );
    }

    pub(crate) fn update_internal(
        &mut self,
        id: &str,
        updates: Value,
    ) -> Result<InternalUpdateOutcome, EngineError> {
        if self.descriptor.append_only {
            return Err(append_only_error("update", &self.name));
        }

        validate_immutable_fields(&updates)?;
        let sanitized_updates = strip_computed(&updates, &self.computed_field_names);
        let existing = self
            .state
            .get(id)
            .ok_or_else(|| not_found(&self.name, id))?
            .clone();

        let hook_ids = self.merged_hook_ids(
            self.callbacks.global_before_update_hooks(),
            &self.descriptor.before_update_hooks,
        );
        let transformed_updates = run_before_update_hooks(
            &self.callbacks,
            &hook_ids,
            BeforeUpdateContext {
                operation: HookOperation::Update,
                collection: self.name.clone(),
                id: id.to_owned(),
                existing: existing.clone(),
                update: sanitized_updates,
            },
        )?;

        let mut merged = deep_merge_updates(&existing, &transformed_updates, &self.callbacks)?;
        let explicitly_sets_updated_at = transformed_updates
            .as_object()
            .map(|m| m.contains_key("updatedAt"))
            .unwrap_or(false);
        if !explicitly_sets_updated_at {
            if let Value::Object(ref mut m) = merged {
                m.insert("updatedAt".to_string(), Value::String(self.clock.now_iso()));
            }
        }

        let validated = self.validate_entity(merged, id)?;
        if update_touches_unique_fields(&transformed_updates, &self.descriptor.unique_fields) {
            self.check_unique_constraints(&validated, Some(id))?;
        }
        self.validate_post_hook_registrations(HookOperation::Update)?;

        self.insert_state(id.to_string(), validated.clone());
        Ok(InternalUpdateOutcome {
            previous: existing,
            current: validated,
            transformed_updates,
        })
    }

    pub(crate) fn create_many_internal(
        &mut self,
        inputs: Vec<Value>,
        skip_duplicates: bool,
    ) -> Result<InternalCreateManyOutcome, EngineError> {
        let now = self.clock.now_iso();
        let mut validated_entities: Vec<Value> = Vec::with_capacity(inputs.len());
        let mut skipped: Vec<SkippedEntry> = vec![];
        let mut batch_constraint_index: Map<String, Value> = Map::new();

        for input in inputs {
            let mut obj = match require_object(input.clone(), "createMany input") {
                Ok(o) => o,
                Err(e) => {
                    if skip_duplicates {
                        skipped.push(SkippedEntry {
                            data: input,
                            reason: e.to_string(),
                        });
                        continue;
                    }
                    return Err(e);
                }
            };
            for name in &self.computed_field_names {
                obj.remove(name);
            }
            let id = match self.resolve_id(&obj) {
                Ok(i) => i,
                Err(e) => {
                    if skip_duplicates {
                        skipped.push(SkippedEntry {
                            data: Value::Object(obj),
                            reason: e.to_string(),
                        });
                        continue;
                    }
                    return Err(e);
                }
            };
            obj.insert("id".to_string(), Value::String(id.clone()));
            let skip_data = Value::Object(obj.clone());
            obj.insert("createdAt".to_string(), Value::String(now.clone()));
            obj.insert("updatedAt".to_string(), Value::String(now.clone()));
            let schema = self.descriptor.schema.clone();
            if let Err(e) = self.apply_defaults(&mut obj, &schema) {
                if skip_duplicates {
                    skipped.push(SkippedEntry {
                        data: skip_data,
                        reason: e.to_string(),
                    });
                    continue;
                }
                return Err(e);
            }
            let entity = match self.validate_entity(Value::Object(obj.clone()), &id) {
                Ok(e) => e,
                Err(e) => {
                    if skip_duplicates {
                        let reason = match &e {
                            EngineError::Validation(v) => {
                                let first_msg = v
                                    .issues
                                    .first()
                                    .map(|i| i.message.clone())
                                    .unwrap_or_else(|| v.message.clone());
                                format!("Validation failed: {first_msg}")
                            }
                            other => format!("Validation failed: {other}"),
                        };
                        skipped.push(SkippedEntry {
                            data: skip_data,
                            reason,
                        });
                        continue;
                    }
                    return Err(e);
                }
            };
            let before_hook_ids = self.merged_hook_ids(
                self.callbacks.global_before_create_hooks(),
                &self.descriptor.before_create_hooks,
            );
            let entity = match run_before_create_hooks(
                &self.callbacks,
                &before_hook_ids,
                BeforeCreateContext {
                    operation: HookOperation::Create,
                    collection: self.name.clone(),
                    data: entity,
                },
            ) {
                Ok(entity) => entity,
                Err(error) => {
                    if skip_duplicates {
                        skipped.push(SkippedEntry {
                            data: skip_data,
                            reason: format!("Hook rejected: {error}"),
                        });
                        continue;
                    }
                    return Err(error);
                }
            };
            if self.state.contains_key(&id)
                || validated_entities
                    .iter()
                    .any(|e| e["id"].as_str() == Some(&id))
            {
                let error = EngineError::DuplicateKey(Box::new(DuplicateKeyError {
                    collection: self.name.clone(),
                    field: "id".to_string(),
                    value: id.clone(),
                    existing_id: id.clone(),
                    message: if self.state.contains_key(&id) {
                        format!("Duplicate value for field 'id': \"{id}\"")
                    } else {
                        format!("Duplicate value for field 'id': \"{id}\" (in batch)")
                    },
                }));
                if skip_duplicates {
                    skipped.push(SkippedEntry {
                        data: skip_data,
                        reason: format!("Duplicate ID: {id}"),
                    });
                    continue;
                }
                return Err(error);
            }
            if let Err(e) =
                self.check_unique_constraints_with_batch(&entity, None, &batch_constraint_index)
            {
                if skip_duplicates {
                    let reason = match &e {
                        EngineError::UniqueConstraint(uc) => {
                            format!("Unique constraint violation: {}", uc.message)
                        }
                        other => format!("Unique constraint violation: {other}"),
                    };
                    skipped.push(SkippedEntry {
                        data: entity,
                        reason,
                    });
                    continue;
                }
                return Err(e);
            }
            self.add_to_batch_constraint_index(&entity, &mut batch_constraint_index);
            validated_entities.push(entity);
        }

        let created: Vec<Value> = validated_entities.clone();
        if !created.is_empty() {
            self.validate_post_hook_registrations(HookOperation::Create)?;
        }
        for entity in validated_entities {
            let id = entity["id"].as_str().unwrap_or_default().to_string();
            self.insert_state(id, entity);
        }
        Ok(InternalCreateManyOutcome {
            result: CreateManyResult { created, skipped },
        })
    }

    pub(crate) fn update_many_internal(
        &mut self,
        predicate: impl Fn(&Value) -> bool,
        updates: Value,
    ) -> Result<InternalUpdateManyOutcome, EngineError> {
        if self.descriptor.append_only {
            return Err(append_only_error("updateMany", &self.name));
        }
        validate_immutable_fields(&updates)?;
        let updates = strip_computed(&updates, &self.computed_field_names);
        let now = self.clock.now_iso();
        let matching_ids: Vec<String> = self
            .state
            .iter()
            .filter(|(_, v)| predicate(v))
            .map(|(k, _)| k.clone())
            .collect();
        if self.callbacks.callback_aborted() {
            return Err(callback_abort_error("updateMany"));
        }
        if matching_ids.is_empty() {
            return Ok(InternalUpdateManyOutcome {
                result: UpdateManyResult::default(),
                contexts: Vec::new(),
            });
        }
        let mut validated_pairs: Vec<(String, Value, Value, Value)> =
            Vec::with_capacity(matching_ids.len());
        let before_hook_ids = self.merged_hook_ids(
            self.callbacks.global_before_update_hooks(),
            &self.descriptor.before_update_hooks,
        );
        for id in &matching_ids {
            let existing = self.state.get(id.as_str()).unwrap().clone();
            let transformed_updates = run_before_update_hooks(
                &self.callbacks,
                &before_hook_ids,
                BeforeUpdateContext {
                    operation: HookOperation::Update,
                    collection: self.name.clone(),
                    id: id.clone(),
                    existing: existing.clone(),
                    update: updates.clone(),
                },
            )?;
            let mut merged = deep_merge_updates(&existing, &transformed_updates, &self.callbacks)?;
            let explicitly_sets_updated_at = transformed_updates
                .as_object()
                .map(|m| m.contains_key("updatedAt"))
                .unwrap_or(false);
            if !explicitly_sets_updated_at {
                if let Value::Object(ref mut m) = merged {
                    m.insert("updatedAt".to_string(), Value::String(now.clone()));
                }
            }
            let validated = self.validate_entity(merged, id)?;
            validated_pairs.push((id.clone(), existing, validated, transformed_updates));
        }
        if validated_pairs.iter().any(|(_, _, _, transformed)| {
            update_touches_unique_fields(transformed, &self.descriptor.unique_fields)
        }) {
            let updating_ids: HashSet<String> = matching_ids.iter().cloned().collect();
            let mut proposed_index: Map<String, Value> = Map::new();
            for (id, _, validated, _) in &validated_pairs {
                self.check_unique_constraints_update_batch(
                    validated,
                    id.as_str(),
                    &updating_ids,
                    &proposed_index,
                )?;
                self.add_to_batch_constraint_index(validated, &mut proposed_index);
            }
        }
        let mut updated = Vec::with_capacity(validated_pairs.len());
        self.validate_post_hook_registrations(HookOperation::Update)?;
        for (id, _, validated, _) in &validated_pairs {
            self.insert_state(id.clone(), validated.clone());
            updated.push(validated.clone());
        }
        let count = updated.len();
        Ok(InternalUpdateManyOutcome {
            result: UpdateManyResult { count, updated },
            contexts: validated_pairs,
        })
    }

    pub(crate) fn upsert_internal(
        &mut self,
        where_clause: Value,
        create_data: Value,
        update_data: Value,
    ) -> Result<InternalUpsertOutcome, EngineError> {
        if self.descriptor.append_only {
            return Err(append_only_error("upsert", &self.name));
        }
        let where_obj = require_object(where_clause, "upsert where")?;
        let create_obj = require_object(create_data, "upsert create")?;
        self.validate_upsert_where(&where_obj)?;
        let existing_id = self.find_by_where(&where_obj);
        if let Some(id) = existing_id {
            let outcome = self.update_internal(&id, update_data)?;
            let result = UpsertOutcome {
                entity: outcome.current.clone(),
                action: UpsertAction::Updated,
            };
            Ok(InternalUpsertOutcome {
                result,
                post: InternalUpsertPost::Updated {
                    id,
                    previous: outcome.previous,
                    current: outcome.current,
                    transformed_updates: outcome.transformed_updates,
                },
            })
        } else {
            let mut base: Map<String, Value> = where_obj.clone();
            for (k, v) in create_obj {
                base.insert(k, v);
            }
            for name in &self.computed_field_names.clone() {
                base.remove(name);
            }
            let id = where_obj
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| self.id_gen.generate());
            base.insert("id".to_string(), Value::String(id));
            let entity = self.create_no_post_hooks(Value::Object(base))?;
            Ok(InternalUpsertOutcome {
                result: UpsertOutcome {
                    entity: entity.clone(),
                    action: UpsertAction::Created,
                },
                post: InternalUpsertPost::Created(entity),
            })
        }
    }

    pub(crate) fn upsert_many_internal(
        &mut self,
        inputs: Vec<(Value, Value, Value)>,
    ) -> Result<InternalUpsertManyOutcome, EngineError> {
        if self.descriptor.append_only {
            return Err(append_only_error("upsertMany", &self.name));
        }
        let now = self.clock.now_iso();
        let mut candidates_create: Vec<Value> = vec![];
        let mut candidates_update: Vec<(String, Value, Value, Value)> = vec![];
        let mut result_unchanged: Vec<Value> = vec![];
        let before_create_hook_ids = self.merged_hook_ids(
            self.callbacks.global_before_create_hooks(),
            &self.descriptor.before_create_hooks,
        );
        let before_update_hook_ids = self.merged_hook_ids(
            self.callbacks.global_before_update_hooks(),
            &self.descriptor.before_update_hooks,
        );
        for (where_clause, create_data, update_data) in inputs {
            let where_obj = require_object(where_clause, "upsertMany where")?;
            let create_obj = require_object(create_data, "upsertMany create")?;
            self.validate_upsert_where(&where_obj)?;
            if let Some(id) = self.find_by_where(&where_obj) {
                let existing = self.state.get(id.as_str()).unwrap().clone();
                let updates = strip_computed(&update_data, &self.computed_field_names);
                let would_change = would_update_change(&existing, &updates, &self.callbacks)?;
                if !would_change {
                    result_unchanged.push(existing);
                    continue;
                }
                validate_immutable_fields(&updates)?;
                let transformed_updates = run_before_update_hooks(
                    &self.callbacks,
                    &before_update_hook_ids,
                    BeforeUpdateContext {
                        operation: HookOperation::Update,
                        collection: self.name.clone(),
                        id: id.clone(),
                        existing: existing.clone(),
                        update: updates,
                    },
                )?;
                let mut merged =
                    deep_merge_updates(&existing, &transformed_updates, &self.callbacks)?;
                let explicitly_sets_updated_at = transformed_updates
                    .as_object()
                    .map(|m| m.contains_key("updatedAt"))
                    .unwrap_or(false);
                if !explicitly_sets_updated_at {
                    if let Value::Object(ref mut m) = merged {
                        m.insert("updatedAt".to_string(), Value::String(now.clone()));
                    }
                }
                let validated = self.validate_entity(merged, &id)?;
                candidates_update.push((id, existing, validated, transformed_updates));
            } else {
                let mut base: Map<String, Value> = where_obj.clone();
                for (k, v) in create_obj {
                    base.insert(k, v);
                }
                for name in &self.computed_field_names.clone() {
                    base.remove(name);
                }
                let id = where_obj
                    .get("id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| self.id_gen.generate());
                base.insert("id".to_string(), Value::String(id.clone()));
                base.insert("createdAt".to_string(), Value::String(now.clone()));
                base.insert("updatedAt".to_string(), Value::String(now.clone()));
                let schema = self.descriptor.schema.clone();
                self.apply_defaults(&mut base, &schema)?;
                let entity = self.validate_entity(Value::Object(base), &id)?;
                let entity = run_before_create_hooks(
                    &self.callbacks,
                    &before_create_hook_ids,
                    BeforeCreateContext {
                        operation: HookOperation::Create,
                        collection: self.name.clone(),
                        data: entity,
                    },
                )?;
                candidates_create.push(entity);
            }
        }
        {
            let mut seen_ids: HashSet<String> = HashSet::new();
            for entity in &candidates_create {
                let id = entity["id"].as_str().unwrap_or_default();
                if self.state.contains_key(id) {
                    return Err(EngineError::DuplicateKey(Box::new(DuplicateKeyError {
                        collection: self.name.clone(),
                        field: "id".to_string(),
                        value: id.to_string(),
                        existing_id: id.to_string(),
                        message: format!("Duplicate value for field 'id': \"{id}\""),
                    })));
                }
                if !seen_ids.insert(id.to_string()) {
                    return Err(EngineError::DuplicateKey(Box::new(DuplicateKeyError {
                        collection: self.name.clone(),
                        field: "id".to_string(),
                        value: id.to_string(),
                        existing_id: id.to_string(),
                        message: format!("Duplicate value for field 'id': \"{id}\" (in batch)"),
                    })));
                }
            }
        }
        {
            let mut batch_index: Map<String, Value> = Map::new();
            for entity in &candidates_create {
                self.check_unique_constraints_with_batch(entity, None, &batch_index)?;
                self.add_to_batch_constraint_index(entity, &mut batch_index);
            }
        }
        if !candidates_update.is_empty() && !self.descriptor.unique_fields.is_empty() {
            let updating_ids: HashSet<String> = candidates_update
                .iter()
                .map(|(id, _, _, _)| id.clone())
                .collect();
            let mut combined_proposed: Map<String, Value> = Map::new();
            for entity in &candidates_create {
                self.add_to_batch_constraint_index(entity, &mut combined_proposed);
            }
            for (id, _, validated, _) in &candidates_update {
                self.check_unique_constraints_update_batch(
                    validated,
                    id.as_str(),
                    &updating_ids,
                    &combined_proposed,
                )?;
                self.add_to_batch_constraint_index(validated, &mut combined_proposed);
            }
        }
        let created: Vec<Value> = candidates_create.clone();
        let updated: Vec<Value> = candidates_update
            .iter()
            .map(|(_, _, e, _)| e.clone())
            .collect();
        if !created.is_empty() {
            self.validate_post_hook_registrations(HookOperation::Create)?;
        }
        if !updated.is_empty() {
            self.validate_post_hook_registrations(HookOperation::Update)?;
        }
        for entity in candidates_create {
            let id = entity["id"].as_str().unwrap_or_default().to_string();
            self.insert_state(id, entity);
        }
        for (id, _, validated, _) in &candidates_update {
            self.insert_state(id.clone(), validated.clone());
        }
        Ok(InternalUpsertManyOutcome {
            result: UpsertManyResult {
                created: created.clone(),
                updated,
                unchanged: result_unchanged,
            },
            created_contexts: created,
            updated_contexts: candidates_update,
        })
    }

    /// Resolve the id for a new entity from the input object and `id_strategy`.
    fn resolve_id(&mut self, obj: &Map<String, Value>) -> Result<String, EngineError> {
        match &self.descriptor.id_strategy {
            IdStrategy::Provided
            | IdStrategy::DerivedFromKey
            | IdStrategy::NamedGenerator { .. } => match obj.get("id").and_then(|v| v.as_str()) {
                Some(id) if !id.is_empty() => Ok(id.to_string()),
                _ => {
                    if let Some(message) = &self.named_id_generator_error {
                        return Err(EngineError::Operation(OperationError {
                            operation: "create".to_string(),
                            reason: "missing-id-generator".to_string(),
                            message: message.clone(),
                        }));
                    }
                    Ok(self.id_gen.generate())
                }
            },
        }
    }

    /// Apply `OptionalWithDefault` callbacks to a mutable entity object.
    ///
    /// # Semantics (matches TS)
    ///
    /// - **Field absent**: invoke default callback.
    ///   If no callback is registered for the id → `OperationError` (loud failure).
    /// - **Field present** (including explicit `null`): leave as-is.
    ///   The schema validator handles null rejection for `OptionalWithDefault` fields.
    ///
    /// Note: for `Optional` (no default), absent fields are always valid.
    fn apply_defaults(
        &self,
        obj: &mut Map<String, Value>,
        schema: &SchemaNode,
    ) -> Result<(), EngineError> {
        if let SchemaNode::Struct { fields } = schema {
            for StructField {
                name,
                schema: field_schema,
            } in fields
            {
                match field_schema {
                    SchemaNode::OptionalWithDefault {
                        inner,
                        default_callback_id,
                    } => {
                        if !obj.contains_key(name) {
                            // Field is ABSENT: apply default (fail loudly if not registered)
                            match self.callbacks.invoke_default(default_callback_id) {
                                Some(default_val) => {
                                    obj.insert(name.clone(), default_val);
                                }
                                None => {
                                    return Err(EngineError::Operation(OperationError {
                                        operation: "create".to_string(),
                                        reason: format!(
                                            "default callback '{}' is not registered for field '{}'",
                                            default_callback_id, name
                                        ),
                                        message: format!(
                                            "Default callback '{}' for field '{}' in collection '{}' \
                                             is not registered. Register it via CallbackRegistry \
                                             before creating entities.",
                                            default_callback_id, name, self.name
                                        ),
                                    }));
                                }
                            }
                        }
                        // Field present (even null): leave as-is; validator will check it.
                        // Recurse into inner struct if the field is now present
                        if let Some(Value::Object(nested)) = obj.get_mut(name) {
                            if let SchemaNode::Struct { .. } = inner.as_ref() {
                                let inner_clone = inner.as_ref().clone();
                                self.apply_defaults(nested, &inner_clone)?;
                            }
                        }
                    }
                    SchemaNode::Struct { .. } => {
                        // Recurse into nested struct
                        if let Some(Value::Object(nested)) = obj.get_mut(name) {
                            let schema_clone = field_schema.clone();
                            self.apply_defaults(nested, &schema_clone)?;
                        }
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }

    /// Decode and validate an entity value against the collection schema.
    ///
    /// Calls `decode_value` (mirrors `Schema.decodeUnknownEffect(schema)(entity)`):
    /// - Strips excess properties not declared in the schema.
    /// - Transforms fields with encoding transforms (e.g. `NumFromStr` "42" → 42).
    /// - Returns the fully decoded entity that is then stored.
    ///
    /// For `DerivedFromKey` id strategy, strips `id` before decoding and
    /// re-attaches it afterward — matching `validateEntityWithDerivedId` in TS.
    ///
    /// # Repeated decode on update — deliberate TS parity
    ///
    /// This function is called on every CRUD mutation, including updates, so the
    /// already-stored (decoded) entity is re-decoded after the update merge.  The
    /// TS engine does the same: `validateEntityWithDerivedId` calls
    /// `Schema.decodeUnknownEffect(schema)(merged)` on every mutation path in
    /// `create.ts` and `update.ts`.  For non-transform schemas the round-trip is
    /// identity; for `NumFromStr` the stored number value (42) will fail decode
    /// because `decodeUnknown` expects the encoded string form ("42") — identical
    /// to the TS observable behaviour.  **Do not change this to `validate_value`**
    /// on update paths; doing so would diverge from TS parity.
    fn validate_entity(&self, entity: Value, id: &str) -> Result<Value, EngineError> {
        let is_derived = matches!(self.descriptor.id_strategy, IdStrategy::DerivedFromKey);

        if is_derived {
            let stripped = strip_id_field(entity);
            let decoded = decode_value(&self.descriptor.schema, &stripped)?;
            let mut obj = decoded.as_object().cloned().unwrap_or_default();
            obj.insert("id".to_string(), Value::String(id.to_string()));
            Ok(Value::Object(obj))
        } else {
            decode_value(&self.descriptor.schema, &entity)
        }
    }

    fn validate_loaded_entity(&self, entity: &Value, id: &str) -> Result<(), EngineError> {
        if matches!(self.descriptor.id_strategy, IdStrategy::DerivedFromKey) {
            let stripped = strip_id_field(entity.clone());
            validate_value(&self.descriptor.schema, &stripped)?;
            if entity.get("id").and_then(Value::as_str) != Some(id) {
                return Err(EngineError::Validation(ValidationError {
                    message: "Reloaded record id does not match derived key".to_string(),
                    issues: vec![ValidationIssue {
                        field: "id".to_string(),
                        message: "Expected derived id to match the runtime key".to_string(),
                        value: entity.get("id").cloned(),
                        expected: Some(id.to_string()),
                        received: entity.get("id").and_then(Value::as_str).map(str::to_string),
                    }],
                }));
            }
            Ok(())
        } else {
            validate_value(&self.descriptor.schema, entity)
        }
    }

    /// Check unique constraints for a single entity against the current state.
    ///
    /// `exclude_id` is `Some(id)` on updates (the entity being updated is
    /// excluded from conflict checks) and `None` on creates.
    fn check_unique_constraints(
        &self,
        entity: &Value,
        exclude_id: Option<&str>,
    ) -> Result<(), EngineError> {
        self.check_unique_constraints_with_batch(entity, exclude_id, &Map::new())
    }

    /// Check unique constraints against state AND a batch constraint index.
    ///
    /// The `batch_index` maps `constraintKey` → entity-id (from prior entities
    /// in the same batch that have already passed checks).
    fn check_unique_constraints_with_batch(
        &self,
        entity: &Value,
        exclude_id: Option<&str>,
        batch_index: &Map<String, Value>,
    ) -> Result<(), EngineError> {
        let entity_obj = match entity.as_object() {
            Some(m) => m,
            None => return Ok(()),
        };

        let entity_id = entity_obj
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        for constraint_fields in &self.descriptor.unique_fields {
            let fields: Vec<String> = match constraint_fields {
                UniqueConstraintDescriptor::Single(f) => vec![f.clone()],
                UniqueConstraintDescriptor::Compound(fs) => fs.clone(),
            };

            // Extract values; skip constraint if any field is null/absent
            let mut constraint_values: Map<String, Value> = Map::new();
            let mut has_null = false;
            for field in &fields {
                let val = entity_obj
                    .get(field.as_str())
                    .cloned()
                    .unwrap_or(Value::Null);
                if val.is_null() {
                    has_null = true;
                    break;
                }
                constraint_values.insert(field.clone(), val);
            }

            if has_null {
                // TS: null/undefined values skip the constraint check
                continue;
            }

            let constraint_name = format!("unique_{}", fields.join("_"));
            let index_key = batch_constraint_key(&constraint_name, &fields, &constraint_values);

            // Check batch index first
            if let Some(Value::String(batch_existing_id)) = batch_index.get(&index_key) {
                if batch_existing_id.as_str() != entity_id
                    && exclude_id != Some(batch_existing_id.as_str())
                {
                    return Err(unique_constraint_error(
                        &self.name,
                        &constraint_name,
                        &fields,
                        constraint_values,
                        batch_existing_id,
                        entity_obj,
                    ));
                }
            }

            // Check against existing state using JS `===` semantics (js_eq).
            // Primitives: value equality (same as JS ===).
            // Objects/arrays: never equal across JSON boundary (identity semantics).
            // Practical implication: unique constraints on object-valued fields
            // never trigger; use primitive-valued fields for unique constraints.
            for (existing_id, existing) in &self.state {
                if exclude_id == Some(existing_id.as_str()) || existing_id.as_str() == entity_id {
                    continue;
                }

                let existing_obj = match existing.as_object() {
                    Some(m) => m,
                    None => continue,
                };

                let all_match = fields.iter().all(|f| {
                    match (
                        existing_obj.get(f.as_str()),
                        constraint_values.get(f.as_str()),
                    ) {
                        (Some(a), Some(b)) => js_eq(a, b),
                        _ => false,
                    }
                });

                if all_match {
                    return Err(unique_constraint_error(
                        &self.name,
                        &constraint_name,
                        &fields,
                        constraint_values,
                        existing_id,
                        entity_obj,
                    ));
                }
            }
        }

        Ok(())
    }

    /// Check unique constraints for a proposed entity in an `update_many` or `upsert_many`
    /// context, where multiple entities in the same batch may be proposed simultaneously.
    ///
    /// Checks `entity` against:
    /// 1. All entities in `self.state` that are NOT in `updating_ids` (the pre-update
    ///    state minus the entities being replaced).
    /// 2. All prior proposed entities already added to `proposed_index`.
    ///
    /// This catches conflicts where two batch members both propose the same unique value
    /// (which per-entity checks against the unchanged state cannot detect).
    fn check_unique_constraints_update_batch(
        &self,
        entity: &Value,
        entity_id: &str,
        updating_ids: &HashSet<String>,
        proposed_index: &Map<String, Value>,
    ) -> Result<(), EngineError> {
        let entity_obj = match entity.as_object() {
            Some(m) => m,
            None => return Ok(()),
        };

        for constraint_fields in &self.descriptor.unique_fields {
            let fields: Vec<String> = match constraint_fields {
                UniqueConstraintDescriptor::Single(f) => vec![f.clone()],
                UniqueConstraintDescriptor::Compound(fs) => fs.clone(),
            };

            let mut constraint_values: Map<String, Value> = Map::new();
            let mut has_null = false;
            for field in &fields {
                let val = entity_obj
                    .get(field.as_str())
                    .cloned()
                    .unwrap_or(Value::Null);
                if val.is_null() {
                    has_null = true;
                    break;
                }
                constraint_values.insert(field.clone(), val);
            }
            if has_null {
                continue;
            }

            let constraint_name = format!("unique_{}", fields.join("_"));
            let index_key = batch_constraint_key(&constraint_name, &fields, &constraint_values);

            // 1. Check proposed_index (other proposed entities in this batch)
            if let Some(Value::String(prior_id)) = proposed_index.get(&index_key) {
                if prior_id.as_str() != entity_id {
                    return Err(unique_constraint_error(
                        &self.name,
                        &constraint_name,
                        &fields,
                        constraint_values,
                        prior_id,
                        entity_obj,
                    ));
                }
            }

            // 2. Check current state, excluding all entities being updated in this batch.
            // Uses js_eq for JS `===` semantics (primitives: value equality;
            // objects/arrays: never equal across boundary).
            for (existing_id, existing) in &self.state {
                // Skip entities being replaced (their old values don't count)
                if updating_ids.contains(existing_id) {
                    continue;
                }
                if existing_id.as_str() == entity_id {
                    continue;
                }

                let existing_obj = match existing.as_object() {
                    Some(m) => m,
                    None => continue,
                };

                let all_match = fields.iter().all(|f| {
                    match (
                        existing_obj.get(f.as_str()),
                        constraint_values.get(f.as_str()),
                    ) {
                        (Some(a), Some(b)) => js_eq(a, b),
                        _ => false,
                    }
                });

                if all_match {
                    return Err(unique_constraint_error(
                        &self.name,
                        &constraint_name,
                        &fields,
                        constraint_values,
                        existing_id,
                        entity_obj,
                    ));
                }
            }
        }

        Ok(())
    }

    /// Build a batch constraint index key and add entity's values to the index.
    fn add_to_batch_constraint_index(&self, entity: &Value, batch_index: &mut Map<String, Value>) {
        let entity_obj = match entity.as_object() {
            Some(m) => m,
            None => return,
        };
        let entity_id = entity_obj
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        for constraint_fields in &self.descriptor.unique_fields {
            let fields: Vec<String> = match constraint_fields {
                UniqueConstraintDescriptor::Single(f) => vec![f.clone()],
                UniqueConstraintDescriptor::Compound(fs) => fs.clone(),
            };

            let mut constraint_values: Map<String, Value> = Map::new();
            let mut has_null = false;
            for field in &fields {
                let val = entity_obj
                    .get(field.as_str())
                    .cloned()
                    .unwrap_or(Value::Null);
                if val.is_null() {
                    has_null = true;
                    break;
                }
                constraint_values.insert(field.clone(), val);
            }

            if has_null {
                continue;
            }

            let constraint_name = format!("unique_{}", fields.join("_"));
            let key = batch_constraint_key(&constraint_name, &fields, &constraint_values);
            batch_index.insert(key, Value::String(entity_id.to_string()));
        }
    }

    /// Find the first entity matching ALL fields in `where_obj`.
    ///
    /// Field equality uses JS `===` semantics via `js_eq`:
    /// - Primitives (string, number, boolean, null): value equality.
    /// - Objects / arrays: never equal across the JSON boundary.
    ///
    /// TS reference: `findByWhere` in `upsert.ts` uses `entity[key] !== value`.
    fn find_by_where(&self, where_obj: &Map<String, Value>) -> Option<String> {
        // Fast path: id lookup
        if let Some(Value::String(id)) = where_obj.get("id") {
            let candidate = self.state.get(id.as_str())?;
            let candidate_obj = candidate.as_object()?;
            let all_match = where_obj.iter().all(|(k, v)| {
                candidate_obj
                    .get(k.as_str())
                    .map(|cv| js_eq(cv, v))
                    .unwrap_or(false)
            });
            return if all_match { Some(id.clone()) } else { None };
        }

        // Slow path: scan
        for (id, entity) in &self.state {
            let entity_obj = match entity.as_object() {
                Some(m) => m,
                None => continue,
            };
            let all_match = where_obj.iter().all(|(k, v)| {
                entity_obj
                    .get(k.as_str())
                    .map(|ev| js_eq(ev, v))
                    .unwrap_or(false)
            });
            if all_match {
                return Some(id.clone());
            }
        }

        None
    }

    /// Validate that an upsert where clause targets `id` or a declared unique field.
    fn validate_upsert_where(&self, where_obj: &Map<String, Value>) -> Result<(), EngineError> {
        let where_keys: Vec<&str> = where_obj.keys().map(|k| k.as_str()).collect();

        if where_keys.contains(&"id") {
            return Ok(());
        }

        for constraint in &self.descriptor.unique_fields {
            let fields: Vec<String> = match constraint {
                UniqueConstraintDescriptor::Single(f) => vec![f.clone()],
                UniqueConstraintDescriptor::Compound(fs) => fs.clone(),
            };
            if fields.iter().all(|f| where_keys.contains(&f.as_str())) {
                return Ok(());
            }
        }

        Err(EngineError::Validation(ValidationError {
            message: "Upsert where clause must target a unique field or id".to_string(),
            issues: vec![ValidationIssue {
                field: "where".to_string(),
                message: format!(
                    "Where clause does not match any declared unique field in collection '{}'",
                    self.name
                ),
                value: Some(Value::Object(where_obj.clone())),
                expected: None,
                received: None,
            }],
        }))
    }
}

// ── Module-private helpers ────────────────────────────────────────────────────

fn require_object(v: Value, context: &str) -> Result<Map<String, Value>, EngineError> {
    match v {
        Value::Object(m) => Ok(m),
        _ => Err(EngineError::Validation(ValidationError {
            message: format!("{context} must be a JSON object"),
            issues: vec![ValidationIssue {
                field: "(root)".to_string(),
                message: format!("{context} must be a JSON object"),
                value: None,
                expected: Some("object".to_string()),
                received: None,
            }],
        })),
    }
}

fn not_found(collection: &str, id: &str) -> EngineError {
    EngineError::NotFound(NotFoundError {
        collection: collection.to_string(),
        id: id.to_string(),
        message: format!(
            "Entity with id \"{}\" not found in collection \"{}\"",
            id, collection
        ),
    })
}

/// Build an `OperationError` matching the exact TS `forbiddenOp` shape:
///
/// ```ts
/// new OperationError({
///   operation: opName,
///   reason: "append-only",
///   message: `Operation '${opName}' is not allowed on append-only collection '${collectionName}'`,
/// })
/// ```
fn callback_abort_error(operation: &str) -> EngineError {
    EngineError::Operation(OperationError {
        operation: operation.to_owned(),
        reason: "callback-aborted".to_owned(),
        message: "Callback evaluation aborted before mutation".to_owned(),
    })
}

fn append_only_error(operation: &str, collection: &str) -> EngineError {
    EngineError::Operation(OperationError {
        operation: operation.to_string(),
        reason: "append-only".to_string(),
        message: format!(
            "Operation '{}' is not allowed on append-only collection '{}'",
            operation, collection
        ),
    })
}

fn strip_id_field(value: Value) -> Value {
    match value {
        Value::Object(mut m) => {
            m.remove("id");
            Value::Object(m)
        }
        v => v,
    }
}

/// Strip computed field names from an update/create payload.
fn strip_computed(value: &Value, names: &HashSet<String>) -> Value {
    if names.is_empty() {
        return value.clone();
    }
    match value.as_object() {
        Some(m) => {
            let filtered: Map<String, Value> = m
                .iter()
                .filter(|(k, _)| !names.contains(*k))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            Value::Object(filtered)
        }
        None => value.clone(),
    }
}

/// Detect whether the schema declares a top-level `deletedAt` optional field.
fn schema_has_deleted_at(schema: &SchemaNode) -> bool {
    if let SchemaNode::Struct { fields } = schema {
        fields.iter().any(|f| {
            f.name == "deletedAt"
                && matches!(
                    &f.schema,
                    SchemaNode::Optional(_)
                        | SchemaNode::OptionalWithDefault { .. }
                        | SchemaNode::NullOr(_)
                )
        })
    } else {
        false
    }
}

/// Build the batch constraint index key for a given constraint + values.
fn batch_constraint_key(
    constraint_name: &str,
    fields: &[String],
    values: &Map<String, Value>,
) -> String {
    let vals: Vec<String> = fields
        .iter()
        .map(|f| serde_json::to_string(&values[f]).unwrap_or_default())
        .collect();
    format!("{}:{}", constraint_name, vals.join("\x00"))
}

/// Build a `UniqueConstraintError` with the exact TS message format.
fn unique_constraint_error(
    collection: &str,
    constraint_name: &str,
    fields: &[String],
    values: Map<String, Value>,
    existing_id: &str,
    entity_obj: &Map<String, Value>,
) -> EngineError {
    let values_json = serde_json::to_string(&Value::Object(
        entity_obj
            .iter()
            .filter(|(k, _)| fields.contains(k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    ))
    .unwrap_or_default();
    EngineError::UniqueConstraint(Box::new(UniqueConstraintError {
        collection: collection.to_string(),
        constraint: constraint_name.to_string(),
        fields: fields.to_vec(),
        values,
        existing_id: existing_id.to_string(),
        message: format!(
            "Unique constraint violation on {}: {} ({}) = {} already exists (id: {})",
            collection,
            constraint_name,
            fields.join(", "),
            values_json,
            existing_id,
        ),
    }))
}

/// Check whether applying `updates` to `existing` would produce any change.
///
/// Returns `Err` when a deep_merge_updates call itself fails (e.g. unregistered
/// `$removeBy` callback). That error should propagate up rather than silently
/// treating it as "unchanged".
fn would_update_change(
    existing: &Value,
    updates: &Value,
    registry: &CallbackRegistry,
) -> Result<bool, EngineError> {
    let updates_obj = match updates.as_object() {
        Some(m) => m,
        None => return Ok(false),
    };

    for (key, update_value) in updates_obj {
        // Any operator-containing update → assume would change
        if let Some(obj) = update_value.as_object() {
            if obj.keys().any(|k| k.starts_with('$')) {
                return Ok(true);
            }
        }

        // Direct value: compare to current using JS `===` semantics.
        // For primitives: value equality (correct).
        // For objects/arrays: js_eq is always false across the boundary, so
        // any object-valued field in the update is always treated as "would
        // change" (conservative safe default matching JS identity semantics).
        let current_value = existing.get(key);
        let is_same = current_value
            .map(|cv| js_eq(cv, update_value))
            .unwrap_or(false);
        if !is_same {
            let merged_field = deep_merge_updates(
                &existing.get(key).cloned().unwrap_or(Value::Null),
                update_value,
                registry,
            )?;
            let merged_same = existing
                .get(key)
                .map(|cv| js_eq(cv, &merged_field))
                .unwrap_or(false);
            if !merged_same {
                return Ok(true);
            }
        }
    }

    Ok(false)
}
