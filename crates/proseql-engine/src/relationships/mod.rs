//! U4 — Relationship semantics: population, FK validation, and relationship-aware
//! CRUD operations.
//!
//! # Platform contract
//! No `std::time`, no I/O, no panics.  All error paths return [`EngineError`].
//! WASM-safe: no `SystemTime`, no platform I/O.
//!
//! # TS source references
//! - `packages/core/src/operations/relationships/populate-stream.ts`
//! - `packages/core/src/operations/crud/create-with-relationships.ts`
//! - `packages/core/src/operations/crud/update-with-relationships.ts`
//! - `packages/core/src/operations/crud/delete-with-relationships.ts`
//! - `packages/core/src/types/crud-relationship-types.ts`  (`isRelationshipOperation`)
//!
//! # Design decisions
//!
//! ## FK validation
//! `Database::create` and `Database::update` both validate Ref FK fields after
//! the schema-level mutation.  Non-null string FK values must point to an existing
//! entity in the target collection.  On FK failure after an update, the owning
//! entity's state is restored to its pre-mutation snapshot (mirrors TS semantics
//! where the mutation is atomic: either all constraints pass or nothing changes).
//!
//! ## Population pipeline order
//! `Database::query` runs filter/sort/paginate without selection, then applies
//! population, then applies `QueryInput.select`.  This lets `select` project
//! into populated objects.
//!
//! ## Dangling reference semantics
//! A Ref FK with a string value that points to a non-existent entity returns
//! `DanglingReferenceError` (canonical populate path).  Null / absent / non-string
//! FKs are silently absent (not an error).
//!
//! ## create_with_relationships ordering
//! Parent ID is reserved BEFORE any nested creates so inverse child entities can
//! hold an FK pointing to the not-yet-created parent:
//!   1. Reserve parent id
//!   2. Ref $create/$connectOrCreate → create nested, inject FK into base_data
//!   3. Inverse $create/$createMany → create children with FK=parent_id (BEFORE parent)
//!   4. Inverse $connectOrCreate: existing → deferred connect; missing → create child before parent
//!   5. Ref $connect → resolve, inject FK into base_data; propagate ForeignKeyError if not found
//!   6. FK-validate assembled base_data
//!   7. Create parent (with reserved id in base_data)
//!   8. Inverse deferred connects → patch_raw FK=parent_id on target entities
//!
//! ## update_with_relationships semantics
//! Steps 5-9 (target mutations) execute BEFORE step 10 (validate+write parent).
//! After applying base updates to the parent, ALL Ref FKs on the resulting entity
//! are validated.  If FK validation fails, the parent entity is restored to its
//! pre-step-10 snapshot; target side-effects from steps 5-9 persist.
//!
//! ## delete_with_relationships — sequential (TS artifact)
//! For SINGLE entity delete, relationship entries are processed in descriptor order:
//! cascade/set_null are applied IMMEDIATELY; restrict violations are collected.
//! AFTER the loop, if any restrict violations exist, the operation fails.
//! This means cascade side-effects on earlier entries persist even when a later
//! restrict fires (exact TS `processRelationshipCascades` behaviour).
//!
//! ## delete_many_with_relationships — fully atomic
//! ALL restrict violations are checked before ANY mutation (different from single).
//!
//! ## Two separate inverse FK resolvers
//! Population uses `resolve_inv_fk_population`:
//!   explicit → reverse-Ref explicit FK only → singularize SOURCE collection.
//! CRUD uses `resolve_inv_fk_crud`:
//!   explicit → reverse-Ref explicit FK or `<relName>Id` → `None` (no singularize).
//!
//! ## Cascade results keyed by target collection
//! Mirrors TS: `cascadeResults[targetCollection]` (not relationship name).
//!
//! ## CascadeSoft: direct trusted patch
//! Soft-cascade patches `deletedAt`/`updatedAt` directly via `Collection::patch_raw`
//! without schema validation (mirrors TS direct `Ref.update` approach).
//!
//! ## Nested depth limit
//! Maximum population depth 5; at depth > 5 entities are returned un-populated.

use std::collections::HashMap;
use std::sync::Arc;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use self::helpers::{col_nf, fk_field_names, payload_touches_fk_field, validate_fk};
use self::populate::apply_populate;
use crate::callbacks::CallbackRegistry;
use crate::collection::Collection;
use crate::errors::EngineError;
use crate::query::{
    apply_selection, execute_cursor_query, execute_query, CursorConfig, CursorPageResult,
    QueryInput,
};
#[cfg(not(target_arch = "wasm32"))]
use crate::reactive::ThreadReactiveScheduler;
#[cfg(target_arch = "wasm32")]
use crate::reactive::UnsupportedReactiveScheduler;
use crate::reactive::{ChangeOperation, ReactiveHub, ReactiveScheduler};
use crate::transactions::ActiveTransactionKind;

// ── Public types ──────────────────────────────────────────────────────────────

/// Cascade behaviour for a relationship when its owning entity is deleted.
///
/// Mirrors the TS `CascadeOption` from `crud-relationship-types.ts`.
/// Serializes with `snake_case` to match TS string literals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CascadeOption {
    /// Leave related entities untouched (default when absent from `include`).
    Preserve,
    /// Fail with `ValidationError` if any related entities exist.
    Restrict,
    /// Hard-delete related entities (or soft-delete when `opts.soft=true`).
    Cascade,
    /// Set the FK field on related entities to `null`.
    #[serde(rename = "set_null")]
    SetNull,
    /// Soft-delete related entities (set `deletedAt`); always soft regardless of `opts.soft`.
    CascadeSoft,
}

/// Metadata for a set of related entities that were cascaded.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CascadedCollection {
    /// Number of entities affected.
    pub count: usize,
    /// IDs of the affected entities.
    pub ids: Vec<String>,
}

/// Result of [`Database::delete_with_relationships`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWithRelResult {
    /// The deleted (or soft-deleted) entity.
    pub deleted: Value,
    /// Cascade results keyed by **target collection name** (not relationship name).
    /// Omitted from serialization when no cascade operations were performed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cascaded: Option<HashMap<String, CascadedCollection>>,
}

/// Result of [`Database::delete_many_with_relationships`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteManyWithRelResult {
    /// Number of owner entities deleted.
    pub count: usize,
    /// The deleted owner entities.
    pub deleted: Vec<Value>,
    /// Aggregate cascade results keyed by **target collection name**.
    /// Omitted from serialization when no cascade operations were performed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cascaded: Option<HashMap<String, CascadedCollection>>,
}

/// Options controlling relationship cascade on delete operations.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeleteRelationshipsOptions {
    /// If `true`, the owner entity is soft-deleted instead of hard-deleted.
    /// Also causes `Cascade` to soft-delete related entities (mirrors TS `opts.soft`).
    pub soft: bool,
    /// Maximum number of matching owner entities (delete_many only).
    /// `None` or `Some(0)` = no cap (mirrors TS `options.limit`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    /// Per-relationship cascade behaviour.
    /// Relationships absent from this map default to [`CascadeOption::Preserve`].
    pub include: HashMap<String, CascadeOption>,
}

// ── Database ──────────────────────────────────────────────────────────────────

/// Multi-collection database with relationship-aware CRUD and population.
pub struct Database {
    pub(crate) collections: IndexMap<String, Collection>,
    pub(crate) registry: Arc<CallbackRegistry>,
    pub(crate) reactive: ReactiveHub,
    pub(crate) active_transaction_kind: ActiveTransactionKind,
    pub(crate) reactive_event_suppression_depth: usize,
}

impl Database {
    /// Create a new `Database` from a named, ordered collection map.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new(collections: IndexMap<String, Collection>, registry: Arc<CallbackRegistry>) -> Self {
        Self::new_with_reactive_scheduler(
            collections,
            registry,
            Arc::new(ThreadReactiveScheduler::default()) as Arc<dyn ReactiveScheduler>,
        )
    }

    /// Create a new `Database` from a named, ordered collection map.
    #[cfg(target_arch = "wasm32")]
    pub fn new(collections: IndexMap<String, Collection>, registry: Arc<CallbackRegistry>) -> Self {
        Self::new_with_reactive_scheduler(
            collections,
            registry,
            Arc::new(UnsupportedReactiveScheduler) as Arc<dyn ReactiveScheduler>,
        )
    }

    /// Read-only reference to a named collection, or `None` if absent.
    pub fn collection(&self, name: &str) -> Option<&Collection> {
        self.collections.get(name)
    }

    // ── Plain CRUD (with FK validation on create/update) ─────────────────────

    /// Create an entity, validating Ref FK fields after schema decoding.
    ///
    /// Non-null FK values are coerced via `String(value)` (JS semantics) and
    /// looked up in the target collection.  Null and absent FKs are skipped.
    ///
    /// # TS error precedence
    ///
    /// TS order: schema decode first, THEN FK validation.  This means:
    /// - A numeric FK on a `Str`-typed field fails with `ValidationError` (schema
    ///   rejects before FK check).
    /// - A numeric FK on an `Unknown`-typed field passes schema, then fails FK
    ///   lookup (coerced to string "42") → `ForeignKeyError`.
    ///
    /// Implementation:
    ///  1. Call `Collection::create(data)` — schema validation, defaults, decode.
    ///  2. If schema fails → return `ValidationError` (entity never created).
    ///  3. FK-validate the DECODED entity.
    ///  4. If FK fails → `delete_raw` the just-created entity, return `ForeignKeyError`.
    pub fn create(&mut self, collection: &str, data: Value) -> Result<Value, EngineError> {
        let snapshot = self
            .collections
            .get(collection)
            .ok_or_else(|| col_nf(collection))?
            .snapshot_state();

        // Step 1 & 2: schema / defaults / decode.  Entity is created in state on success.
        let entity = self
            .collections
            .get_mut(collection)
            .ok_or_else(|| col_nf(collection))?
            .create_no_post_hooks(data)?;

        // Step 3: FK-validate the decoded entity.
        let rels = {
            self.collections
                .get(collection)
                .ok_or_else(|| col_nf(collection))?
                .descriptor
                .relationships
                .clone()
        };
        if let Err(fk_err) = validate_fk(collection, &rels, &entity, &self.collections) {
            if let Some(col) = self.collections.get_mut(collection) {
                col.restore_state(snapshot);
            }
            return Err(fk_err);
        }

        if let Some(owner) = self.collections.get(collection) {
            owner.run_after_create_entity(entity.clone());
        }

        self.sync_reactive_snapshots();
        self.emit_owner_change_event(collection, ChangeOperation::Create);

        Ok(entity)
    }

    /// Update an entity by id, validating Ref FK fields after schema mutation.
    ///
    /// If the schema-validated result would violate an FK constraint, the entity
    /// is restored to its pre-update state and a `ForeignKeyError` is returned.
    /// The only state that changes is the owner entity — other collections are
    /// not touched.
    pub fn update(
        &mut self,
        collection: &str,
        id: &str,
        updates: Value,
    ) -> Result<Value, EngineError> {
        // Snapshot entity BEFORE mutation so we can restore on FK failure.
        let snapshot = self
            .collections
            .get(collection)
            .ok_or_else(|| col_nf(collection))?
            .snapshot_entity(id);

        let rels = self
            .collections
            .get(collection)
            .ok_or_else(|| col_nf(collection))?
            .descriptor
            .relationships
            .clone();
        let internal = self
            .collections
            .get_mut(collection)
            .ok_or_else(|| col_nf(collection))?
            .update_internal(id, updates)?;

        if payload_touches_fk_field(&internal.transformed_updates, &fk_field_names(&rels)) {
            if let Err(fk_err) =
                validate_fk(collection, &rels, &internal.current, &self.collections)
            {
                if let Some(col) = self.collections.get_mut(collection) {
                    col.restore_entity_snapshot(id, snapshot);
                }
                return Err(fk_err);
            }
        }

        if let Some(owner) = self.collections.get(collection) {
            owner.run_after_update_context(
                id,
                internal.previous.clone(),
                internal.current.clone(),
                internal.transformed_updates.clone(),
            );
        }

        self.sync_reactive_snapshots();
        self.emit_owner_change_event(collection, ChangeOperation::Update);

        Ok(internal.current)
    }

    /// Hard-delete an entity by id (no cascade).
    pub fn delete(&mut self, collection: &str, id: &str) -> Result<Value, EngineError> {
        let deleted = self
            .collections
            .get_mut(collection)
            .ok_or_else(|| col_nf(collection))?
            .delete(id)?;
        self.sync_reactive_snapshots();
        self.emit_owner_change_event(collection, ChangeOperation::Delete);
        Ok(deleted)
    }

    /// Query with optional population.
    ///
    /// Pipeline order: filter/sort/paginate → populate → select.
    pub fn query(
        &self,
        collection: &str,
        input: QueryInput,
        populate: Option<Value>,
    ) -> Result<Vec<Value>, EngineError> {
        // Step 1 — pipeline without selection
        let results = {
            let col = self
                .collections
                .get(collection)
                .ok_or_else(|| col_nf(collection))?;
            let mut q = input.clone();
            q.select = None;
            execute_query(col, &q, &self.registry)?
        };

        // Step 2 — population (read-only across all collections)
        let populated = match populate {
            Some(ref cfg) => apply_populate(results, cfg, collection, &self.collections, 0)?,
            None => results,
        };

        // Step 3 — selection from original QueryInput
        Ok(populated
            .iter()
            .map(|e| apply_selection(e, input.select.as_ref()))
            .collect())
    }

    /// Cursor-paginated query with optional population and selection.
    ///
    /// Pipeline order: cursor-paginate → populate → select → return CursorPageResult.
    /// `page_info` is preserved from the cursor stage.
    pub fn query_cursor(
        &self,
        collection: &str,
        input: &QueryInput,
        cursor_cfg: &CursorConfig,
        populate: Option<Value>,
    ) -> Result<CursorPageResult, EngineError> {
        // Step 1 — cursor pipeline without selection
        let raw_page = {
            let col = self
                .collections
                .get(collection)
                .ok_or_else(|| col_nf(collection))?;
            let mut q = input.clone();
            q.select = None;
            execute_cursor_query(col, &q, cursor_cfg, &self.registry)?
        };

        // Step 2 — population (read-only across all collections)
        let populated_items = match populate {
            Some(ref cfg) => apply_populate(raw_page.items, cfg, collection, &self.collections, 0)?,
            None => raw_page.items,
        };

        // Step 3 — apply selection
        let selected_items = populated_items
            .iter()
            .map(|e| apply_selection(e, input.select.as_ref()))
            .collect();

        Ok(CursorPageResult {
            items: selected_items,
            page_info: raw_page.page_info,
        })
    }
}

mod create;
mod delete;
pub(crate) mod helpers;
mod populate;
mod update;
