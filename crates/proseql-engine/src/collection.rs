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
use crate::clock::Clock;
use crate::descriptor::{
    CollectionDescriptor, IdStrategy, SchemaNode, StructField, UniqueConstraintDescriptor,
};
use crate::errors::{
    DuplicateKeyError, EngineError, NotFoundError, OperationError, UniqueConstraintError,
    ValidationError, ValidationIssue,
};
use crate::id_gen::IdGenerator;
use crate::operators::{
    deep_merge_updates, update_touches_unique_fields, validate_immutable_fields,
};
use crate::query::indexes::QueryIndexes;
use crate::validator::{decode_value, js_eq};

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
    /// Clock used to produce ISO 8601 UTC timestamps.
    clock: Box<dyn Clock>,
    /// Whether the schema declares an optional `deletedAt` field (soft-delete support).
    supports_soft_delete: bool,
    /// Set of computed field names to strip from create/update/upsert inputs.
    computed_field_names: HashSet<String>,
    /// Query-time acceleration indexes (equality + full-text search).
    /// Rebuilt from scratch after every atomic mutation.
    /// Private: callers use [`Collection::narrow_candidates`] instead.
    query_indexes: QueryIndexes,
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
        Self {
            name: name.into(),
            descriptor,
            state: IndexMap::new(),
            callbacks,
            id_gen,
            clock,
            supports_soft_delete,
            computed_field_names,
            query_indexes: QueryIndexes::new(),
        }
    }

    /// Rebuild all query indexes from the current entity snapshot.
    ///
    /// Called internally after every successful atomic mutation so indexes
    /// stay consistent.  O(n) per call; acceptable at U3 scope.
    fn rebuild_indexes(&mut self) {
        let entity_refs: Vec<(String, &Value)> =
            self.state.iter().map(|(id, v)| (id.clone(), v)).collect();
        self.query_indexes.rebuild(
            &entity_refs,
            &self.descriptor.indexes,
            &self.descriptor.search_index,
        );
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
    pub fn narrow_candidates(&self, where_clause: &Value) -> Option<Vec<String>> {
        let insertion_order = self.insertion_order();
        self.query_indexes
            .narrow_by_equality(where_clause, &insertion_order)
            .or_else(|| {
                self.query_indexes
                    .narrow_by_search(where_clause, &insertion_order)
            })
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
    /// 6. Check for duplicate id → `DuplicateKeyError`
    /// 7. Check unique constraints → `UniqueConstraintError`
    /// 8. Insert into state
    pub fn create(&mut self, input: Value) -> Result<Value, EngineError> {
        let mut obj = require_object(input, "create input")?;

        // Strip computed fields (they are derived, not persisted)
        for name in &self.computed_field_names {
            obj.remove(name);
        }

        let id = self.resolve_id(&obj)?;
        let now = self.clock.now_iso();

        // Always overwrite timestamps — mirrors TS unconditional spread:
        // `const raw = { ...sanitizedInput, id, createdAt: now, updatedAt: now }`
        obj.insert("id".to_string(), Value::String(id.clone()));
        obj.insert("createdAt".to_string(), Value::String(now.clone()));
        obj.insert("updatedAt".to_string(), Value::String(now.clone()));

        // Apply OptionalWithDefault callbacks for absent fields (fail loudly if missing)
        self.apply_defaults(&mut obj, &self.descriptor.schema.clone())?;

        // Validate against schema (handles DerivedFromKey stripping)
        let entity = self.validate_entity(Value::Object(obj), &id)?;

        // Duplicate id check
        if self.state.contains_key(&id) {
            return Err(EngineError::DuplicateKey(DuplicateKeyError {
                collection: self.name.clone(),
                field: "id".to_string(),
                value: id.clone(),
                existing_id: id,
                message: format!("Duplicate value for field 'id': \"{}\"", entity["id"]),
            }));
        }

        // Unique constraint checks
        self.check_unique_constraints(&entity, None)?;

        // Insert (appended at end in IndexMap)
        let stored_id = entity["id"].as_str().unwrap_or_default().to_string();
        self.state.insert(stored_id, entity.clone());

        // Rebuild query indexes after successful mutation
        self.rebuild_indexes();

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
        let now = self.clock.now_iso();
        let mut validated_entities: Vec<Value> = Vec::with_capacity(inputs.len());
        let mut skipped: Vec<SkippedEntry> = vec![];
        // Batch constraint index: constraintKey → id (for inter-batch dedup)
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

            // Strip computed fields (TS: sanitizedInput = stripComputedFromInput(input))
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

            // Insert resolved id into obj
            obj.insert("id".to_string(), Value::String(id.clone()));

            // TS skip data = { ...sanitizedInput, id } — stripped input WITH id, WITHOUT
            // auto-generated timestamps.  Save it NOW before we overwrite timestamps.
            let skip_data = Value::Object(obj.clone());

            // TS: const raw = { ...sanitizedInput, id, createdAt: now, updatedAt: now }
            // Always overwrite timestamps.
            obj.insert("createdAt".to_string(), Value::String(now.clone()));
            obj.insert("updatedAt".to_string(), Value::String(now.clone()));

            // Apply defaults
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

            // Validate schema
            // TS reason: `Validation failed: ${firstIssueMessage}`
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
                            data: skip_data, // TS: { ...sanitizedInput, id } (no timestamps)
                            reason,
                        });
                        continue;
                    }
                    return Err(e);
                }
            };

            // Duplicate id check against existing state and within-batch validated list.
            // TS reason: `Duplicate ID: ${id}`
            // TS skip data: { ...sanitizedInput, id } = skip_data
            if self.state.contains_key(&id) {
                let e = EngineError::DuplicateKey(DuplicateKeyError {
                    collection: self.name.clone(),
                    field: "id".to_string(),
                    value: id.clone(),
                    existing_id: id.clone(),
                    message: format!("Duplicate value for field 'id': \"{id}\""),
                });
                if skip_duplicates {
                    skipped.push(SkippedEntry {
                        data: skip_data,
                        reason: format!("Duplicate ID: {id}"),
                    });
                    continue;
                }
                return Err(e);
            }
            if validated_entities
                .iter()
                .any(|e| e["id"].as_str() == Some(&id))
            {
                let e = EngineError::DuplicateKey(DuplicateKeyError {
                    collection: self.name.clone(),
                    field: "id".to_string(),
                    value: id.clone(),
                    existing_id: id.clone(),
                    message: format!("Duplicate value for field 'id': \"{id}\" (in batch)"),
                });
                if skip_duplicates {
                    skipped.push(SkippedEntry {
                        data: skip_data,
                        reason: format!("Duplicate ID: {id}"),
                    });
                    continue;
                }
                return Err(e);
            }

            // Unique constraints against state + batch.
            // TS reason: `Unique constraint violation: ${error.message}`
            // TS skip data: entity (the validated entity WITH timestamps)
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
                        data: entity, // TS: entity (WITH timestamps)
                        reason,
                    });
                    continue;
                }
                return Err(e);
            }

            // Add to batch index
            self.add_to_batch_constraint_index(&entity, &mut batch_constraint_index);
            validated_entities.push(entity);
        }

        // Atomic apply: only if nothing failed (or skip_duplicates collected failures)
        let created: Vec<Value> = validated_entities.clone();
        for entity in validated_entities {
            let id = entity["id"].as_str().unwrap_or_default().to_string();
            self.state.insert(id, entity);
        }

        // Rebuild query indexes after successful batch mutation
        self.rebuild_indexes();

        Ok(CreateManyResult { created, skipped })
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
        // Append-only guard
        if self.descriptor.append_only {
            return Err(append_only_error("update", &self.name));
        }

        // Immutability guard
        validate_immutable_fields(&updates)?;

        // Strip computed fields
        let updates = strip_computed(&updates, &self.computed_field_names);

        // Look up existing
        let existing = self
            .state
            .get(id)
            .ok_or_else(|| not_found(&self.name, id))?
            .clone();

        // Merge updates
        let mut merged = deep_merge_updates(&existing, &updates, &self.callbacks)?;

        // Auto-set updatedAt if not in updates
        let explicitly_sets_updated_at = updates
            .as_object()
            .map(|m| m.contains_key("updatedAt"))
            .unwrap_or(false);
        if !explicitly_sets_updated_at {
            if let Value::Object(ref mut m) = merged {
                m.insert("updatedAt".to_string(), Value::String(self.clock.now_iso()));
            }
        }

        // Validate
        let validated = self.validate_entity(merged, id)?;

        // Unique constraint check — only when update actually touches a unique field
        if update_touches_unique_fields(&updates, &self.descriptor.unique_fields) {
            self.check_unique_constraints(&validated, Some(id))?;
        }

        // Replace in state (IndexMap preserves insertion position on update)
        self.state.insert(id.to_string(), validated.clone());

        // Rebuild query indexes after successful mutation
        self.rebuild_indexes();

        Ok(validated)
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
        if self.descriptor.append_only {
            return Err(append_only_error("updateMany", &self.name));
        }

        validate_immutable_fields(&updates)?;
        let updates = strip_computed(&updates, &self.computed_field_names);

        let now = self.clock.now_iso();
        let explicitly_sets_updated_at = updates
            .as_object()
            .map(|m| m.contains_key("updatedAt"))
            .unwrap_or(false);

        // Find matching ids (collect first to avoid borrow conflicts)
        let matching_ids: Vec<String> = self
            .state
            .iter()
            .filter(|(_, v)| predicate(v))
            .map(|(k, _)| k.clone())
            .collect();

        if matching_ids.is_empty() {
            return Ok(UpdateManyResult::default());
        }

        // Validate all updates first (phase 1), then apply atomically (phase 2)
        let mut validated_pairs: Vec<(String, Value)> = Vec::with_capacity(matching_ids.len());

        for id in &matching_ids {
            let existing = self.state.get(id.as_str()).unwrap().clone();
            let mut merged = deep_merge_updates(&existing, &updates, &self.callbacks)?;
            if !explicitly_sets_updated_at {
                if let Value::Object(ref mut m) = merged {
                    m.insert("updatedAt".to_string(), Value::String(now.clone()));
                }
            }
            let validated = self.validate_entity(merged, id)?;
            validated_pairs.push((id.clone(), validated));
        }

        // Check unique constraints against the FULL proposed state:
        // for each proposed entity, exclude all entities being replaced from the
        // state check and include all OTHER proposed entities (via the batch index).
        // This catches conflicts where two batch members both propose the same
        // unique value — the per-entity checks in the old code missed this.
        if update_touches_unique_fields(&updates, &self.descriptor.unique_fields) {
            let updating_ids: HashSet<String> = matching_ids.iter().cloned().collect();
            let mut proposed_index: Map<String, Value> = Map::new();
            for (id, validated) in &validated_pairs {
                self.check_unique_constraints_update_batch(
                    validated,
                    id.as_str(),
                    &updating_ids,
                    &proposed_index,
                )?;
                self.add_to_batch_constraint_index(validated, &mut proposed_index);
            }
        }

        // Phase 2: atomic apply
        let mut updated = Vec::with_capacity(validated_pairs.len());
        for (id, validated) in validated_pairs {
            self.state.insert(id, validated.clone());
            updated.push(validated);
        }

        // Rebuild query indexes after successful batch mutation
        self.rebuild_indexes();

        let count = updated.len();
        Ok(UpdateManyResult { count, updated })
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

        if soft && !self.supports_soft_delete {
            return Err(EngineError::Operation(OperationError {
                operation: "soft delete".to_string(),
                reason: "Entity does not have a deletedAt field".to_string(),
                message: "Entity does not have a deletedAt field".to_string(),
            }));
        }

        if soft {
            let now = self.clock.now_iso();
            let mut soft_deleted: Map<String, Value> =
                entity.as_object().cloned().unwrap_or_default();

            // Preserve original deletedAt and updatedAt on repeated soft delete
            let already_deleted = soft_deleted
                .get("deletedAt")
                .map(|v| !v.is_null())
                .unwrap_or(false);
            if !already_deleted {
                soft_deleted.insert("deletedAt".to_string(), Value::String(now.clone()));
                soft_deleted.insert("updatedAt".to_string(), Value::String(now));
            }

            let soft_deleted_value = Value::Object(soft_deleted);
            self.state
                .insert(id.to_string(), soft_deleted_value.clone());
            self.rebuild_indexes();
            Ok(soft_deleted_value)
        } else {
            // Hard delete: shift_remove preserves insertion order of remaining entries
            let removed = self.state.shift_remove(id).unwrap();
            self.rebuild_indexes();
            Ok(removed)
        }
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
                self.state.insert(id.clone(), result.clone());
                deleted.push(result);
            }
        } else {
            for id in &matching_ids {
                if let Some(entity) = self.state.shift_remove(id.as_str()) {
                    deleted.push(entity);
                }
            }
        }

        // Rebuild indexes after successful batch delete
        self.rebuild_indexes();

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
        if self.descriptor.append_only {
            return Err(append_only_error("upsert", &self.name));
        }

        let where_obj = require_object(where_clause, "upsert where")?;
        let create_obj = require_object(create_data, "upsert create")?;

        // Validate where clause targets a unique field or id
        self.validate_upsert_where(&where_obj)?;

        // Find existing entity
        let existing_id = self.find_by_where(&where_obj);

        if let Some(ref id) = existing_id {
            let id = id.clone();
            // UPDATE PATH: validate immutable fields first, then update
            validate_immutable_fields(&update_data)?;
            let validated = self.update(&id, update_data)?;
            Ok(UpsertOutcome {
                entity: validated,
                action: UpsertAction::Updated,
            })
        } else {
            // CREATE PATH: where → create → id → timestamps
            //
            // TS source (`upsert.ts`):
            //   const id = typeof where.id === "string" ? where.id : generateId();
            //   const createData = { ...where, ...input.create, id, createdAt: now, updatedAt: now };
            //
            // The `id` comes ONLY from `where.id` or `generateId()`.  Any `id`
            // field in `create_data` is included in the spread but then
            // overwritten by the explicitly set `id` — it is NOT used as a
            // fallback.  Fix: remove the `or_else` fallback.
            let mut base: Map<String, Value> = where_obj.clone();

            // create_data fields override where fields
            for (k, v) in create_obj {
                base.insert(k, v);
            }

            // Strip computed fields
            for name in &self.computed_field_names.clone() {
                base.remove(name);
            }

            // id: where.id if it is a string, else generateId() — no fallback to create_data.id
            let id = where_obj
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| self.id_gen.generate());

            // Always overwrite id (matches TS explicit `id` in the spread)
            base.insert("id".to_string(), Value::String(id));

            let entity = self.create(Value::Object(base))?;
            Ok(UpsertOutcome {
                entity,
                action: UpsertAction::Created,
            })
        }
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
        if self.descriptor.append_only {
            return Err(append_only_error("upsertMany", &self.name));
        }

        let now = self.clock.now_iso();

        // Phase 1: Categorize all inputs without touching self.state.
        // All WHERE lookups use the initial snapshot (no cross-batch visibility).
        let mut candidates_create: Vec<Value> = vec![]; // schema-validated, ready to insert
        let mut candidates_update: Vec<(String, Value)> = vec![]; // (id, validated proposed entity)
        let mut result_unchanged: Vec<Value> = vec![];

        for (where_clause, create_data, update_data) in inputs {
            let where_obj = require_object(where_clause, "upsertMany where")?;
            let create_obj = require_object(create_data, "upsertMany create")?;

            self.validate_upsert_where(&where_obj)?;

            if let Some(id) = self.find_by_where(&where_obj) {
                // UPDATE PATH: validate but don't mutate
                let existing = self.state.get(id.as_str()).unwrap().clone();

                // TS: strip computed fields before any change detection or immutable
                // validation, mirroring `stripComputedFromUpdates` in `update.ts`.
                // A payload that contains only computed field names must be classified
                // as "unchanged" after stripping, not dispatched to the update path.
                // Without this ordering, computed-only payloads would be misclassified
                // as "would change" (the computed key is absent from `existing`, so
                // `would_update_change` sees an apparent new-field write).
                let updates = strip_computed(&update_data, &self.computed_field_names);

                // Detect unchanged using the sanitized (post-computed-strip) updates.
                let would_change = would_update_change(&existing, &updates, &self.callbacks)?;
                if !would_change {
                    result_unchanged.push(existing);
                    continue;
                }

                validate_immutable_fields(&updates)?;
                let mut merged = deep_merge_updates(&existing, &updates, &self.callbacks)?;
                let explicitly_sets_updated_at = updates
                    .as_object()
                    .map(|m| m.contains_key("updatedAt"))
                    .unwrap_or(false);
                if !explicitly_sets_updated_at {
                    if let Value::Object(ref mut m) = merged {
                        m.insert("updatedAt".to_string(), Value::String(now.clone()));
                    }
                }
                let validated = self.validate_entity(merged, &id)?;
                candidates_update.push((id, validated));
            } else {
                // CREATE PATH: build + validate candidate entity
                let mut base: Map<String, Value> = where_obj.clone();
                for (k, v) in create_obj {
                    base.insert(k, v);
                }
                for name in &self.computed_field_names.clone() {
                    base.remove(name);
                }
                // id: where.id if string, else generateId() — NO fallback to base.id.
                // Mirrors TS: `const id = typeof where.id === "string" ? where.id : generateId()`
                // Any `id` in create_data (base) is overwritten by the explicitly-set `id` below.
                let id = where_obj
                    .get("id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| self.id_gen.generate());

                base.insert("id".to_string(), Value::String(id.clone()));
                // TS: always overwrite timestamps
                base.insert("createdAt".to_string(), Value::String(now.clone()));
                base.insert("updatedAt".to_string(), Value::String(now.clone()));

                // Apply OptionalWithDefault callbacks
                let schema = self.descriptor.schema.clone();
                self.apply_defaults(&mut base, &schema)?;

                // Schema validation
                let entity = self.validate_entity(Value::Object(base), &id)?;
                candidates_create.push(entity);
            }
        }

        // Phase 2a: Duplicate id check for creates
        {
            let mut seen_ids: HashSet<String> = HashSet::new();
            for entity in &candidates_create {
                let id = entity["id"].as_str().unwrap_or_default();
                // Conflict with existing state
                if self.state.contains_key(id) {
                    return Err(EngineError::DuplicateKey(DuplicateKeyError {
                        collection: self.name.clone(),
                        field: "id".to_string(),
                        value: id.to_string(),
                        existing_id: id.to_string(),
                        message: format!("Duplicate value for field 'id': \"{id}\""),
                    }));
                }
                // Conflict within the batch
                if !seen_ids.insert(id.to_string()) {
                    return Err(EngineError::DuplicateKey(DuplicateKeyError {
                        collection: self.name.clone(),
                        field: "id".to_string(),
                        value: id.to_string(),
                        existing_id: id.to_string(),
                        message: format!("Duplicate value for field 'id': \"{id}\" (in batch)"),
                    }));
                }
            }
        }

        // Phase 2b: Unique constraint checks for creates (against existing + batch)
        {
            let mut batch_index: Map<String, Value> = Map::new();
            for entity in &candidates_create {
                self.check_unique_constraints_with_batch(entity, None, &batch_index)?;
                self.add_to_batch_constraint_index(entity, &mut batch_index);
            }
        }

        // Phase 2c: Unique constraint checks for updates (against non-updating state +
        // all other proposed entities: already-processed updates + all creates)
        if !candidates_update.is_empty() && !self.descriptor.unique_fields.is_empty() {
            let updating_ids: HashSet<String> =
                candidates_update.iter().map(|(id, _)| id.clone()).collect();

            // Seed the combined proposed index with all create candidates first
            let mut combined_proposed: Map<String, Value> = Map::new();
            for entity in &candidates_create {
                self.add_to_batch_constraint_index(entity, &mut combined_proposed);
            }

            // Check each update candidate in order, adding it to the index after check
            for (id, validated) in &candidates_update {
                self.check_unique_constraints_update_batch(
                    validated,
                    id.as_str(),
                    &updating_ids,
                    &combined_proposed,
                )?;
                self.add_to_batch_constraint_index(validated, &mut combined_proposed);
            }
        }

        // Phase 3: Apply all atomically
        let created: Vec<Value> = candidates_create.clone();
        let updated: Vec<Value> = candidates_update.iter().map(|(_, e)| e.clone()).collect();

        for entity in candidates_create {
            let id = entity["id"].as_str().unwrap_or_default().to_string();
            self.state.insert(id, entity);
        }
        for (id, validated) in candidates_update {
            self.state.insert(id, validated);
        }

        // Rebuild query indexes after successful batch mutation
        self.rebuild_indexes();

        Ok(UpsertManyResult {
            created,
            updated,
            unchanged: result_unchanged,
        })
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /// Resolve the id for a new entity from the input object and `id_strategy`.
    fn resolve_id(&mut self, obj: &Map<String, Value>) -> Result<String, EngineError> {
        match &self.descriptor.id_strategy {
            IdStrategy::Provided
            | IdStrategy::DerivedFromKey
            | IdStrategy::NamedGenerator { .. } => match obj.get("id").and_then(|v| v.as_str()) {
                Some(id) if !id.is_empty() => Ok(id.to_string()),
                _ => Ok(self.id_gen.generate()),
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
        message: format!("Entity '{}' not found in collection '{}'", id, collection),
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
